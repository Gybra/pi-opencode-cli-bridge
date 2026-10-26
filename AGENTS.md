# General Software Engineering Principles

These rules are mandatory for every code change, regardless of language, framework, or project. Do not treat them as optional suggestions.

Before writing code, understand the requirement and the relevant existing code. Do not proceed with the first plausible idea without checking whether an existing, simpler, or more direct solution would work better. Choose the smallest solution that fully meets the need. If a rule cannot be followed, explain why before proceeding.

## Choose the Smallest Correct Solution

You MUST implement the simplest solution that fully meets the requirement.

You MUST NOT add abstractions, layers, helpers, configuration, indirection, or generalized infrastructure for hypothetical future needs. Add them only when they provide a concrete benefit to the current work, such as correctness, security, necessary reuse, testability, or meaningfully reduced duplication.

## Preserve Responsibility and Domain Boundaries

Each class and module MUST have a clear, cohesive responsibility and belong to the domain that owns that behavior.

Keep domain-specific rules with their owning domain. A workflow may coordinate multiple domains when that is its purpose, but the coordination MUST be explicit and live at the appropriate application boundary. Do not move domain logic into unrelated domains or create unnecessary cross-domain dependencies.

## Keep Functions Focused and Compact

You MUST keep functions focused on a clear purpose and compact enough to understand in one pass.

Split a function when doing so clarifies distinct responsibilities or makes the main workflow easier to follow. Do not split mechanically by line count, or create tiny helpers that only move code around and make the flow harder to trace.

## Keep Files Manageable

When a file becomes excessively large or difficult to navigate, you MUST split it into cohesive, clearly named files while preserving responsibility and domain boundaries.

Split by responsibility and domain, not by arbitrary line counts. Do not fragment cohesive code or introduce extra indirection merely to make files shorter.

## Write for Human Understanding

You MUST use clear names, straightforward control flow, and familiar patterns. Do not use cleverness or excessive compression at the expense of readability.

Make the intent easy to understand for someone reviewing or maintaining the code. Remove duplication and unnecessary structure, but keep boundaries that make the code clearer.

## Keep Exported Types in a Types Module

You MUST declare every exported `type` and `interface` in the package's types module (`src/types.ts`), never in a file that also exports functions, classes, or values. Import them with `import type`.

A type used by only one file stays in that file, unexported.

## pi-opencode-cli-bridge constraints

Pi extension that registers the `opencode-cli` provider and sends model requests through the local `opencode run` CLI.

- Native OpenCode tools must never execute: keep the `ask` permission guard and, on OpenCode 1.x, the `tool.execute.before` plugin. Any change to tool handling needs the real-CLI integration tests (`npm run test:integration`) to pass on every supported OpenCode release.
- Never claim support for an OpenCode version the integration tests have not run against. `MAX_SUPPORTED_OPENCODE_VERSION` stays in `src/index.ts`, where the release workflow reads it.
- Treat CLI output as untrusted: malformed events end the turn with an error, never crash Pi. Timeouts and cancellation kill the whole OpenCode process group.
- Never log, commit or put in test fixtures prompts, transcripts, credentials or OpenCode auth and session files.
- Keep the package minimal TypeScript using Pi's extension and provider APIs, with no runtime dependencies or bundler. Pi host packages are `peerDependencies` with `*` ranges.
- Work on a dedicated feature branch with logically scoped, one-line conventional commits, without Co-Authored-By trailers. Never commit planning documents (design specs, implementation plans) or reference them from tracked files.
- Before committing, run `npm run typecheck` and `npm test`; before a release also run `npm run test:integration`, inspect `npm pack --dry-run --json` and keep the published `files` allowlist up to date.

Source of mandatory principles: https://github.com/Gybra/software-engineering-principles (access may require repository authorization).
