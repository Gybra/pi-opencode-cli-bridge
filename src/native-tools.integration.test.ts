// Runs the real OpenCode CLI against a local OpenAI-compatible fixture that asks
// for native side effects. Needs OpenCode 1.19.0 or 2.2.5: set OPENCODE_PI_INTEGRATION_BIN
// or put `opencode` on PATH. No network access or credentials are used.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBashToolDefinition, createReadToolDefinition, createWriteToolDefinition } from "@earendil-works/pi-coding-agent";
import { validateToolCall } from "@earendil-works/pi-ai";
import type { Api, Model, SimpleStreamOptions, Tool } from "@earendil-works/pi-ai";
import { cleanupPiSessionState } from "./sessions.js";
import { streamOpenCode } from "./stream.js";

const realBin = process.env.OPENCODE_PI_INTEGRATION_BIN || "opencode";
const version = /\d+\.\d+\.\d+/.exec(execFileSync(realBin, ["--version"], { encoding: "utf8" }))?.[0];
const isV2 = version?.startsWith("2.") === true;
const shellTool = isV2 ? "shell" : "bash";

type Recorded = { tools: string[]; toolResults: string[]; messages: string };
type Scenario = "side-effects" | "grep-recovery" | "reasoning-recovery" | "reasoning-answer" | "mixed-dsml" | "invalid-json" | "native-alternative" | "native-no-alternative";

