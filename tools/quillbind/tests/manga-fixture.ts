import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { collectBookWalker } from "../packages/core/src/bookwalker.js";
import {
  japaneseHtml,
  taiwanHtml,
  jpUrl,
  selection,
} from "./bookwalker-fixture.js";
export async function mangaFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "quillbind-manga-"));

  const scans = path.join(root, "scans");
  await fs.mkdir(scans);
  const raw = Buffer.from(
    Array.from({ length: 32 * 24 * 4 }, (_, i) =>
      i % 4 === 3 ? (i % 3 === 0 ? 0 : 255) : (i * 31) % 256,
    ),
  );
  const source = sharp(raw, { raw: { width: 32, height: 24, channels: 4 } });
  await source
    .clone()
    .withIccProfile("srgb")
    .png()
    .toFile(path.join(scans, "2.png"));
  await source.clone().removeAlpha().jpeg().toFile(path.join(scans, "10.jpg"));
  await source.clone().png().toFile(path.join(scans, "1.png"));
  const lock = await collectBookWalker(
    { ...selection, kind: "manga" },
    {
      online: true,
      fetcher: async ({ url }) => ({
        status: 200,
        headers: {},
        bytes: Buffer.from(
          url === jpUrl
            ? japaneseHtml({ kind: "マンガ" })
            : taiwanHtml({ kind: "漫畫" }),
        ),
      }),
    },
  );
  const bookwalker = path.join(root, "bookwalker.json");
  await fs.writeFile(bookwalker, JSON.stringify(lock));
  return {
    root,
    scans,
    lock,
    bookwalker,
    output: path.join(root, "volume.cbz"),
  };
}
