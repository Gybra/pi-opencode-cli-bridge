import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import test from "node:test";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
  resetApiProviders as clearApiProviders,
  getApiProvider,
} from "@earendil-works/pi-ai/compat";
import { validateToolArguments } from "@earendil-works/pi-ai";
import type {
  Api,
  AssistantMessageEvent,
  Context,
  Message,
  Model,
  Tool,
  ToolCall,
} from "@earendil-works/pi-ai";
import opencodePiExtension, {
  cleanupPiSessionState,
  deleteOpenCodeSession,
  discoverModels,
  imageContentsForModel,
  isActiveModel,
  isFreeModel,
  isToolCallMarkerResponse,
  parseModelCost,
  parseToolCallResponse,
  parseToolCalls,
  parseVerboseModels,
  reasoningCliArgs,
  resolveTurnTimeoutMs,
  streamOpenCode,
  trackedPiSessionCount,
  translateNativeToolCall,
} from "./index.js";

function fakeModel(): Model<Api> {
  return {
    id: "opencode/fake-free",
    name: "Fake",
    api: "opencode-cli-runner",
    provider: "opencode-cli",
    baseUrl: "",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
  };
}

function fakeContext(toolNames: string[] = []): Context {
  return {
    messages: [],
    tools: toolNames.map((name) => ({
      name,
      description: `${name} tool`,
      parameters: {},
    })) as Context["tools"],
  };
}

function fakeEventScript(events: unknown[]): string {
  return `for (const event of ${JSON.stringify(events)}) process.stdout.write(JSON.stringify(event) + "\\n");`;
}

async function collectStreamEvents(
  script: string,
  context: Context,
): Promise<AssistantMessageEvent[]> {
  return withFakeOpenCode(script, async () => {
    const events: AssistantMessageEvent[] = [];
    for await (const event of streamOpenCode(fakeModel(), context)) {
      events.push(event);
    }
    return events;
  });
}

// A fake AbortSignal that reports not-aborted on its first read (mirroring the
// pre-spawn check at the top of streamOpenCode) and aborted on every read
// after that, so it deterministically simulates an abort landing in the
// async gap right after the first check without racing real timers.
function abortAfterFirstCheck(): AbortSignal {
  let calls = 0;
  return {
    get aborted() {
      calls += 1;
      return calls > 1;
    },
    addEventListener() {},
    removeEventListener() {},
  } as unknown as AbortSignal;
}

// Same idea as abortAfterFirstCheck, but reports not-aborted for the first
// two reads (the pre-spawn check and the recheck after createTempAgentDir)
// and aborted from the third read onward, so it deterministically lands the
// abort in the async gap right after writeImageFiles instead.
function abortAfterSecondCheck(): AbortSignal {
  let calls = 0;
  return {
    get aborted() {
      calls += 1;
      return calls > 2;
    },
    addEventListener() {},
    removeEventListener() {},
  } as unknown as AbortSignal;
}

// process.env values are coerced to strings, so `process.env.X = undefined`
// sets it to the literal string "undefined" instead of clearing it. Restore
// via delete when the original value was unset.
function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

async function withFakeOpenCode<T>(
  script: string,
  run: () => Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "opencode-pi-fake-bin-"));
  const binPath = join(dir, "opencode-fake.js");
  writeFileSync(binPath, `#!/usr/bin/env node\n${script}`, "utf8");
  chmodSync(binPath, 0o755);

  const previousBin = process.env.OPENCODE_PI_BIN;
  process.env.OPENCODE_PI_BIN = binPath;
  try {
    return await run();
  } finally {
    restoreEnv("OPENCODE_PI_BIN", previousBin);
    rmSync(dir, { recursive: true, force: true });
  }
}

function imageContext(mimeType: string, data: string): Context {
  return {
    messages: [
      {
        role: "user",
        content: [{ type: "image", mimeType, data }],
        timestamp: 1,
      },
    ],
  };
}

async function invalidImageResult(
  mimeType: string,
  data: string,
): Promise<{ message: Awaited<ReturnType<ReturnType<typeof streamOpenCode>["result"]>>; spawned: boolean }> {
  const sentinelDir = mkdtempSync(join(tmpdir(), "opencode-pi-sentinel-"));
  const sentinelPath = join(sentinelDir, "ran.marker");
  try {
    const message = await withFakeOpenCode(
      `const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(sentinelPath)}, "ran");
process.stdout.write(JSON.stringify({ type: "text", part: { text: "ok" } }) + "\\n");
`,
      () =>
        streamOpenCode(
          { ...fakeModel(), input: ["text", "image"] },
          imageContext(mimeType, data),
        ).result(),
    );
    return { message, spawned: existsSync(sentinelPath) };
  } finally {
    rmSync(sentinelDir, { recursive: true, force: true });
  }
}

