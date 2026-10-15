# pi-opencode-cli-bridge

Use the local [OpenCode CLI](https://opencode.ai) as a model backend for [Pi Coding Agent](https://pi.dev).

This is an unofficial bridge, not an OpenCode or Pi product. It registers the `opencode-cli` provider and sends model requests through `opencode run`.

## Credits and fork history

This package builds on other people's work:

- **[luongnv89 and the pi-extensions contributors](https://github.com/luongnv89/pi-extensions/tree/main/extensions/opencode-pi)** created the original `opencode-pi` extension.
- **[Rodrigo Manuel Jager Pinheiro](https://github.com/rodrigojager/opencode-pi)** extracted the extension and added the native-tool execution blocker for compatibility with OpenCode's free-tier request validation, plus Windows executable resolution.
- **[Gybra](https://github.com/Gybra/pi-opencode-cli-bridge)** maintains this fork, adds Pi 1.2 transcript compatibility and regression tests, and packages it under a distinct name.

The original MIT copyright notice is preserved in [LICENSE](LICENSE). The new package name does not change that attribution.

## Requirements and tested support

- Node.js **22.19.0 or newer**.
- Pi Coding Agent **1.2.0 or newer**; the development SDK is pinned to 1.2.0.
- OpenCode installed on the same machine and available on `PATH`, or selected with `OPENCODE_PI_BIN`.

Check OpenCode before starting Pi:

```sh
opencode --version
opencode models opencode --verbose
```

| Platform | Verification |
| --- | --- |
| macOS | Tested with Pi 1.2.0 and OpenCode 1.19.0: DeepSeek v4.1 Flash Free text response and a file read through Pi's own tool, with thinking off. |
| Linux | Not yet verified end to end against a real model. |
| Windows | Experimental. Native executable resolution is inherited from Rodrigo's fork; real-model behavior has not been verified here. |

OpenCode 2.x has not been verified. Its CLI arguments may differ.

## Install

Install **this fork from GitHub** with Pi's package manager:

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

The intended npm package name is **`pi-opencode-cli-bridge`**. Until an npm release is published, use the GitHub command above. The npm packages `opencode-pi`, `pi-opencode` and `pi-opencode-bridge` are different packages.

Manage this installation with:

```sh
pi list
pi update git:github.com/Gybra/pi-opencode-cli-bridge
pi uninstall git:github.com/Gybra/pi-opencode-cli-bridge
```

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

Without an override, discovery selects active models whose reported input and output costs are zero. When cost metadata is missing, selection falls back to the upstream free-model naming rules. Review costs before explicitly selecting a paid model.

## How it works

1. The extension discovers models through the local CLI.
2. It replays Pi's transcript system messages to recover the current system prompt and tool declarations, including later changes.
3. It creates a temporary OpenCode project containing a `pi-model` agent and a `tool.execute.before` plugin. Native tool declarations remain on the request, while the plugin is intended to stop their execution.
4. It sends the prompt over standard input to `opencode run --format json`. User and tool-result images are written to temporary files and attached only when the model supports images.
5. Text markers such as `<pi_tool_call>{"name":"read","arguments":{"path":"example.txt"}}</pi_tool_call>` become Pi tool calls. Tool names must be in the current Pi tool list; execution then follows Pi's normal validation and permission pipeline.
6. Successful continuation turns reuse an OpenCode session and send only the new transcript. Changes to the model, prompt, tools or transcript prefix start a fresh session.

Reasoning variants, image support and token limits follow CLI discovery. Token usage is taken from CLI events when available, otherwise estimated. Session records and temporary project directories are cleaned up on a best-effort basis.

## Security, privacy and limits

- Prompts, system instructions, tool declarations, conversation text and attached images pass to OpenCode and its model provider. Do not send confidential data unless that provider's policies are suitable.
- The extension does not directly extract credentials or call model HTTP endpoints. The OpenCode subprocess still runs as your user and can use its own configuration, credentials and inherited environment.
- The native-tool blocker is a guard rail, **not a sandbox**. Its behavior depends on OpenCode loading and honoring the plugin. It has not yet received an end-to-end negative test proving that native tools cannot run.
- Pi and OpenCode can both retain local conversation data. Best-effort cleanup is not a guarantee of secure deletion.
- Free-tier model availability and accepted request shapes can change. This fork makes no guarantee of continued access or compliance with a hosted provider's terms; review the applicable terms yourself.
- Thinking off passed the live tests above. The first high-thinking test timed out; no default thinking setting is changed by this package.
- The inherited process handling and CLI event parser have outstanding defects described in the [code review](https://github.com/Gybra/pi-opencode-cli-bridge/blob/main/docs/code-review.md). In particular, a process that ignores `SIGTERM` can exceed its timeout, and a JSON `null` event can still crash the host.

See [SECURITY.md](SECURITY.md) for the trust boundaries. This is an experimental fork, not a claim that the inherited code has been fully hardened.

## Development

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
npm pack --dry-run
```

The automated suite uses a fake OpenCode executable and does not require API credentials or a real model request. Development SDKs are pinned; Pi supplies those packages at runtime. The npm archive includes the extension source, README, security policy and license, not tests or installed dependencies.

## License

MIT. See [LICENSE](LICENSE).
