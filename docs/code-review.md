# Code review: OpenCode CLI bridge

## Scope and verdict

This bridge delegates Pi model turns to an OpenCode subprocess, then converts text markers into Pi tool calls. The expected load is one local user with sequential agent turns, plus bounded state for several Pi sessions. It is not a server or a messaging-account bridge.

Reviewed the model discovery, prompt serialization, tool-marker parser, subprocess I/O, session reuse, temporary files, package metadata and tests. Compared the implementation with installed `pi-whatsapp` 0.3.0 and `@gybra/pi-tg` 0.2.0, their GitHub test workflows, and Pi 1.2.0's extension and custom-provider documentation.

**Verdict: the Pi 1.2 crash fix works, but the inherited process and event handling is not yet at the same hardening level as the reference integrations.** The findings below are deliberately not hidden behind a green unit suite.

## What already follows the expected practices

- The actual OpenCode CLI is invoked with an argument array, not a constructed shell command. Prompts go through standard input.
- Model selection uses discovered activity, costs and capabilities rather than assigning capabilities to every model.
- Tool marker payloads are parsed and checked against the current Pi tool names. Pi remains responsible for argument validation and permissions.
- Pi's transcript helpers now recover system-prompt sections and tool changes; malformed transcript preparation returns a stream error rather than an unhandled rejection.
- Session reuse checks model, tools, prompt and transcript prefix. Tracked session state is bounded, and temporary directories are created with `mkdtemp`.
- Regression tests cover prompt and tool-state replay, image validation, session continuation, parser behavior and several abort paths.

The signed-send approval flow in pi-whatsapp and pi-tg solves a different problem. Copying their account-pairing or message-signing machinery into a model provider would not fix this bridge's process or protocol defects.

## Must fix before treating this fork as hardened

### 1. Timeout and cancellation do not guarantee process termination

**Where:** `src/index.ts:1448-1456` and the wait for `close` at `src/index.ts:1547-1556`. Discovery and session-deletion helpers have similar termination assumptions.

**Concrete case:** a fake OpenCode process installs a no-op `SIGTERM` handler and exits naturally after three seconds. With `timeoutMs: 1000`, the bridge returned only after about 3399 ms. A process that never exits can keep the stream pending indefinitely. The original live high-thinking test also remained pending beyond the expected turn bound, although that alone does not establish the CLI's internal cause.

**Smallest fix:** make termination bounded: send `SIGTERM`, escalate after a short grace period, settle the stream deterministically and clear listeners and timers on every path. Add tests using a subprocess that ignores `SIGTERM`, for both timeout and abort. Apply the same rule to discovery and deletion helpers rather than adding separate inconsistent policies.

**If skipped:** cancellation can leave Pi waiting and leave child processes alive.

### 2. Valid JSON with an invalid event envelope still crashes Pi

**Where:** `src/index.ts:1462-1479`, called from the stdout `data` handler.

**Concrete case:** a fake CLI writes `null\n`. JSON parsing succeeds, then `event.sessionID` throws `TypeError: Cannot read properties of null (reading 'sessionID')`. The host process exits with code 1. The outer async `try/catch` does not catch exceptions thrown later by an EventEmitter callback.

**Smallest fix:** decode CLI events from `unknown`, validate the envelope before reading fields, and route callback failures into the stream's error/termination path. Test null, scalar and malformed events without terminating the host process.

**If skipped:** an unexpected CLI event can reproduce a full host crash despite the transcript fix.

## Should fix

### 3. Shutdown starts cleanup without letting Pi await it

**Where:** `src/index.ts:1833-1835`.

The `session_shutdown` callback calls `void cleanupPiSessionState()`. The reference integrations return an async handler and await cleanup before disposing session resources. Here Pi receives no promise to wait for, so directory removal is not guaranteed to finish at shutdown or reload. OpenCode session deletion is separately fire-and-forget.