test("parseVerboseModels normalizes capabilities, limits, and variants", () => {
  const output = `opencode/vision-reasoner-free
{
  "id": "vision-reasoner-free",
  "name": "Vision Reasoner",
  "cost": { "input": 99, "output": 99 },
  "limit": { "context": 200000, "output": 32000 },
  "capabilities": {
    "reasoning": true,
    "input": { "text": true, "image": true }
  },
  "variants": {
    "none": { "reasoningEffort": "none" },
    "low": { "reasoningEffort": "low" },
    "high": { "reasoningEffort": "high" },
    "max": { "reasoningEffort": "max" }
  }
}
opencode/text-free
{
  "id": "text-free",
  "name": "Text {Free}",
  "limit": { "context": 64000, "output": 4096 },
  "capabilities": {
    "reasoning": false,
    "input": { "text": true, "image": false }
  },
  "variants": {}
}
`;

  assert.deepEqual(parseVerboseModels(output), [
    {
      id: "opencode/vision-reasoner-free",
      name: "Vision Reasoner",
      reasoning: true,
      image: true,
      contextWindow: 200000,
      maxTokens: 32000,
      cost: { input: 99, output: 99, cacheRead: 0, cacheWrite: 0 },
      costFromMetadata: true,
      thinkingLevelMap: {
        off: "none",
        minimal: null,
        low: "low",
        medium: null,
        high: "high",
        xhigh: "max",
      },
    },
    {
      id: "opencode/text-free",
      name: "Text {Free}",
      reasoning: false,
      image: false,
      contextWindow: 64000,
      maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
  ]);
});

test("parseVerboseModels maps an OpenCode off variant to Pi off", () => {
  const output = `opencode/reasoner-free
{
  "capabilities": { "reasoning": true },
  "variants": { "off": {}, "medium": {} }
}
`;

  assert.deepEqual(parseVerboseModels(output)[0]?.thinkingLevelMap, {
    off: "off",
    minimal: null,
    low: null,
    medium: "medium",
    high: null,
    xhigh: null,
  });
});

test("reasoningCliArgs respects off, selected levels, and provider defaults", () => {
  const map = { off: "none", low: "low" } as const;

  assert.deepEqual(reasoningCliArgs("off", map), []);
  assert.deepEqual(reasoningCliArgs("low", map), [
    "--thinking",
    "--variant",
    "low",
  ]);
  assert.deepEqual(reasoningCliArgs(undefined, map), []);
  assert.deepEqual(reasoningCliArgs("high", map), ["--thinking"]);
});

test("imageContentsForModel omits historical images for text-only models", () => {
  const historicalImage = {
    type: "image" as const,
    mimeType: "image/png",
    data: "AAAA",
  };
  const messages: Message[] = [
    {
      role: "user",
      content: [historicalImage],
      timestamp: 1,
    },
    {
      role: "user",
      content: "Continue without re-sending the old image",
      timestamp: 2,
    },
  ];

  assert.deepEqual(imageContentsForModel(messages, false), []);
  assert.deepEqual(imageContentsForModel(messages, true), [historicalImage]);
});

test("parseVerboseModels skips malformed metadata and uses safe defaults", () => {
  const output = `opencode/broken-free
{not json}
opencode/custom-free
{
  "capabilities": { "reasoning": true, "input": {} },
  "variants": {}
}
`;

  assert.deepEqual(parseVerboseModels(output), [
    {
      id: "opencode/custom-free",
      name: "OpenCode custom-free",
      reasoning: true,
      image: false,
      contextWindow: 128000,
      maxTokens: 16384,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      thinkingLevelMap: {
        minimal: null,
        low: null,
        medium: null,
        high: null,
        xhigh: null,
      },
    },
  ]);
});

test("parseToolCalls accepts complete marker-only responses", () => {
  const response = `
<pi_tool_call>{"name":"read","arguments":{"path":"README.md"}}</pi_tool_call>
<pi_tool_call>{"name":"bash","arguments":{"command":"pwd"}}</pi_tool_call>
`;

  assert.deepEqual(parseToolCalls(response, new Set(["read", "bash"])), [
    { name: "read", arguments: { path: "README.md" } },
    { name: "bash", arguments: { command: "pwd" } },
  ]);
});

test("parseToolCallResponse keeps valid calls and strips malformed sibling markers", () => {
  const response =
    '<pi_tool_call>{"name":"read","arguments":{"path":"README.md"}}</pi_tool_call>' +
    "<pi_tool_call>{not json}</pi_tool_call>";

  assert.deepEqual(parseToolCallResponse(response, new Set(["read"])), {
    ok: true,
    calls: [{ name: "read", arguments: { path: "README.md" } }],
    cleanedText:
      '<pi_tool_call>{"name":"read","arguments":{"path":"README.md"}}</pi_tool_call>',
  });
});

test("parseToolCallResponse rejects when every marker payload is invalid", () => {
  const response = `<pi_tool_call>{not json}</pi_tool_call>`;

  assert.deepEqual(parseToolCallResponse(response, new Set(["read"])), {
    ok: false,
    rejection: { reason: "invalid_payload" },
  });
});

test("parseToolCallResponse rejects all calls when any candidate has invalid arguments", () => {
  const response = `<pi_tool_call>[
    {"name":"read","arguments":{"path":"README.md"}},
    {"name":"read","arguments":[]}
  ]</pi_tool_call>`;

  assert.deepEqual(parseToolCallResponse(response, new Set(["read"])), {
    ok: false,
    rejection: { reason: "invalid_payload" },
  });
});

test("parseToolCalls supports nested function calls and JSON-string arguments", () => {
  const response = `<pi_tool_call>{"tool_calls":[{"type":"function","function":{"name":"read","arguments":"{\\"path\\":\\"src/index.ts\\"}"}}]}</pi_tool_call>`;

  assert.deepEqual(parseToolCalls(response, new Set(["read"])), [
    { name: "read", arguments: { path: "src/index.ts" } },
  ]);
});

test("parseToolCalls repairs unescaped quotes emitted inside argument strings", () => {
  const response = `<pi_tool_call>{"name":"bash","arguments":{"command":"git status && echo "---" && printf "%s" done"}}</pi_tool_call>`;

  assert.deepEqual(parseToolCalls(response, new Set(["bash"])), [
    {
      name: "bash",
      arguments: {
        command: 'git status && echo "---" && printf "%s" done',
      },
    },
  ]);
});

test("parseToolCallResponse distinguishes plain text from malformed marker attempts", () => {
  // Plain text without markers returns empty calls (ok=true)
  assert.deepEqual(
    parseToolCallResponse('{"name":"bash","arguments":{"command":"pwd"}}'),
    { ok: true, calls: [] },
  );
  // Lenient parser: prose before/after valid markers is extracted
  assert.deepEqual(
    parseToolCallResponse(
      'Example: <pi_tool_call>{"name":"bash","arguments":{"command":"pwd"}}</pi_tool_call>',
    ),
    { ok: true, calls: [{ name: "bash", arguments: { command: "pwd" } }] },
  );
  // Some models JSON-encode their entire text response.
  assert.deepEqual(
    parseToolCallResponse(
      '"<pi_tool_call>{\\"name\\":\\"bash\\",\\"arguments\\":{}}</pi_tool_call>"',
    ),
    { ok: true, calls: [{ name: "bash", arguments: {} }] },
  );
});

test("parseToolCallResponse accepts bounded closing-tag variants", () => {
  const closers = [
    "</ pi_tool_call>",
    "</pi-tool-call>",
    "</pi_tool_calls>",
    "</pi_tool_call >",
    "</PI_TOOL_CALL>",
  ];

  for (const closer of closers) {
    assert.deepEqual(
      parseToolCallResponse(
        `<pi_tool_call>{"name":"bash","arguments":{}}${closer}`,
        new Set(["bash"]),
      ),
      { ok: true, calls: [{ name: "bash", arguments: {} }] },
    );
  }
});

test("parseToolCallResponse recovers a complete JSON payload without a closing tag", () => {
  assert.deepEqual(
    parseToolCallResponse(
      '<pi_tool_call>{"name":"bash","arguments":{"command":"pwd"}}',
      new Set(["bash"]),
    ),
    {
      ok: true,
      calls: [{ name: "bash", arguments: { command: "pwd" } }],
    },
  );
});

test("parseToolCallResponse degrades unrecoverable markers to stripped plain text", () => {
  const responses = [
    '<pi_tool_call>{"name":"bash","arguments":{"command":"pwd"}',
    '<pi_tool_call>{"name":"bash","arguments":{}} trailing prose',
    '<pi_tool_call>{"name":"bash","arguments":{}}</tool_call>',
    '<pi_tool_call>{"name":"bash","arguments":{}}<pi_tool_call>',
  ];

  for (const response of responses) {
    // No hard failure: the marker text is stripped and the turn continues
    // as a plain-text response instead of erroring the whole stream (#39).
    assert.deepEqual(parseToolCallResponse(response, new Set(["bash"])), {
      ok: true,
      calls: [],
      cleanedText: "",
    });
  }
});

test("parseToolCallResponse keeps valid calls when a truncated marker precedes them", () => {
  const response =
    'Let me check. <pi_tool_call>{"name":"bash","argum' +
    '<pi_tool_call>{"name":"read","arguments":{"path":"README.md"}}</pi_tool_call>';

  assert.deepEqual(parseToolCallResponse(response, new Set(["read", "bash"])), {
    ok: true,
    calls: [{ name: "read", arguments: { path: "README.md" } }],
    cleanedText:
      'Let me check. <pi_tool_call>{"name":"read","arguments":{"path":"README.md"}}</pi_tool_call>',
  });
});

test("parseToolCallResponse rejects tool names absent from the current context", () => {
  const response = `<pi_tool_call>{"name":"bash","arguments":{"command":"pwd"}}</pi_tool_call>`;
  assert.deepEqual(parseToolCallResponse(response, new Set(["read"])), {
    ok: false,
    rejection: { reason: "unavailable_tool", toolName: "bash" },
  });
});

// Captured from a real DeepSeek v4.1 Flash reply that ignored the markers.
const dsmlResponse = [
  "Let me check.",
  "<｜｜DSML｜｜tool_calls>",
  '<｜｜DSML｜｜invoke name="bash">',
  '<｜｜DSML｜｜parameter name="command" string="true">echo "a < b" && ls</｜｜DSML｜｜parameter>',
  '<｜｜DSML｜｜parameter name="timeout">120</｜｜DSML｜｜parameter>',
  "</｜｜DSML｜｜invoke>",
  '<｜｜DSML｜｜invoke name="read">',
  '<｜｜DSML｜｜parameter name="path" string="true">src/index.ts</｜｜DSML｜｜parameter>',
  '<｜｜DSML｜｜parameter name="offset">1</｜｜DSML｜｜parameter>',
  "</｜｜DSML｜｜invoke>",
  "</｜｜DSML｜｜tool_calls>",
].join("\n");

test("parseToolCallResponse converts DeepSeek DSML tool calls into Pi calls", () => {
  assert.deepEqual(parseToolCalls(dsmlResponse, new Set(["bash", "read"])), [
    { name: "bash", arguments: { command: 'echo "a < b" && ls', timeout: 120 } },
    { name: "read", arguments: { path: "src/index.ts", offset: 1 } },
  ]);

  const singleBar =
    '<｜DSML｜function_calls><｜DSML｜invoke name="read"><｜DSML｜parameter name="path" string="false">"a.md"</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜function_calls>';
  assert.deepEqual(parseToolCalls(singleBar, new Set(["read"])), [
    { name: "read", arguments: { path: "a.md" } },
  ]);
});

test("parseToolCallResponse keeps DSML and marker calls in response order", () => {
  const write = '<pi_tool_call>{"name":"write","arguments":{"path":"a.md","content":"x"}}</pi_tool_call>';
  const read =
    '<｜DSML｜tool_calls><｜DSML｜invoke name="read"><｜DSML｜parameter name="path" string="true">a.md</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜tool_calls>';
  const tools = new Set(["read", "write"]);
  assert.deepEqual(parseToolCalls(write + read, tools).map((call) => call.name), ["write", "read"]);
  assert.deepEqual(parseToolCalls(read + write, tools).map((call) => call.name), ["read", "write"]);
  assert.deepEqual(parseToolCalls(`\n  ${read}\n${write}`, tools).map((call) => call.name), ["read", "write"]);
});

test("parseToolCallResponse leaves marker text inside DSML arguments untouched", () => {
  const command = "rg '<pi_tool_call>' src/index.ts";
  const response =
    `<｜DSML｜tool_calls><｜DSML｜invoke name="bash"><｜DSML｜parameter name="command" string="true">${command}</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜tool_calls>`;
  assert.deepEqual(parseToolCalls(response, new Set(["bash"])), [
    { name: "bash", arguments: { command } },
  ]);
});

test("parseToolCallResponse leaves DSML text inside marker arguments untouched", () => {
  const calls = [
    { name: "bash", arguments: { command: "rg '<｜DSML｜invoke' src/index.ts" } },
    { name: "write", arguments: { path: "fixture.txt", content: dsmlResponse } },
  ];
  const response = calls.map((call) => `<pi_tool_call>${JSON.stringify(call)}</pi_tool_call>`).join("\n");
  assert.deepEqual(parseToolCalls(response, new Set(["bash", "write"])), calls);
});

test("parseToolCallResponse rejects a complete DSML block followed by an unclosed one", () => {
  const unclosed = dsmlResponse.split("\n").slice(1, 4).join("\n");
  assert.deepEqual(parseToolCallResponse(`${dsmlResponse}\n${unclosed}`, new Set(["bash", "read"])), {
    ok: false,
    rejection: { reason: "incomplete_dsml" },
  });
});

test("parseToolCallResponse treats tool syntax as prose when the turn has no tools", () => {
  // A compaction summary of DSML work quotes both syntaxes; it has no tools to call.
  const summary = `Fixed \`<｜DSML｜invoke\` parsing.\n${dsmlResponse}\n<pi_tool_call>{"name":"...","arguments":{}}</pi_tool_call>`;
  assert.deepEqual(parseToolCallResponse(summary, new Set()), { ok: true, calls: [] });
});

test("parseToolCallResponse rejects DSML calls to tools absent from the current context", () => {
  assert.deepEqual(parseToolCallResponse(dsmlResponse, new Set(["read"])), {
    ok: false,
    rejection: { reason: "unavailable_tool", toolName: "bash" },
  });
});

test("parseToolCalls ignores marker-like text embedded inside JSON string arguments", () => {
  const response = `<pi_tool_call>{"name":"bash","arguments":{"command":"echo '</pi_tool_call>'"}}</pi_tool_call>`;

  assert.deepEqual(parseToolCalls(response, new Set(["bash"])), [
    { name: "bash", arguments: { command: "echo '</pi_tool_call>'" } },
  ]);
});

test("isToolCallMarkerResponse detects a marker followed by trailing prose", () => {
  const response = `<pi_tool_call>{"name":"bash","arguments":{"command":"pwd"}}</pi_tool_call> thanks!`;
  assert.equal(isToolCallMarkerResponse(response), true);
});

test("isToolCallMarkerResponse detects leading prose followed by a marker", () => {
  const response = `Sure, one moment: <pi_tool_call>{"name":"bash","arguments":{"command":"pwd"}}</pi_tool_call>`;
  assert.equal(isToolCallMarkerResponse(response), true);
});

test("isToolCallMarkerResponse is false for plain text with no marker syntax", () => {
  assert.equal(isToolCallMarkerResponse("Sure, here is the answer."), false);
});

test("isToolCallMarkerResponse is false for a lone closing marker with no opening marker", () => {
  const response =
    "The bridge closes tool calls with a literal `</pi_tool_call>` tag.";
  assert.equal(isToolCallMarkerResponse(response), false);
});

test("streamOpenCode emits Pi tool-call events and a toolUse result", async () => {
  const marker =
    '<pi_tool_call>{"name":"read","arguments":{"path":"README.md"}}</pi_tool_call>';
  const events = await collectStreamEvents(
    fakeEventScript([{ type: "text", part: { text: marker } }]),
    fakeContext(["read"]),
  );

  assert.deepEqual(
    events.map((event) => event.type),
    ["start", "toolcall_start", "toolcall_delta", "toolcall_end", "done"],
  );
  const started = events.find((event) => event.type === "toolcall_start");
  const startedCall = started?.partial.content[started.contentIndex];
  assert.equal(startedCall?.type, "toolCall");

  const delta = events.find((event) => event.type === "toolcall_delta");
  assert.equal(delta?.contentIndex, started?.contentIndex);
  assert.match(delta?.delta ?? "", /"path": "README\.md"/);

  const completed = events.find((event) => event.type === "toolcall_end");
  assert.equal(completed?.contentIndex, started?.contentIndex);
  assert.equal(completed?.toolCall.name, "read");
  assert.deepEqual(completed?.toolCall.arguments, { path: "README.md" });
  assert.match(completed?.toolCall.id ?? "", /^opencode_pi_/);
  if (startedCall?.type === "toolCall") {
    assert.equal(startedCall.id, completed?.toolCall.id);
    assert.equal(startedCall.name, completed?.toolCall.name);
  }

  const done = events.at(-1);
  assert.equal(done?.type, "done");
  if (done?.type !== "done") return;
  assert.equal(done.reason, "toolUse");
  assert.equal(done.message.stopReason, "toolUse");
  assert.deepEqual(done.message.content, [completed?.toolCall]);
});

test("streamOpenCode accepts repaired tool JSON alongside thinking output", async () => {
  const marker = `<pi_tool_call>{"name":"bash","arguments":{"command":"git status && echo "---" && git log -1"}}</pi_tool_call>`;
  const events = await collectStreamEvents(
    fakeEventScript([
      { type: "reasoning", part: { text: "I should inspect the repository." } },
      { type: "text", part: { text: marker } },
    ]),
    fakeContext(["bash"]),
  );

  assert.deepEqual(
    events.map((event) => event.type),
    [
      "start",
      "thinking_start",
      "thinking_delta",
      "thinking_end",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_end",
      "done",
    ],
  );
  const completed = events.find((event) => event.type === "toolcall_end");
  assert.deepEqual(completed?.toolCall.arguments, {
    command: 'git status && echo "---" && git log -1',
  });
});

test("streamOpenCode diagnoses invalid markers before emitting any tool call", async () => {
  // With the lenient parser, prose around valid markers is extracted.
  // Only truly invalid payloads (bad JSON, missing fields) produce errors.
  const cases = [
    {
      // Valid JSON but missing "arguments" field
      text: '<pi_tool_call>{"name":"read"}</pi_tool_call>',
      diagnostic:
        'OpenCode returned an invalid Pi tool-call payload. Each marker must contain valid JSON with a non-empty string "name" and object "arguments".',
    },
    {
      // Valid JSON but "arguments" is not an object
      text: '<pi_tool_call>{"name":"read","arguments":"not-an-object"}</pi_tool_call>',
      diagnostic:
        'OpenCode returned an invalid Pi tool-call payload. Each marker must contain valid JSON with a non-empty string "name" and object "arguments".',
    },
  ];

  for (const { text, diagnostic } of cases) {
    const events = await collectStreamEvents(
      fakeEventScript([{ type: "text", part: { text } }]),
      fakeContext(["read"]),
    );

    assert.deepEqual(
      events.map((event) => event.type),
      ["start", "error"],
    );
    const error = events.at(-1);
    assert.equal(error?.type, "error");
    if (error?.type !== "error") continue;
    assert.equal(error.error.errorMessage, diagnostic);
  }
});

test("streamOpenCode keeps valid tool calls alongside a truncated marker", async () => {
  const text =
    '<pi_tool_call>{"name":"bash","argum' +
    '<pi_tool_call>{"name":"read","arguments":{"path":"README.md"}}</pi_tool_call>';
  const events = await collectStreamEvents(
    fakeEventScript([{ type: "text", part: { text } }]),
    fakeContext(["read", "bash"]),
  );

  assert.deepEqual(
    events.map((event) => event.type),
    ["start", "toolcall_start", "toolcall_delta", "toolcall_end", "done"],
  );
  const done = events.at(-1);
  assert.equal(done?.type, "done");
  if (done?.type !== "done") return;
  assert.equal(done.reason, "toolUse");
  const toolCallPart = done.message.content[0];
  assert.equal(toolCallPart.type, "toolCall");
  if (toolCallPart.type !== "toolCall") return;
  assert.equal(toolCallPart.name, "read");
  assert.deepEqual(toolCallPart.arguments, { path: "README.md" });
});

test("streamOpenCode shows remaining prose when all markers are unrecoverable", async () => {
  const events = await collectStreamEvents(
    fakeEventScript([
      { type: "text", part: { text: 'Sorry, I cannot help with that. <pi_tool_call>{"name":' } },
    ]),
    fakeContext(["read"]),
  );

  assert.equal(events.at(-1)?.type, "done");
  const done = events.at(-1);
  if (done?.type !== "done") return;
  assert.notEqual(done.reason, "error");
  const textContent = done.message.content.find(
    (part) => part.type === "text",
  );
  assert.ok(textContent, "should emit remaining prose as text");
  if (textContent?.type !== "text") return;
  assert.ok(!textContent.text.includes("<pi_tool_call>"));
  assert.match(textContent.text, /Sorry, I cannot help/);
});

test("streamOpenCode diagnoses tools unavailable in the current Pi turn", async () => {
  const marker =
    '<pi_tool_call>{"name":"bash","arguments":{"command":"pwd"}}</pi_tool_call>';
  const events = await collectStreamEvents(
    fakeEventScript([{ type: "text", part: { text: marker } }]),
    fakeContext(["read"]),
  );

  assert.deepEqual(
    events.map((event) => event.type),
    ["start", "error"],
  );
  const error = events.at(-1);
  assert.equal(error?.type, "error");
  if (error?.type !== "error") return;
  assert.equal(
    error.error.errorMessage,
    'OpenCode requested unavailable Pi tool "bash". Use only tools available in the current Pi turn: "read".',
  );
});

test("streamOpenCode diagnoses XML-style tool-use as disabled native tool", async () => {
  const xmlResponse = `<tool_call>bash<arg_key>command</arg_key><arg_value>pwd</arg_value>`;
  const events = await collectStreamEvents(
    fakeEventScript([{ type: "text", part: { text: xmlResponse } }]),
    fakeContext(["read"]),
  );
  assert.deepEqual(events.map((e) => e.type), ["start", "error"]);
  const error = events.at(-1);
  assert.equal(error?.type, "error");
  if (error?.type !== "error") return;
  assert.ok(
    error.error?.errorMessage?.includes("disabled native tool"),
    "should diagnose XML-style tool-use as disabled native tool",
  );
  assert.ok(
    error.error?.errorMessage?.includes("<pi_tool_call>"),
    "should mention <pi_tool_call> markers in the diagnostic",
  );
});

test("streamOpenCode hands DeepSeek DSML tool calls to Pi", async () => {
  const message = await withFakeOpenCode(
    fakeEventScript([{ type: "text", part: { text: dsmlResponse } }]),
    () => streamOpenCode(fakeModel(), fakeContext(["bash", "read"])).result(),
  );

  assert.equal(message.stopReason, "toolUse");
  assert.deepEqual(
    message.content.flatMap((part) => (part.type === "toolCall" ? [[part.name, part.arguments]] : [])),
    [
      ["bash", { command: 'echo "a < b" && ls', timeout: 120 }],
      ["read", { path: "src/index.ts", offset: 1 }],
    ],
  );
  assert.ok(!JSON.stringify(message.content).includes("DSML"));
});

test("streamOpenCode hands Pi the calls DeepSeek wrote only in its reasoning", async () => {
  const message = await withFakeOpenCode(
    fakeEventScript([
      { type: "reasoning", part: { text: 'One command is enough. <pi_tool_call>{"name":"bash","arguments":{"command":"ls"}}</pi_tool_call>' } },
    ]),
    () => streamOpenCode(fakeModel(), fakeContext(["bash"])).result(),
  );

  assert.equal(message.stopReason, "toolUse");
  assert.deepEqual(
    message.content.flatMap((part) => (part.type === "toolCall" ? [[part.name, part.arguments]] : [])),
    [["bash", { command: "ls" }]],
  );
});

test("streamOpenCode ignores reasoning drafts when the reply has text", async () => {
  const message = await withFakeOpenCode(
    fakeEventScript([
      { type: "reasoning", part: { text: 'Draft: <pi_tool_call>{"name":"bash","arguments":{"command":"ls"}}</pi_tool_call>' } },
      { type: "text", part: { text: "No command needed." } },
    ]),
    () => streamOpenCode(fakeModel(), fakeContext(["bash"])).result(),
  );

  assert.equal(message.stopReason, "stop");
  assert.ok(!message.content.some((part) => part.type === "toolCall"));
});

test("streamOpenCode diagnoses broken calls in reasoning instead of ending the turn", async () => {
  const message = await withFakeOpenCode(
    fakeEventScript([
      { type: "reasoning", part: { text: dsmlResponse.split("\n").slice(0, 4).join("\n") } },
    ]),
    () => streamOpenCode(fakeModel(), fakeContext(["bash"])).result(),
  );

  assert.equal(message.stopReason, "error");
  assert.match(message.errorMessage ?? "", /incomplete DeepSeek DSML tool call/);
});

test("streamOpenCode diagnoses an unclosed DSML tool call instead of ending the turn", async () => {
  const message = await withFakeOpenCode(
    fakeEventScript([
      { type: "text", part: { text: dsmlResponse.split("\n").slice(0, 4).join("\n") } },
    ]),
    () => streamOpenCode(fakeModel(), fakeContext(["bash"])).result(),
  );

  assert.equal(message.stopReason, "error");
  assert.match(message.errorMessage ?? "", /incomplete DeepSeek DSML tool call.*<pi_tool_call>/);
});

test("streamOpenCode rejects native OpenCode tool use with marker remediation", async () => {
  const message = await withFakeOpenCode(
    fakeEventScript([{ type: "tool_use", part: { tool: "bash" } }]),
    () => streamOpenCode(fakeModel(), fakeContext(["read"])).result(),
  );

  assert.equal(message.stopReason, "error");
  assert.equal(
    message.errorMessage,
    'OpenCode attempted to use its disabled native tool ("bash"). Retry the request; Pi tools must be requested with <pi_tool_call>{"name":"...","arguments":{}}</pi_tool_call> markers.',
  );
});

const piToolDefinitions = [
  createBashToolDefinition, createReadToolDefinition, createWriteToolDefinition,
  createEditToolDefinition, createGrepToolDefinition, createFindToolDefinition,
].map((create) => create(process.cwd()));

/** Pi accepts extra properties, so also reject keys its real schema does not declare. */
function assertPiAccepts(call: ReturnType<typeof translateNativeToolCall>) {
  assert.ok(call, "call was not translated");
  const definition = piToolDefinitions.find((d) => d.name === call.name);
  assert.ok(definition, `no Pi tool named ${call.name}`);
  validateToolArguments(definition as unknown as Tool, { type: "toolCall", id: "t", name: call.name, arguments: call.arguments as ToolCall["arguments"] });
  const declared = Object.keys((definition.parameters as { properties: object }).properties);
  for (const key of Object.keys(call.arguments)) assert.ok(declared.includes(key), `${call.name} has no ${key}`);
  return call;
}

test("translateNativeToolCall maps blocked OpenCode calls onto arguments Pi's real tools accept", () => {
  const all = new Set(["bash", "read", "write", "edit", "grep", "find"]);
  const dirs = ["/tmp/oc-project", "/private/tmp/oc-project"];
  const t = (tool: string, input: unknown, allowed = all) => translateNativeToolCall(tool, input, allowed, dirs);
  const ok = (tool: string, input: unknown) => assertPiAccepts(t(tool, input));
  assert.deepEqual(ok("bash", { command: "ls", description: "List", timeout: 1500 }), { name: "bash", arguments: { command: "ls", timeout: 2 } });
  assert.deepEqual(ok("bash", { command: "ls", workdir: "/tmp/oc-project" }), { name: "bash", arguments: { command: "ls" } });
  assert.deepEqual(ok("read", { filePath: "/private/tmp/oc-project/src/a.ts", offset: 3, limit: 10 }), { name: "read", arguments: { path: "src/a.ts", offset: 3, limit: 10 } });
  assert.deepEqual(ok("read", { filePath: "/etc/hosts" }), { name: "read", arguments: { path: "/etc/hosts" } });
  assert.deepEqual(ok("read", { filePath: "/tmp/oc-project-other/a.ts" }), { name: "read", arguments: { path: "/tmp/oc-project-other/a.ts" } });
  assert.deepEqual(ok("write", { filePath: "/tmp/oc-project/n.txt", content: "x" }), { name: "write", arguments: { path: "n.txt", content: "x" } });
  assert.deepEqual(ok("edit", { filePath: "a.ts", oldString: "a", newString: "b" }), { name: "edit", arguments: { path: "a.ts", edits: [{ oldText: "a", newText: "b" }] } });
  assert.deepEqual(ok("grep", { pattern: "x", path: "/tmp/oc-project", include: "*.ts" }), { name: "grep", arguments: { pattern: "x", path: ".", glob: "*.ts" } });
  assert.deepEqual(ok("glob", { pattern: "**/*.ts", path: "src" }), { name: "find", arguments: { pattern: "**/*.ts", path: "src" } });
  // Different semantics, missing Pi tools or malformed input stay untranslated.
  assert.equal(t("edit", { filePath: "a.ts", oldString: "a", newString: "b", replaceAll: true }), undefined);
  assert.equal(t("edit", { filePath: "a.ts", oldString: "", newString: "b" }), undefined);
  assert.equal(t("bash", { command: "ls", workdir: "/elsewhere" }), undefined);
  assert.equal(t("bash", { command: 1 }), undefined);
  assert.equal(t("webfetch", { url: "https://example.com" }), undefined);
  assert.equal(t("bash", { command: "ls" }, new Set(["read"])), undefined);
  assert.equal(t("read", null), undefined);
});

test("translateNativeToolCall recognizes Windows temp-project paths regardless of slashes and case", () => {
  const dirs = ["C:\\Users\\Me\\AppData\\Local\\Temp\\opencode-pi-1"];
  const t = (input: unknown, tool = "read") => translateNativeToolCall(tool, input, new Set(["read", "bash"]), dirs, win32);
  assert.deepEqual(t({ filePath: "c:/users/me/appdata/local/temp/opencode-pi-1/src/a.ts" }), { name: "read", arguments: { path: "src\\a.ts" } });
  assert.deepEqual(t({ filePath: "C:\\Users\\Me\\AppData\\Local\\Temp\\opencode-pi-1\\a.ts" }), { name: "read", arguments: { path: "a.ts" } });
  assert.deepEqual(t({ filePath: "D:/repo/a.ts" }), { name: "read", arguments: { path: "D:/repo/a.ts" } });
  assert.deepEqual(t({ command: "dir", workdir: "C:/Users/Me/AppData/Local/Temp/opencode-pi-1/" }, "bash"), { name: "bash", arguments: { command: "dir" } });
});

test("streamOpenCode turns a translatable native step into Pi tool calls and stops OpenCode", async () => {
  const started = Date.now();
  const message = await withFakeOpenCode(`
const dir = process.argv[process.argv.indexOf("--dir") + 1];
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
emit({ type: "text", part: { text: "Checking." } });
emit({ type: "tool_use", part: { tool: "read", state: { status: "error", input: { filePath: dir + "/src/a.ts" } } } });
emit({ type: "tool_use", part: { tool: "bash", state: { status: "error", input: { command: "npm test", timeout: 60000 } } } });
emit({ type: "step_finish", part: {} });
setTimeout(() => { emit({ type: "text", part: { text: "after rejection" } }); process.exit(0); }, 5000);
`, () => streamOpenCode(fakeModel(), fakeContext(["read", "bash"])).result());
  assert.ok(Date.now() - started < 3000, "OpenCode kept running after the translated step");
  assert.equal(message.stopReason, "toolUse");
  assert.deepEqual(
    message.content.flatMap((c) => c.type === "toolCall" ? [{ name: c.name, arguments: c.arguments }] : []),
    [{ name: "read", arguments: { path: "src/a.ts" } }, { name: "bash", arguments: { command: "npm test", timeout: 60 } }],
  );
});

test("streamOpenCode accepts the model's recovery after an untranslatable native call", async () => {
  const recovered = await withFakeOpenCode(fakeEventScript([
    { type: "tool_use", part: { tool: "webfetch", state: { status: "error", input: { url: "https://x" } } } },
    { type: "step_finish", part: {} },
    { type: "text", part: { text: '<pi_tool_call>{"name":"read","arguments":{"path":"a.ts"}}</pi_tool_call>' } },
  ]), () => streamOpenCode(fakeModel(), fakeContext(["read"])).result());
  assert.equal(recovered.stopReason, "toolUse");
  assert.deepEqual(recovered.content.find((c) => c.type === "toolCall")?.arguments, { path: "a.ts" });

  const unrecovered = await withFakeOpenCode(fakeEventScript([
    { type: "text", part: { text: "Fetching." } },
    { type: "tool_use", part: { tool: "webfetch", state: { status: "error", input: { url: "https://x" } } } },
    { type: "step_finish", part: {} },
  ]), () => streamOpenCode(fakeModel(), fakeContext(["read"])).result());
  assert.equal(unrecovered.stopReason, "error");
  assert.match(unrecovered.errorMessage ?? "", /disabled native tool \("webfetch"\)/);
});

test("session_start warns when OpenCode is not the version the native-tool guard was verified with", async () => {
  const previousModels = process.env.OPENCODE_PI_MODELS;
  process.env.OPENCODE_PI_MODELS = "custom-model-a";
  try {
    const recorder = sessionStartRecorder();
    const ctx = recordingCtx();
    await withFakeOpenCode('process.stdout.write("opencode 9.9.9\\n");', async () => {
      await opencodePiExtension(recorder.extension);
      await recorder.run(ctx);
    });
    const warnings = ctx.notifications.filter((n) => n.level === "warning");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!.message, /OpenCode 9\.9\.9.*1\.19\.0/);
  } finally {
    restoreEnv("OPENCODE_PI_MODELS", previousModels);
  }
});