/** OpenAI-compatible SSE fixture for blocked native calls and Pi-tool recovery. */
async function startFixture(scenario: Scenario) {
  const requests: Recorded[] = [];
  const nativeFetches: string[] = [];
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    if (req.url?.startsWith("/native-web-sentinel")) nativeFetches.push(req.url);
    if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
      res.writeHead(404).end();
      return;
    }
    const request = JSON.parse(body) as {
      tools?: { function?: { name?: string } }[];
      messages?: { role: string; content?: unknown }[];
    };
    const tools = (request.tools ?? []).map((tool) => tool.function?.name ?? "");
    const toolResults = (request.messages ?? [])
      .filter((message) => message.role === "tool")
      .map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content));
    const messages = JSON.stringify(request.messages ?? []);
    requests.push({ tools, toolResults, messages });

    const base = { id: "chatcmpl-fixture", object: "chat.completion.chunk", created: 1, model: "model" };
    const send = (choices: unknown[]) => res.write(`data: ${JSON.stringify({ ...base, choices })}\n\n`);
    res.writeHead(200, { "content-type": "text/event-stream" });
    if ((scenario === "native-alternative" || scenario === "native-no-alternative") && tools.includes("webfetch")) {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/native-web-sentinel`;
      if (messages.includes("Your previous attempt used the disabled OpenCode native tool") && messages.includes(url)) {
        const content = scenario === "native-alternative"
          ? `<pi_tool_call>${JSON.stringify({ name: "inspect_document", arguments: { path: url } })}</pi_tool_call>`
          : "No suitable Pi tool can read this page. Please paste the content.";
        send([{ index: 0, delta: { role: "assistant", content }, finish_reason: null }]);
        send([{ index: 0, delta: {}, finish_reason: "stop" }]);
      } else if (toolResults.length === 0) {
        send([{ index: 0, delta: { role: "assistant", tool_calls: [
          { index: 0, id: "call_fetch", type: "function", function: { name: "webfetch", arguments: JSON.stringify({ url, format: "markdown" }) } },
        ] }, finish_reason: null }]);
        send([{ index: 0, delta: {}, finish_reason: "tool_calls" }]);
      } else {
        send([{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: "stop" }]);
      }
    } else if ((scenario === "mixed-dsml" || scenario === "invalid-json") && tools.includes("write")) {
      const content = messages.includes("Your previous attempt returned a malformed Pi tool call")
        ? '<pi_tool_call>{"name":"bash","arguments":{"command":"rg needle ."}}</pi_tool_call>'
        : scenario === "mixed-dsml"
          ? '<pi_tool_call>{"name":"read","arguments":{"path":"fixture.txt"}}</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>'
          : '<pi_tool_call>{"name":"bash","arguments":{"command":"grep REPORT_TOKEN fixture.html}}</pi_tool_call>';
      send([{ index: 0, delta: { role: "assistant", content }, finish_reason: null }]);
      send([{ index: 0, delta: {}, finish_reason: "stop" }]);
    } else if ((scenario === "reasoning-recovery" || scenario === "reasoning-answer") && tools.includes("write")) {
      const delta = scenario === "reasoning-answer"
        ? { role: "assistant", reasoning_content: "Private reasoning from the fixture.", content: "done" }
        : messages.includes("Your previous attempt ended with reasoning only")
          ? { role: "assistant", content: '<pi_tool_call>{"name":"bash","arguments":{"command":"curl -I https://example.com"}}</pi_tool_call>' }
          : { role: "assistant", reasoning_content: "I should use Pi bash to fetch the page. Let me do that." };
      send([{ index: 0, delta, finish_reason: null }]);
      send([{ index: 0, delta: {}, finish_reason: "stop" }]);
    } else if (scenario === "grep-recovery" && tools.includes("grep")) {
      if (messages.includes("Your previous attempt used the disabled OpenCode native tool")) {
        send([{ index: 0, delta: { role: "assistant", content: '<pi_tool_call>{"name":"bash","arguments":{"command":"rg needle ."}}</pi_tool_call>' }, finish_reason: null }]);
        send([{ index: 0, delta: {}, finish_reason: "stop" }]);
      } else if (toolResults.length === 0) {
        send([{ index: 0, delta: { role: "assistant", tool_calls: [
          { index: 0, id: "call_grep", type: "function", function: { name: "grep", arguments: JSON.stringify({ pattern: "needle" }) } },
        ] }, finish_reason: null }]);
        send([{ index: 0, delta: {}, finish_reason: "tool_calls" }]);
      } else {
        send([{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: "stop" }]);
      }
    } else if (tools.includes("write") && toolResults.length === 0) {
      send([{ index: 0, delta: { role: "assistant", tool_calls: [
        { index: 0, id: "call_write", type: "function", function: { name: "write", arguments: JSON.stringify({ [isV2 ? "path" : "filePath"]: "write-sentinel.txt", content: "native write ran" }) } },
        { index: 1, id: "call_bash", type: "function", function: { name: shellTool, arguments: JSON.stringify({ command: "echo native bash ran > bash-sentinel.txt", description: "Write sentinel" }) } },
      ] }, finish_reason: null }]);
      send([{ index: 0, delta: {}, finish_reason: "tool_calls" }]);
    } else {
      send([{ index: 0, delta: { role: "assistant", content: "done" }, finish_reason: null }]);
      send([{ index: 0, delta: {}, finish_reason: "stop" }]);
    }
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return { requests, nativeFetches, port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

function fixtureModel(): Model<Api> {
  return {
    id: "fixture/model", name: "Fixture", api: "opencode-cli-runner", provider: "opencode-cli", baseUrl: "",
    reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 64_000, maxTokens: 4_096,
  };
}

/** Wraps the real CLI: records the project directory and optionally sabotages the blocker plugin. */
function writeWrapper(dir: string, mode: "intact" | "missing" | "failing"): string {
  const wrapper = join(dir, "opencode-wrapper.cjs");
  writeFileSync(wrapper, `#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path"), { spawn } = require("node:child_process");
if (process.argv[2] === "run") {
  const configDir = process.env.OPENCODE_CONFIG_DIR;
  fs.writeFileSync(${JSON.stringify(join(dir, "project-dir"))}, path.dirname(configDir));
  const plugin = path.join(configDir, "plugins", "pi-native-tool-blocker.js");
  if (${JSON.stringify(mode)} === "missing") fs.rmSync(plugin, { force: true });
  if (${JSON.stringify(mode)} === "failing") fs.writeFileSync(plugin, 'export const PiNativeToolBlocker = async () => { throw new Error("blocker init failed") }\\n');
}
const child = spawn(${JSON.stringify(realBin)}, process.argv.slice(2), { stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 1));
`, "utf8");
  chmodSync(wrapper, 0o755);
  return wrapper;
}

function isolatedEnv(home: string, port: number): Record<string, string> {
  return {
    HOME: home,
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_DATA_HOME: join(home, "data"),
    XDG_CACHE_HOME: join(home, "cache"),
    XDG_STATE_HOME: join(home, "state"),
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      share: "disabled",
      small_model: "fixture/model",
      provider: {
        fixture: {
          npm: "@ai-sdk/openai-compatible",
          name: "Fixture",
          options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: "fixture" },
          models: { model: { name: "Fixture", tool_call: true, limit: { context: 64_000, output: 4_096 } } },
        },
      },
    }),
  };
}

test("real OpenCode CLI version matches the pinned integration target", () => {
  assert.ok(version && ["1.19.0", "2.2.5"].includes(version), "set OPENCODE_PI_INTEGRATION_BIN to OpenCode 1.19.0 or 2.2.5");
});

// Pi's real tool schemas, so translated calls are checked against what Pi will validate.
const piTools = [createWriteToolDefinition, createBashToolDefinition]
  .map((create) => create(process.cwd()))
  .map(({ name, description, parameters }) => ({ name, description, parameters })) as unknown as Tool[];

async function runNativeScenario(mode: "intact" | "missing" | "failing", tools: Tool[], scenario: Scenario = "side-effects", reasoning?: "off" | "high") {
  const dir = mkdtempSync(join(tmpdir(), `pi-native-${mode}-`));
  const fixture = await startFixture(scenario);
  const previousBin = process.env.OPENCODE_PI_BIN;
  const sessionId = `pi-native-${mode}-${Date.now()}`;
  const observed: string[] = [];
  process.env.OPENCODE_PI_BIN = writeWrapper(dir, mode);
  try {
    const message = await streamOpenCode(fixtureModel(), {
      messages: [{ role: "user", content: "Use your native tools.", timestamp: 1 }],
      tools,
    }, {
      sessionId,
      timeoutMs: 60_000,
      reasoning: reasoning as SimpleStreamOptions["reasoning"],
      onProviderStreamEvent: event => { observed.push((event as { type: string }).type); },
      env: isolatedEnv(join(dir, "home"), fixture.port),
    }).result();
    const project = readFileSync(join(dir, "project-dir"), "utf8");
    // Declarations stay on the request, and the fixture really asked for both calls.
    const first = fixture.requests.find((request) => request.tools.includes("write"));
    assert.ok(first, "native tool declarations were not sent to the model");
    assert.ok(first.tools.includes(shellTool));
    assert.equal(existsSync(join(project, "write-sentinel.txt")), false, "native write executed");
    assert.equal(existsSync(join(project, "bash-sentinel.txt")), false, "native bash executed");
    assert.equal(fixture.nativeFetches.length, 0, "native webfetch performed an HTTP request");
    return { message, requests: fixture.requests, observed };
  } finally {
    process.env.OPENCODE_PI_BIN = previousBin;
    if (previousBin === undefined) delete process.env.OPENCODE_PI_BIN;
    await cleanupPiSessionState(sessionId);
    await fixture.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const mode of ["intact", "missing", "failing"] as const) {
  test(`native write and bash never run and become Pi calls when the blocker plugin is ${mode}`, { timeout: 90_000 }, async () => {
    const { message } = await runNativeScenario(mode, piTools);
    assert.equal(message.stopReason, "toolUse", message.errorMessage);
    for (const call of message.content) if (call.type === "toolCall") validateToolCall(piTools, call);
    // Parallel native calls arrive in completion order, which is not part of the protocol.
    const calls = message.content
      .flatMap((c) => c.type === "toolCall" ? [{ name: c.name, arguments: c.arguments }] : [])
      .sort((a, b) => a.name.localeCompare(b.name));
    assert.deepEqual(calls, [
      { name: "bash", arguments: { command: "echo native bash ran > bash-sentinel.txt" } },
      { name: "write", arguments: { path: "write-sentinel.txt", content: "native write ran" } },
    ]);
  });
}

test("native grep stays blocked and recovers through Pi bash when Pi grep is unavailable", { timeout: 90_000 }, async () => {
  const tools = piTools.filter(tool => tool.name === "bash");
  const { message, requests } = await runNativeScenario("intact", tools, "grep-recovery");
  assert.equal(message.stopReason, "toolUse", message.errorMessage);
  const calls = message.content.filter(c => c.type === "toolCall");
  assert.equal(calls.length, 1);
  for (const call of calls) validateToolCall(tools, call);
  assert.equal(calls[0]!.name, "bash");
  assert.deepEqual(calls[0]!.arguments, { command: "rg needle ." });
  assert.ok(requests.some(request => request.messages.includes("Available Pi tools: bash")));
  const blocked = requests.flatMap(request => request.toolResults).join("\n");
  assert.match(blocked, /disabled in the Pi bridge|cannot ask the user for permission|rejected|denied/i);
});

for (const reasoning of [undefined, "off", "high"] as const) {
  test(`reasoning-only output recovers with thinking ${reasoning ?? "default"}`, { timeout: 90_000 }, async () => {
    const tools = piTools.filter(tool => tool.name === "bash");
    const { message, requests, observed } = await runNativeScenario("intact", tools, "reasoning-recovery", reasoning);
    assert.equal(message.stopReason, "toolUse", message.errorMessage);
    const calls = message.content.filter(c => c.type === "toolCall");
    assert.equal(calls.length, 1);
    for (const call of calls) validateToolCall(tools, call);
    assert.deepEqual(calls[0]!.arguments, { command: "curl -I https://example.com" });
    assert.equal(calls[0]!.name, "bash");
    assert.equal(requests.filter(request => request.tools.includes("write")).length, 2);
    assert.ok(requests.some(request => request.messages.includes("Your previous attempt ended with reasoning only")));
    assert.ok(observed.includes("reasoning"));
  });
}

test("thinking off captures reasoning internally without displaying it", { timeout: 90_000 }, async () => {
  const { message, requests, observed } = await runNativeScenario("intact", piTools, "reasoning-answer", "off");
  assert.equal(message.stopReason, "stop", message.errorMessage);
  assert.ok(observed.includes("reasoning"), "CLI reasoning was not captured");
  assert.deepEqual(message.content, [{ type: "text", text: "done" }]);
  assert.equal(requests.filter(request => request.tools.includes("write")).length, 1);
});

for (const scenario of ["mixed-dsml", "invalid-json"] as const) {
  test(`malformed ${scenario} output is regenerated without executing the rejected call`, { timeout: 90_000 }, async () => {
    const tools = piTools.filter(tool => tool.name === "bash");
    const { message, requests } = await runNativeScenario("intact", tools, scenario);
    assert.equal(message.stopReason, "toolUse", message.errorMessage);
    const calls = message.content.filter(c => c.type === "toolCall");
    assert.equal(calls.length, 1);
    for (const call of calls) validateToolCall(tools, call);
    assert.equal(calls[0]!.name, "bash");
    assert.deepEqual(calls[0]!.arguments, { command: "rg needle ." });
    assert.equal(requests.filter(request => request.tools.includes("write")).length, 2);
    assert.ok(requests.some(request => request.messages.includes("Your previous attempt returned a malformed Pi tool call")));
  });
}

for (const alternative of [true, false]) {
  test(`blocked native webfetch recovers with ${alternative ? "a schema-compatible Pi alternative" : "a request for page content"}`, { timeout: 90_000 }, async () => {
    const tools: Tool[] = alternative ? [{
      name: "inspect_document",
      description: "Read the full page at the URL supplied in path.",
      parameters: createReadToolDefinition(process.cwd()).parameters,
    }] : [];
    const { message, requests } = await runNativeScenario("intact", tools, alternative ? "native-alternative" : "native-no-alternative");
    assert.equal(message.stopReason, alternative ? "toolUse" : "stop", message.errorMessage);
    assert.equal(requests.filter(request => request.tools.includes("write") && request.toolResults.length === 0).length, 2);
    assert.ok(requests.some(request => request.messages.includes("Your previous attempt used the disabled OpenCode native tool")));
    if (alternative) {
      const calls = message.content.filter(c => c.type === "toolCall");
      assert.equal(calls.length, 1);
      validateToolCall(tools, calls[0]!);
      assert.equal(calls[0]!.name, "inspect_document");
      assert.match(String(calls[0]!.arguments.path), /^http:\/\/127\.0\.0\.1:\d+\/native-web-sentinel$/);
    } else {
      assert.deepEqual(message.content, [{ type: "text", text: "No suitable Pi tool can read this page. Please paste the content." }]);
    }
  });
}

test("without Pi equivalents the model gets the blocker's correction and the run continues", { timeout: 90_000 }, async () => {
  const { message, requests } = await runNativeScenario("intact", []);
  const correction = requests.find((request) => request.toolResults.length > 0)?.toolResults.join("\n") ?? "";
  assert.match(correction, isV2
    ? /cannot ask the user for permission|rejected|denied/i
    : /disabled in the Pi bridge[\s\S]*<pi_tool_call>\{\\?"name\\?":/);
  assert.equal(message.stopReason, "stop", message.errorMessage);
  assert.deepEqual(message.content, [{ type: "text", text: "done" }]);
});
