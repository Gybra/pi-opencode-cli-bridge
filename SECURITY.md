# Security policy

## Reporting a problem

Never include prompts, conversation history, images, API keys, auth files or session databases in a public report. Use a minimal, sanitized reproduction. For sensitive findings, contact the repository maintainer privately before disclosing details.

## Trust boundaries

- This extension and the OpenCode executable run with your user's operating-system permissions. Neither is a sandbox.
- Requests are delegated to the real OpenCode CLI. The extension does not directly read credentials, but the subprocess inherits the environment and uses OpenCode's own configuration and authentication.
- System instructions, tool declarations, transcript text and image attachments can reach the selected model provider. Provider retention and training policies apply.
- The current Pi tool list is checked before marker responses become Pi tool calls. Pi remains responsible for argument validation and tool permission checks.
- A generated OpenCode plugin is intended to block native tool execution before side effects. Native declarations remain visible to the model. This protection depends on the CLI plugin contract and is not a security boundary against a hostile local process or extension.
- Temporary project directories and OpenCode session records are removed best-effort. Pi's own conversation history is not deleted by the extension.

## Known gaps

The [code review](https://github.com/Gybra/pi-opencode-cli-bridge/blob/main/docs/code-review.md) records inherited weaknesses, including incomplete process termination, an unvalidated CLI event envelope, unawaited shutdown cleanup and missing negative coverage for the native-tool blocker. The working live text and Pi-tool tests do not prove those cases safe.

Only the current development branch is maintained. There is no npm release yet and no independently audited security guarantee.
