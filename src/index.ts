import { runOpenCodeProcess } from "./process.js";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix, resolve, win32 } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerApiProvider } from "@earendil-works/pi-ai/compat";
import {
  calculateCost,
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  getCurrentTools,
  normalizeContext,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type ImageContent,
  type Message,
  type Model,
  type ModelThinkingLevel,
  type SimpleStreamOptions,
  type TextContent,
  type ThinkingLevelMap,
  type Tool,
  type ToolCall,
} from "@earendil-works/pi-ai";

const PROVIDER_ID = "opencode-cli";
const API_ID = "opencode-cli-runner";
const AGENT_ID = "pi-model";
const MAX_SUPPORTED_OPENCODE_VERSION = "2.0.30";
const cliVersions = new Map<string, string | undefined>();

async function usesV2Cli(): Promise<boolean> {
  if (!cliVersions.has(opencodeBin())) await checkCliStatus();
  return cliVersions.get(opencodeBin())?.startsWith("2.") === true;
}
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;
const DISCOVERY_TIMEOUT_MS = 8_000;
const STATUS_TIMEOUT_MS = 10_000;
const SESSION_DELETE_TIMEOUT_MS = 10_000;
const STDERR_LIMIT = 20_000;
/**
 * Upper bound for every model turn, applied even when Pi supplies no
 * `timeoutMs`. A session ID reused from the wrong project directory hangs
 * with empty stdout/stderr, so no turn may wait indefinitely (#73).
 */
const DEFAULT_TURN_TIMEOUT_MS = 180_000;
/** Cap on tracked Pi sessions; the oldest entry is evicted with cleanup. */
const MAX_TRACKED_PI_SESSIONS = 10;

export type CliStatus = {
  ok: boolean;
  summary: string;
  detail?: string;
};

const DEFAULT_FREE_MODELS = [
  "opencode/mimo-v2.5-free",
  "opencode/nemotron-3.5-lightning-free",
  "opencode/ling-3.0-flash-fin-free",
  "opencode/big-pickle",
];
export type ModelCost = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};
const ZERO_COST: ModelCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const satisfies readonly ModelThinkingLevel[];

export type OpenCodeModelInfo = {
  id: string;
  name: string;
  reasoning: boolean;
  image: boolean;
  contextWindow: number;
  maxTokens: number;
  cost: ModelCost;
  /** True when `cost` was read from discovery metadata rather than defaulted. */
  costFromMetadata?: boolean;
  status?: string;
  thinkingLevelMap?: ThinkingLevelMap;
};

export type ParsedToolCall = {
  name: string;
  arguments: Record<string, unknown>;
};

export type ToolCallParseResult =
  | { ok: true; calls: ParsedToolCall[]; cleanedText?: string }
  | {
      ok: false;
      rejection:
        | { reason: "malformed_markers" }
        | { reason: "invalid_payload" }
        | { reason: "incomplete_dsml" }
        | { reason: "unavailable_tool"; toolName: string };
    };

let registeredModels: OpenCodeModelInfo[] = [];
let lastDiscoveryTime: number | undefined;
let lastDiscoveryError: string | undefined;

function opencodeBin(): string {
  const configured = process.env.OPENCODE_PI_BIN?.trim();
  if (configured) {
    return configured.includes("/") || configured.includes("\\")
      ? resolve(configured)
      : configured;
  }
  if (process.platform === "win32") {
    // npm's `opencode.cmd` shim cannot be launched by spawn() without a shell.
    // Resolve the native executable installed beside the active Node runtime.
    const native = join(
      dirname(process.execPath),
      "node_modules",
      "opencode-ai",
      "bin",
      "opencode.exe",
    );
    if (existsSync(native)) return native;
  }
  return "opencode";
}

