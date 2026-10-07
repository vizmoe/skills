import { afterEach, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { run } from "../packages/core/src/process.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "quillbind-process-"));
  roots.push(root);
  const script = path.join(root, "child.mjs");
  await fs.writeFile(
    script,
    `
    import fs from 'node:fs';
    import path from 'node:path';
    const root = path.dirname(process.argv[1]);
    process.on('SIGTERM', () => {
      fs.writeFileSync(path.join(root, 'closed'), 'graceful');
      process.exit(0);
    });
    fs.writeFileSync(path.join(root, 'ready'), 'ready');
    setTimeout(() => process.exit(0), 2500);
  `,
  );
  return { root, script };
}
it("allows a timed-out tool to close gracefully before reporting timeout", async () => {
  const { root, script } = await fixture();
  await expect(
    run(process.execPath, [script], { timeout: 500 }),
  ).rejects.toHaveProperty("code", "TOOL_TIMEOUT");
  expect(await fs.readFile(path.join(root, "closed"), "utf8")).toBe("graceful");
});
it("waits for cleanup on cancellation and preserves the caller's reason", async () => {
  const { root, script } = await fixture();
  const controller = new AbortController();
  const reason = new Error("user cancelled validation");
  const execution = run(process.execPath, [script], {
    signal: controller.signal,
  });
  const verdict = expect(execution).rejects.toBe(reason);
  for (let i = 0; i < 100; i++) {
    if (
      await fs.access(path.join(root, "ready")).then(
        () => true,
        () => false,
      )
    )
      break;
    await delay(10);
  }
  controller.abort(reason);
  await verdict;
  expect(await fs.readFile(path.join(root, "closed"), "utf8")).toBe("graceful");
});

it("closes descendants that retain output pipes after the tool exits", async () => {
  const { root, script } = await fixture();
  const parent = path.join(root, "parent.mjs");
  await fs.writeFile(
    parent,
    `
    import fs from 'node:fs';
    import { spawn } from 'node:child_process';
    const child = spawn(process.execPath, [process.argv[2]], { stdio: 'inherit' });
    const ready = setInterval(() => {
      if (fs.existsSync(process.argv[3])) {
        clearInterval(ready);
        process.exit(0);
      }
    }, 10);
    child.on('error', () => process.exit(1));
  `,
  );
  const output = await run(process.execPath, [
    parent,
    script,
    path.join(root, "ready"),
  ]);
  expect(output.exitCode).toBe(0);
  expect(await fs.readFile(path.join(root, "closed"), "utf8")).toBe("graceful");
});

it("bounds shutdown when a tool ignores the graceful termination signal", async () => {
  const started = performance.now();
  await expect(
    run(
      process.execPath,
      [
        "-e",
        "process.on('SIGTERM', () => {}); setTimeout(() => process.exit(0), 3000);",
      ],
      {
        timeout: 300,
        killGraceMs: 100,
      },
    ),
  ).rejects.toHaveProperty("code", "TOOL_TIMEOUT");
  expect(performance.now() - started).toBeLessThan(2000);
});

it("reports spawn failures without waiting for a nonexistent process", async () => {
  const { root } = await fixture();
  await expect(run(path.join(root, "missing-tool"), [])).rejects.toHaveProperty(
    "code",
    "ENVIRONMENT_ERROR",
  );
});
