import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runOpenCodeProcess } from "./process.js";

const run = (script: string, options: Partial<Parameters<typeof runOpenCodeProcess>[2]> = {}) =>
  runOpenCodeProcess(process.execPath, ["-e", script], { timeoutMs: 3000, ...options });

test("process captures normal and nonzero exits and handles a missing executable", async () => {
  const result = await run('process.stdout.write("ok"); process.stderr.write("diagnostic"); process.exitCode = 7;');
  assert.deepEqual(result, { stdout: "ok", stderr: "diagnostic", code: 7 });
  await assert.rejects(runOpenCodeProcess("/pi-bridge-does-not-exist", [], { timeoutMs: 1000 }), /ENOENT/);
});

test("process kills a SIGTERM-ignoring child on timeout", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-process-timeout-"));
  const pidFile = join(dir, "pid");
  try {
    const started = Date.now();
    await assert.rejects(run(`process.on("SIGTERM", () => {});
require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setTimeout(() => process.exit(0), 3000);`, { timeoutMs: 800 }), /timed out after 800ms/);
    assert.ok(Date.now() - started < 2000);
    const pid = Number(readFileSync(pidFile, "utf8"));
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("process cancellation kills the child even while its async observer is blocked", async () => {
  const controller = new AbortController();
  const started = Date.now();
  await assert.rejects(run('process.on("SIGTERM", () => {}); process.stdout.write("ready"); setTimeout(() => process.exit(0), 3000);', {
    signal: controller.signal,
    onStdout: async () => {
      controller.abort();
      await new Promise(() => {});
    },
  }), /aborted/);
  assert.ok(Date.now() - started < 2000);
});

test("process converts consumer failures and stdin EPIPE into rejected requests", async () => {
  await assert.rejects(run('process.stdout.write("ready"); setTimeout(() => process.exit(0), 3000);', {
    onStdout: async () => { throw new Error("observer failed"); },
  }), /observer failed/);
  await assert.rejects(run('process.stdin.destroy(); process.exit(0);', {
    input: "x".repeat(16 * 1024 * 1024),
  }), /EPIPE|ECONNRESET|closed/i);
});

test("process consumes stdout sequentially without duplicating captured output", async () => {
  let received = "";
  let busy = false;
  await run('for (let i=0; i<20; i++) setTimeout(() => process.stdout.write(String(i%10)), i*2);', {
    onStdout: async (chunk) => {
      assert.equal(busy, false);
      busy = true;
      await new Promise((resolve) => setTimeout(resolve, 5));
      received += chunk;
      busy = false;
    },
  });
  assert.equal(received, "01234567890123456789");
});
