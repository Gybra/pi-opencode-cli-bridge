// Moves every pin of the supported OpenCode version to a new release and bumps the package patch version.
// Usage: node scripts/bump-opencode-version.mjs <x.y.z>
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const next = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(next ?? "")) throw new Error("usage: bump-opencode-version.mjs <x.y.z>");

const read = (file) => readFileSync(root + file, "utf8");
const old = /MAX_SUPPORTED_OPENCODE_VERSION = "(\d+\.\d+\.\d+)"/.exec(read("src/index.ts"))?.[1];
if (!old) throw new Error("src/index.ts: MAX_SUPPORTED_OPENCODE_VERSION not found");
const nextPatch = (version) => version.replace(/\d+$/, (n) => String(Number(n) + 1));

// A missing pattern means the files drifted from what this script knows: fail instead of releasing a half bump.
function edit(file, replacements) {
  let text = read(file);
  for (const [from, to] of replacements) {
    if (typeof from === "string" ? !text.includes(from) : text.search(from) < 0) throw new Error(`${file}: no match for ${from}`);
    text = text.replace(from, to);
  }
  writeFileSync(root + file, text);
}

const oldRe = new RegExp(`(?<![\\d.])${old.replaceAll(".", "\\.")}(?![\\d.]*\\d)`, "g");
for (const file of ["src/index.ts", "src/native-tools.integration.test.ts", "README.md", "SECURITY.md", ".github/workflows/test.yml"]) {
  edit(file, [[oldRe, next]]);
}

edit("src/index.test.ts", [
  // Versions above the maximum start one patch past the new maximum.
  [`["${nextPatch(old)}", `, `["${nextPatch(next)}", `],
  [new RegExp(`("${old.replaceAll(".", "\\.")}")(\\]\\) \\{\\n  test\\(\`session_start accepts)`), `$1, "${next}"$2`],
  [`up to ${old}.`, `up to ${next}.`],
]);

execFileSync("npm", ["version", "patch", "--no-git-tag-version"], { cwd: root, stdio: "inherit" });
