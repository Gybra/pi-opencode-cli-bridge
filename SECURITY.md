# Security policy

## Reporting a problem

Never include prompts, conversation history, images, API keys, auth files or session databases in a public report. Use a minimal, sanitized reproduction. For sensitive findings, contact the repository maintainer privately before disclosing details.

## Trust boundaries

- This extension and the OpenCode executable run with your user's operating-system permissions. Neither is a sandbox.
- Requests are delegated to the real OpenCode CLI. The extension does not directly read credentials, but the subprocess inherits the environment and uses OpenCode's own configuration and authentication.
- System instructions, tool declarations, transcript text and image attachments can reach the selected model provider. Provider retention and training policies apply.
- The current Pi tool list is checked before marker responses become Pi tool calls. Pi remains responsible for argument validation and tool permission checks.
- Native OpenCode tools are guarded by an agent permission of `ask` for everything, which non-interactive `opencode run` rejects. On 1.19.0 a generated `tool.execute.before` plugin provides a second guard; on 2.0.31 the bridge relies on permissions, not that legacy plugin. Native declarations remain visible to the model. Real-CLI integration tests on both releases request `write` and `bash`/`shell` side effects and verify that neither executes with the legacy plugin intact, missing, or failing. These guards are not a security boundary against a hostile local process, your own OpenCode configuration (it is loaded and may add tools or agent overrides), or other OpenCode versions.
- Temporary project directories and OpenCode session records are removed best-effort. Pi's own conversation history is not deleted by the extension.

## Known gaps

The [code review](https://github.com/Gybra/pi-opencode-cli-bridge/blob/main/docs/code-review.md) records the findings fixed in 0.1.0 and the residual risks. Only the latest release is maintained. There is no independently audited security guarantee.
