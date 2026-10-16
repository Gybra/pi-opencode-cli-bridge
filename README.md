# pi-opencode-cli-bridge

Use the local [OpenCode CLI](https://opencode.ai) as a model backend for [Pi Coding Agent](https://pi.dev).

This is an unofficial bridge, not an OpenCode or Pi product. It registers the `opencode-cli` provider and sends model requests through `opencode run`.

## Why this fork exists

The bridge started as `opencode-pi`. Rodrigo Jager's fork then kept OpenCode's native tool declarations on each request, which OpenCode's free tier expects, and blocked their execution with a plugin. On Pi 1.2 that version stopped working: Pi now carries the system prompt and tool list inside the transcript, and every request crashed with `message.content.map is not a function`.

This fork fixes that and closes the gaps found while reviewing the code:

- **Works with Pi 1.2.** The current system prompt, prompt sections and tool changes are read from the transcript, so tool calls work again.
- **Native OpenCode tools cannot run, even if the safety plugin fails.** A test with the real CLI showed that the plugin alone failed open: if it was missing or crashed at startup, OpenCode wrote files. The bridge's agent now also requires permission for every native tool, which `opencode run` refuses automatically.
- **No hung turns or orphaned processes.** Timeouts and cancellation kill the OpenCode process group, even when it ignores `SIGTERM`.
- **Unexpected CLI output no longer crashes Pi.** Malformed events end the turn with an error.
- **Clean shutdown.** Pi waits for temporary directories and OpenCode session records to be removed.
- **Fewer failed turns when the model reaches for OpenCode's own tools.** A blocked native `bash`, `read`, `write`, `edit`, `grep` or `glob` call with a Pi equivalent is handed to Pi as a normal tool call. For other tools, the model is told how to ask Pi instead and can recover in the same run.
- **Standard Pi provider hooks.** `onPayload`, `onResponse` and `onProviderStreamEvent` work as with built-in providers.
- **Its own npm package**, with the original authors credited.

## Credits and fork history

This package builds on other people's work:

- **[luongnv89 and the pi-extensions contributors](https://github.com/luongnv89/pi-extensions/tree/main/extensions/opencode-pi)** created the original `opencode-pi` extension.
- **[Rodrigo Manuel Jager Pinheiro](https://github.com/rodrigojager/opencode-pi)** extracted the extension and added the native-tool execution blocker for compatibility with OpenCode's free-tier request validation, plus Windows executable resolution.
- **[Gybra](https://github.com/Gybra/pi-opencode-cli-bridge)** maintains this fork, adds Pi 1.2 transcript compatibility, process and protocol hardening, provider hooks, a second native-tool guard with real-CLI integration tests, and packages it under a distinct name.

The original MIT copyright notice is preserved in [LICENSE](LICENSE). The new package name does not change that attribution.

## Requirements

- Node.js **22.19.0 or newer**.
- Pi Coding Agent **1.2.0 or newer**; the development SDK is pinned to 1.2.0.
- OpenCode installed on the same machine and available on `PATH`, or selected with `OPENCODE_PI_BIN`. Supports OpenCode up to **2.0.31**. Real-CLI integration tests cover **1.19.0** and **2.0.31**; intermediate releases are not individually verified.

Check OpenCode before starting Pi:

```sh
opencode --version
opencode models
# Metadata on OpenCode 2.x:
opencode api --standalone get /api/model
# Metadata on OpenCode 1.x:
opencode models opencode --verbose
```

## Install

Install from npm with Pi's package manager:

```sh
pi install npm:pi-opencode-cli-bridge
```

Or track the GitHub repository directly:

```sh
pi install git:github.com/Gybra/pi-opencode-cli-bridge
```

Then restart Pi or run `/reload`. For the first switch from another bridge, restarting avoids retaining an old provider in memory.

If you already installed another `opencode-pi` source, use `pi list` and remove that source first. For example:

```sh
pi uninstall npm:opencode-pi
# Or, if this is the source shown by pi list:
pi uninstall git:github.com/rodrigojager/opencode-pi
```

The npm packages `opencode-pi`, `pi-opencode` and `pi-opencode-bridge` are different packages.

Manage the installation with `pi list`, `pi update <source>` and `pi uninstall <source>`, using the source you installed (`npm:pi-opencode-cli-bridge` or `git:github.com/Gybra/pi-opencode-cli-bridge`).

## Usage

Choose an OpenCode model from `/model`, or start Pi directly:

```sh
pi --provider opencode-cli --model opencode/deepseek-v4.1-flash-free --thinking off
```

For an isolated text smoke test:

```sh
pi -p --no-session --provider opencode-cli --model opencode/deepseek-v4.1-flash-free --thinking off "Reply with exactly OK"
```

Model availability changes. Refresh the list with `/opencode-pi update` if the example model is no longer listed. Bundled free models do not require an OpenCode login; availability and server-side acceptance are controlled by OpenCode.

The provider ID `opencode-cli` and the command `/opencode-pi` retain their upstream names for compatibility:

```text
/opencode-pi status
/opencode-pi models
/opencode-pi test
/opencode-pi update
/opencode-pi help
```

The `test` command prints diagnostic commands; it does not send a model request itself.

## Configuration

| Environment variable | Purpose |
| --- | --- |
| `OPENCODE_PI_BIN` | Path to the OpenCode executable. Defaults to `opencode`. |
| `OPENCODE_PI_MODELS` | Comma- or space-separated model IDs. IDs without a provider prefix receive `opencode/`. |

An explicit model list skips startup discovery and starts with conservative fallback capabilities. Run `/opencode-pi update` to discover image input, reasoning variants, token limits and costs.

Without an override, discovery selects active `opencode/` models whose reported input and output costs are zero. OpenCode 2.x discovery uses the local `/api/model` endpoint, excludes disabled models, and checks every pricing tier before selecting a free model. For explicitly configured tiered models, displayed costs conservatively use the highest reported rate for each cost field. When cost metadata is missing, selection falls back to the upstream free-model naming rules. Review costs before explicitly selecting a paid model.

## How it works

1. The extension discovers models through the local CLI.
2. It replays Pi's transcript system messages to recover the current system prompt and tool declarations, including later changes.
3. It creates a temporary OpenCode project containing a `pi-model` agent whose permissions are all `ask`. Non-interactive `opencode run` rejects those permission requests automatically, while native tool declarations remain on the model request. On 1.x, a generated `tool.execute.before` plugin provides a second guard; 2.x relies on the permission guard, not the legacy plugin.
4. It sends the prompt over standard input to `opencode run --format json`. On 2.x, it uses a private `--standalone` server, sets the subprocess working directory instead of the removed `--dir` flag, and selects reasoning variants with `provider/model#variant` instead of `--variant`. User and tool-result images are written to temporary files and attached only when the model supports images.
5. If the model calls a native OpenCode tool anyway, the call is still blocked. When every native call in that step has a Pi equivalent in the current tool list (`bash` or 2.x `shell`, `read`, `write`, `edit` with a single replacement, `grep`, and `glob` as `find`), the bridge stops OpenCode and returns them as Pi tool calls. Paths inside the temporary project become relative to Pi's working directory. Otherwise OpenCode continues and the model can correct itself. If it ends without recovering, the bridge makes one fresh attempt with the original transcript, the blocked native calls and their arguments, and a correction referring to the available Pi tool descriptions and schemas. The model is asked to choose tools that can perform the required operation, not merely tools with similar names, and generate arguments for their Pi schemas. This is a model-directed fallback, not an automatic conversion or a guarantee of functional equivalence. If no suitable tool exists, including when Pi exposes no tools, the model is asked to explain the limitation and request the missing content or access (for example, the text of an unreadable web page). Native tools stay blocked on both attempts, which share the turn timeout. A second failure produces an error rather than retrying indefinitely.
6. Text markers such as `<pi_tool_call>{"name":"read","arguments":{"path":"example.txt"}}</pi_tool_call>` become Pi tool calls. Tool names must be in the current Pi tool list; execution then follows Pi's normal validation and permission pipeline. DeepSeek models sometimes write their native DSML tool-call blocks (`<｜DSML｜invoke name="...">`) as text instead; complete blocks are converted the same way, with incomplete blocks rejected rather than executed.
7. Successful continuation turns reuse an OpenCode session and send only the new transcript. Changes to the model, prompt, tools or transcript prefix start a fresh session.

A turn containing only reasoning, with no answer or usable Pi tool call, also gets one fresh recovery attempt instead of silently ending the conversation. The model is asked to answer or request an available Pi tool; normal text answers and valid calls found in reasoning are unchanged. The bridge always captures CLI reasoning blocks internally, even when Pi thinking is off or unset, so hidden reasoning can still trigger recovery or supply a valid Pi call. This uses the CLI's display flag, not a higher model reasoning variant. Reasoning is shown in Pi only when a non-off thinking level is requested.

Rejected malformed Pi markers, invalid tool-call payloads and incomplete DeepSeek DSML calls also get a fresh attempt to regenerate the call, rather than a generic empty-response error. The bridge does not execute rejected calls or infer missing arguments; valid sibling calls and remaining prose retain their existing behavior. Unavailable Pi tools still fail without retry. Reasoning-only, malformed-call and blocked-native failures share the same single retry and remaining turn timeout. If recovery fails, Pi receives an explicit error, not another thinking-only message.

Pi's provider instrumentation hooks follow the CLI transport, not OpenCode's internal HTTP traffic:

- `onPayload` receives `{ prompt }`, the exact text written to the CLI's standard input. Returning `{ prompt: "..." }` replaces it; any other non-`undefined` value fails the turn. A turn with a payload hook always starts a fresh OpenCode session.
- `onResponse` is called once the subprocess has started, with `status: 0` (no HTTP status exists) and the header `x-pi-transport: opencode-cli`.
- `onProviderStreamEvent` receives each validated `--format json` event in order, and is awaited before the event is processed. Raw observers can receive reasoning events even when thinking is hidden in Pi; the display setting does not redact transport instrumentation.
- Provider-scoped `env` values are passed to the subprocess. The bridge's own configuration directory and update-check settings always take precedence.

Reasoning variants, image support and token limits follow CLI discovery. Token usage is taken from CLI events when available, otherwise estimated, and includes both attempts when recovery is needed. Session records and temporary project directories are cleaned up on a best-effort basis.

## Security, privacy and limits

- Prompts, system instructions, tool declarations, conversation text and attached images pass to OpenCode and its model provider. Do not send confidential data unless that provider's policies are suitable.
- The extension does not directly extract credentials or call model HTTP endpoints. The OpenCode subprocess still runs as your user and can use its own configuration, credentials and inherited environment.
- The native-tool guard is a guard rail, **not a sandbox**. Integration tests run the real OpenCode 1.19.0 and 2.0.31 CLIs against a local model fixture that requests native `write` and `bash`/`shell` calls, and check that neither runs with the legacy plugin intact, missing, or failing at startup. Other OpenCode versions, tools contributed by your own global OpenCode configuration (for example MCP servers), and a hostile local process are not covered.
- Pi and OpenCode can both retain local conversation data. Best-effort cleanup is not a guarantee of secure deletion.
- Free-tier model availability and accepted request shapes can change. This fork makes no guarantee of continued access or compliance with a hosted provider's terms; review the applicable terms yourself.
- Live tests with DeepSeek v4.1 Flash Free used thinking off. The first high-thinking test timed out; no default thinking setting is changed by this package.
- At startup Pi warns when your OpenCode version exceeds the supported maximum, **2.0.31**, or its version cannot be determined.
- Timeouts and cancellation escalate from `SIGTERM` to `SIGKILL` on the CLI's process group after 250 ms; on Windows the whole process tree is ended with `taskkill /T /F` (not tested on Windows). If OpenCode quits before reading the prompt, the turn shows OpenCode's own error rather than a broken-pipe error. Malformed or unexpected CLI events end the turn with an error instead of crashing Pi. Shutdown waits for session cleanup.

See [SECURITY.md](SECURITY.md) for the trust boundaries and [docs/code-review.md](https://github.com/Gybra/pi-opencode-cli-bridge/blob/main/docs/code-review.md) for what was fixed and what remains. This is an experimental, unaudited fork.

## Development

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
OPENCODE_PI_INTEGRATION_BIN="$(which opencode)" npm run test:integration
npm pack --dry-run
```

`npm test` uses a fake OpenCode executable. `npm run test:integration` needs the real OpenCode CLI at version 1.19.0 or 2.0.31 (on `PATH` or in `OPENCODE_PI_INTEGRATION_BIN`), runs it with isolated home and data directories against a local model fixture, and makes no network request. Neither suite needs API credentials. Development SDKs are pinned; Pi supplies those packages at runtime. The npm archive includes the extension source, README, security policy and license, not tests or installed dependencies.

## License

MIT. See [LICENSE](LICENSE).