test("streamOpenCode diagnoses empty provider output with detailed context", async () => {
  const message = await withFakeOpenCode("", () =>
    streamOpenCode(fakeModel(), fakeContext()).result(),
  );

  assert.equal(message.stopReason, "error");
  assert.ok(
    message.errorMessage?.includes("empty assistant response"),
    "should mention empty assistant response",
  );
  assert.ok(
    message.errorMessage?.includes("no text events received"),
    "should include raw text context",
  );
  assert.ok(
    message.errorMessage?.includes("Retry the request or select another OpenCode model"),
    "should suggest retry",
  );
});

test("streamOpenCode diagnoses empty output with whitespace-only text events", async () => {
  const message = await collectStreamEvents(
    fakeEventScript([
      { type: "text", part: { text: "   \n\n   " } },
    ]),
    fakeContext(["read"]),
  );

  const error = message.find((e) => e.type === "error");
  assert.ok(error, "should emit an error event");
  assert.equal(error?.type, "error");
  if (error?.type !== "error") return;

  assert.ok(
    error.error?.errorMessage?.includes("empty assistant response"),
    "should diagnose whitespace-only text as empty response",
  );
  assert.ok(
    error.error?.errorMessage?.includes("raw text length="),
    "should include raw text length in diagnostic",
  );
});

