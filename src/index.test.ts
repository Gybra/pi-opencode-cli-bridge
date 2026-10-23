import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, win32 } from "node:path";
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
  SimpleStreamOptions,
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
  options?: SimpleStreamOptions,
): Promise<AssistantMessageEvent[]> {
  return withFakeOpenCode(script, async () => {
    const events: AssistantMessageEvent[] = [];
    for await (const event of streamOpenCode(fakeModel(), context, options)) {
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
  version = "1.19.0",
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "opencode-pi-fake-bin-"));
  const binPath = join(dir, "opencode-fake.js");
  writeFileSync(binPath, `#!/usr/bin/env node\nif (process.argv[2] === "--version") { console.log(${JSON.stringify(version)}); process.exit(0); }\n${script}`, "utf8");
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

test("reasoningCliArgs always captures reasoning without changing off or default effort", () => {
  const map = { off: "none", low: "low" } as const;

  assert.deepEqual(reasoningCliArgs("off", map), ["--thinking"]);
  assert.deepEqual(reasoningCliArgs("low", map), [
    "--thinking",
    "--variant",
    "low",
  ]);
  assert.deepEqual(reasoningCliArgs(undefined, map), ["--thinking"]);
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

// Shapes captured from live DeepSeek/GLM failures; paths and commands are sanitized.
const malformedLiveResponses = [
  '<pi_tool_call>{"name":"read","arguments":{"path":"fixture.txt"}}</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>',
  '<pi_tool_call>{"name":"bash","arguments":{"command":"grep REPORT_TOKEN fixture.html}}</pi_tool_call>',
];

test("parseToolCallResponse rejects unrecoverable markers when nothing usable remains", () => {
  const responses = [
    '<pi_tool_call>{"name":"bash","arguments":{"command":"pwd"}',
    '<pi_tool_call>{"name":"bash","arguments":{}} trailing prose',
    '<pi_tool_call>{"name":"bash","arguments":{}}</tool_call>',
    '<pi_tool_call>{"name":"bash","arguments":{}}<pi_tool_call>',
    ...malformedLiveResponses,
  ];

  for (const response of responses.flatMap(text => [text, ` \n${text}\n `])) {
    assert.deepEqual(parseToolCallResponse(response, new Set(["read", "bash"])), {
      ok: false,
      rejection: { reason: "malformed_markers" },
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
    { reasoning: "high" },
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
    assert.equal(error.error.errorMessage, `${diagnostic} Recovery failed after one attempt.`);
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

test("streamOpenCode diagnoses a truncated marker in reasoning instead of ending the turn", async () => {
  const message = await withFakeOpenCode(
    fakeEventScript([
      { type: "reasoning", part: { text: '<pi_tool_call>{"name":"bash","arguments":{"command":"ls"' } },
    ]),
    () => streamOpenCode(fakeModel(), fakeContext(["bash"])).result(),
  );

  assert.equal(message.stopReason, "error");
  assert.match(message.errorMessage ?? "", /malformed Pi tool-call markers/);
});

test("streamOpenCode diagnoses an unclosed DSML tool call instead of ending the turn", async () => {
  const message = await withFakeOpenCode(
    fakeEventScript([
      { type: "text", part: { text: dsmlResponse.split("\n").slice(0, 4).join("\n") } },
    ]),
    () => streamOpenCode(fakeModel(), fakeContext(["bash"])).result(),
  );

  assert.equal(message.stopReason, "error");
  assert.match(message.errorMessage ?? "", /incomplete DeepSeek DSML tool call.*after one attempt/);
  assert.doesNotMatch(message.errorMessage ?? "", /<pi_tool_call>/);
});

test("streamOpenCode reports failed native-tool recovery without exposing protocol markers", async () => {
  const message = await withFakeOpenCode(
    fakeEventScript([{ type: "tool_use", part: { tool: "bash" } }]),
    () => streamOpenCode(fakeModel(), fakeContext(["read"])).result(),
  );

  assert.equal(message.stopReason, "error");
  assert.equal(
    message.errorMessage,
    'OpenCode could not use the available Pi tools after one recovery attempt (blocked native tool: "bash"). Retry the request or select another OpenCode model.',
  );
});

const reasoningOnlyEvents = [
  { type: "reasoning", part: { text: "I should use Pi bash to fetch the page. Let me do that." } },
  { type: "step_finish", part: { tokens: { total: 10, input: 6, output: 4 } } },
];

function recoveryScript(capturePath: string, nextEvents: unknown[], firstEvents?: unknown[]): string {
  return `
const fs = require("node:fs");
if (process.argv[2] !== "run") process.exit(0);
let body = "";
process.stdin.on("data", chunk => body += chunk);
process.stdin.on("end", () => {
  const capture = ${JSON.stringify(capturePath)};
  const previous = fs.existsSync(capture) ? fs.readFileSync(capture, "utf8").trim().split("\\n").length : 0;
  fs.appendFileSync(capture, JSON.stringify({ args: process.argv.slice(2), stdin: body }) + "\\n");
  const events = previous === 0 ? ${JSON.stringify(firstEvents)} ?? [
    { type: "text", part: { text: "discarded draft" } },
    { type: "reasoning", part: { text: "discarded reasoning" } },
    { type: "tool_use", part: { tool: "grep", state: { status: "error", input: { pattern: "needle", path: "." } } } },
    { type: "step_finish", part: { tokens: { total: 10, input: 6, output: 4 } } },
  ] : ${JSON.stringify(nextEvents)};
  for (const event of events) process.stdout.write(JSON.stringify({ ...event, sessionID: "ses-native-" + previous }) + "\\n");
});`;
}

const nativeRecoveryEvents = [
  { type: "text", part: { text: '<pi_tool_call>{"name":"bash","arguments":{"command":"rg needle ."}}</pi_tool_call>' } },
  { type: "step_finish", part: { tokens: { total: 5, input: 3, output: 2 } } },
];

for (const version of ["1.19.0", "2.0.30"]) {
  test(`OpenCode ${version} recovers native grep through available Pi tools`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-native-recovery-"));
    const capture = join(dir, "calls.jsonl");
    const events: AssistantMessageEvent[] = [];
    let payloads = 0;
    try {
      const message = await withFakeOpenCode(recoveryScript(capture, nativeRecoveryEvents), async () => {
        const stream = streamOpenCode(fakeModel(), userContext(["Find needle in this project"], ["read", "bash", "edit", "write"]), {
          onPayload: (payload) => {
            payloads++;
            return { prompt: (payload as { prompt: string }).prompt + "\nscoped payload" };
          },
        });
        for await (const event of stream) events.push(event);
        return stream.result();
      }, version);
      assert.equal(message.stopReason, "toolUse", message.errorMessage);
      assert.deepEqual(message.content.map(c => c.type === "toolCall" ? { name: c.name, arguments: c.arguments } : c), [
        { name: "bash", arguments: { command: "rg needle ." } },
      ]);
      assert.equal(events.filter(e => e.type === "start").length, 1);
      assert.equal(events.filter(e => e.type === "error").length, 0);
      assert.equal(events.filter(e => e.type === "done").length, 1);
      assert.equal(message.usage.input, 9);
      assert.equal(message.usage.output, 6);
      assert.equal(message.usage.totalTokens, 15);
      const calls = readInvocations(capture);
      assert.equal(calls.length, 2);
      assert.equal(payloads, 2);
      assert.match(calls[1]!.stdin, /Find needle in this project/);
      assert.match(calls[1]!.stdin, /native tool.*grep/i);
      assert.match(calls[1]!.stdin, /needle/);
      assert.match(calls[1]!.stdin, /Available Pi tools: read, bash, edit, write/);
      assert.match(calls[1]!.stdin, /<pi_tool_call>/);
      assert.match(calls[1]!.stdin, /scoped payload/);
      assert.equal(calls[1]!.args.includes("--session"), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

for (const version of ["1.19.0", "2.0.30"]) {
  for (const channel of ["text", "reasoning"]) {
    for (const [index, text] of [
      ...malformedLiveResponses,
      '<pi_tool_call>{"name":"read"}</pi_tool_call>',
      dsmlResponse.split("\n").slice(0, 4).join("\n"),
    ].entries()) {
      test(`OpenCode ${version} regenerates malformed tool call ${index + 1} in ${channel}`, async () => {
        const dir = mkdtempSync(join(tmpdir(), "pi-malformed-recovery-"));
        const capture = join(dir, "calls.jsonl");
        const sessionId = `pi-malformed-${version}-${channel}-${index}`;
        const events: AssistantMessageEvent[] = [];
        try {
          await withFakeOpenCode(recoveryScript(capture, nativeRecoveryEvents, [
            { type: channel, part: { text } },
            { type: "step_finish", part: { tokens: { total: 10, input: 6, output: 4 } } },
          ]), async () => {
            const stream = streamOpenCode(fakeModel(), userContext(["Find the report token"], ["read", "bash"]), { sessionId });
            for await (const event of stream) events.push(event);
            const message = await stream.result();
            assert.equal(message.stopReason, "toolUse", message.errorMessage);
            assert.deepEqual(message.content.map(c => c.type === "toolCall" ? { name: c.name, arguments: c.arguments } : c), [
              { name: "bash", arguments: { command: "rg needle ." } },
            ]);
            assert.equal(message.usage.totalTokens, 15);
            assert.equal(events.filter(e => e.type === "start").length, 1);
            assert.equal(events.filter(e => e.type === "done").length, 1);
            assert.equal(events.filter(e => e.type === "toolcall_end").length, 1);
            assert.equal(events.some(e => e.type === "error" || e.type === "thinking_delta"), false);
            const calls = readInvocations(capture);
            assert.equal(calls.length, 2);
            assert.equal(calls[1]!.args.includes("--session"), false);
            assert.match(calls[1]!.stdin, /Find the report token/);
            assert.match(calls[1]!.stdin, /malformed Pi tool call/);
            assert.match(calls[1]!.stdin, /Available Pi tools: read, bash/);

            await streamOpenCode(fakeModel(), userContext(["Find the report token", "Next question"], ["read", "bash"]), { sessionId }).result();
            const next = readInvocations(capture)[2]!;
            assert.equal(next.args.includes("--session"), false);
            assert.doesNotMatch(next.stdin, /Your previous attempt/);
          }, version);
        } finally {
          await cleanupPiSessionState(sessionId);
          rmSync(dir, { recursive: true, force: true });
        }
      });
    }
  }
}

const malformedEvents = [{ type: "text", part: { text: malformedLiveResponses[0] } }];
for (const [label, first, second] of [
  ["malformed to malformed", malformedEvents, malformedEvents],
  ["malformed to native", malformedEvents, [{ type: "tool_use", part: { tool: "grep" } }]],
  ["native to malformed", undefined, malformedEvents],
  ["reasoning to malformed", reasoningOnlyEvents, malformedEvents],
  ["malformed to reasoning", malformedEvents, reasoningOnlyEvents],
] as const) {
  test(`malformed-call recovery shares one attempt with other failures (${label})`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-malformed-repeat-"));
    const capture = join(dir, "calls.jsonl");
    try {
      const message = await withFakeOpenCode(recoveryScript(capture, [...second], first && [...first]), () =>
        streamOpenCode(fakeModel(), fakeContext(["read", "bash"])).result());
      assert.equal(message.stopReason, "error");
      assert.match(message.errorMessage ?? "", /after one (?:recovery )?attempt/);
      assert.doesNotMatch(message.errorMessage ?? "", /empty assistant response|<pi_tool_call>|<｜/);
      assert.equal(readInvocations(capture).length, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

for (const boundary of ["cancellation", "deadline"] as const) {
  test(`malformed-call recovery does not retry after ${boundary}`, async t => {
    const dir = mkdtempSync(join(tmpdir(), "pi-malformed-budget-"));
    const capture = join(dir, "calls.jsonl");
    const controller = new AbortController();
    const now = Date.now.bind(Date);
    let elapsed = 0;
    t.mock.method(Date, "now", () => now() + elapsed);
    try {
      const message = await withFakeOpenCode(recoveryScript(capture, nativeRecoveryEvents, [
        ...malformedEvents, { type: "step_finish", part: {} },
      ]), () => streamOpenCode(fakeModel(), fakeContext(["read", "bash"]), {
        timeoutMs: 10_000,
        signal: controller.signal,
        onProviderStreamEvent: event => {
          if ((event as { type: string }).type !== "step_finish") return;
          if (boundary === "cancellation") controller.abort();
          else elapsed = 100_000;
        },
      }).result());
      assert.equal(message.stopReason, boundary === "cancellation" ? "aborted" : "error");
      assert.equal(readInvocations(capture).length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

for (const version of ["1.19.0", "2.0.30"]) {
  for (const outcome of ["alternative", "clarification", "unavailable"] as const) {
    test(`OpenCode ${version} forwards blocked native requests for functional recovery (${outcome})`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "pi-native-alternative-"));
      const capture = join(dir, "calls.jsonl");
      const sessionId = `pi-alternative-${version}-${outcome}`;
      const firstUrl = 'https://example.com/proposal?title="demo"';
      const secondUrl = "https://example.com/appendix";
      const tools = [outcome === "alternative" ? {
        name: "inspect_document",
        description: "Read the full document at the URL supplied in path; not a search engine.",
        parameters: createReadToolDefinition(process.cwd()).parameters,
      } : {
        name: "webfetch_search",
        description: "Search an index for snippets only. Cannot retrieve a URL or read a full page.",
        parameters: createGrepToolDefinition(process.cwd()).parameters,
      }];
      const context: Context = { ...userContext(["Inspect the proposed documents"]), tools };
      const reply = outcome === "clarification"
        ? "No suitable tool can read these pages. Please paste their content."
        : outcome === "unavailable"
          ? '<pi_tool_call>{"name":"webfetch","arguments":{"url":"https://example.com/proposal"}}</pi_tool_call>'
          : [firstUrl, secondUrl].map(path => `<pi_tool_call>${JSON.stringify({ name: "inspect_document", arguments: { path } })}</pi_tool_call>`).join("\n");
      try {
        await withFakeOpenCode(recoveryScript(capture, [
          { type: "text", part: { text: reply } },
          { type: "step_finish", part: { tokens: { total: 5, input: 3, output: 2 } } },
        ], [
          { type: "tool_use", part: { tool: "webfetch", state: { input: { url: firstUrl, format: "markdown" } } } },
          { type: "tool_use", part: { tool: "webfetch", state: { input: { url: secondUrl, format: "text" } } } },
          { type: "step_finish", part: { tokens: { total: 10, input: 6, output: 4 } } },
        ]), async () => {
          const message = await streamOpenCode(fakeModel(), context, { sessionId }).result();
          assert.equal(message.stopReason, outcome === "alternative" ? "toolUse" : outcome === "clarification" ? "stop" : "error", message.errorMessage);
          if (outcome === "alternative") {
            const calls = message.content.filter(c => c.type === "toolCall");
            assert.deepEqual(calls.map(c => ({ name: c.name, arguments: c.arguments })), [
              { name: "inspect_document", arguments: { path: firstUrl } },
              { name: "inspect_document", arguments: { path: secondUrl } },
            ]);
            for (const call of calls) validateToolArguments(tools[0]!, call);
          } else if (outcome === "clarification") {
            assert.deepEqual(message.content, [{ type: "text", text: reply }]);
          } else {
            assert.match(message.errorMessage ?? "", /unavailable Pi tool "webfetch"/);
            assert.equal(message.content.some(c => c.type === "toolCall"), false);
          }
          assert.equal(message.usage.totalTokens, 15);
          const invocations = readInvocations(capture);
          assert.equal(invocations.length, 2);
          assert.equal(invocations[1]!.args.includes("--session"), false);
          const correction = invocations[1]!.stdin.slice(invocations[1]!.stdin.indexOf("Your previous attempt"));
          assert.ok(correction.includes(JSON.stringify(firstUrl)), "first native request arguments were lost");
          assert.ok(correction.includes(JSON.stringify(secondUrl)), "second native request arguments were lost");
          assert.match(correction, /"format": "markdown"/);
          assert.match(correction, /"format": "text"/);
          assert.ok(invocations[1]!.stdin.includes(tools[0]!.description));
          assert.match(invocations[1]!.stdin, /"properties"/);
          assert.ok(invocations[1]!.stdin.includes(tools[0]!.name));
          await streamOpenCode(fakeModel(), { ...context, messages: [...context.messages, { role: "user", content: "Next question", timestamp: 2 }] }, { sessionId }).result();
          const next = readInvocations(capture)[2]!;
          assert.doesNotMatch(next.stdin, /Your previous attempt/);
          assert.equal(next.stdin.includes(secondUrl), false, "native-call arguments leaked into the next Pi turn");
        }, version);
      } finally {
        await cleanupPiSessionState(sessionId);
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
}

test("native-tool recovery stops after one attempt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-native-repeat-"));
  const capture = join(dir, "calls.jsonl");
  try {
    const message = await withFakeOpenCode(recoveryScript(capture, [
      { type: "tool_use", part: { tool: "grep", state: { status: "error", input: { pattern: "needle" } } } },
      { type: "step_finish", part: {} },
    ]), () => streamOpenCode(fakeModel(), fakeContext(["bash"])).result(), "2.0.30");
    assert.equal(message.stopReason, "error");
    assert.match(message.errorMessage ?? "", /after one recovery attempt.*grep/);
    assert.doesNotMatch(message.errorMessage ?? "", /<pi_tool_call>/);
    assert.equal(readInvocations(capture).length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("blocked native call recovers when the model replies with prose instead of a Pi call", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-native-prose-recovery-"));
  const capture = join(dir, "calls.jsonl");
  try {
    const message = await withFakeOpenCode(recoveryScript(capture, nativeRecoveryEvents, [
      { type: "tool_use", part: { tool: "webfetch", state: { status: "error", input: { url: "https://example.com" } } } },
      { type: "text", part: { text: "Il fetch diretto è stato rifiutato dalle permission. Chiedo a Pi di eseguire un curl." } },
      { type: "step_finish", part: { tokens: { total: 10, input: 6, output: 4 } } },
    ]), () => streamOpenCode(fakeModel(), userContext(["Leggi la pagina web https://example.com e dimmi cosa contiene."], ["read", "bash"])).result(), "2.0.30");
    assert.equal(message.stopReason, "toolUse", message.errorMessage);
    assert.deepEqual(message.content.map(c => c.type === "toolCall" ? { name: c.name, arguments: c.arguments } : c), [
      { name: "bash", arguments: { command: "rg needle ." } },
    ]);
    const invocations = readInvocations(capture);
    assert.equal(invocations.length, 2, "prose-only recovery must retry once");
    assert.match(invocations[1]!.stdin, /disabled OpenCode native tool "webfetch"/);
    assert.match(invocations[1]!.stdin, /Available Pi tools: read, bash/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("blocked native call does not retry when the model emits a valid Pi tool call", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-native-valid-noretry-"));
  const capture = join(dir, "calls.jsonl");
  try {
    const reply = 'Non posso usare webfetch.\n<pi_tool_call>{"name":"bash","arguments":{"command":"curl -s https://example.com"}}</pi_tool_call>';
    const message = await withFakeOpenCode(recoveryScript(capture, nativeRecoveryEvents, [
      { type: "tool_use", part: { tool: "webfetch", state: { status: "error", input: { url: "https://example.com" } } } },
      { type: "text", part: { text: reply } },
      { type: "step_finish", part: { tokens: { total: 10, input: 6, output: 4 } } },
    ]), () => streamOpenCode(fakeModel(), fakeContext(["bash"])).result(), "2.0.30");
    assert.equal(message.stopReason, "toolUse", message.errorMessage);
    assert.deepEqual(message.content.map(c => c.type === "toolCall" ? { name: c.name, arguments: c.arguments } : c), [
      { name: "bash", arguments: { command: "curl -s https://example.com" } },
    ]);
    assert.equal(readInvocations(capture).length, 1, "a valid Pi call must not trigger a retry");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("blocked native call keeps a valid Pi call found only in reasoning without retrying", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-native-reasoning-noretry-"));
  const capture = join(dir, "calls.jsonl");
  try {
    const message = await withFakeOpenCode(recoveryScript(capture, [], [
      { type: "tool_use", part: { tool: "webfetch", state: { status: "error", input: { url: "https://example.com" } } } },
      { type: "reasoning", part: { text: '<pi_tool_call>{"name":"bash","arguments":{"command":"curl -s https://example.com"}}</pi_tool_call>' } },
      { type: "step_finish", part: { tokens: { total: 10, input: 6, output: 4 } } },
    ]), () => streamOpenCode(fakeModel(), fakeContext(["bash"])).result(), "2.0.30");
    assert.equal(message.stopReason, "toolUse", message.errorMessage);
    assert.deepEqual(message.content.map(c => c.type === "toolCall" ? { name: c.name, arguments: c.arguments } : c), [
      { name: "bash", arguments: { command: "curl -s https://example.com" } },
    ]);
    assert.equal(readInvocations(capture).length, 1, "a valid Pi call in reasoning must not trigger a retry");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("malformed-call recovery does not retry unavailable Pi tools", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-unavailable-no-retry-"));
  const capture = join(dir, "calls.jsonl");
  try {
    const message = await withFakeOpenCode(recoveryScript(capture, nativeRecoveryEvents, [
      { type: "text", part: { text: '<pi_tool_call>{"name":"bash","arguments":{"command":"pwd"}}</pi_tool_call>' } },
    ]), () => streamOpenCode(fakeModel(), fakeContext(["read"])).result());
    assert.equal(message.stopReason, "error");
    assert.match(message.errorMessage ?? "", /unavailable Pi tool "bash"/);
    assert.equal(readInvocations(capture).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("native-tool recovery can ask for content when Pi exposes no tools", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-native-no-tools-"));
  const capture = join(dir, "calls.jsonl");
  try {
    const message = await withFakeOpenCode(recoveryScript(capture, [
      { type: "text", part: { text: "No suitable tool is available. Please paste the page content." } },
    ]), () => streamOpenCode(fakeModel(), fakeContext()).result());
    assert.equal(message.stopReason, "stop", message.errorMessage);
    assert.deepEqual(message.content, [{ type: "text", text: "No suitable tool is available. Please paste the page content." }]);
    assert.equal(readInvocations(capture).length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("native-tool recovery does not retry after the turn budget expires", async t => {
  const dir = mkdtempSync(join(tmpdir(), "pi-native-deadline-"));
  const capture = join(dir, "calls.jsonl");
  const now = Date.now.bind(Date);
  let elapsed = 0;
  t.mock.method(Date, "now", () => now() + elapsed);
  try {
    const message = await withFakeOpenCode(recoveryScript(capture, nativeRecoveryEvents), () =>
      streamOpenCode(fakeModel(), fakeContext(["bash"]), {
        timeoutMs: 10_000,
        onProviderStreamEvent: event => {
          if ((event as { type: string }).type === "step_finish") elapsed = 100_000;
        },
      }).result());
    assert.equal(message.stopReason, "error");
    assert.doesNotMatch(message.errorMessage ?? "", /after one recovery attempt/);
    assert.equal(readInvocations(capture).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("native-tool recovery does not retry after cancellation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-native-abort-"));
  const capture = join(dir, "calls.jsonl");
  const controller = new AbortController();
  try {
    const message = await withFakeOpenCode(recoveryScript(capture, nativeRecoveryEvents), () =>
      streamOpenCode(fakeModel(), fakeContext(["bash"]), {
        signal: controller.signal,
        onProviderStreamEvent: event => {
          if ((event as { type: string }).type === "step_finish") controller.abort();
        },
      }).result());
    assert.equal(message.stopReason, "aborted");
    assert.equal(readInvocations(capture).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("native-tool recovery does not reuse hidden correction history on the next Pi turn", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-native-session-"));
  const capture = join(dir, "calls.jsonl");
  const sessionId = "pi-native-recovery-session";
  try {
    await withFakeOpenCode(recoveryScript(capture, nativeRecoveryEvents), async () => {
      const first = await streamOpenCode(fakeModel(), userContext(["Find needle"], ["bash"]), { sessionId }).result();
      assert.equal(first.stopReason, "toolUse", first.errorMessage);
      const next = await streamOpenCode(fakeModel(), userContext(["Find needle", "Next question"], ["bash"]), { sessionId }).result();
      assert.equal(next.stopReason, "toolUse", next.errorMessage);
      const calls = readInvocations(capture);
      assert.equal(calls.length, 3);
      assert.equal(calls[2]!.args.includes("--session"), false);
      assert.match(calls[2]!.stdin, /Find needle/);
      assert.match(calls[2]!.stdin, /Next question/);
      assert.doesNotMatch(calls[2]!.stdin, /Available Pi tools:/);
      await cleanupPiSessionState(sessionId);
    });
  } finally {
    await cleanupPiSessionState(sessionId);
    rmSync(dir, { recursive: true, force: true });
  }
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
  assert.match(unrecovered.errorMessage ?? "", /after one recovery attempt.*blocked native tool: "webfetch"/);
});

for (const version of ["2.1.5", "2.1.100", "2.2.0", "3.0.0"]) {
  test(`session_start warns that OpenCode ${version} exceeds the supported maximum`, async () => {
    const previousModels = process.env.OPENCODE_PI_MODELS;
    process.env.OPENCODE_PI_MODELS = "custom-model-a";
    try {
      const recorder = sessionStartRecorder();
      const ctx = recordingCtx();
      await withFakeOpenCode("", async () => {
        await opencodePiExtension(recorder.extension);
        await recorder.run(ctx);
      }, `opencode ${version}`);
      const warnings = ctx.notifications.filter((n) => n.level === "warning");
      assert.equal(warnings.length, 1);
      assert.equal(warnings[0]!.message, `opencode-pi: detected OpenCode ${version}. This bridge supports OpenCode up to 2.1.4. Please install a supported version.`);
    } finally {
      restoreEnv("OPENCODE_PI_MODELS", previousModels);
    }
  });
}

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

for (const version of ["1.19.0", "2.0.30"]) {
  test(`OpenCode ${version} recovers reasoning-only output through Pi tools`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-reasoning-recovery-"));
    const capture = join(dir, "calls.jsonl");
    const sessionId = `pi-reasoning-${version}`;
    const events: AssistantMessageEvent[] = [];
    try {
      await withFakeOpenCode(recoveryScript(capture, nativeRecoveryEvents, reasoningOnlyEvents), async () => {
        const stream = streamOpenCode(fakeModel(), userContext(["Fetch the page"], ["bash"]), { sessionId });
        for await (const event of stream) events.push(event);
        const message = await stream.result();
        assert.equal(message.stopReason, "toolUse", message.errorMessage);
        assert.deepEqual(message.content.map(c => c.type === "toolCall" ? { name: c.name, arguments: c.arguments } : c), [
          { name: "bash", arguments: { command: "rg needle ." } },
        ]);
        assert.equal(message.usage.input, 9);
        assert.equal(message.usage.output, 6);
        assert.equal(message.usage.totalTokens, 15);
        assert.equal(events.filter(e => e.type === "start").length, 1);
        assert.equal(events.filter(e => e.type === "done").length, 1);
        assert.equal(events.some(e => e.type === "thinking_delta" || e.type === "error"), false);
        const calls = readInvocations(capture);
        assert.equal(calls.length, 2);
        assert.equal(calls[1]!.args.includes("--session"), false);
        assert.match(calls[1]!.stdin, /Fetch the page/);
        assert.match(calls[1]!.stdin, /reasoning only/);
        assert.match(calls[1]!.stdin, /Available Pi tools: bash/);

        const next = await streamOpenCode(fakeModel(), userContext(["Fetch the page", "Next question"], ["bash"]), { sessionId }).result();
        assert.equal(next.stopReason, "toolUse", next.errorMessage);
        const nextCall = readInvocations(capture)[2]!;
        assert.equal(nextCall.args.includes("--session"), false);
        assert.match(nextCall.stdin, /Next question/);
        assert.doesNotMatch(nextCall.stdin, /Your previous attempt/);
      }, version);
    } finally {
      await cleanupPiSessionState(sessionId);
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

for (const version of ["1.19.0", "2.0.30"]) {
  for (const reasoning of [undefined, "off", "high"] as const) {
    for (const reply of ["answer", "text call", "reasoning call"] as const) {
      test(`OpenCode ${version} separates reasoning capture and display (${reasoning ?? "default"}, ${reply})`, async () => {
        const dir = mkdtempSync(join(tmpdir(), "pi-thinking-display-"));
        const capture = join(dir, "calls.jsonl");
        const marker = '<pi_tool_call>{"name":"read","arguments":{"path":"fixture.txt"}}</pi_tool_call>';
        const thinking = reply === "reasoning call" ? `Inspect the file. ${marker}` : "Private reasoning.";
        const events: AssistantMessageEvent[] = [];
        const observed: string[] = [];
        try {
          await withFakeOpenCode(recoveryScript(capture, [], [
            { type: "reasoning", part: { text: thinking } },
            { type: "text", part: { text: reply === "answer" ? "done" : reply === "text call" ? marker : "" } },
          ]), async () => {
            const stream = streamOpenCode({ ...fakeModel(), thinkingLevelMap: { off: "none", high: "max" } }, fakeContext(["read"]), {
              // Pi maps off to undefined; also cover explicit off from JS callers.
              reasoning: reasoning as SimpleStreamOptions["reasoning"],
              onProviderStreamEvent: event => { observed.push((event as { type: string }).type); },
            });
            for await (const event of stream) events.push(event);
            const message = await stream.result();
            assert.equal(message.stopReason, reply === "answer" ? "stop" : "toolUse", message.errorMessage);
            assert.equal(message.content.some(c => c.type === "thinking"), reasoning === "high");
            assert.equal(events.some(e => e.type.startsWith("thinking_")), reasoning === "high");
            assert.ok(observed.includes("reasoning"));
            const content = message.content.filter(c => c.type !== "thinking");
            if (reply === "answer") assert.deepEqual(content, [{ type: "text", text: "done" }]);
            else {
              assert.equal(content.length, 1);
              assert.equal(content[0]?.type, "toolCall");
              if (content[0]?.type === "toolCall") {
                assert.equal(content[0].name, "read");
                assert.deepEqual(content[0].arguments, { path: "fixture.txt" });
              }
            }
            const calls = readInvocations(capture);
            assert.equal(calls.length, 1);
            const args = calls[0]!.args;
            assert.equal(args.filter(arg => arg === "--thinking").length, 1);
            assert.equal(args[args.indexOf("-m") + 1], reasoning === "high" && version === "2.0.30" ? "opencode/fake-free#max" : "opencode/fake-free");
            assert.equal(args.includes("--variant"), reasoning === "high" && version === "1.19.0");
            if (args.includes("--variant")) assert.equal(args[args.indexOf("--variant") + 1], "max");
          }, version);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      });
    }
  }
}

test("reasoning-only recovery can answer without Pi tools", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-reasoning-answer-"));
  const capture = join(dir, "calls.jsonl");
  try {
    const message = await withFakeOpenCode(recoveryScript(capture, [
      { type: "text", part: { text: "Here is the answer." } },
    ], reasoningOnlyEvents), () => streamOpenCode(fakeModel(), fakeContext()).result());
    assert.equal(message.stopReason, "stop", message.errorMessage);
    assert.deepEqual(message.content, [{ type: "text", text: "Here is the answer." }]);
    assert.equal(readInvocations(capture).length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const [first, second] of [
  [reasoningOnlyEvents, reasoningOnlyEvents],
  [reasoningOnlyEvents, [{ type: "tool_use", part: { tool: "grep", state: { input: { pattern: "needle" } } } }]],
  [undefined, reasoningOnlyEvents],
] as const) {
  test(`reasoning-only and blocked-native failures share one recovery attempt (${first ? "reasoning" : "native"} to ${second === reasoningOnlyEvents ? "reasoning" : "native"})`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-reasoning-repeat-"));
    const capture = join(dir, "calls.jsonl");
    try {
      const message = await withFakeOpenCode(recoveryScript(capture, [...second], first && [...first]), () =>
        streamOpenCode(fakeModel(), fakeContext(["bash"])).result());
      assert.equal(message.stopReason, "error");
      assert.match(message.errorMessage ?? "", /after one recovery attempt/);
      assert.doesNotMatch(message.errorMessage ?? "", /<pi_tool_call>/);
      assert.equal(message.content.some(c => c.type === "text"), true);
      assert.equal(readInvocations(capture).length, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

for (const boundary of ["cancellation", "deadline"] as const) {
  test(`reasoning-only recovery does not retry after ${boundary}`, async t => {
    const dir = mkdtempSync(join(tmpdir(), "pi-reasoning-budget-"));
    const capture = join(dir, "calls.jsonl");
    const controller = new AbortController();
    const now = Date.now.bind(Date);
    let elapsed = 0;
    t.mock.method(Date, "now", () => now() + elapsed);
    try {
      const message = await withFakeOpenCode(recoveryScript(capture, nativeRecoveryEvents, reasoningOnlyEvents), () =>
        streamOpenCode(fakeModel(), fakeContext(["bash"]), {
          signal: controller.signal,
          timeoutMs: 10_000,
          onProviderStreamEvent: event => {
            if ((event as { type: string }).type !== "step_finish") return;
            if (boundary === "cancellation") controller.abort();
            else elapsed = 100_000;
          },
        }).result());
      assert.equal(message.stopReason, boundary === "cancellation" ? "aborted" : "error");
      assert.equal(readInvocations(capture).length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

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

  // Both the rejected attempt and its failed recovery release their listener.
  assert.equal(added, 2);
  assert.equal(removed, 2);
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
    assert.equal(invocations.length, 4);
    assert.equal(invocations[2]?.args.includes("--session"), false);
    assert.match(invocations[2]?.stdin ?? "", /malformed Pi tool call/);
    // The next Pi turn starts fresh, without the failed recovery's correction.
    assert.equal(invocations[3]?.args.includes("--session"), false);
    assert.match(invocations[3]?.stdin ?? "", /Conversation transcript/);
    assert.doesNotMatch(invocations[3]?.stdin ?? "", /Your previous attempt/);
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

test("OpenCode never compacts the session itself", async () => {
  // Its summary would reach Pi as reply text; Pi owns compaction.
  const message = await withFakeOpenCode(`const c = require("node:fs").readFileSync(process.env.OPENCODE_CONFIG_DIR + "/opencode.json", "utf8"); process.stdout.write(JSON.stringify({type:"text",part:{text:String(JSON.parse(c).compaction.auto)}}) + "\\n");`, () =>
    streamOpenCode(fakeModel(), fakeContext()).result());
  assert.deepEqual(message.content, [{ type: "text", text: "false" }]);
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

const v2Model = {
  id: "vision-free", modelID: "vision-free", providerID: "opencode", name: "Vision Free",
  enabled: true, status: "active", capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
  variants: [{ id: "none", settings: {} }, { id: "high", settings: {} }, { id: "max", settings: {} }],
  limit: { context: 1048576, output: 131072 }, cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
};

function v2DiscoveryScript(data: unknown): string {
  return `const assert = require("node:assert/strict");
assert.deepEqual(process.argv.slice(2), ["api", "--standalone", "get", "/api/model"]);
console.log(${JSON.stringify(JSON.stringify({ location: { directory: "/fixture" }, data }))});`;
}

test("OpenCode 2 discovery reads metadata and excludes paid, tiered, disabled and foreign models", async () => {
  const previous = process.env.OPENCODE_PI_MODELS;
  delete process.env.OPENCODE_PI_MODELS;
  try {
    const { models, error } = await withFakeOpenCode(v2DiscoveryScript([
      v2Model,
      { ...v2Model, id: "paid-free", cost: [{ input: 1, output: 2 }] },
      { ...v2Model, id: "tiered-free", cost: [{ input: 0, output: 0 }, { tier: { type: "context", size: 200000 }, input: 1, output: 2 }] },
      { ...v2Model, id: "disabled-free", enabled: false },
      { ...v2Model, id: "retired-free", status: "deprecated" },
      { ...v2Model, providerID: "opencode-go" },
      null,
    ]), () => discoverModels(), "opencode v2.0.30");
    assert.equal(error, undefined);
    assert.deepEqual(models.map(m => m.id), ["opencode/vision-free"]);
    assert.equal(models[0]?.reasoning, true);
    assert.equal(models[0]?.image, true);
    assert.equal(models[0]?.contextWindow, 1048576);
    assert.equal(models[0]?.maxTokens, 131072);
    assert.equal(models[0]?.thinkingLevelMap?.off, "none");
    assert.equal(models[0]?.thinkingLevelMap?.xhigh, "max");
  } finally { restoreEnv("OPENCODE_PI_MODELS", previous); }
});

test("OpenCode 2 forced discovery enriches explicit paid models", async () => {
  const previous = process.env.OPENCODE_PI_MODELS;
  process.env.OPENCODE_PI_MODELS = "opencode/vision-free";
  try {
    const { models, error } = await withFakeOpenCode(v2DiscoveryScript([
      { ...v2Model, cost: [{ input: 3, output: 15, cache: { read: 0.3, write: 0 } }] },
    ]), () => discoverModels({ forceDiscovery: true }), "2.0.30");
    assert.equal(error, undefined);
    assert.deepEqual(models[0]?.cost, { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 });
    assert.equal(models[0]?.image, true);
  } finally { restoreEnv("OPENCODE_PI_MODELS", previous); }
});

test("OpenCode 2 run uses the isolated cwd, standalone server and model variant syntax", async () => {
  const message = await withFakeOpenCode(`
const assert = require("node:assert/strict"), path = require("node:path");
assert.deepEqual(process.argv.slice(2), ["run", "-m", "opencode/fake-free#max", "--agent", "pi-model", "--format", "json", "--standalone", "--thinking"]);
assert.equal(process.cwd(), require("node:fs").realpathSync(process.env.PWD));
assert.equal(process.cwd(), require("node:fs").realpathSync(path.dirname(process.env.OPENCODE_CONFIG_DIR)));
process.stdout.write(JSON.stringify({ type: "text", part: { text: "v2 reply" } }) + "\\n");
`, () => streamOpenCode({ ...fakeModel(), thinkingLevelMap: { xhigh: "max" } }, fakeContext(), { reasoning: "xhigh" }).result(), "opencode v2.0.30");
  assert.equal(message.stopReason, "stop", message.errorMessage);
  assert.deepEqual(message.content, [{ type: "text", text: "v2 reply" }]);
});

for (const executable of ["relative", "PATH"] as const) {
  test(`OpenCode 2 launches a configured ${executable} executable from its isolated project`, async () => {
    const previousPath = process.env.PATH;
    const dir = mkdtempSync(join(process.cwd(), ".opencode-pi-bin-"));
    try {
      const message = await withFakeOpenCode(fakeEventScript([
        { type: "text", part: { text: "configured executable ran" } },
      ]), async () => {
        const bin = join(dir, "opencode.js");
        copyFileSync(process.env.OPENCODE_PI_BIN!, bin);
        chmodSync(bin, 0o755);
        if (executable === "relative") {
          process.env.OPENCODE_PI_BIN = relative(process.cwd(), bin);
        } else {
          process.env.OPENCODE_PI_BIN = basename(bin);
          process.env.PATH = `${dirname(bin)}${process.platform === "win32" ? ";" : ":"}${previousPath ?? ""}`;
        }
        return streamOpenCode(fakeModel(), fakeContext()).result();
      }, "opencode v2.0.30");
      assert.equal(message.stopReason, "stop", message.errorMessage);
      assert.deepEqual(message.content, [{ type: "text", text: "configured executable ran" }]);
    } finally {
      restoreEnv("PATH", previousPath);
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("OpenCode 2 shell calls translate to Pi bash without dropping unsupported execution options", () => {
  const translate = (input: unknown) => translateNativeToolCall("shell", input, new Set(["bash"]), ["/tmp/project"]);
  assert.deepEqual(translate({ command: "npm test", timeout: 1501 }), { name: "bash", arguments: { command: "npm test", timeout: 2 } });
  assert.equal(translate({ command: "npm test", background: true }), undefined);
  assert.equal(translate({ command: "npm test", cwd: "/other" }), undefined);
  assert.equal(translate({ command: "npm test", timeout: 0 }), undefined);
});

for (const version of ["1.19.0", "2.0.9", "2.0.29", "2.0.30", "2.0.31", "2.0.32", "2.1.2", "2.1.4"]) {
  test(`session_start accepts OpenCode ${version} up to the supported maximum`, async () => {
    const previous = process.env.OPENCODE_PI_MODELS;
    process.env.OPENCODE_PI_MODELS = "big-pickle";
    try {
      const recorder = sessionStartRecorder(), ctx = recordingCtx();
      await withFakeOpenCode("", async () => {
        await opencodePiExtension(recorder.extension);
        await recorder.run(ctx);
      }, `opencode v${version}`);
      assert.deepEqual(ctx.notifications.filter(n => n.level === "warning"), []);
    } finally { restoreEnv("OPENCODE_PI_MODELS", previous); }
  });
}
