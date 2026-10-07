import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { createServer } from "node:http";
import { chromium } from "@playwright/test";
import { browserPath, runAce, runQa } from "../packages/core/src/qa.js";
import { run } from "../packages/core/src/process.js";
import { candidate, copyBook } from "./helpers.js";

vi.mock("@playwright/test", () => ({ chromium: { launch: vi.fn() } }));
vi.mock("node:http", () => ({ createServer: vi.fn() }));
vi.mock("../packages/core/src/files.js", async (original) => {
  const actual =
    await original<typeof import("../packages/core/src/files.js")>();
  return {
    ...actual,
    exists: (file: string) =>
      file.endsWith(".cache/tools/browser.json")
        ? Promise.resolve(true)
        : actual.exists(file),
  };
});
vi.mock("../packages/core/src/json.js", async (original) => {
  const actual =
    await original<typeof import("../packages/core/src/json.js")>();
  return {
    ...actual,
    readJson: (file: string) =>
      file.endsWith(".cache/tools/browser.json")
        ? Promise.resolve({ executablePath: process.execPath })
        : actual.readJson(file),
  };
});
vi.mock("../packages/core/src/process.js", async (original) => ({
  ...(await original<typeof import("../packages/core/src/process.js")>()),
  run: vi.fn(),
}));

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const roots: string[] = [];
const browser = { close: vi.fn(), version: () => "test", newContext: vi.fn() };
let server: EventEmitter & {
  listen: ReturnType<typeof vi.fn>;
  address: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  closeAllConnections: ReturnType<typeof vi.fn>;
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CODEX_SANDBOX", "");
  browser.close.mockReset().mockResolvedValue(undefined);
  browser.newContext.mockReset().mockRejectedValue(new Error("context failed"));
  vi.mocked(chromium.launch).mockResolvedValue(browser as never);
  server = Object.assign(new EventEmitter(), {
    listen: vi.fn((_port, _host, ready) => ready()),
    address: vi.fn(() => ({ port: 12345 })),
    close: vi.fn((done) => done()),
    closeAllConnections: vi.fn(),
  });
  vi.mocked(createServer).mockReturnValue(server as never);
});
afterEach(async () => {
  Object.defineProperty(process, "platform", platform);
  vi.unstubAllEnvs();
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await copyBook("technical");
  roots.push(root);
  const file = path.join(root, "candidate.epub");
  await fs.writeFile(file, await candidate(root));
  return file;
}

it("rejects the known macOS sandbox before launching Chrome or Ace", async () => {
  Object.defineProperty(process, "platform", { value: "darwin" });
  vi.stubEnv("CODEX_SANDBOX", "seatbelt");
  await expect(browserPath()).rejects.toMatchObject({
    code: "ENVIRONMENT_ERROR",
    details: { tool: "chromium", reason: "macos-sandbox" },
  });
  const file = await fixture();
  await expect(runQa(file)).rejects.toHaveProperty("code", "ENVIRONMENT_ERROR");
  await expect(
    runAce(file, path.join(path.dirname(file), "reports")),
  ).rejects.toHaveProperty("code", "ENVIRONMENT_ERROR");
  expect(chromium.launch).not.toHaveBeenCalled();
  expect(run).not.toHaveBeenCalled();
});

it.each(["darwin", "linux"])(
  "keeps the pinned browser available on an unrestricted %s host",
  async (value) => {
    Object.defineProperty(process, "platform", { value });
    await expect(browserPath()).resolves.toBe(process.execPath);
  },
);

it("closes the browser if the local server cannot start", async () => {
  server.listen.mockImplementation(() => {
    queueMicrotask(() => server.emit("error", new Error("listen failed")));
  });
  await expect(runQa(await fixture())).rejects.toThrow("listen failed");
  expect(browser.close).toHaveBeenCalledTimes(1);
});

it("closes the server even if browser shutdown fails and preserves the original error", async () => {
  browser.close.mockRejectedValue(new Error("close failed"));
  await expect(runQa(await fixture())).rejects.toThrow("context failed");
  expect(server.close).toHaveBeenCalledTimes(1);
  expect(server.closeAllConnections).toHaveBeenCalledTimes(1);
});

it("does not launch a browser for an already cancelled operation", async () => {
  const signal = AbortSignal.abort(new Error("cancelled"));
  await expect(runQa(await fixture(), { signal })).rejects.toThrow("cancelled");
  expect(chromium.launch).not.toHaveBeenCalled();
});

it("closes once and preserves cancellation when it interrupts browser setup", async () => {
  const controller = new AbortController();
  browser.newContext.mockImplementation(async () => {
    controller.abort(new Error("cancelled"));
    throw new Error("Target closed");
  });
  await expect(
    runQa(await fixture(), { signal: controller.signal }),
  ).rejects.toThrow("cancelled");
  expect(browser.close).toHaveBeenCalledTimes(1);
  expect(server.close).toHaveBeenCalledTimes(1);
});

it("reports a failed browser launch as an environment error without retrying", async () => {
  vi.mocked(chromium.launch).mockRejectedValue(new Error("launch failed"));
  await expect(runQa(await fixture())).rejects.toMatchObject({
    code: "ENVIRONMENT_ERROR",
    details: { tool: "chromium", reason: "launch-failed" },
  });
  expect(chromium.launch).toHaveBeenCalledTimes(1);
});