test("streamOpenCode never spawns opencode when the signal aborts before the child is launched", async () => {
  const sentinelDir = mkdtempSync(join(tmpdir(), "opencode-pi-sentinel-"));
  const sentinelPath = join(sentinelDir, "ran.marker");

  try {
    const message = await withFakeOpenCode(
      `require("node:fs").writeFileSync(${JSON.stringify(sentinelPath)}, "ran");`,
      () =>
        streamOpenCode(fakeModel(), fakeContext(), {
          signal: abortAfterFirstCheck(),
        }).result(),
    );

    assert.equal(message.stopReason, "aborted");
    assert.equal(existsSync(sentinelPath), false);
  } finally {
    rmSync(sentinelDir, { recursive: true, force: true });
  }
});

test("streamOpenCode spawns opencode and returns its output when not aborted", async () => {
  const sentinelDir = mkdtempSync(join(tmpdir(), "opencode-pi-sentinel-"));
  const sentinelPath = join(sentinelDir, "ran.marker");

  try {
    const message = await withFakeOpenCode(
      `require("node:fs").writeFileSync(${JSON.stringify(sentinelPath)}, "ran");
process.stdout.write(JSON.stringify({ type: "text", part: { text: "ok" } }) + "\\n");`,
      () => streamOpenCode(fakeModel(), fakeContext()).result(),
    );

    assert.equal(existsSync(sentinelPath), true);
    assert.equal(message.stopReason, "stop");
  } finally {
    rmSync(sentinelDir, { recursive: true, force: true });
  }
});

test("streamOpenCode never spawns opencode when the signal aborts after image file setup", async () => {
  const sentinelDir = mkdtempSync(join(tmpdir(), "opencode-pi-sentinel-"));
  const sentinelPath = join(sentinelDir, "ran.marker");

  try {
    const message = await withFakeOpenCode(
      `require("node:fs").writeFileSync(${JSON.stringify(sentinelPath)}, "ran");`,
      () =>
        streamOpenCode(fakeModel(), fakeContext(), {
          signal: abortAfterSecondCheck(),
        }).result(),
    );

    assert.equal(message.stopReason, "aborted");
    assert.equal(existsSync(sentinelPath), false);
  } finally {
    rmSync(sentinelDir, { recursive: true, force: true });
  }
});

