import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { candidate, copyBook } from "./helpers.js";
import { recordedZhconvert } from "./zhconvert-fixture.js";
import { convertWithLock } from "../packages/core/src/conversion-lock.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await copyBook();
  roots.push(root);
  return {
    root,
    bytes: await candidate(root),
    lock: path.join(root, "metadata/conversion.traditional.lock.json"),
  };
}

it("replays a persisted conversion in a separate session with zero network and equal EPUB bytes", async () => {
  const { bytes, lock } = await fixture();
  const online = await convertWithLock(
    bytes,
    {
      target: "traditional",
      online: true,
      fetcher: recordedZhconvert(),
      apiKey: "private-test-key",
    },
    lock,
  );
  const saved = await fs.readFile(lock, "utf8");
  expect(saved).not.toContain("private-test-key");
  const fetcher = vi.fn<typeof fetch>();
  const offline = await convertWithLock(
    bytes,
    { target: "traditional", fetcher },
    lock,
  );
  expect(offline.bytes).toEqual(online.bytes);
  expect(offline.report).toMatchObject({
    source: "saved-lock",
    requests: 0,
    revision: online.report.revision,
    snapshotSha256: online.report.snapshotSha256,
  });
  expect(await fs.readFile(lock, "utf8")).toBe(saved);
  expect(fetcher).not.toHaveBeenCalled();
});

it("fails closed on missing, stale, malformed and tampered locks", async () => {
  const { bytes, lock } = await fixture();
  const fetcher = vi.fn<typeof fetch>();
  const options = { target: "traditional" as const, fetcher };
  await expect(convertWithLock(bytes, options, lock)).rejects.toMatchObject({
    code: "CONVERSION_LOCK_MISSING",
  });
  await convertWithLock(
    bytes,
    { ...options, online: true, fetcher: recordedZhconvert() },
    lock,
  );
  const saved = await fs.readFile(lock, "utf8");
  await expect(
    convertWithLock(
      Buffer.concat([bytes, Buffer.from("changed")]),
      options,
      lock,
    ),
  ).rejects.toMatchObject({ code: "CONVERSION_LOCK_STALE" });
  await expect(
    convertWithLock(bytes, { ...options, target: "taiwan" }, lock),
  ).rejects.toMatchObject({ code: "CONVERSION_LOCK_STALE" });
  const tampered = JSON.parse(saved);
  tampered.entries[0].text += "altered";
  await fs.writeFile(lock, JSON.stringify(tampered));
  await expect(convertWithLock(bytes, options, lock)).rejects.toMatchObject({
    code: "CONVERSION_LOCK_INVALID",
  });
  await fs.writeFile(lock, "{");
  await expect(convertWithLock(bytes, options, lock)).rejects.toMatchObject({
    code: "CONVERSION_LOCK_INVALID",
  });
  expect(fetcher).not.toHaveBeenCalled();
});

it("preserves the previous lock if an explicit online refresh fails", async () => {
  const { bytes, lock } = await fixture();
  await convertWithLock(
    bytes,
    { target: "traditional", online: true, fetcher: recordedZhconvert() },
    lock,
  );
  const saved = await fs.readFile(lock);
  await expect(
    convertWithLock(
      bytes,
      {
        target: "traditional",
        online: true,
        fetcher: vi
          .fn<typeof fetch>()
          .mockResolvedValue(new Response("unavailable", { status: 400 })),
      },
      lock,
    ),
  ).rejects.toThrow();
  expect(await fs.readFile(lock)).toEqual(saved);
});