function configuredModels(): string[] | undefined {
  const raw = process.env.OPENCODE_PI_MODELS?.trim();
  if (!raw) return undefined;
  return raw
    .split(/[\s,]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((model) => (model.includes("/") ? model : `opencode/${model}`));
}

function modelDisplayName(model: string): string {
  const [, id = model] = model.split(/\/(.*)/s);
  return `OpenCode ${id}`;
}

function contextWindowFor(model: string): number {
  if (model.includes("big-pickle")) return 200_000;
  return DEFAULT_CONTEXT_WINDOW;
}

function maxTokensFor(model: string): number {
  if (model.includes("big-pickle")) return 32_000;
  return DEFAULT_MAX_TOKENS;
}

function looksFree(model: string): boolean {
  return /(^opencode\/.*-free$)|(^opencode\/big-pickle$)/.test(model);
}

/** Read a non-negative finite cost figure; anything else means "unknown". */
function costFigure(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

/**
 * Read the real per-model cost from verbose discovery metadata (#78).
 * Missing or malformed figures fall back to zero so a model is never
 * reported with an invented non-zero cost.
 */
export function parseModelCost(metadata: unknown): ModelCost {
  const value = metadata as {
    cost?: {
      input?: unknown;
      output?: unknown;
      cache?: { read?: unknown; write?: unknown };
    };
  } | null;
  const cost = value?.cost;
  return {
    input: costFigure(cost?.input) ?? 0,
    output: costFigure(cost?.output) ?? 0,
    cacheRead: costFigure(cost?.cache?.read) ?? 0,
    cacheWrite: costFigure(cost?.cache?.write) ?? 0,
  };
}

/**
 * Free models are identified by zero input and output cost in the discovery
 * metadata (#77). When a record carries no usable cost figures (older CLI
 * output), fall back to the legacy `-free` name pattern so paid models are
 * never misregistered as free.
 */
export function isFreeModel(model: {
  id: string;
  cost: ModelCost;
  costFromMetadata?: boolean;
}): boolean {
  if (model.cost.input !== 0 || model.cost.output !== 0) return false;
  if (model.costFromMetadata === true) return true;
  return looksFree(model.id);
}

/**
 * Discovery metadata carries a per-model status field (#79). Only `active`
 * models are registered; a missing status is treated as active so older CLI
 * output without the field keeps working.
 */
export function isActiveModel(status: unknown): boolean {
  if (status === undefined || status === null) return true;
  return String(status).trim().toLowerCase() === "active";
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function fallbackModel(id: string): OpenCodeModelInfo {
  return {
    id,
    name: modelDisplayName(id),
    reasoning: false,
    image: false,
    contextWindow: contextWindowFor(id),
    maxTokens: maxTokensFor(id),
    cost: ZERO_COST,
  };
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

function thinkingLevelMap(variants: unknown): ThinkingLevelMap {
  const map: ThinkingLevelMap = {};
  const names =
    typeof variants === "object" && variants !== null && !Array.isArray(variants)
      ? new Set(Object.keys(variants))
      : new Set<string>();

  for (const level of THINKING_LEVELS) {
    if (level === "off") {
      if (names.has("off")) map.off = "off";
      else if (names.has("none")) map.off = "none";
      continue;
    }
    map[level] = names.has(level) ? level : null;
  }
  if (!names.has("xhigh") && names.has("max")) map.xhigh = "max";
  return map;
}

export function reasoningCliArgs(
  requestedReasoning: ModelThinkingLevel | undefined,
  map?: ThinkingLevelMap,
): string[] {
  // Capture blocks for recovery; --thinking controls CLI output, not model effort.
  const args = ["--thinking"];
  if (!requestedReasoning || requestedReasoning === "off") return args;
  const variant = map?.[requestedReasoning];
  if (typeof variant === "string" && variant.trim()) {
    args.push("--variant", variant);
  }
  return args;
}

function findJsonObjectEnd(text: string, start: number): number | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return undefined;
}

/** Parse the `model-id` + pretty-printed JSON pairs from OpenCode verbose discovery. */
export function parseVerboseModels(output: string): OpenCodeModelInfo[] {
  const records = new Map<string, OpenCodeModelInfo>();
  const idPattern = /^opencode\/[^\s]+\s*$/gm;
  for (const match of output.matchAll(idPattern)) {
    const id = match[0].trim();
    const metadataStart = (match.index ?? 0) + match[0].length;
    const objectStart = output.indexOf("{", metadataStart);
    if (objectStart < 0) continue;

    const nextId = output.slice(metadataStart).search(/^opencode\/[^\s]+\s*$/m);
    if (nextId >= 0 && objectStart >= metadataStart + nextId) continue;
    const objectEnd = findJsonObjectEnd(output, objectStart);
    if (objectEnd === undefined) continue;

    let metadata: unknown;
    try {
      metadata = JSON.parse(output.slice(objectStart, objectEnd));
    } catch {
      continue;
    }
    if (typeof metadata !== "object" || metadata === null) continue;

    records.set(id, modelInfo(id, metadata));
  }
  return [...records.values()];
}

function modelInfo(id: string, metadata: unknown): OpenCodeModelInfo {
  const value = metadata as {
    name?: unknown;
    status?: unknown;
    cost?: {
      input?: unknown;
      output?: unknown;
      cache?: { read?: unknown; write?: unknown };
    };
    limit?: { context?: unknown; output?: unknown };
    capabilities?: { reasoning?: unknown; input?: { image?: unknown } };
    variants?: unknown;
  };
  const reasoning = value.capabilities?.reasoning === true;
  const cost = parseModelCost(value);
  const costFromMetadata =
    costFigure(value.cost?.input) !== undefined &&
    costFigure(value.cost?.output) !== undefined;
  const status =
    typeof value.status === "string" && value.status.trim()
      ? value.status.trim()
      : undefined;
  return {
    id,
    name:
      typeof value.name === "string" && value.name.trim()
        ? value.name.trim()
        : modelDisplayName(id),
    reasoning,
    image: value.capabilities?.input?.image === true,
    contextWindow: positiveNumber(value.limit?.context, contextWindowFor(id)),
    maxTokens: positiveNumber(value.limit?.output, maxTokensFor(id)),
    cost,
    ...(costFromMetadata ? { costFromMetadata: true as const } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(reasoning ? { thinkingLevelMap: thinkingLevelMap(value.variants) } : {}),
  };
}

/** V2 exposes model metadata through its local API, not `models --verbose`. */
function parseV2Models(output: string): OpenCodeModelInfo[] {
  const data = objectRecord(JSON.parse(output))?.data;
  if (!Array.isArray(data)) return [];
  return data.flatMap((entry) => {
    const value = objectRecord(entry);
    if (value?.providerID !== "opencode" || typeof value.id !== "string" ||
        !value.id.trim() || /[\s/#]/.test(value.id) || value.enabled === false) return [];
    const capabilities = objectRecord(value.capabilities);
    const variants = Array.isArray(value.variants)
      ? value.variants.flatMap((v) => typeof objectRecord(v)?.id === "string" ? [String(v.id)] : [])
      : [];
    const costs = Array.isArray(value.cost) ? value.cost : [];
    // Any paid tier makes automatic selection unsafe, even when the base tier is free.
    if (costs.some((c) => costFigure(objectRecord(c)?.input) === undefined ||
        costFigure(objectRecord(c)?.output) === undefined)) return [];
    const cost = costs.length ? {
      input: Math.max(...costs.map(c => c.input)),
      output: Math.max(...costs.map(c => c.output)),
      cache: {
        read: Math.max(...costs.map(c => costFigure(objectRecord(c.cache)?.read) ?? 0)),
        write: Math.max(...costs.map(c => costFigure(objectRecord(c.cache)?.write) ?? 0)),
      },
    } : undefined;
    return [modelInfo(`opencode/${value.id}`, {
      ...value, cost,
      capabilities: {
        reasoning: variants.length > 0 || typeof objectRecord(value.compatibility)?.reasoningField === "string",
        input: { image: Array.isArray(capabilities?.input) && capabilities.input.includes("image") },
      },
      variants: Object.fromEntries(variants.map(id => [id, {}])),
    })];
  });
}

function runCapture(
  args: string[],
  input?: string,
  timeoutMs = DISCOVERY_TIMEOUT_MS,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return runOpenCodeProcess(opencodeBin(), args, {
    input,
    timeoutMs,
    env: { ...process.env, OPENCODE_DISABLE_UPDATE_CHECK: "1" },
  });
}

/** Build the install/setup instructions shown when the opencode CLI is unusable. */
export function setupGuidance(error: string): string {
  return [
    "opencode-pi could not use the local OpenCode CLI.",
    `Reason: ${error}`,
    "Install OpenCode (https://opencode.ai), ensure `opencode --version` works on PATH, then reload Pi.",
    "Set OPENCODE_PI_BIN to override the executable path.",
  ].join(" ");
}

/** Probe the OpenCode CLI with `opencode --version` to detect a missing/broken install. */
export async function checkCliStatus(): Promise<CliStatus> {
  try {
    const result = await runCapture(["--version"], undefined, STATUS_TIMEOUT_MS);
    if (result.code !== 0) {
      const detail =
        result.stderr.trim() ||
        result.stdout.trim() ||
        `opencode --version exited with code ${result.code}`;
      return { ok: false, summary: "OpenCode CLI is unusable", detail };
    }
    const version =
      result.stdout.trim() || result.stderr.trim() || "OpenCode CLI is available";
    cliVersions.set(opencodeBin(), /\d+\.\d+\.\d+/.exec(version)?.[0]);
    return { ok: true, summary: version };
  } catch (error) {
    return {
      ok: false,
      summary: "OpenCode CLI is unavailable",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function discoverModels(opts?: {
  forceDiscovery?: boolean;
}): Promise<{
  models: OpenCodeModelInfo[];
  time: number;
  error: string | undefined;
}> {
  const configured = configuredModels();
  // An explicit OPENCODE_PI_MODELS list already tells us exactly which
  // models to register, so the fast (non-forced) path skips spawning
  // opencode entirely rather than making explicitly configured users pay a
  // discovery timeout on every startup when the binary is missing or slow.
  // `forceDiscovery` (used by the user-initiated /opencode-pi update
  // command) still runs discovery so configured models can be enriched with
  // real capability metadata (reasoning/image/limits) on request.
  if (configured?.length && !opts?.forceDiscovery) {
    lastDiscoveryError = undefined;
    return {
      models: dedupe(configured).map(fallbackModel),
      time: Date.now(),
      error: undefined,
    };
  }

  try {
    const v2 = await usesV2Cli();
    const result = await runCapture(v2
      ? ["api", "--standalone", "get", "/api/model"]
      : ["models", "opencode", "--verbose"]);
    if (result.code !== 0) {
      throw new Error(
        result.stderr.trim() ||
          `opencode models exited with code ${result.code}`,
      );
    }

    const metadata = v2 ? parseV2Models(result.stdout) : parseVerboseModels(result.stdout);
    if (metadata.length === 0) {
      throw new Error("opencode model discovery returned no metadata");
    }
    const byId = new Map(metadata.map((model) => [model.id, model]));
    const selected = configured?.length
      ? dedupe(configured).map((id) => byId.get(id) ?? fallbackModel(id))
      : metadata.filter(
          (model) => isActiveModel(model.status) && isFreeModel(model),
        );
    if (selected.length === 0) {
      throw new Error("opencode model discovery returned no free models");
    }

    lastDiscoveryError = undefined;
    return { models: selected, time: Date.now(), error: undefined };
  } catch (error) {
    lastDiscoveryError = error instanceof Error ? error.message : String(error);
    const fallbackIds = configured?.length
      ? dedupe(configured)
      : DEFAULT_FREE_MODELS;
    return {
      models: fallbackIds.map(fallbackModel),
      time: Date.now(),
      error: lastDiscoveryError,
    };
  }
}

async function refreshModels(
  pi: ExtensionAPI,
  ctx: { ui: { notify: (msg: string, level?: string) => void } },
): Promise<void> {
  const previousModels = new Set(registeredModels.map((model) => model.id));
  const { models, time, error } = await discoverModels({
    forceDiscovery: true,
  });
  registeredModels = models;
  lastDiscoveryTime = time;

  // Re-register the provider with the updated model list
  const providerConfig: Parameters<ExtensionAPI["registerProvider"]>[1] = {
    name: "OpenCode CLI",
    baseUrl: "cli:opencode",
    apiKey: "opencode-cli-no-api-key",
    api: API_ID,
    models: models.map(providerModel),
    streamSimple: streamOpenCode,
  };

  try {
    pi.registerProvider(PROVIDER_ID, providerConfig);
  } catch {
    // registerProvider may reject if already registered; the models array is already updated.
  }
  registerApiHandler();

  const newModels = models.filter((model) => !previousModels.has(model.id));

  let msg = `opencode-pi: refreshed ${models.length} model(s).`;
  if (newModels.length > 0) {
    msg += ` ${newModels.length} new: ${newModels
      .slice(0, 5)
      .map((model) => model.id)
      .join(", ")}${newModels.length > 5 ? ", ..." : ""}`;
  }
  if (error) msg += ` Discovery issue: ${error}`;
  ctx.ui.notify(msg, "info");
}

function emptyUsage(): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function setEstimatedUsage(
  model: Model<Api>,
  output: AssistantMessage,
  prompt: string,
  text: string,
) {
  if (output.usage.totalTokens > 0) return;
  output.usage.input = estimateTokens(prompt);
  output.usage.output = estimateTokens(text);
  output.usage.totalTokens = output.usage.input + output.usage.output;
  calculateCost(model, output.usage);
}

function contentToText(
  content: string | (TextContent | ImageContent)[],
): string {
  if (typeof content === "string") return content;
  return content
    .map((item) => {
      if (item.type === "text") return item.text;
      return `[image in conversation: ${item.mimeType}, ${item.data.length} base64 chars]`;
    })
    .join("\n");
}

export function imageContentsForModel(
  messages: Message[],
  supportsImages: boolean,
): ImageContent[] {
  if (!supportsImages) return [];

  const images: ImageContent[] = [];
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "toolResult") continue;
    if (typeof message.content === "string") continue;
    for (const content of message.content) {
      if (content.type === "image") images.push(content);
    }
  }
  return images;
}

function safeImageExtension(mimeType: string): string {
  const extensions: Record<string, string> = {
    "image/avif": ".avif",
    "image/bmp": ".bmp",
    "image/gif": ".gif",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
  };
  return extensions[mimeType.toLowerCase()] ?? ".bin";
}

async function writeImageFiles(
  images: ImageContent[],
  directory: string,
): Promise<string[]> {
  const imageDir = join(directory, "pi-images");
  if (images.length > 0) await mkdir(imageDir, { recursive: true });
  return Promise.all(
    images.map(async (image, index) => {
      if (!image.mimeType.toLowerCase().startsWith("image/")) {
        throw new Error(`Unsupported image MIME type: ${image.mimeType}`);
      }
      const base64 = image.data.replace(/\s/g, "");
      if (
        !base64 ||
        base64.length % 4 === 1 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)
      ) {
        throw new Error(`Invalid base64 data for image ${index + 1}`);
      }
      const data = Buffer.from(base64, "base64");
      if (data.length === 0) {
        throw new Error(`Empty image data for image ${index + 1}`);
      }
      const path = join(
        imageDir,
        `image-${String(index + 1).padStart(3, "0")}${safeImageExtension(image.mimeType)}`,
      );
      await writeFile(path, data);
      return path;
    }),
  );
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/**
 * Map a blocked native OpenCode call onto the equivalent Pi tool, so Pi runs
 * it under its own permissions. Calls whose semantics differ stay untranslated.
 */
export function translateNativeToolCall(
  tool: string,
  input: unknown,
  allowedToolNames: Set<string>,
  projectDirs: string[],
  paths: typeof posix = process.platform === "win32" ? win32 : posix,
): ParsedToolCall | undefined {
  const args = objectRecord(input);
  if (!args) return undefined;
  const text = (key: string) => typeof args[key] === "string" ? args[key] as string : undefined;
  const count = (key: string) =>
    typeof args[key] === "number" && args[key] > 0 ? args[key] as number : undefined;
  // OpenCode resolves paths in its temporary project; Pi resolves them in the real one.
  // Platform path rules also cover Windows slash and drive-letter case differences.
  const path = (key: string) => {
    const value = text(key);
    if (value === undefined || !paths.isAbsolute(value)) return value;
    for (const dir of projectDirs) {
      const rel = paths.relative(dir, value);
      if (rel !== ".." && !rel.startsWith(".." + paths.sep) && !paths.isAbsolute(rel)) return rel || ".";
    }
    return value;
  };
  const call = (name: string, entries: Record<string, unknown>): ParsedToolCall => ({
    name,
    arguments: Object.fromEntries(Object.entries(entries).filter(([, v]) => v !== undefined)),
  });
  const fileKey = text("filePath") !== undefined ? "filePath" : "path";
  let result: ParsedToolCall | undefined;
  switch (tool) {
    case "bash":
    case "shell": {
      // shortcut: absolute temp-project paths inside the command are not rewritten; parse them if models rely on it.
      const timeout = count("timeout");
      if (text("command") === undefined ||
          (args.workdir !== undefined && path("workdir") !== ".") ||
          (tool === "shell" && (args.background === true || args.timeout === 0 ||
            (args.cwd !== undefined && path("cwd") !== ".")))) break;
      result = call("bash", { command: text("command"), timeout: timeout && Math.ceil(timeout / 1000) });
      break;
    }
    case "read":
      if (text(fileKey) !== undefined) {
        result = call("read", { path: path(fileKey), offset: count("offset"), limit: count("limit") });
      }
      break;
    case "write":
      if (text(fileKey) !== undefined && text("content") !== undefined) {
        result = call("write", { path: path(fileKey), content: text("content") });
      }
      break;
    case "edit":
      // Pi edits need one unique, non-empty match: no replaceAll or create-by-edit.
      if (text(fileKey) !== undefined && text("oldString") && text("newString") !== undefined &&
          args.replaceAll !== true) {
        result = call("edit", {
          path: path(fileKey),
          edits: [{ oldText: text("oldString"), newText: text("newString") }],
        });
      }
      break;
    case "grep":
      if (text("pattern") !== undefined) {
        result = call("grep", { pattern: text("pattern"), path: path("path"), glob: text("include") });
      }
      break;
    case "glob":
      if (text("pattern") !== undefined) result = call("find", { pattern: text("pattern"), path: path("path") });
      break;
  }
  return result && allowedToolNames.has(result.name) ? result : undefined;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function serializeMessage(message: Message): string {
  if (message.role === "user" || message.role === "system") {
    return `${message.role.toUpperCase()}:\n${contentToText(message.content)}`;
  }

  if (message.role === "toolResult") {
    return [
      `PI TOOL RESULT (${message.toolName}, id=${message.toolCallId}, isError=${message.isError}):`,
      contentToText(message.content),
    ].join("\n");
  }

  const parts = message.content.map(
    (part: TextContent | ToolCall | { type: "thinking"; thinking: string }) => {
      if (part.type === "text") return part.text;
      if (part.type === "thinking")
        return `<thinking>${part.thinking}</thinking>`;
      return `<pi_tool_call>${safeJson({ id: part.id, name: part.name, arguments: part.arguments })}</pi_tool_call>`;
    },
  );
  return `ASSISTANT:\n${parts.join("\n")}`;
}

function serializeTools(tools?: Tool[]): string {
  if (!tools || tools.length === 0)
    return "No Pi tools are available for this turn.";
  return safeJson(
    tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    })),
  );
}

function buildPrompt(context: Context): string {
  const sections: string[] = [];
  sections.push(`# Pi/OpenCode bridge instructions

You are being used as the model backend for Pi Coding Agent through the OpenCode CLI.
OpenCode's own tools are disabled. Do not try to use OpenCode tools.

If you need Pi to run a tool, your entire response must contain only one or more tool-call blocks separated by whitespace:
<pi_tool_call>{"name":"tool_name","arguments":{}}</pi_tool_call>

Rules for Pi tool calls:
- Use only exact tool names listed in the "Available Pi tools" section.
- The JSON inside every marker must be valid JSON with a string "name" and an object "arguments".
- Escape every quote inside a JSON string value as \\\", especially quotes inside shell commands.
- Markers are bridge control syntax. Never quote them, explain them, put them in prose, or wrap them in Markdown fences.
- Never output a marker as an example. A marker means you are requesting immediate execution.
- Do not put any text before or after tool-call markers. Mixed prose and markers will not execute.
- NEVER use XML-style tool-use syntax (e.g., <bash>, <read>, <glob>, <grep>, <edit>, <task>, <arg_key>, <arg_value>). These are your native tool-use format and are completely disabled.
- NEVER use Claude Code XML-style markup (e.g., <bash command="...">, <read path="...">, <arg_key>, <arg_value>). This is not a tool-call and will be treated as plain text.
- If you can answer without a tool, answer normally in plain text and do not emit any marker.
- After Pi returns tool results, match them to prior tool-call IDs in the transcript, then either answer or request another Pi tool call.`);

  if (context.systemPrompt?.trim()) {
    sections.push(`# Pi system prompt

${context.systemPrompt}`);
  }

  sections.push(`# Available Pi tools

${serializeTools(context.tools)}`);

  if (context.messages.length > 0) {
    sections.push(`# Conversation transcript

${context.messages.map(serializeMessage).join("\n\n---\n\n")}`);
  } else {
    sections.push("# Conversation transcript\n\n(no prior messages)");
  }

  sections.push("Now produce the next assistant message for Pi.");
  return sections.join("\n\n---\n\n");
}

const MARKER_OPEN = "<pi_tool_call>";

// Detects marker syntax anywhere in the response, not just at the start, so
// prose-then-marker and marker-then-prose responses are treated the same
// way: either both are rejected as malformed tool-call attempts, or neither
// is. A one-sided check let malformed leading prose silently leak raw
// marker text into the visible chat response while malformed trailing prose
// hard-failed the turn.
//
// Requires the opening marker specifically: a response can only be
// *attempting* a tool call if it emits the open tag. A lone closing marker
// (e.g. prose that merely quotes or discusses `</pi_tool_call>`) is not a
// plausible tool-call attempt and must not hard-fail the turn.
export function isToolCallMarkerResponse(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.includes(MARKER_OPEN);
}

type MarkerClose = { index: number; length: number };

// Models occasionally vary whitespace, separators, plurality, or case in the
// closing tag. Keep the opening marker strict, but accept this bounded family
// of unmistakable Pi marker closers.
const MARKER_CLOSE_PATTERN = /^<\s*\/\s*pi[-_]tool[-_]calls?\s*>/i;

// A closing marker inside a JSON string (e.g. tool arguments that happen to
// contain the literal text "</pi_tool_call>") must not be treated as the
// real boundary, so this walks the JSON string-escaping state rather than
// matching the close tag with a plain regex.
function findMarkerClose(text: string, from: number): MarkerClose | undefined {
  let inString = false;
  let escaped = false;
  for (let i = from; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char !== "<") continue;
    const match = text.slice(i).match(MARKER_CLOSE_PATTERN);
    if (match) return { index: i, length: match[0].length };
  }
  return undefined;
}

// Some models emit a complete marker payload but omit only the closing tag.
// Recover that narrow case by locating one complete top-level JSON object or
// array and requiring whitespace-only content afterward. Payload validation
// and the current-turn tool allowlist are still applied by the caller.
function recoverUnclosedMarkerBody(
  text: string,
  bodyStart: number,
): string | undefined {
  let start = bodyStart;
  while (/\s/.test(text[start] ?? "")) start++;
  const first = text[start];
  if (first !== "{" && first !== "[") return undefined;

  const stack: string[] = [first];
  let inString = false;
  let escaped = false;
  for (let i = start + 1; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{" || char === "[") {
      stack.push(char);
      continue;
    }
    if (char !== "}" && char !== "]") continue;

    const expected = char === "}" ? "{" : "[";
    if (stack.pop() !== expected) return undefined;
    if (stack.length === 0) {
      const end = i + 1;
      return text.slice(end).trim() ? undefined : text.slice(bodyStart, end);
    }
  }
  return undefined;
}

function normalizeQuotedToolCallResponse(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('"') || !trimmed.endsWith('"')) return text;
  try {
    const decoded: unknown = JSON.parse(trimmed);
    return typeof decoded === "string" && decoded.includes(MARKER_OPEN)
      ? decoded
      : text;
  } catch {
    return text;
  }
}

/**
 * Extract <pi_tool_call> marker bodies from the response text.
 * Lenient: markers are extracted anywhere in the text, even with prose
 * before or after them, matching how real models behave. A marker whose
 * payload cannot be recovered (truncated JSON, unclosed with trailing
 * content) is recorded as an invalid span instead of aborting extraction,
 * so valid sibling markers still parse and the unrecoverable text can be
 * stripped from the displayed response (#39).
 */
type MarkerSpan = { start: number; end: number };

type ExtractedMarker = { body: string; start: number; end: number };

type MarkerExtraction = {
  markers: ExtractedMarker[];
  invalidSpans: MarkerSpan[];
};

function toolCallMarkers(text: string): MarkerExtraction | undefined {
  const trimmed = text.trim();
  const markers: ExtractedMarker[] = [];
  const invalidSpans: MarkerSpan[] = [];
  let cursor = 0;
  while (cursor < trimmed.length) {
    const openIndex = trimmed.indexOf(MARKER_OPEN, cursor);
    if (openIndex === -1) break;

    const bodyStart = openIndex + MARKER_OPEN.length;
    const close = findMarkerClose(trimmed, bodyStart);
    if (close) {
      markers.push({
        body: trimmed.slice(bodyStart, close.index),
        start: openIndex,
        end: close.index + close.length,
      });
      cursor = close.index + close.length;
      continue;
    }

    const recovered = recoverUnclosedMarkerBody(trimmed, bodyStart);
    if (recovered !== undefined) {
      const end = bodyStart + recovered.length;
      markers.push({ body: recovered, start: openIndex, end });
      cursor = end;
      continue;
    }

    // Unrecoverable marker: everything up to the next opening marker (or
    // the end of the response) is inside the attempted marker, so strip it.
    const nextOpen = trimmed.indexOf(MARKER_OPEN, bodyStart);
    const spanEnd = nextOpen === -1 ? trimmed.length : nextOpen;
    invalidSpans.push({ start: openIndex, end: spanEnd });
    cursor = spanEnd;
  }
  if (markers.length === 0 && invalidSpans.length === 0) return undefined;
  return { markers, invalidSpans };
}

function stripMarkerSpans(text: string, spans: MarkerSpan[]): string {
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  let cleaned = "";
  let cursor = 0;
  for (const span of sorted) {
    if (span.start < cursor) continue;
    cleaned += text.slice(cursor, span.start);
    cursor = Math.max(cursor, span.end);
  }
  cleaned += text.slice(cursor);
  return cleaned;
}

// DeepSeek sometimes ignores the markers and writes its native DSML tool-call
// syntax as plain text. Each complete block is rewritten in place as markers,
// so call order and the tool-list check stay those of the marker parser.
const DSML = String.raw`[｜|]+\s*DSML\s*[｜|]+`;
const DSML_TAG = new RegExp(String.raw`<\/?${DSML}`);
const DSML_BLOCK = new RegExp(String.raw`^<${DSML}(?:tool|function)_calls>([\s\S]*?)<\/${DSML}(?:tool|function)_calls>`);
const DSML_INVOKE = new RegExp(String.raw`<${DSML}invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/${DSML}invoke>`, "g");
const DSML_PARAMETER = new RegExp(String.raw`<${DSML}parameter\s+name="([^"]+)"(?:\s+string="(true|false)")?\s*>([\s\S]*?)<\/${DSML}parameter>`, "g");

function dsmlBlockToMarkers(body: string): string {
  let markers = "";
  for (const [, name, params] of body.matchAll(DSML_INVOKE)) {
    const args: Record<string, unknown> = {};
    for (const [, key, isString, raw] of params.matchAll(DSML_PARAMETER)) {
      if (isString === "true") {
        args[key] = raw;
        continue;
      }
      try {
        args[key] = JSON.parse(raw);
      } catch {
        args[key] = raw;
      }
    }
    markers += `${MARKER_OPEN}${JSON.stringify({ name, arguments: args })}</pi_tool_call>`;
  }
  return markers;
}

// Scans left to right and consumes whichever starts first, a marker or a DSML
// block, so each keeps the other's syntax intact inside its own arguments.
// Returns undefined for a truncated DSML block, which would otherwise end the
// turn silently or let Pi run only the calls before it.
function dsmlToMarkers(text: string): string | undefined {
  let result = "";
  let rest = text;
  for (;;) {
    const dsmlAt = rest.search(DSML_TAG);
    const markerAt = rest.indexOf(MARKER_OPEN);
    if (dsmlAt < 0) return result + rest;
    if (markerAt >= 0 && markerAt < dsmlAt) {
      // The slice starts at the marker, so trimming cannot shift its span.
      const extraction = toolCallMarkers(rest.slice(markerAt));
      const span = [...(extraction?.markers ?? []), ...(extraction?.invalidSpans ?? [])].find((s) => s.start === 0);
      const end = markerAt + (span?.end ?? MARKER_OPEN.length);
      result += rest.slice(0, end);
      rest = rest.slice(end);
      continue;
    }
    const block = DSML_BLOCK.exec(rest.slice(dsmlAt));
    if (!block) return undefined;
    result += rest.slice(0, dsmlAt) + dsmlBlockToMarkers(block[1]);
    rest = rest.slice(dsmlAt + block[0].length);
  }
}

export function parseToolCallResponse(
  text: string,
  allowedToolNames?: ReadonlySet<string>,
): ToolCallParseResult {
  // A turn without tools (e.g. a compaction summary) cannot call any, so tool
  // syntax it quotes is prose.
  if (allowedToolNames?.size === 0) return { ok: true, calls: [] };
  const normalizedText = dsmlToMarkers(normalizeQuotedToolCallResponse(text));
  if (normalizedText === undefined) {
    return { ok: false, rejection: { reason: "incomplete_dsml" } };
  }
  if (!isToolCallMarkerResponse(normalizedText)) return { ok: true, calls: [] };

  const extraction = toolCallMarkers(normalizedText);
  if (!extraction) return { ok: true, calls: [] };

  const parsed: ParsedToolCall[] = [];
  const strippedSpans: MarkerSpan[] = [...extraction.invalidSpans];
  let payloadRejection:
    | { reason: "invalid_payload" }
    | undefined;

  for (const marker of extraction.markers) {
    const calls = parseToolCallJson(marker.body);
    if (calls.length === 0) {
      // Skip the invalid body but keep any valid sibling calls; if no
      // call survives, surface the original corrective diagnostic.
      payloadRejection ??= { reason: "invalid_payload" };
      strippedSpans.push({ start: marker.start, end: marker.end });
      continue;
    }
    const unavailable = calls.find(
      (call) => allowedToolNames && !allowedToolNames.has(call.name),
    );
    if (unavailable) {
      return {
        ok: false,
        rejection: {
          reason: "unavailable_tool",
          toolName: unavailable.name,
        },
      };
    }
    parsed.push(...calls);
  }

  if (parsed.length === 0 && payloadRejection) {
    return { ok: false, rejection: payloadRejection };
  }

  if (strippedSpans.length === 0) return { ok: true, calls: parsed };
  const cleanedText = stripMarkerSpans(normalizedText.trim(), strippedSpans);
  if (parsed.length === 0 && !cleanedText.trim()) {
    return { ok: false, rejection: { reason: "malformed_markers" } };
  }
  return { ok: true, calls: parsed, cleanedText };
}

export function parseToolCalls(
  text: string,
  allowedToolNames?: ReadonlySet<string>,
): ParsedToolCall[] {
  const result = parseToolCallResponse(text, allowedToolNames);
  return result.ok ? result.calls : [];
}

/**
 * Detects if the model response contains XML-style tool-use markup
 * (e.g., Claude Code's <bash>, <read>, <arg_key>, <arg_value> tags).
 * Returns the detected tool name if found, or undefined if not.
 */
function detectXmlToolUse(text: string): string | undefined {
  // Match XML-style tool tags that look like tool invocations.
  // These are NOT <pi_tool_call> markers — they are the model's native format.
  // Claude Code uses <bash>, <read>, <edit>, etc. directly, but may also
  // emit <arg_key>/<arg_value> pairs inside those tags.
  const xmlToolPattern = /<(bash|read|edit|write|glob|grep|ls|webfetch|websearch|task|todowrite|question|skill|lsp|external_directory|doom_loop|agent|arg_key|arg_value)\b/i;
  const match = text.match(xmlToolPattern);
  return match ? match[1].toLowerCase() : undefined;
}

function toolCallRejectionMessage(
  result: Extract<ToolCallParseResult, { ok: false }>,
  allowedToolNames: ReadonlySet<string>,
): string {
  switch (result.rejection.reason) {
    case "malformed_markers":
      return "OpenCode returned malformed Pi tool-call markers. Ensure each marker contains valid JSON with a string \"name\" and object \"arguments\".";
    case "invalid_payload":
      return 'OpenCode returned an invalid Pi tool-call payload. Each marker must contain valid JSON with a non-empty string "name" and object "arguments".';
    case "incomplete_dsml":
      return "OpenCode returned an incomplete DeepSeek DSML tool call.";
    case "unavailable_tool": {
      const available = [...allowedToolNames].map((name) =>
        JSON.stringify(name),
      );
      return `OpenCode requested unavailable Pi tool ${JSON.stringify(result.rejection.toolName)}. Use only tools available in the current Pi turn: ${available.length > 0 ? available.join(", ") : "none"}.`;
    }
  }
}

function parseArguments(value: unknown): Record<string, unknown> | undefined {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return undefined;
    }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  return parsed as Record<string, unknown>;
}

function repairUnescapedJsonStringQuotes(raw: string): string | undefined {
  const trimmed = raw.trim();
  const matchingContainer =
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"));
  if (!matchingContainer) return undefined;

  let repaired = "";
  let inString = false;
  let escaped = false;
  let changed = false;

  for (let index = 0; index < trimmed.length; index++) {
    const char = trimmed[index];
    if (!inString) {
      repaired += char;
      if (char === '"') inString = true;
      continue;
    }
    if (escaped) {
      repaired += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      repaired += char;
      escaped = true;
      continue;
    }
    if (char !== '"') {
      repaired += char;
      continue;
    }

    let nextIndex = index + 1;
    while (/\s/.test(trimmed[nextIndex] ?? "")) nextIndex++;
    const next = trimmed[nextIndex];
    if (next === undefined || [",", ":", "}", "]"].includes(next)) {
      repaired += char;
      inString = false;
    } else {
      repaired += '\\"';
      changed = true;
    }
  }

  return changed && !inString ? repaired : undefined;
}

function parseToolCallJson(raw: string): ParsedToolCall[] {
  let value: unknown;
  try {
    value = JSON.parse(raw.trim());
  } catch {
    const repaired = repairUnescapedJsonStringQuotes(raw);
    if (!repaired) return [];
    try {
      value = JSON.parse(repaired);
    } catch {
      return [];
    }
  }

  const container = value as { tool_calls?: unknown } | null;
  const candidates = Array.isArray(value)
    ? value
    : Array.isArray(container?.tool_calls)
      ? container.tool_calls
      : [value];
  if (candidates.length === 0) return [];

  const calls: ParsedToolCall[] = [];
  for (const rawCandidate of candidates) {
    if (
      typeof rawCandidate !== "object" ||
      rawCandidate === null ||
      Array.isArray(rawCandidate)
    ) {
      return [];
    }
    const candidate = rawCandidate as {
      name?: unknown;
      tool?: unknown;
      arguments?: unknown;
      args?: unknown;
      input?: unknown;
      function?: { name?: unknown; arguments?: unknown };
    };
    const nameValue =
      typeof candidate.name === "string"
        ? candidate.name
        : typeof candidate.tool === "string"
          ? candidate.tool
          : candidate.function?.name;

    let argumentsValue: unknown;
    if (Object.hasOwn(candidate, "arguments")) {
      argumentsValue = candidate.arguments;
    } else if (Object.hasOwn(candidate, "args")) {
      argumentsValue = candidate.args;
    } else if (Object.hasOwn(candidate, "input")) {
      argumentsValue = candidate.input;
    } else if (
      candidate.function &&
      typeof candidate.function === "object" &&
      Object.hasOwn(candidate.function, "arguments")
    ) {
      argumentsValue = candidate.function.arguments;
    } else {
      return [];
    }

    const args = parseArguments(argumentsValue);
    if (
      typeof nameValue !== "string" ||
      !nameValue.trim() ||
      !args
    ) {
      return [];
    }
    calls.push({ name: nameValue, arguments: args });
  }
  return calls;
}

/**
 * Effective per-turn timeout: honor Pi's `timeoutMs` when it is a positive
 * finite number, otherwise fall back to the unconditional internal bound so
 * no turn can hang indefinitely (#73).
 */
export function resolveTurnTimeoutMs(timeoutMs: unknown): number {
  return typeof timeoutMs === "number" &&
    Number.isFinite(timeoutMs) &&
    timeoutMs > 0
    ? timeoutMs
    : DEFAULT_TURN_TIMEOUT_MS;
}

const pendingSessionDeletions = new Set<Promise<void>>();

/** Best-effort, bounded deletion; shutdown also awaits one-shot deletions. */
export function deleteOpenCodeSession(sessionId: string | undefined): Promise<void> {
  if (!sessionId) return Promise.resolve();
  const args = ["session", "delete", sessionId];
  if (cliVersions.get(opencodeBin())?.startsWith("2.")) args.push("--standalone");
  const task = runCapture(args, undefined, SESSION_DELETE_TIMEOUT_MS)
    .then(() => undefined, () => undefined);
  pendingSessionDeletions.add(task);
  void task.finally(() => pendingSessionDeletions.delete(task));
  return task;
}

export type PiSessionState = {
  /** Lazily created per-Pi-session OpenCode project directory (#74). */
  dirPromise?: Promise<string>;
  /** Recorded OpenCode session ID reused across turns (#75). */
  opencodeSessionId?: string;
  /** Model ID the recorded session was created with. */
  modelId?: string;
  /** Serialized tool list the recorded session was created with (#76). */
  toolsKey?: string;
  /** System prompt the recorded session was created with (#76). */
  systemPrompt?: string;
  /** Serialized transcript prefix already sent to the recorded session. */
  sentParts?: string[];
};

const piSessions = new Map<string, PiSessionState>();

/** Number of tracked Pi sessions (exposed for tests). */
export function trackedPiSessionCount(): number {
  return piSessions.size;
}

function getPiSessionState(piSessionId: string): PiSessionState {
  const existing = piSessions.get(piSessionId);
  if (existing) {
    // Refresh recency so eviction drops the least-recently-used entry.
    piSessions.delete(piSessionId);
    piSessions.set(piSessionId, existing);
    return existing;
  }
  const state: PiSessionState = {};
  piSessions.set(piSessionId, state);
  while (piSessions.size > MAX_TRACKED_PI_SESSIONS) {
    const oldest = piSessions.keys().next();
    if (oldest.done) break;
    void cleanupPiSessionState(oldest.value as string);
  }
  return state;
}

function ensurePiSessionDir(state: PiSessionState): Promise<string> {
  state.dirPromise ??= createTempAgentDir().catch((error) => {
    if (state.dirPromise) state.dirPromise = undefined;
    throw error;
  });
  return state.dirPromise;
}

/**
 * Remove a Pi session's project directory and delete its OpenCode session
 * record — the explicit cleanup path for session teardown (#74). With no
 * argument, every tracked session is cleaned up.
 */
export async function cleanupPiSessionState(
  piSessionId?: string,
): Promise<void> {
  const ids =
    piSessionId === undefined ? [...piSessions.keys()] : [piSessionId];
  await Promise.all(
    ids.map(async (id) => {
      const state = piSessions.get(id);
      if (!state) return;
      piSessions.delete(id);
      const deletion = deleteOpenCodeSession(state.opencodeSessionId);
      state.opencodeSessionId = undefined;
      if (state.dirPromise) {
        const dirPromise = state.dirPromise;
        state.dirPromise = undefined;
        const dir = await dirPromise.catch(() => undefined);
        if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
      await deletion;
    }),
  );
  if (piSessionId === undefined) await Promise.all([...pendingSessionDeletions]);
}

/** Forget a broken session so the next turn starts fresh (#75). */
function dropOpencodeSession(state: PiSessionState): void {
  deleteOpenCodeSession(state.opencodeSessionId);
  state.opencodeSessionId = undefined;
  state.modelId = undefined;
  state.toolsKey = undefined;
  state.systemPrompt = undefined;
  state.sentParts = undefined;
}

function serializedTranscriptParts(messages: Message[]): string[] {
  return messages.map(serializeMessage);
}

/**
 * Decide whether the next turn may continue the recorded OpenCode session
 * (#75, #76). Continuation requires the same model, the same serialized
 * tool list and system prompt, and a transcript that extends — never
 * rewrites — the previously sent prefix, with at least one new message.
 */
function continuationDelta(
  state: PiSessionState,
  modelId: string,
  context: Context,
  parts: string[],
): string[] | undefined {
  if (!state.opencodeSessionId) return undefined;
  if (state.modelId !== modelId) return undefined;
  if ((state.toolsKey ?? "") !== serializeTools(context.tools)) return undefined;
  if ((state.systemPrompt ?? "") !== (context.systemPrompt ?? "")) return undefined;
  const sent = state.sentParts ?? [];
  if (sent.length >= parts.length) return undefined;
  for (let index = 0; index < sent.length; index += 1) {
    if (sent[index] !== parts[index]) return undefined;
  }
  return parts.slice(sent.length);
}

function buildContinuationPrompt(deltaParts: string[]): string {
  return [
    "# Continued Pi/OpenCode bridge turn",
    "",
    "This message continues your existing OpenCode session: the Pi system prompt,",
    "tool list, and earlier transcript are already in context. Do not ask for them again.",
    "If you need Pi to run a tool, your entire response must contain only one or more",
    "tool-call blocks separated by whitespace:",
    '<pi_tool_call>{"name":"tool_name","arguments":{}}</pi_tool_call>',
    "Use only exact tool names from the earlier tool list. Never quote markers, explain",
    "them, or wrap them in Markdown fences. If you can answer without a tool, answer normally.",
    "",
    "# New transcript since your last response",
    "",
    deltaParts.join("\n\n---\n\n"),
    "",
    "Now produce the next assistant message for Pi.",
  ].join("\n");
}

async function createTempAgentDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "opencode-pi-"));
  const configDir = join(dir, ".opencode");
  const agentsDir = join(configDir, "agents");
  const pluginsDir = join(configDir, "plugins");
  await mkdir(agentsDir, { recursive: true });
  await mkdir(pluginsDir, { recursive: true });
  // `opencode run` streams an OpenCode compaction summary as reply text, where
  // its quoted markers break the turn. Pi owns compaction, so overflow must
  // surface as an error instead.
  await writeFile(
    join(configDir, "opencode.json"),
    JSON.stringify({ compaction: { auto: false } }),
    "utf8",
  );
  await writeFile(
    join(agentsDir, `${AGENT_ID}.md`),
    `---
description: Pi bridge agent. Pi tool calls are emitted as text markers.
mode: primary
permission:
  "*": ask
---
You are the OpenCode side of a Pi Coding Agent bridge. Do not use OpenCode native tools. Reply in plain text, or emit <pi_tool_call>{"name":"...","arguments":{...}}</pi_tool_call> exactly when the prompt asks you to request a Pi tool.
`,
    "utf8",
  );
  // Zen's free tier requires OpenCode's normal tool declarations to remain in
  // the request. Permission `deny` removes them before inference and is now
  // rejected as a third-party client. Keep declarations intact, but block
  // every native execution before side effects occur. The agent's `ask`
  // permission keeps declarations too, and `opencode run` auto-rejects asks.
  // V2 relies on that permission guard; the legacy plugin only guards V1.
  await writeFile(
    join(pluginsDir, "pi-native-tool-blocker.js"),
    `export const PiNativeToolBlocker = async () => ({
  "tool.execute.before": async (input) => {
    throw new Error("Native OpenCode tool " + input.tool + " is disabled in the Pi bridge. Request the equivalent Pi tool instead: reply with <pi_tool_call>{\\"name\\":\\"tool_name\\",\\"arguments\\":{}}</pi_tool_call> using a tool from the Pi tool list.")
  },
})
`,
    "utf8",
  );
  return dir;
}

export function streamOpenCode(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  return streamOpenCodeAttempt(model, context, options, true);
}

function streamOpenCodeAttempt(
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions | undefined,
  allowRecovery: boolean,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const deadline = Date.now() + resolveTurnTimeoutMs(options?.timeoutMs);

  (async () => {
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: emptyUsage(),
      stopReason: "stop",
      timestamp: Date.now(),
    };

    let tempDir: string | undefined;
    let prompt = "";
    let accumulatedText = "";
    let accumulatedThinking = "";
    let stderr = "";
    let stdoutRemainder = "";
    let capturedSessionId: string | undefined;
    let opencodeToolUse: string | undefined;
    let recoverableFailure: Error | undefined;
    let toolCallFailure: Extract<ToolCallParseResult, { ok: false }> | undefined;
    // Text after the last blocked native call shows whether the model recovered in-run.
    let nativeTextMark = 0;
    let stepNativeCalls: (ParsedToolCall | undefined)[] = [];
    let nativeCalls: ParsedToolCall[] | undefined;
    // Thrown from the event handler so the process runner stops OpenCode.
    const nativeStepEnd = new Error("OpenCode stopped after a translated native step");
    let opencodeError: string | undefined;
    let finishReason: "stop" | "length" = "stop";
    // Per-Pi-session reuse key supplied by Pi core (stable for the life of
    // the Pi session). Without it, every turn runs an isolated fresh
    // session in its own temporary directory.
    const piSessionId =
      typeof options?.sessionId === "string" && options.sessionId
        ? options.sessionId
        : undefined;
    const piState = piSessionId ? getPiSessionState(piSessionId) : undefined;

    try {
      // pi 1.x carries the current prompt and tools in transcript system messages.
      const { messages } = normalizeContext(context);
      context = {
        messages: messages.filter((message) => message.role !== "system"),
        systemPrompt: getCurrentSystemPrompt(messages),
        tools: getCurrentTools(messages),
      };
      const transcriptParts = serializedTranscriptParts(context.messages);
      const allowedToolNames = new Set(
        context.tools?.map((tool) => tool.name) ?? [],
      );
      stream.push({ type: "start", partial: output });
      if (options?.signal?.aborted) throw new Error("Request was aborted");

      // Continuation decision (#75, #76): reuse the recorded OpenCode
      // session only when the model, tools, system prompt, and transcript
      // prefix all still match. Any drift restarts fresh — and the stale
      // session record is deleted so it cannot leak.
      // A payload hook may rewrite the prompt, so its session cannot be continued as a transcript prefix.
      const payloadHook = options?.onPayload;
      let delta = piState && !payloadHook
        ? continuationDelta(piState, model.id, context, transcriptParts)
        : undefined;
      if (piState && piState.opencodeSessionId && delta === undefined) {
        dropOpencodeSession(piState);
      }
      const isContinuation = delta !== undefined;
      prompt = isContinuation
        ? buildContinuationPrompt(delta)
        : buildPrompt(context);
      const sentMessages = isContinuation
        ? context.messages.slice(transcriptParts.length - delta.length)
        : context.messages;

      const sessionDir = piState
        ? await ensurePiSessionDir(piState)
        : await createTempAgentDir().then((dir) => {
            tempDir = dir;
            return dir;
          });
      if (options?.signal?.aborted) throw new Error("Request was aborted");
      const projectDirs = [sessionDir, await realpath(sessionDir).catch(() => sessionDir)];
      const images = imageContentsForModel(
        sentMessages,
        model.input.includes("image"),
      );
      const imagePaths = await writeImageFiles(images, sessionDir);
      if (options?.signal?.aborted) throw new Error("Request was aborted");
      const v2 = await usesV2Cli();
      const requestedReasoning = options?.reasoning as ModelThinkingLevel | undefined;
      const variant = requestedReasoning && requestedReasoning !== "off"
        ? model.thinkingLevelMap?.[requestedReasoning] : undefined;
      const args = [
        "run",
        "-m",
        v2 && typeof variant === "string" && variant.trim() ? `${model.id}#${variant}` : model.id,
        "--agent",
        AGENT_ID,
        "--format",
        "json",
        ...(v2 ? ["--standalone"] : ["--dir", sessionDir]),
      ];
      if (isContinuation && piState?.opencodeSessionId) {
        args.push("--session", piState.opencodeSessionId);
      }
      args.push(...reasoningCliArgs(requestedReasoning, v2 ? undefined : model.thinkingLevelMap));
      for (const path of imagePaths) args.push("--file", path);

      const handleLine = async (line: string) => {
        // Output after a translated native step belongs to a run Pi already ended.
        if (!line.trim() || nativeCalls) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          // Plugins share OpenCode's stdout; keep stray log lines as diagnostics.
          stderr = (stderr + `\n${line}`).slice(-STDERR_LIMIT);
          return;
        }
        const event = objectRecord(parsed);
        const part = objectRecord(event?.part);
        if (!event || typeof event.type !== "string" ||
            (event.part !== undefined && !part)) {
          throw new Error("Invalid OpenCode event envelope");
        }
        await options?.onProviderStreamEvent?.(event, model);

        // Every JSON event carries the OpenCode session ID (#71).
        if (typeof event.sessionID === "string" && event.sessionID) {
          capturedSessionId = event.sessionID;
        } else if (
          typeof part?.sessionID === "string" &&
          part.sessionID
        ) {
          capturedSessionId = part.sessionID;
        }

        if (event.type === "text" || event.type === "reasoning") {
          if (typeof part?.text !== "string") throw new Error("Invalid OpenCode event text");
          if (event.type === "text") accumulatedText += part.text;
          else accumulatedThinking += part.text;
          return;
        }

        if (event.type === "step_finish") {
          if (/length|max.?tokens/i.test(String(part?.reason ?? ""))) {
            finishReason = "length";
          }
          const tokens = objectRecord(part?.tokens);
          if (tokens) {
            const cache = objectRecord(tokens.cache);
            output.usage.input = Number(tokens.input ?? 0);
            output.usage.output =
              Number(tokens.output ?? 0) + Number(tokens.reasoning ?? 0);
            output.usage.cacheRead = Number(cache?.read ?? 0);
            output.usage.cacheWrite = Number(cache?.write ?? 0);
            output.usage.totalTokens = Number(
              tokens.total ??
                output.usage.input +
                  output.usage.output +
                  output.usage.cacheRead +
                  output.usage.cacheWrite,
            );
            calculateCost(model, output.usage);
          }
          const calls = stepNativeCalls;
          stepNativeCalls = [];
          // A fully translatable step ends the turn like a normal tool-call response.
          // Otherwise OpenCode continues and the model sees the blocker's correction.
          if (calls.length > 0 && calls.every(Boolean)) {
            nativeCalls = calls as ParsedToolCall[];
            throw nativeStepEnd;
          }
          return;
        }

        if (event.type === "tool_use") {
          opencodeToolUse = part?.tool ? String(part.tool) : "unknown";
          nativeTextMark = accumulatedText.length;
          stepNativeCalls.push(translateNativeToolCall(
            opencodeToolUse,
            objectRecord(part?.state)?.input,
            allowedToolNames,
            projectDirs,
          ));
          return;
        }

        if (event.type === "error") {
          const error = objectRecord(event.error);
          const message = objectRecord(error?.data)?.message ?? error?.message ?? part?.message;
          opencodeError =
            typeof message === "string" && message.trim()
              ? message.trim()
              : safeJson(event);
          stderr = (stderr + `\n${opencodeError}`).slice(-STDERR_LIMIT);
        }
      };

      const result = await runOpenCodeProcess(opencodeBin(), args, {
        cwd: v2 ? sessionDir : undefined,
        input: async () => {
          if (!payloadHook) return prompt;
          const replacement = await payloadHook({ prompt }, model);
          if (replacement === undefined) return prompt;
          const payload = objectRecord(replacement);
          if (typeof payload?.prompt !== "string") {
            throw new Error("OpenCode CLI payload must be an object with a string prompt");
          }
          return (prompt = payload.prompt);
        },
        // A CLI subprocess has no HTTP status; 0 marks the non-HTTP transport.
        onStart: () => options?.onResponse?.(
          { status: 0, headers: { "x-pi-transport": "opencode-cli" } },
          model,
        ),
        timeoutMs: resolveTurnTimeoutMs(options?.timeoutMs),
        signal: options?.signal,
        env: {
          ...process.env,
          ...options?.env,
          ...(v2 ? { PWD: sessionDir } : {}),
          OPENCODE_DISABLE_UPDATE_CHECK: "1",
          OPENCODE_CONFIG_DIR: join(sessionDir, ".opencode"),
        },
        onStdout: async (chunk) => {
          stdoutRemainder += chunk;
          const lines = stdoutRemainder.split(/\r?\n/);
          stdoutRemainder = lines.pop() ?? "";
          for (const line of lines) await handleLine(line);
        },
        onEnd: () => handleLine(stdoutRemainder),
      }).catch((error: unknown) => {
        // Stopping OpenCode after a translated native step is a normal end of turn.
        if (error === nativeStepEnd) return undefined;
        throw error;
      });
      if (result) {
        stderr = (stderr + result.stderr).slice(-STDERR_LIMIT);
        if (result.code !== 0) {
          throw new Error(stderr.trim() || `opencode exited with code ${result.code}`);
        }
      }
      if (opencodeError) throw new Error(opencodeError);
      if (opencodeToolUse && !nativeCalls && !accumulatedText.slice(nativeTextMark).trim()) {
        recoverableFailure = new Error(
          `OpenCode could not use the available Pi tools${allowRecovery ? "" : " after one recovery attempt"} (blocked native tool: ${JSON.stringify(opencodeToolUse)}). Retry the request or select another OpenCode model.`,
        );
        throw recoverableFailure;
      }

      const toolCallResult = parseToolCallResponse(
        accumulatedText,
        allowedToolNames,
      );
      if (!toolCallResult.ok) {
        toolCallFailure = toolCallResult;
        throw new Error(
          toolCallRejectionMessage(toolCallResult, allowedToolNames),
        );
      }
      // Unrecoverable marker text is stripped so it never leaks into the
      // visible chat response; remaining prose still displays normally.
      const displayText = toolCallResult.cleanedText ?? accumulatedText;
      let textCalls = toolCallResult.calls;
      // DeepSeek sometimes writes its only calls in the reasoning and replies
      // with nothing, which would end the turn silently.
      if (textCalls.length === 0 && !nativeCalls && !displayText.trim()) {
        let reasoningResult = parseToolCallResponse(
          accumulatedThinking,
          allowedToolNames,
        );
        // Markers stripped with no call surviving were meant as calls too.
        if (reasoningResult.ok && reasoningResult.calls.length === 0 && reasoningResult.cleanedText !== undefined) {
          reasoningResult = { ok: false, rejection: { reason: "malformed_markers" } };
        }
        if (!reasoningResult.ok) {
          toolCallFailure = reasoningResult;
          throw new Error(
            toolCallRejectionMessage(reasoningResult, allowedToolNames),
          );
        }
        textCalls = reasoningResult.calls;
      }
      const toolCalls = [...textCalls, ...(nativeCalls ?? [])];
      if (toolCalls.length === 0 && displayText.trim()) {
        // Check if the model tried to use XML-style tool-use instead of
        // <pi_tool_call> markers — a common mistake with Claude-based models.
        const xmlTool = detectXmlToolUse(displayText);
        if (xmlTool) {
          throw new Error(
            `OpenCode attempted to use its disabled native tool (${JSON.stringify(xmlTool)}). This bridge only accepts <pi_tool_call>{"name":"...","arguments":{}}</pi_tool_call> markers. Do not use XML-style tool-use syntax.`,
          );
        }
      }
      if (toolCalls.length === 0 && !displayText.trim() && accumulatedThinking.trim()) {
        recoverableFailure = new Error(
          `OpenCode returned only reasoning without an answer or Pi tool call${allowRecovery ? "" : " after one recovery attempt"}. Retry the request or select another OpenCode model.`,
        );
        throw recoverableFailure;
      }
      if (
        toolCalls.length === 0 &&
        !displayText.trim() &&
        !accumulatedThinking.trim()
      ) {
        const stderrMsg = stderr.trim();
        if (stderrMsg) {
          throw new Error(
            `OpenCode returned stderr: ${stderrMsg}`,
          );
        }
        // The model may have emitted text events with empty strings, or
        // may have produced reasoning-only output that was not captured
        // as assistant text. Provide a clearer diagnostic.
        const rawTextPreview = accumulatedText
          ? `raw text length=${accumulatedText.length} (trimmed to "${accumulatedText.slice(0, 80).replace(/\n/g, " ")}")`
          : "no text events received";
        const rawThinkingPreview = accumulatedThinking
          ? `thinking length=${accumulatedThinking.length}`
          : "no thinking output";
        throw new Error(
          `OpenCode returned empty assistant response (${rawTextPreview}; ${rawThinkingPreview}). This can happen with some free models when the prompt is too long, the model times out, or the model is overloaded. Retry the request or select another OpenCode model.`,
        );
      }
      setEstimatedUsage(
        model,
        output,
        prompt,
        accumulatedText + accumulatedThinking,
      );
      // The turn succeeded: record the session for reuse, or delete the
      // one-shot session record so it cannot accumulate (#71, #75).
      // A session holding a blocked native call cannot be continued as a transcript prefix.
      if (piState && !payloadHook && !nativeCalls) {
        piState.opencodeSessionId =
          capturedSessionId ?? piState.opencodeSessionId;
        piState.modelId = model.id;
        piState.toolsKey = serializeTools(context.tools);
        piState.systemPrompt = context.systemPrompt ?? "";
        piState.sentParts = transcriptParts;
      } else {
        if (piState) dropOpencodeSession(piState);
        deleteOpenCodeSession(capturedSessionId);
      }

      if (accumulatedThinking && requestedReasoning && requestedReasoning !== "off") {
        const thinkingIndex = output.content.length;
        output.content.push({ type: "thinking", thinking: accumulatedThinking });
        stream.push({
          type: "thinking_start",
          contentIndex: thinkingIndex,
          partial: output,
        });
        stream.push({
          type: "thinking_delta",
          contentIndex: thinkingIndex,
          delta: accumulatedThinking,
          partial: output,
        });
        stream.push({
          type: "thinking_end",
          contentIndex: thinkingIndex,
          content: accumulatedThinking,
          partial: output,
        });
      }

      if (toolCalls.length > 0) {
        output.stopReason = "toolUse";
        for (const call of toolCalls) {
          const toolCall: ToolCall = {
            type: "toolCall",
            id: `opencode_pi_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            name: call.name,
            arguments: call.arguments as ToolCall["arguments"],
          };
          const contentIndex = output.content.length;
          output.content.push(toolCall);
          stream.push({
            type: "toolcall_start",
            contentIndex,
            partial: output,
          });
          stream.push({
            type: "toolcall_delta",
            contentIndex,
            delta: safeJson(toolCall.arguments),
            partial: output,
          });
          stream.push({
            type: "toolcall_end",
            contentIndex,
            toolCall,
            partial: output,
          });
        }
        stream.push({ type: "done", reason: "toolUse", message: output });
        stream.end();
        return;
      }

      output.stopReason = finishReason;
      if (displayText) {
        const contentIndex = output.content.length;
        output.content.push({ type: "text", text: displayText });
        stream.push({ type: "text_start", contentIndex, partial: output });
        stream.push({
          type: "text_delta",
          contentIndex,
          delta: displayText,
          partial: output,
        });
        stream.push({
          type: "text_end",
          contentIndex,
          content: displayText,
          partial: output,
        });
      }
      stream.push({ type: "done", reason: finishReason, message: output });
      stream.end();
    } catch (error) {
      if (toolCallFailure && toolCallFailure.rejection.reason !== "unavailable_tool" && error instanceof Error) {
        recoverableFailure = error;
        if (!allowRecovery) error.message += " Recovery failed after one attempt.";
      }
      // Any error, timeout, or abort drops the session ID so the next turn
      // starts fresh with the full transcript; the failed session record is
      // deleted best-effort and never fails the turn (#71, #75).
      deleteOpenCodeSession(capturedSessionId);
      if (piState) dropOpencodeSession(piState);
      const remainingMs = deadline - Date.now();
      if (recoverableFailure && error === recoverableFailure && allowRecovery &&
          !options?.signal?.aborted && remainingMs > 0 && (!opencodeToolUse || context.tools?.length)) {
        setEstimatedUsage(model, output, prompt, accumulatedText + accumulatedThinking);
        const correction = [
          toolCallFailure
            ? `Your previous attempt returned a malformed Pi tool call. ${recoverableFailure.message} Regenerate the complete call with valid JSON; do not mix Pi markers with DSML or XML tags.`
            : opencodeToolUse
              ? `Your previous attempt used the disabled OpenCode native tool ${JSON.stringify(opencodeToolUse)}.`
              : "Your previous attempt ended with reasoning only, without an answer or Pi tool call. Provide a final answer or request a Pi tool, not just a plan to act.",
          `Available Pi tools: ${context.tools?.map(tool => tool.name).join(", ") || "none"}.`,
          "Complete the original request using only those Pi tools. Do not call any OpenCode native tool.",
          'Request Pi tools as <pi_tool_call>{"name":"tool_name","arguments":{}}</pi_tool_call> markers, or answer normally if no tool is needed.',
          "If Pi has no grep tool, request a search through Pi bash when it is available instead.",
        ].join("\n");
        // A fresh attempt keeps rejected native calls out of the continued transcript.
        const recovery = streamOpenCodeAttempt(model, {
          ...context,
          messages: [...context.messages, { role: "user", content: correction, timestamp: Date.now() }],
        }, { ...options, timeoutMs: remainingMs }, false);
        for await (const event of recovery) {
          if (event.type === "start") continue;
          const message = event.type === "done" ? event.message : event.type === "error" ? event.error : undefined;
          if (message) {
            for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) {
              message.usage[key] += output.usage[key];
            }
            calculateCost(model, message.usage);
          }
          stream.push(event);
        }
        stream.end();
        return;
      }
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage =
        error instanceof Error ? error.message : String(error);
      // Ensure output.content has text so downstream tools (model-debugger,
      // Pi agent) see real content instead of flagging a "silent failure."
      if (output.content.length === 0) {
        output.content.push({ type: "text", text: `Error: ${output.errorMessage}` });
      }
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    } finally {
      // Only one-shot turns own their directory. Per-Pi-session directories
      // persist for reuse and are removed at session teardown (#74).
      if (tempDir) {
        await rm(tempDir, { recursive: true, force: true }).catch(
          () => undefined,
        );
      }
    }
  })();

  return stream;
}

function providerModel(model: OpenCodeModelInfo) {
  return {
    id: model.id,
    name: `${model.name} (OpenCode CLI)`,
    reasoning: model.reasoning,
    ...(model.thinkingLevelMap
      ? { thinkingLevelMap: model.thinkingLevelMap }
      : {}),
    input: model.image
      ? (["text", "image"] as ("text" | "image")[])
      : (["text"] as ("text" | "image")[]),
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    cost: model.cost,
  };
}

function statusLines(): string[] {
  const lines = [
    `Provider: ${PROVIDER_ID}`,
    `OpenCode binary: ${opencodeBin()}`,
    `OpenCode installed: ${existsSync(opencodeBin()) || opencodeBin() === "opencode" ? "check PATH with /opencode-pi test" : "no"}`,
    `Registered models: ${registeredModels.length}`,
    `Last discovery: ${lastDiscoveryTime ? new Date(lastDiscoveryTime).toLocaleString() : "never"}`,
  ];
  if (lastDiscoveryError)
    lines.push(`Discovery fallback: ${lastDiscoveryError}`);
  lines.push("");
  for (const model of registeredModels) {
    const capabilities = [
      model.reasoning ? "reasoning" : undefined,
      model.image ? "image" : undefined,
    ].filter(Boolean);
    lines.push(
      `  - ${PROVIDER_ID}/${model.id}${capabilities.length > 0 ? ` (${capabilities.join(", ")})` : ""}`,
    );
  }
  lines.push("");
  lines.push(
    "OpenCode login is not required for the bundled free OpenCode models.",
  );
  lines.push(
    "OpenCode tools are disabled; Pi tool use is bridged with prompt-level tool-call markers.",
  );
  lines.push(
    "Run /opencode-pi update to refresh the model list from opencode.",
  );
  return lines;
}

function registerApiHandler(): void {
  registerApiProvider(
    {
      api: API_ID,
      stream: (model, context, options) =>
        streamOpenCode(model, context, options),
      streamSimple: streamOpenCode,
    },
    PROVIDER_ID,
  );
}

export default async function opencodePiExtension(pi: ExtensionAPI) {
  const { models, time } = await discoverModels();
  registeredModels = models;
  lastDiscoveryTime = time;

  pi.registerProvider(PROVIDER_ID, {
    name: "OpenCode CLI",
    baseUrl: "cli:opencode",
    apiKey: "opencode-cli-no-api-key",
    api: API_ID,
    models: registeredModels.map(providerModel),
    streamSimple: streamOpenCode,
  });
  registerApiHandler();

  // Tear down per-Pi-session OpenCode state — project directories and
  // session records — when the Pi session ends for any reason (#74).
  pi.on("session_shutdown", () => cleanupPiSessionState());

  pi.on("session_start", async (_event: any, ctx: any) => {
    const cliStatus = await checkCliStatus();
    if (!cliStatus.ok) {
      const fastPathConfigured = Boolean(configuredModels()?.length);
      const fastPathNote = fastPathConfigured
        ? "OPENCODE_PI_MODELS skipped discovery, so this was not detected at startup. "
        : "";
      ctx.ui.notify(
        `opencode-pi: ${fastPathNote}${setupGuidance(cliStatus.detail ?? cliStatus.summary)}`,
        "warning",
      );
      return;
    }
    ctx.ui.notify(
      `opencode-pi: registered ${registeredModels.length} OpenCode CLI model(s). Use /model and pick ${PROVIDER_ID}.`,
      "info",
    );
    const version = /\d+\.\d+\.\d+/.exec(cliStatus.summary)?.[0];
    if (!version || version.localeCompare(MAX_SUPPORTED_OPENCODE_VERSION, undefined, { numeric: true }) > 0) {
      ctx.ui.notify(
        `opencode-pi: detected OpenCode ${version ?? cliStatus.summary}. This bridge supports OpenCode up to ${MAX_SUPPORTED_OPENCODE_VERSION}. Please install a supported version.`,
        "warning",
      );
    }
    if (lastDiscoveryError) {
      ctx.ui.notify(
        `opencode-pi: model discovery used fallback (${lastDiscoveryError})`,
        "warning",
      );
    }
  });

  pi.registerCommand("opencode-pi", {
    description: "OpenCode CLI bridge status and setup help",
    handler: async (args: string, ctx: any) => {
      const sub = args.trim().split(/\s+/).filter(Boolean)[0] ?? "status";
      if (sub === "status") {
        for (const line of statusLines()) ctx.ui.notify(line, "info");
        return;
      }
      if (sub === "models") {
        for (const model of registeredModels)
          ctx.ui.notify(`${PROVIDER_ID}/${model.id}`, "info");
        ctx.ui.notify(
          `Override with OPENCODE_PI_MODELS="opencode/model-a,opencode/model-b"`,
          "info",
        );
        return;
      }
      if (sub === "test") {
        ctx.ui.notify(
          `Run: pi -p --provider ${PROVIDER_ID} --model ${registeredModels[0]?.id ?? DEFAULT_FREE_MODELS[0]} "Reply with exactly OK"`,
          "info",
        );
        ctx.ui.notify(
          `OpenCode check: ${opencodeBin()} run -m ${registeredModels[0]?.id ?? DEFAULT_FREE_MODELS[0]} --format json "Reply OK"`,
          "info",
        );
        return;
      }
      if (sub === "update") {
        await refreshModels(pi, ctx);
        for (const line of statusLines()) ctx.ui.notify(line, "info");
        return;
      }
      if (sub === "help") {
        ctx.ui.notify(
          "Usage: /opencode-pi [status|models|test|update|help]",
          "info",
        );
        ctx.ui.notify(
          "Set OPENCODE_PI_BIN to override the opencode executable.",
          "info",
        );
        ctx.ui.notify(
          "Set OPENCODE_PI_MODELS to register a custom comma-separated model list.",
          "info",
        );
        return;
      }
      ctx.ui.notify(
        `Unknown /opencode-pi subcommand: ${sub}. Try /opencode-pi help`,
        "warning",
      );
    },
  });
}