test("streamOpenCode succeeds when opencode emits reasoning-only output with no text or tool calls", async () => {
  const message = await withFakeOpenCode(
    `process.stdout.write(JSON.stringify({ type: "reasoning", part: { text: "thinking it through" } }) + "\\n");`,
    () => streamOpenCode(fakeModel(), fakeContext()).result(),
  );

  assert.equal(message.stopReason, "stop");
  assert.equal(message.errorMessage, undefined);
  const thinkingBlock = message.content.find(
    (block) => block.type === "thinking",
  );
  assert.equal(thinkingBlock?.thinking, "thinking it through");
  assert.equal(
    message.content.some((block) => block.type === "text"),
    false,
  );
});

test("streamOpenCode returns the expected error outcome when opencode times out", async () => {
  const message = await withFakeOpenCode(
    "setInterval(() => undefined, 1_000);",
    () =>
      streamOpenCode(fakeModel(), fakeContext(), {
        timeoutMs: 30,
      }).result(),
  );

  assert.equal(message.stopReason, "error");
  assert.equal(message.errorMessage, "opencode timed out after 30ms");
});

test("streamOpenCode forwards reasoning settings and image files to opencode", async () => {
  const captureDir = mkdtempSync(join(tmpdir(), "opencode-pi-capture-"));
  const capturePath = join(captureDir, "invocation.json");
  const model: Model<Api> = {
    ...fakeModel(),
    reasoning: true,
    input: ["text", "image"],
    thinkingLevelMap: { high: "max" },
  };

  try {
    const message = await withFakeOpenCode(
      `const fs = require("node:fs");
const args = process.argv.slice(2);
const fileIndex = args.indexOf("--file");
const imagePath = args[fileIndex + 1];
fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({
  args,
  imagePath,
  imageHex: fs.readFileSync(imagePath).toString("hex"),
}));
process.stdout.write(JSON.stringify({ type: "text", part: { text: "ok" } }) + "\\n");`,
      () =>
        streamOpenCode(
          model,
          imageContext("image/png", Buffer.from("image bytes").toString("base64")),
          { reasoning: "high" },
        ).result(),
    );

    const invocation = JSON.parse(readFileSync(capturePath, "utf8")) as {
      args: string[];
      imagePath: string;
      imageHex: string;
    };
    assert.equal(message.stopReason, "stop");
    assert.equal(invocation.args.includes("--pure"), false);
    assert.deepEqual(invocation.args.slice(0, 7), [
      "run",
      "-m",
      "opencode/fake-free",
      "--agent",
      "pi-model",
      "--format",
      "json",
    ]);
    assert.deepEqual(invocation.args.slice(-5), [
      "--thinking",
      "--variant",
      "max",
      "--file",
      invocation.imagePath,
    ]);
    assert.equal(invocation.imagePath.endsWith("pi-images/image-001.png"), true);
    assert.equal(
      invocation.imageHex,
      Buffer.from("image bytes").toString("hex"),
    );
  } finally {
    rmSync(captureDir, { recursive: true, force: true });
  }
});

test("streamOpenCode rejects unsupported image types before provider execution", async () => {
  const { message, spawned } = await invalidImageResult(
    "application/octet-stream",
    "aGVsbG8=",
  );

  assert.equal(message.stopReason, "error");
  assert.equal(
    message.errorMessage,
    "Unsupported image MIME type: application/octet-stream",
  );
  assert.equal(spawned, false);
});

test("streamOpenCode rejects malformed encoded images before provider execution", async () => {
  const { message, spawned } = await invalidImageResult("image/png", "%%%=");

  assert.equal(message.stopReason, "error");
  assert.equal(message.errorMessage, "Invalid base64 data for image 1");
  assert.equal(spawned, false);
});

test("streamOpenCode rejects empty decoded images before provider execution", async () => {
  const { message, spawned } = await invalidImageResult("image/png", "==");

  assert.equal(message.stopReason, "error");
  assert.equal(message.errorMessage, "Empty image data for image 1");
  assert.equal(spawned, false);
});

test("discoverModels bypasses opencode discovery when OPENCODE_PI_MODELS is set", async () => {
  const sentinelDir = mkdtempSync(join(tmpdir(), "opencode-pi-sentinel-"));
  const sentinelPath = join(sentinelDir, "ran.marker");
  const previousModels = process.env.OPENCODE_PI_MODELS;
  process.env.OPENCODE_PI_MODELS = "custom-model-a, opencode/custom-model-b";

  try {
    const { models, error } = await withFakeOpenCode(
      `require("node:fs").writeFileSync(${JSON.stringify(sentinelPath)}, "ran");`,
      () => discoverModels(),
    );

    assert.equal(existsSync(sentinelPath), false);
    assert.equal(error, undefined);
    assert.deepEqual(
      models.map((model) => model.id),
      ["opencode/custom-model-a", "opencode/custom-model-b"],
    );
  } finally {
    restoreEnv("OPENCODE_PI_MODELS", previousModels);
    rmSync(sentinelDir, { recursive: true, force: true });
  }
});