**Smallest fix:** return or await the cleanup promise from the handler. Keep cleanup idempotent and bound any awaited subprocess deletion. Add a shutdown test that waits for the actual cleanup, not only the helper in isolation.

**If skipped:** project directories or OpenCode session data can remain after shutdown. Documentation must continue to describe deletion as best-effort.

### 4. Pi's provider instrumentation callbacks are ignored

**Where:** `streamOpenCode` in `src/index.ts`, including subprocess setup and `handleLine`.

Pi's custom-provider contract includes `onPayload`, `onResponse` and `onProviderStreamEvent`. A runtime probe supplied all three callbacks; a successful fake response invoked none. Request inspection and transformations supplied by callers are therefore not honored, and raw event observers see no CLI events.

**Smallest fix:** define the CLI payload/response representation, honor payload replacement before sending, and await event observation in stream order. Add tests for the observable callback behavior, including replacement, without asserting on the test double alone.

**If skipped:** debugging and request-transformation extensions behave differently for this provider. Callers cannot rely on their normal provider hooks here.

### 5. The native-tool blocker has no negative integration coverage

**Where:** generated `tool.execute.before` plugin in `src/index.ts:1299-1329`; current tests in `src/index.test.ts`.

The tests replace OpenCode with a fake executable. The live Pi read test proves that marker calls can reach Pi, not that OpenCode's native file or shell tools cannot execute. This fork keeps native declarations enabled and relies on the plugin being loaded and invoked before side effects.

**Smallest fix:** test the actual generated blocker and add a negative test against a pinned supported OpenCode version. Attempt a native tool write to an isolated sentinel path and prove the file is not created; also test that plugin loading failure cannot silently produce an unrestricted request.

**If skipped:** the main execution guard depends on an external plugin contract that the suite does not exercise. It must not be described as a sandbox or an audited guarantee.

## Packaging and documentation corrected in this task

The original package still targeted Pi 0.75.4, declared Node 18 support, lacked an explicit development SDK and Node type setup, pointed its install instructions at the upstream npm package, and did not include the original MIT license file. The earlier local build used symlinks to host SDKs, which was not a reproducible contributor setup.

This fork now uses a distinct package identity, Node 22.19+ and documented Pi 1.2+ requirements; host packages remain peer dependencies, with pinned development copies and Node types. It adds separate typechecking, a test timeout, a complete npm lockfile, archive allowlisting, and Linux/macOS CI modeled on the reference repositories. Credits and the original MIT notice are preserved. README security and terms statements describe limits rather than asserting universal safety.

## Structure follow-up

`src/index.ts` combines discovery, transcript building, marker parsing, process management and extension registration. The reference integrations separate those responsibilities. When fixing findings 1 and 2, extracting process/protocol handling into focused modules would let the failure paths be tested directly. A framework or a broad rewrite is not needed, and splitting files solely to meet a line-count target is not recommended.

## Verification and limits

- Prior regression cycle: the three transcript/error-preparation tests failed before the compatibility fix, then passed after it.
- Packaging verification: a fresh `npm ci`, typechecking and all 69 tests passed on Node 22.19.0. The first CI run exposed an inherited lifecycle test that restored the real CLI before invoking its handler; that fixture scope is now corrected. The targeted test and the full 69-test suite also pass with `OPENCODE_PI_BIN` forced to a nonexistent executable, so this verification does not depend on a locally installed OpenCode CLI.
- Live macOS checks: DeepSeek v4.1 Flash Free returned `OK`, and a Pi `read` tool call read a fresh test file and returned its exact contents. Both used thinking off.
- Review probes reproduced findings 1 and 2 in isolated Node processes and demonstrated the missing callbacks in finding 4. Test processes and files were bounded and isolated from personal data.
- Not checked: real-model behavior on Linux or Windows, OpenCode 2.x, high-thinking reliability, adversarial native-tool execution, provider legal compliance or upstream service internals.
- This review was performed by the implementing assistant, not an independent reviewer. It changed package/documentation setup, not the inherited defects above.