test("discoverModels runs opencode discovery and filters to free models when OPENCODE_PI_MODELS is unset", async () => {
  const previousModels = process.env.OPENCODE_PI_MODELS;
  const previousBin = process.env.OPENCODE_PI_BIN;
  delete process.env.OPENCODE_PI_MODELS;
  const dir = mkdtempSync(join(tmpdir(), "opencode-pi-fake-bin-"));
  const binPath = join(dir, "opencode-fake.js");
  writeFileSync(
    binPath,
    `#!/usr/bin/env node
process.stdout.write([
  "opencode/one-free",
  JSON.stringify({ capabilities: { reasoning: true, input: { image: true } } }),
  "opencode/two-paid",
  JSON.stringify({ capabilities: {} }),
].join("\\n"));
`,
    "utf8",
  );
  chmodSync(binPath, 0o755);
  process.env.OPENCODE_PI_BIN = binPath;

  try {
    const { models, error } = await discoverModels();

    assert.equal(error, undefined);
    assert.deepEqual(
      models.map((model) => model.id),
      ["opencode/one-free"],
    );
  } finally {
    restoreEnv("OPENCODE_PI_BIN", previousBin);
    restoreEnv("OPENCODE_PI_MODELS", previousModels);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("extension registration preserves discovered model capabilities", async () => {
  const previousModels = process.env.OPENCODE_PI_MODELS;
  delete process.env.OPENCODE_PI_MODELS;
  let providerId: string | undefined;
  let providerConfig:
    | Parameters<ExtensionAPI["registerProvider"]>[1]
    | undefined;

  try {
    await withFakeOpenCode(
      `process.stdout.write([
  "opencode/capable-free",
  JSON.stringify({
    name: "Capable Model",
    limit: { context: 196000, output: 24576 },
    capabilities: { reasoning: true, input: { text: true, image: true } },
    variants: { off: {}, low: {}, high: {}, max: {} },
  }),
].join("\\n"));`,
      () =>
        opencodePiExtension({
          registerProvider(
            id: string,
            config: Parameters<ExtensionAPI["registerProvider"]>[1],
          ) {
            providerId = id;
            providerConfig = config;
          },
          on() {},
          registerCommand() {},
        } as unknown as ExtensionAPI),
    );

    assert.equal(providerId, "opencode-cli");
    assert.deepEqual(providerConfig?.models, [
      {
        id: "opencode/capable-free",
        name: "Capable Model (OpenCode CLI)",
        reasoning: true,
        thinkingLevelMap: {
          off: "off",
          minimal: null,
          low: "low",
          medium: null,
          high: "high",
          xhigh: "max",
        },
        input: ["text", "image"],
        contextWindow: 196000,
        maxTokens: 24576,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ]);
  } finally {
    restoreEnv("OPENCODE_PI_MODELS", previousModels);
  }
});

test("extension registration resolves the API handler for inference", async () => {
  const previousModels = process.env.OPENCODE_PI_MODELS;
  delete process.env.OPENCODE_PI_MODELS;

  try {
    await withFakeOpenCode(
      `process.stdout.write("opencode/one-free\\n");`,
      () =>
        opencodePiExtension({
          registerProvider() {},
          on() {},
          registerCommand() {},
        } as unknown as ExtensionAPI),
    );

    const apiProvider = getApiProvider("opencode-cli-runner");
    assert.notEqual(apiProvider, undefined);
    assert.equal(typeof apiProvider?.streamSimple, "function");
    assert.equal(typeof apiProvider?.stream, "function");
  } finally {
    restoreEnv("OPENCODE_PI_MODELS", previousModels);
    clearApiProviders();
  }
});

test("discoverModels with forceDiscovery still enriches configured models from opencode metadata", async () => {
  const previousModels = process.env.OPENCODE_PI_MODELS;
  const previousBin = process.env.OPENCODE_PI_BIN;
  process.env.OPENCODE_PI_MODELS = "custom-reasoner-free";
  const dir = mkdtempSync(join(tmpdir(), "opencode-pi-fake-bin-"));
  const binPath = join(dir, "opencode-fake.js");
  writeFileSync(
    binPath,
    `#!/usr/bin/env node
process.stdout.write([
  "opencode/custom-reasoner-free",
  JSON.stringify({
    capabilities: { reasoning: true, input: { image: true } },
    variants: { off: {}, high: {} },
  }),
].join("\\n"));
`,
    "utf8",
  );
  chmodSync(binPath, 0o755);
  process.env.OPENCODE_PI_BIN = binPath;

  try {
    const { models, error } = await discoverModels({ forceDiscovery: true });

    assert.equal(error, undefined);
    assert.equal(models.length, 1);
    assert.equal(models[0]?.id, "opencode/custom-reasoner-free");
    assert.equal(models[0]?.reasoning, true);
    assert.equal(models[0]?.image, true);
  } finally {
    restoreEnv("OPENCODE_PI_BIN", previousBin);
    restoreEnv("OPENCODE_PI_MODELS", previousModels);
    rmSync(dir, { recursive: true, force: true });
  }
});

type RecordedNotification = { message: string; level?: string };

type NotifyCtx = { ui: { notify: (msg: string, level?: string) => void } };

function sessionStartRecorder() {
  let handler:
    | ((event: unknown, ctx: unknown) => Promise<void>)
    | undefined;
  const extension = {
    registerProvider() {},
    on(event: string, registered: (event: unknown, ctx: unknown) => Promise<void>) {
      if (event === "session_start") handler = registered;
    },
    registerCommand() {},
  };
  return {
    extension: extension as unknown as ExtensionAPI,
    async run(ctx: NotifyCtx) {
      if (!handler) throw new Error("session_start handler not registered");
      await handler({}, ctx);
    },
  };
}

function recordingCtx(): {
  notifications: RecordedNotification[];
  ui: { notify: (msg: string, level?: string) => void };
} {
  const notifications: RecordedNotification[] = [];
  return {
    notifications,
    ui: {
      notify(message: string, level?: string) {
        notifications.push({ message, level });
      },
    },
  };
}

test("session_start warns with setup guidance when the opencode binary is missing", async () => {
  const previousModels = process.env.OPENCODE_PI_MODELS;
  delete process.env.OPENCODE_PI_MODELS;
  const previousBin = process.env.OPENCODE_PI_BIN;
  process.env.OPENCODE_PI_BIN = join(tmpdir(), "opencode-pi-does-not-exist");

  try {
    const recorder = sessionStartRecorder();
    await opencodePiExtension(recorder.extension);

    const ctx = recordingCtx();
    await recorder.run(ctx);

    const warnings = ctx.notifications.filter((n) => n.level === "warning");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!.message, /could not use the local OpenCode CLI/);
    assert.match(warnings[0]!.message, /Reason:/);
    assert.match(warnings[0]!.message, /Install OpenCode/);
    assert.equal(
      ctx.notifications.some((n) => n.level === "info"),
      false,
    );
  } finally {
    restoreEnv("OPENCODE_PI_BIN", previousBin);
    restoreEnv("OPENCODE_PI_MODELS", previousModels);
  }
});

test("session_start flags the OPENCODE_PI_MODELS fast path when the binary is missing", async () => {
  const previousModels = process.env.OPENCODE_PI_MODELS;
  process.env.OPENCODE_PI_MODELS = "custom-model-a";
  const previousBin = process.env.OPENCODE_PI_BIN;
  process.env.OPENCODE_PI_BIN = join(tmpdir(), "opencode-pi-does-not-exist");

  try {
    const recorder = sessionStartRecorder();
    await opencodePiExtension(recorder.extension);

    const ctx = recordingCtx();
    await recorder.run(ctx);

    const warnings = ctx.notifications.filter((n) => n.level === "warning");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!.message, /OPENCODE_PI_MODELS skipped discovery/);
    assert.match(warnings[0]!.message, /could not use the local OpenCode CLI/);
  } finally {
    restoreEnv("OPENCODE_PI_BIN", previousBin);
    restoreEnv("OPENCODE_PI_MODELS", previousModels);
  }
});

test("session_start produces no warning when opencode answers --version", async () => {
  const previousModels = process.env.OPENCODE_PI_MODELS;
  delete process.env.OPENCODE_PI_MODELS;

  try {
    const recorder = sessionStartRecorder();
    const ctx = recordingCtx();
    await withFakeOpenCode(
      `if (process.argv.includes("--version")) {
  process.stdout.write("1.19.0\\n");
  process.exit(0);
}
process.stdout.write([
  "opencode/one-free",
  JSON.stringify({ capabilities: {} }),
].join("\\n"));`,
      async () => {
        await opencodePiExtension(recorder.extension);
        await recorder.run(ctx);
      },
    );

    assert.deepEqual(
      ctx.notifications.filter((n) => n.level === "warning"),
      [],
    );
    const info = ctx.notifications.find((n) => n.level === "info");
    assert.match(info?.message ?? "", /registered \d+ OpenCode CLI model\(s\)/);
  } finally {
    restoreEnv("OPENCODE_PI_MODELS", previousModels);
  }
});

test("parseModelCost reads real input, output, and cache figures", () => {
  assert.deepEqual(
    parseModelCost({
      cost: { input: 10, output: 50, cache: { read: 1, write: 12.5 } },
    }),
    { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  );
});

test("parseModelCost defaults missing or malformed figures to zero", () => {
  assert.deepEqual(parseModelCost({}), {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  });
  assert.deepEqual(
    parseModelCost({
      cost: { input: -5, output: "free", cache: { read: NaN, write: null } },
    }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  );
});

test("parseVerboseModels records status and cost provenance", () => {
  const output = `opencode/paid-model
{
  "cost": { "input": 3, "output": 15, "cache": { "read": 0.3, "write": 3.75 } },
  "status": "active",
  "capabilities": {}
}
opencode/retired-free
{
  "cost": { "input": 0, "output": 0, "cache": { "read": 0, "write": 0 } },
  "status": "deprecated",
  "capabilities": {}
}
`;
  assert.deepEqual(parseVerboseModels(output), [
    {
      id: "opencode/paid-model",
      name: "OpenCode paid-model",
      reasoning: false,
      image: false,
      contextWindow: 128000,
      maxTokens: 16384,
      cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      costFromMetadata: true,
      status: "active",
    },
    {
      id: "opencode/retired-free",
      name: "OpenCode retired-free",
      reasoning: false,
      image: false,
      contextWindow: 128000,
      maxTokens: 16384,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      costFromMetadata: true,
      status: "deprecated",
    },
  ]);
});

test("isFreeModel selects by cost metadata, not the name pattern", () => {
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  // A free model without a -free suffix is picked up via cost metadata.
  assert.equal(
    isFreeModel({ id: "opencode/big-pickle", cost: zero, costFromMetadata: true }),
    true,
  );
  // A paid model keeps its real cost even with a -free-looking name.
  assert.equal(
    isFreeModel({
      id: "opencode/sneaky-free",
      cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
      costFromMetadata: true,
    }),
    false,
  );
  // Without cost metadata the legacy name pattern still applies.
  assert.equal(isFreeModel({ id: "opencode/old-free", cost: zero }), true);
  assert.equal(isFreeModel({ id: "opencode/old-paid", cost: zero }), false);
});

test("isActiveModel excludes non-active statuses and tolerates a missing field", () => {
  assert.equal(isActiveModel("active"), true);
  assert.equal(isActiveModel("Active"), true);
  assert.equal(isActiveModel("deprecated"), false);
  assert.equal(isActiveModel("disabled"), false);
  assert.equal(isActiveModel(undefined), true);
  assert.equal(isActiveModel(null), true);
});

test("discoverModels selects zero-cost models and skips inactive ones", async () => {
  const previousModels = process.env.OPENCODE_PI_MODELS;
  const previousBin = process.env.OPENCODE_PI_BIN;
  delete process.env.OPENCODE_PI_MODELS;
  const dir = mkdtempSync(join(tmpdir(), "opencode-pi-fake-bin-"));
  const binPath = join(dir, "opencode-fake.js");
  writeFileSync(
    binPath,
    `#!/usr/bin/env node
process.stdout.write([
  "opencode/plain-free-name",
  JSON.stringify({
    status: "active",
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    capabilities: {},
  }),
  "opencode/retired-free",
  JSON.stringify({
    status: "deprecated",
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    capabilities: {},
  }),
  "opencode/sneaky-free",
  JSON.stringify({
    status: "active",
    cost: { input: 3, output: 15, cache: { read: 0.3, write: 0 } },
    capabilities: {},
  }),
].join("\\n"));
`,
    "utf8",
  );
  chmodSync(binPath, 0o755);
  process.env.OPENCODE_PI_BIN = binPath;

  try {
    const { models, error } = await discoverModels();

    assert.equal(error, undefined);
    assert.deepEqual(
      models.map((model) => model.id),
      ["opencode/plain-free-name"],
    );
  } finally {
    restoreEnv("OPENCODE_PI_BIN", previousBin);
    restoreEnv("OPENCODE_PI_MODELS", previousModels);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("discoverModels reports real cost for a configured paid model", async () => {
  const previousModels = process.env.OPENCODE_PI_MODELS;
  const previousBin = process.env.OPENCODE_PI_BIN;
  process.env.OPENCODE_PI_MODELS = "opencode/paid-model";
  const dir = mkdtempSync(join(tmpdir(), "opencode-pi-fake-bin-"));
  const binPath = join(dir, "opencode-fake.js");
  writeFileSync(
    binPath,
    `#!/usr/bin/env node
process.stdout.write([
  "opencode/paid-model",
  JSON.stringify({
    status: "active",
    cost: { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } },
    capabilities: {},
  }),
].join("\\n"));
`,
    "utf8",
  );
  chmodSync(binPath, 0o755);
  process.env.OPENCODE_PI_BIN = binPath;

  try {
    const { models, error } = await discoverModels({ forceDiscovery: true });

    assert.equal(error, undefined);
    assert.equal(models.length, 1);
    assert.deepEqual(models[0]?.cost, {
      input: 3,
      output: 15,
      cacheRead: 0.3,
      cacheWrite: 3.75,
    });
  } finally {
    restoreEnv("OPENCODE_PI_BIN", previousBin);
    restoreEnv("OPENCODE_PI_MODELS", previousModels);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("discoverModels falls back to live free model IDs when discovery fails", async () => {
  const previousModels = process.env.OPENCODE_PI_MODELS;
  const previousBin = process.env.OPENCODE_PI_BIN;
  delete process.env.OPENCODE_PI_MODELS;
  const dir = mkdtempSync(join(tmpdir(), "opencode-pi-fake-bin-"));
  const binPath = join(dir, "opencode-fake.js");
  writeFileSync(
    binPath,
    "#!/usr/bin/env node\nprocess.stderr.write('boom');\nprocess.exit(1);\n",
    "utf8",
  );
  chmodSync(binPath, 0o755);
  process.env.OPENCODE_PI_BIN = binPath;

  try {
    const { models, error } = await discoverModels();

    assert.notEqual(error, undefined);
    assert.deepEqual(
      models.map((model) => model.id),
      [
        "opencode/mimo-v2.5-free",
        "opencode/nemotron-3.5-lightning-free",
        "opencode/ling-3.0-flash-fin-free",
        "opencode/big-pickle",
      ],
    );
  } finally {
    restoreEnv("OPENCODE_PI_BIN", previousBin);
    restoreEnv("OPENCODE_PI_MODELS", previousModels);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveTurnTimeoutMs honors Pi timeouts and bounds unbounded turns", () => {
  assert.equal(resolveTurnTimeoutMs(30), 30);
  assert.equal(resolveTurnTimeoutMs(600_000), 600_000);
  assert.equal(resolveTurnTimeoutMs(undefined), 180_000);
  assert.equal(resolveTurnTimeoutMs(0), 180_000);
  assert.equal(resolveTurnTimeoutMs(-5), 180_000);
  assert.equal(resolveTurnTimeoutMs(Number.NaN), 180_000);
  assert.equal(resolveTurnTimeoutMs(Number.POSITIVE_INFINITY), 180_000);
});

test("streamOpenCode detaches the abort listener on the error path", async () => {
  let added = 0;
  let removed = 0;
  const signal = {
    aborted: false,
    addEventListener() {
      added += 1;
    },
    removeEventListener() {
      removed += 1;
    },
  } as unknown as AbortSignal;

  await withFakeOpenCode(
    fakeEventScript([
      { type: "text", part: { text: '<pi_tool_call>{"name":"nope"}</pi_tool_call>' } },
    ]),
    () =>
      streamOpenCode(fakeModel(), fakeContext(["read"]), { signal }).result(),
  );

  assert.equal(added, 1);
  assert.equal(removed, 1);
});

test("streamOpenCode detaches the abort listener on the timeout path", async () => {
  let added = 0;
  let removed = 0;
  const signal = {
    aborted: false,
    addEventListener() {
      added += 1;
    },
    removeEventListener() {
      removed += 1;
    },
  } as unknown as AbortSignal;

  const message = await withFakeOpenCode(
    "setInterval(() => undefined, 1_000);",
    () =>
      streamOpenCode(fakeModel(), fakeContext(), {
        signal,
        timeoutMs: 30,
      }).result(),
  );

  assert.equal(message.stopReason, "error");
  assert.equal(added, 1);
  assert.equal(removed, 1);
});

// A fake `opencode` binary that records every invocation (args + stdin) and
// answers turns with a fixed session ID, so session-reuse tests can assert
// continuation args, delta-only prompts, and directory stability. The
// fire-and-forget `session delete` helper hits the same binary and must not
// pollute the capture log.
function sessionFakeScript(capturePath: string, sessionId: string): string {
  return `const fs = require("node:fs");
if (process.argv.includes("session")) process.exit(0);
let body = "";
process.stdin.on("data", (chunk) => { body += chunk; });
process.stdin.on("end", () => {
  fs.appendFileSync(${JSON.stringify(capturePath)}, JSON.stringify({ args: process.argv.slice(2), stdin: body }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "text", part: { text: "hello" }, sessionID: ${JSON.stringify(sessionId)} }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "step_finish", part: { reason: "stop", tokens: { total: 10, input: 5, output: 5, reasoning: 0, cache: { read: 0, write: 0 } } }, sessionID: ${JSON.stringify(sessionId)} }) + "\\n");
});
`;
}

test("streamOpenCode accepts tool calls from normalized system declarations", { timeout: 3000 }, async () => {
  const message = await withFakeOpenCode(
    fakeEventScript([{ type: "text", part: { text: '<pi_tool_call>{"name":"read","arguments":{"path":"example.txt"}}</pi_tool_call>' } }]),
    () => streamOpenCode(fakeModel(), {
      messages: [
        { role: "system", content: "", toolsAdded: fakeContext(["read"]).tools, timestamp: 0 },
        { role: "user", content: "Read example.txt", timestamp: 1 },
      ],
    }).result(),
  );
  assert.equal(message.stopReason, "toolUse");
  assert.deepEqual(message.content.map((part) => part.type === "toolCall" ? { name: part.name, arguments: part.arguments } : part), [
    { name: "read", arguments: { path: "example.txt" } },
  ]);
});

test("streamOpenCode replays normalized prompt sections and tool changes", { timeout: 3000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-pi-normalized-"));
  const capturePath = join(dir, "invocations.jsonl");
  try {
    const message = await withFakeOpenCode(sessionFakeScript(capturePath, "ses-normalized"), () =>
      streamOpenCode(fakeModel(), {
        messages: [
          {
            role: "system", content: "Base instructions", timestamp: 0,
            sections: { project: "Old project instructions", obsolete: "Obsolete instructions" },
            toolsAdded: fakeContext(["read", "write"]).tools,
          },
          { role: "user", content: "First question", timestamp: 1 },
          {
            role: "system", content: [{ type: "text", text: "Additional instructions" }], timestamp: 2,
            sections: { project: "New project instructions", obsolete: null },
            toolsRemoved: [{ name: "read" }],
          },
          { role: "user", content: "Second question", timestamp: 3 },
        ],
      }).result(),
    );
    assert.equal(message.stopReason, "stop");
    const prompt = readInvocations(capturePath)[0]?.stdin ?? "";
    assert.match(prompt, /Base instructions/);
    assert.match(prompt, /Additional instructions/);
    assert.match(prompt, /New project instructions/);
    assert.doesNotMatch(prompt, /Old project instructions|Obsolete instructions/);
    const tools = JSON.parse(prompt.split("# Available Pi tools\n\n")[1].split("\n\n---\n\n")[0]);
    assert.deepEqual(tools.map((tool: { name: string }) => tool.name), ["write"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("streamOpenCode reports transcript preparation errors without crashing", { timeout: 3000 }, async () => {
  const message = await streamOpenCode(fakeModel(), {
    messages: [{ role: "assistant", content: null } as unknown as Message],
  }).result();
  assert.equal(message.stopReason, "error");
  assert.match(message.errorMessage ?? "", /map/);
});

function readInvocations(capturePath: string): { args: string[]; stdin: string }[] {
  if (!existsSync(capturePath)) return [];
  return readFileSync(capturePath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function userContext(texts: string[], toolNames: string[] = []): Context {
  return {
    messages: texts.map((text, index) => ({
      role: "user" as const,
      content: text,
      timestamp: index + 1,
    })),
    tools: toolNames.map((name) => ({
      name,
      description: `${name} tool`,
      parameters: {},
    })) as Context["tools"],
  };
}

function conversationContext(): Context {
  return {
    messages: [
      { role: "user", content: "first question", timestamp: 1 },
      {
        role: "assistant",
        content: [{ type: "text" as const, text: "hello" }],
        timestamp: 2,
      } as unknown as Context["messages"][number],
      { role: "user", content: "second question", timestamp: 3 },
    ],
  };
}

test("streamOpenCode reuses the session and sends only the transcript delta", async () => {
  const captureDir = mkdtempSync(join(tmpdir(), "opencode-pi-capture-"));
  const capturePath = join(captureDir, "invocations.jsonl");
  const piSessionId = `pi-reuse-${Date.now()}`;
  try {
    const first = await withFakeOpenCode(
      sessionFakeScript(capturePath, "ses-reuse-1"),
      () =>
        streamOpenCode(fakeModel(), userContext(["first question"]), {
          sessionId: piSessionId,
        }).result(),
    );
    assert.equal(first.stopReason, "stop");

    const second = await withFakeOpenCode(
      sessionFakeScript(capturePath, "ses-reuse-1"),
      () =>
        streamOpenCode(fakeModel(), conversationContext(), {
          sessionId: piSessionId,
        }).result(),
    );
    assert.equal(second.stopReason, "stop");

    const invocations = readInvocations(capturePath);
    assert.equal(invocations.length, 2);
    // First turn starts a fresh session with the full transcript.
    assert.equal(invocations[0]?.args.includes("--session"), false);
    assert.match(invocations[0]?.stdin ?? "", /first question/);
    // Continuation passes --session, reuses the directory, and sends the delta.
    const sessionIndex = invocations[1]?.args.indexOf("--session") ?? -1;
    assert.notEqual(sessionIndex, -1);
    assert.equal(invocations[1]?.args[sessionIndex + 1], "ses-reuse-1");
    assert.match(invocations[1]?.stdin ?? "", /second question/);
    assert.equal((invocations[1]?.stdin ?? "").includes("first question"), false);
    const dirIndex = (args: string[]) => args.indexOf("--dir");
    assert.equal(
      invocations[1]?.args[dirIndex(invocations[1]?.args ?? []) + 1],
      invocations[0]?.args[dirIndex(invocations[0]?.args ?? []) + 1],
    );
    assert.equal(trackedPiSessionCount() >= 1, true);
  } finally {
    await cleanupPiSessionState(piSessionId);
    rmSync(captureDir, { recursive: true, force: true });
  }
});

test("streamOpenCode starts fresh after an error drops the session", async () => {
  const captureDir = mkdtempSync(join(tmpdir(), "opencode-pi-capture-"));
  const capturePath = join(captureDir, "invocations.jsonl");
  const piSessionId = `pi-drop-${Date.now()}`;
  try {
    const first = await withFakeOpenCode(
      sessionFakeScript(capturePath, "ses-drop-1"),
      () =>
        streamOpenCode(fakeModel(), userContext(["first question"]), {
          sessionId: piSessionId,
        }).result(),
    );
    assert.equal(first.stopReason, "stop");

    // A failed turn (invalid tool-call payload) drops the recorded session.
    const failed = await withFakeOpenCode(
      `const fs = require("node:fs");
if (process.argv.includes("session")) process.exit(0);
let body = "";
process.stdin.on("data", (chunk) => { body += chunk; });
process.stdin.on("end", () => {
  fs.appendFileSync(${JSON.stringify(capturePath)}, JSON.stringify({ args: process.argv.slice(2), stdin: body }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "text", part: { text: '<pi_tool_call>{"name":"nope"}</pi_tool_call>', sessionID: "ses-drop-1" } }) + "\\n");
});
`,
      () =>
        streamOpenCode(fakeModel(), userContext(["boom"], ["bash"]), {
          sessionId: piSessionId,
        }).result(),
    );
    assert.equal(failed.stopReason, "error");

    const recovered = await withFakeOpenCode(
      sessionFakeScript(capturePath, "ses-drop-2"),
      () =>
        streamOpenCode(fakeModel(), userContext(["third question"]), {
          sessionId: piSessionId,
        }).result(),
    );
    assert.equal(recovered.stopReason, "stop");

    const invocations = readInvocations(capturePath);
    assert.equal(invocations.length, 3);
    // The recovery turn starts a fresh full-transcript session.
    assert.equal(invocations[2]?.args.includes("--session"), false);
    assert.match(invocations[2]?.stdin ?? "", /Conversation transcript/);
  } finally {
    await cleanupPiSessionState(piSessionId);
    rmSync(captureDir, { recursive: true, force: true });
  }
});

test("streamOpenCode restarts the session when tools change", async () => {
  const captureDir = mkdtempSync(join(tmpdir(), "opencode-pi-capture-"));
  const capturePath = join(captureDir, "invocations.jsonl");
  const piSessionId = `pi-tools-${Date.now()}`;
  try {
    const first = await withFakeOpenCode(
      sessionFakeScript(capturePath, "ses-tools-1"),
      () =>
        streamOpenCode(fakeModel(), userContext(["q1"], ["read"]), {
          sessionId: piSessionId,
        }).result(),
    );
    assert.equal(first.stopReason, "stop");

    const second = await withFakeOpenCode(
      sessionFakeScript(capturePath, "ses-tools-2"),
      () =>
        streamOpenCode(fakeModel(), userContext(["q1", "q2"], ["read", "bash"]), {
          sessionId: piSessionId,
        }).result(),
    );
    assert.equal(second.stopReason, "stop");

    const invocations = readInvocations(capturePath);
    assert.equal(invocations.length, 2);
    // A changed tool list restarts with the full transcript, not a delta.
    assert.equal(invocations[1]?.args.includes("--session"), false);
    assert.match(invocations[1]?.stdin ?? "", /Available Pi tools/);
    assert.match(invocations[1]?.stdin ?? "", /q1/);
  } finally {
    await cleanupPiSessionState(piSessionId);
    rmSync(captureDir, { recursive: true, force: true });
  }
});

test("streamOpenCode runs isolated fresh sessions without a Pi session ID", async () => {
  const captureDir = mkdtempSync(join(tmpdir(), "opencode-pi-capture-"));
  const capturePath = join(captureDir, "invocations.jsonl");
  try {
    for (const question of ["q1", "q2"]) {
      const message = await withFakeOpenCode(
        sessionFakeScript(capturePath, "ses-once"),
        () => streamOpenCode(fakeModel(), userContext([question])).result(),
      );
      assert.equal(message.stopReason, "stop");
    }
    const invocations = readInvocations(capturePath);
    assert.equal(invocations.length, 2);
    for (const invocation of invocations) {
      assert.equal(invocation.args.includes("--session"), false);
      assert.match(invocation.stdin, /Conversation transcript/);
    }
    assert.notEqual(
      invocationDir(invocations[0]),
      invocationDir(invocations[1]),
    );
    function invocationDir(invocation: { args: string[] }): string {
      return invocation.args[invocation.args.indexOf("--dir") + 1] ?? "";
    }
  } finally {
    rmSync(captureDir, { recursive: true, force: true });
  }
});

test("provider hooks await ordered observations and replace the actual CLI prompt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hooks-"));
  const capture = join(dir, "calls.jsonl");
  const order: string[] = [];
  const pause = () => new Promise((resolve) => setTimeout(resolve, 5));
  try {
    const message = await withFakeOpenCode(sessionFakeScript(capture, "ses-hooks"), () =>
      streamOpenCode(fakeModel(), userContext(["original"]), {
        onPayload: async (payload, model) => {
          assert.equal(model.id, "opencode/fake-free");
          assert.match((payload as { prompt: string }).prompt, /original/);
          order.push("payload"); await pause(); return { prompt: "replacement" };
        },
        onResponse: async (response) => {
          assert.equal(response.status, 0);
          assert.equal(response.headers["x-pi-transport"], "opencode-cli");
          order.push("response"); await pause(); order.push("response-done");
        },
        onProviderStreamEvent: async (event) => {
          const type = (event as { type: string }).type;
          order.push(type); await pause(); order.push(type + "-done");
        },
      }).result());
    assert.equal(message.stopReason, "stop");
    assert.equal(readInvocations(capture)[0]?.stdin, "replacement");
    assert.deepEqual(order, ["payload", "response", "response-done", "text", "text-done", "step_finish", "step_finish-done"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("provider hooks reject invalid payloads and contain callback failures", async () => {
  for (const payload of [null, "bad", { prompt: 42 }]) {
    const message = await withFakeOpenCode(fakeEventScript([{ type: "text", part: { text: "ok" } }]), () =>
      streamOpenCode(fakeModel(), fakeContext(), { onPayload: () => payload }).result());
    assert.equal(message.stopReason, "error");
    assert.match(message.errorMessage ?? "", /payload.*prompt/i);
  }
  for (const hook of ["onPayload", "onResponse", "onProviderStreamEvent"] as const) {
    const message = await withFakeOpenCode(fakeEventScript([{ type: "text", part: { text: "ok" } }]), () =>
      streamOpenCode(fakeModel(), fakeContext(), {
        [hook]: async () => { throw new Error("callback failed"); },
      }).result());
    assert.equal(message.stopReason, "error");
    assert.equal(message.errorMessage, "callback failed");
  }
});

test("provider hooks remain cancellable during payload, response and unterminated final events", async () => {
  for (const hook of ["onPayload", "onResponse", "onProviderStreamEvent"] as const) {
    const controller = new AbortController();
    let entered = false;
    const start = Date.now();
    const message = await withFakeOpenCode('process.stdout.write(JSON.stringify({type:"text",part:{text:"ok"}}));', () =>
      streamOpenCode(fakeModel(), fakeContext(), {
        signal: controller.signal, timeoutMs: 1000,
        [hook]: async () => {
          entered = true; controller.abort(); await new Promise(() => {});
        },
      }).result());
    assert.equal(entered, true, hook);
    assert.equal(message.stopReason, "aborted");
    assert.ok(Date.now() - start < 2000);
  }
});

test("provider payload transformations start fresh instead of reusing stale session context", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hooks-reuse-"));
  const capture = join(dir, "calls.jsonl");
  const sessionId = "pi-payload-session";
  try {
    await withFakeOpenCode(sessionFakeScript(capture, "ses-payload"), async () => {
      for (const contexts of [userContext(["first question"]), conversationContext()]) {
        const message = await streamOpenCode(fakeModel(), contexts, {
          sessionId, onPayload: (payload) => payload,
        }).result();
        assert.equal(message.stopReason, "stop");
      }
      const calls = readInvocations(capture);
      assert.equal(calls.length, 2);
      assert.equal(calls[1]!.args.includes("--session"), false);
      assert.match(calls[1]!.stdin, /first question/);
      await cleanupPiSessionState(sessionId);
    });
  } finally {
    await cleanupPiSessionState(sessionId);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("provider environment reaches the CLI without replacing mandatory bridge configuration", async () => {
  const message = await withFakeOpenCode(`process.stdout.write(JSON.stringify({type:"text",part:{text:process.env.PI_BRIDGE_TEST + "|" + process.env.OPENCODE_CONFIG_DIR.endsWith(".opencode")}}) + "\\n");`, () =>
    streamOpenCode(fakeModel(), fakeContext(), { env: { PI_BRIDGE_TEST: "scoped", OPENCODE_CONFIG_DIR: "/wrong" } }).result());
  assert.equal(message.stopReason, "stop");
  assert.deepEqual(message.content, [{ type: "text", text: "scoped|true" }]);
});

test("streamOpenCode kills SIGTERM-ignoring children on timeout and abort", async () => {
  for (const cancel of ["timeout", "abort"] as const) {
    const controller = new AbortController();
    const start = Date.now();
    const abortTimer = cancel === "abort" ? setTimeout(() => controller.abort(), 800) : undefined;
    try {
      const message = await withFakeOpenCode(
        'process.on("SIGTERM", () => {}); setInterval(() => {}, 100); setTimeout(() => process.exit(0), 3000);',
        () => streamOpenCode(fakeModel(), fakeContext(), {
          timeoutMs: cancel === "timeout" ? 800 : 5000,
          signal: controller.signal,
        }).result(),
      );
      assert.equal(message.stopReason, cancel === "abort" ? "aborted" : "error");
      assert.ok(Date.now() - start < 2000, `${cancel} did not terminate the child within its grace period`);
    } finally {
      clearTimeout(abortTimer);
    }
  }
});

test("streamOpenCode treats non-JSON stdout lines as diagnostics, not failed turns", async () => {
  const message = await withFakeOpenCode(
    `process.stdout.write("[my-plugin] loaded\\n" + JSON.stringify({ type: "text", part: { text: "ok" } }) + "\\n");`,
    () => streamOpenCode(fakeModel(), fakeContext()).result(),
  );
  assert.equal(message.stopReason, "stop");
  assert.deepEqual(message.content, [{ type: "text", text: "ok" }]);
});

test("streamOpenCode turns invalid CLI envelopes into errors without crashing its host", async () => {
  for (const envelope of [null, [], 42, true, {}, { type: "text", part: null }]) {
    await withFakeOpenCode(fakeEventScript([envelope]), async () => {
      const script = `import { streamOpenCode } from ${JSON.stringify(new URL("./index.js", import.meta.url).href)};
const stream = streamOpenCode(${JSON.stringify(fakeModel())}, { messages: [] });
const events = []; for await (const event of stream) events.push(event.type);
console.log(JSON.stringify({ events, message: await stream.result() }));`;
      const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
        env: process.env, encoding: "utf8", timeout: 5000,
      });
      assert.equal(child.status, 0, child.stderr);
      const result = JSON.parse(child.stdout);
      assert.deepEqual(result.events, ["start", "error"]);
      assert.equal(result.message.stopReason, "error");
      assert.match(result.message.errorMessage, /invalid.*event/i);
    });
  }
});

test("session_shutdown waits for project removal and OpenCode deletion", async () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-pi-shutdown-"));
  const capture = join(dir, "calls.jsonl");
  const deleted = join(dir, "deleted");
  const sessionId = "pi-await-shutdown";
  const previousModels = process.env.OPENCODE_PI_MODELS;
  process.env.OPENCODE_PI_MODELS = "fake-free";
  try {
    await withFakeOpenCode(`if (process.argv.includes("session")) {
  setTimeout(() => { require("node:fs").writeFileSync(${JSON.stringify(deleted)}, "deleted"); process.exit(0); }, 250);
} else { ${sessionFakeScript(capture, "ses-await-shutdown")} }`, async () => {
      let shutdown: (() => Promise<void> | void) | undefined;
      await opencodePiExtension({
        registerProvider() {}, registerCommand() {},
        on(name: string, handler: () => Promise<void> | void) { if (name === "session_shutdown") shutdown = handler; },
      } as unknown as ExtensionAPI);
      await streamOpenCode(fakeModel(), userContext(["hello"]), { sessionId }).result();
      const args = readInvocations(capture)[0]!.args;
      const project = args[args.indexOf("--dir") + 1]!;
      assert.equal(existsSync(project), true);
      assert.ok(shutdown);
      await shutdown();
      assert.equal(existsSync(project), false);
      assert.equal(existsSync(deleted), true);
    });
  } finally {
    restoreEnv("OPENCODE_PI_MODELS", previousModels);
    await cleanupPiSessionState(sessionId);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deleteOpenCodeSession never throws without a session ID", () => {
  assert.doesNotThrow(() => deleteOpenCodeSession(undefined));
});

test("cleanupPiSessionState removes the project directory at teardown", async () => {
  const captureDir = mkdtempSync(join(tmpdir(), "opencode-pi-capture-"));
  const capturePath = join(captureDir, "invocations.jsonl");
  const piSessionId = `pi-teardown-${Date.now()}`;
  let before = 0;
  try {
    await withFakeOpenCode(
      sessionFakeScript(capturePath, "ses-teardown-1"),
      () =>
        streamOpenCode(fakeModel(), userContext(["hello"]), {
          sessionId: piSessionId,
        }).result(),
    );
    before = trackedPiSessionCount();
    assert.equal(before >= 1, true);
    const invocations = readInvocations(capturePath);
    const dir = invocations[0]?.args[invocations[0]?.args.indexOf("--dir") + 1];
    assert.equal(existsSync(dir), true);

    await cleanupPiSessionState(piSessionId);

    assert.equal(existsSync(dir), false);
    assert.equal(trackedPiSessionCount(), before - 1);
  } finally {
    await cleanupPiSessionState(piSessionId);
    rmSync(captureDir, { recursive: true, force: true });
  }
});
