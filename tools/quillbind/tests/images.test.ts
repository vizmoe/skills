import { afterEach, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { deflateSync, inflateSync } from "node:zlib";
import { prepareImage } from "../packages/core/src/images.js";
import { optimizePng } from "../packages/core/src/png.js";
import { crc32 } from "../packages/core/src/zip.js";
import {
  inspectBytes,
  compatibilityLint,
} from "../packages/core/src/validate.js";
import { openBook } from "../packages/core/src/config.js";
import { preflightBook } from "../packages/core/src/markdown.js";
import { json } from "../packages/core/src/json.js";
import { sha256 } from "../packages/core/src/hash.js";
import { bodymatterItems, candidate, copyBook } from "./helpers.js";
import { elements, NS } from "../packages/core/src/xml.js";

const temporary: string[] = [];
afterEach(async () => {
  for (const root of temporary.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});
function chunk(type: string, data: Buffer) {
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length);
  result.write(type, 4, "ascii");
  data.copy(result, 8);
  result.writeUInt32BE(crc32(result.subarray(4, -4)), result.length - 4);
  return result;
}
function parts(bytes: Buffer) {
  const entries: { type: string; raw: Buffer; data: Buffer }[] = [];
  for (let at = 8; at < bytes.length;) {
    const end = at + 12 + bytes.readUInt32BE(at);
    entries.push({
      type: bytes.toString("ascii", at + 4, at + 8),
      raw: bytes.subarray(at, end),
      data: bytes.subarray(at + 8, end - 4),
    });
    at = end;
  }
  return entries;
}
function scanlines(bytes: Buffer) {
  return inflateSync(
    Buffer.concat(
      parts(bytes)
        .filter((c) => c.type === "IDAT")
        .map((c) => c.data),
    ),
  );
}
function nonIdat(bytes: Buffer) {
  return Buffer.concat(
    parts(bytes)
      .filter((c) => c.type !== "IDAT")
      .map((c) => c.raw),
  );
}
function png(depth: number, color: number, width = 128, height = 128) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = depth;
  header[9] = color;
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[
    color
  ];
  const stride = Math.ceil((width * channels * depth) / 8) + 1;
  const data = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    for (let x = 1; x < stride; x++)
      data[y * stride + x] =
        color === 3 ? x % 2 : x % 8 === 0 ? 0 : 37 + (x % 4);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    ...(color === 3
      ? [
          chunk("PLTE", Buffer.from([22, 39, 42, 55, 60, 75])),
          chunk("tRNS", Buffer.from([0, 255])),
        ]
      : []),
    chunk("tEXt", Buffer.from("Author\0Original author and copyright")),
    chunk("pHYs", Buffer.from([0, 0, 11, 19, 0, 0, 11, 19, 1])),
    chunk("qbNd", Buffer.from("private metadata that may be copied")),
    chunk("IDAT", deflateSync(data, { level: 0 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

it.each([
  ["png", 1399, 2100, true],
  ["jpeg", 2100, 1399, true],
  ["png", 1400, 2100, false],
  ["jpeg", 2100, 1400, false],
] as const)(
  "checks the %s cover's %i × %i short edge without rejecting or resizing it",
  async (format, width, height, warn) => {
    const root = await copyBook("technical");
    temporary.push(root);
    const { config } = await openBook(root);
    const file = `assets/images/cover.${format}`;
    const source = await sharp({
      create: { width, height, channels: 3, background: "#334477" },
    })
      .toFormat(format)
      .toBuffer();
    await fs.writeFile(path.join(root, file), source);
    await json(path.join(root, "book.yaml"), {
      ...config,
      cover: { path: file },
      build: { ...config.build, optimizeImages: false },
    });
    const preflight = await preflightBook(root);
    expect(preflight.status).toBe("pass");
    expect(preflight.diagnostics).toHaveLength(warn ? 1 : 0);
    if (warn) {
      expect(preflight.diagnostics[0]).toMatchObject({
        code: "COVER_RESOLUTION_LOW",
        severity: "warning",
        source: file,
        standardUrl:
          "https://help.apple.com/itc/booksassetguide/en.lproj/static.html",
      });
      expect(preflight.diagnostics[0].message).toContain(
        `${width} × ${height}`,
      );
      expect(preflight.diagnostics[0].message).toContain("1399");
      expect(preflight.diagnostics[0].suggestion).toContain("do not upscale");
    }
    const info = inspectBytes(await candidate(root));
    const cover = info.manifest.find((item) =>
      item.properties.includes("cover-image"),
    )!;
    expect(info.entries.get(cover.path)!.bytes).toEqual(source);
    expect(await fs.readFile(path.join(root, file))).toEqual(source);
  },
);

it("exempts vector covers and does not apply the cover threshold to body images", async () => {
  const root = await copyBook("technical");
  temporary.push(root);
  const { config } = await openBook(root);
  await fs.writeFile(path.join(root, "small.png"), png(8, 6));
  await fs.appendFile(
    path.join(root, config.chapters[0]),
    "\n\n![Small diagram](small.png)\n",
  );
  expect((await preflightBook(root)).diagnostics).toEqual([]);
  await json(path.join(root, "book.yaml"), {
    ...config,
    cover: { path: "assets/images/flow.svg" },
  });
  const preflight = await preflightBook(root);
  expect(preflight.status).toBe("pass");
  expect(preflight.diagnostics).toEqual([]);
});

it.each([
  [8, 6],
  [16, 6],
  [1, 0],
  [8, 3],
])(
  "losslessly compresses PNG depth %i color %i and preserves all non-IDAT bytes",
  async (depth, color) => {
    const source = png(depth, color);
    const optimized = await prepareImage(source, "figure.png", true);
    expect(optimized.processing.action).toBe("png-lossless");
    expect(optimized.bytes.length).toBeLessThan(source.length);
    expect(scanlines(optimized.bytes)).toEqual(scanlines(source));
    expect(nonIdat(optimized.bytes)).toEqual(nonIdat(source));
    // Independent native decoding also verifies displayed pixel values.
    const decode = (bytes: Buffer) =>
      sharp(bytes)
        .toColourspace(depth === 16 ? "rgb16" : "srgb")
        .raw({ depth: depth === 16 ? "ushort" : "uchar" })
        .toBuffer();
    expect(await decode(optimized.bytes)).toEqual(await decode(source));
    expect(optimizePng(optimized.bytes).bytes).toEqual(optimized.bytes);
  },
);

it("preserves ICC, EXIF, text and Adam7 interlacing", async () => {
  const source = await sharp({
    create: {
      width: 65,
      height: 33,
      channels: 4,
      background: { r: 45, g: 81, b: 22, alpha: 0.5 },
    },
  })
    .withMetadata({ orientation: 6, density: 300 })
    .png({ compressionLevel: 0, progressive: true })
    .toBuffer();
  const output = (await prepareImage(source, "interlaced.png", true)).bytes;
  expect(output.length).toBeLessThan(source.length);
  expect(scanlines(output).equals(scanlines(source))).toBe(true);
  expect(nonIdat(output)).toEqual(nonIdat(source));
  const originalMetadata = await sharp(source).metadata();
  const outputMetadata = await sharp(output).metadata();
  expect(originalMetadata.isProgressive).toBe(true);
  expect(originalMetadata.icc?.length).toBeGreaterThan(0);
  expect(outputMetadata.icc).toEqual(originalMetadata.icc);
  expect(outputMetadata.exif).toEqual(originalMetadata.exif);
});

it("retains APNG frames and unknown unsafe chunks without modification", () => {
  const source = png(8, 6);
  const split = parts(source);
  const animation = Buffer.alloc(8);
  animation.writeUInt32BE(1);
  const frame = Buffer.alloc(26);
  frame.writeUInt32BE(128, 4);
  frame.writeUInt32BE(128, 8);
  frame.writeUInt16BE(1, 20);
  frame.writeUInt16BE(10, 22);
  for (const extra of [
    [chunk("acTL", animation), chunk("fcTL", frame)],
    [chunk("qbND", Buffer.from("private dependent metadata"))],
  ]) {
    const input = Buffer.concat([
      source.subarray(0, 8),
      split[0].raw,
      ...extra,
      ...split.slice(1).map((c) => c.raw),
    ]);
    expect(optimizePng(input).bytes).toEqual(input);
    expect(optimizePng(input).action).toBe("preserved");
  }
});

it("rejects corrupt PNG data instead of silently discarding it", () => {
  const source = png(8, 6);
  source[50] ^= 1;
  expect(() => optimizePng(source)).toThrow("checksum");
});

it("can disable optimization and never recodes JPEG, GIF or SVG", async () => {
  const source = png(8, 6);
  expect((await prepareImage(source, "untouched.png", false)).bytes).toEqual(
    source,
  );
  const jpeg = await sharp(source)
    .withMetadata({ orientation: 6, density: 300 })
    .jpeg()
    .toBuffer();
  const gif = await sharp(source).gif().toBuffer();
  const svg = Buffer.from(
    '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><path d="M0 0L20 20"/></svg>',
  );
  for (const bytes of [jpeg, gif, svg]) {
    const output = await prepareImage(bytes, "original", true);
    expect(output.bytes).toEqual(bytes);
    expect(output.processing.verification).toBe("original-bytes");
  }
  const webp = await sharp(source).webp({ lossless: true }).toBuffer();
  await expect(prepareImage(webp, "unsupported.webp", true)).rejects.toThrow(
    "supply JPEG, PNG, GIF or passive SVG",
  );
  await expect(
    prepareImage(
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'),
      "active.svg",
      true,
    ),
  ).rejects.toThrow("active SVG");
});

it("builds an image beyond the old byte and pixel limits, reports guidance and preserves source data", async () => {
  const root = await copyBook("technical");
  temporary.push(root);
  const project = await openBook(root);
  const source = png(8, 6, 3400, 3400);
  expect(source.length).toBeGreaterThan(32 * 1024 * 1024);
  const file = "assets/images/large.png";
  await fs.writeFile(path.join(root, file), source);
  const chapter = path.join(root, project.config.chapters[0]);
  await fs.appendFile(
    chapter,
    `\n\n![Detailed diagram](${file})\n\nInline ![Marker](${file}) text.\n`,
  );
  const bytes = await candidate(root);
  const info = inspectBytes(bytes);
  const item = info.manifest.find((m) => m.mediaType === "image/png")!;
  const output = info.entries.get(item.path)!.bytes;
  expect(scanlines(output).equals(scanlines(source))).toBe(true);
  expect(nonIdat(output)).toEqual(nonIdat(source));
  expect(sha256(await fs.readFile(path.join(root, file)))).toBe(sha256(source));
  const apple = await compatibilityLint(bytes, "apple-books");
  expect(apple.status).toBe("pass");
  expect(apple.diagnostics).toContainEqual(
    expect.objectContaining({
      code: "APPLE_IMAGE_PIXEL_GUIDANCE",
      severity: "warning",
    }),
  );
  const kindle = await compatibilityLint(bytes, "kindle");
  expect(kindle.status).toBe("pass");
  expect(
    kindle.diagnostics.some((d) => d.code === "APPLE_IMAGE_PIXEL_GUIDANCE"),
  ).toBe(false);
  const document = info.documents.get(bodymatterItems(info)[0].path)!;
  const images = elements(document, "img", NS.xhtml);
  expect(images.some((img) => img.parentNode?.nodeName === "figure")).toBe(
    true,
  );
  expect(
    images.some((img) => img.getAttribute("class") === "inline-image"),
  ).toBe(true);
  await json(path.join(root, "book.yaml"), {
    ...project.config,
    build: { ...project.config.build, optimizeImages: false },
  });
  const original = inspectBytes(await candidate(root));
  const originalItem = original.manifest.find(
    (m) => m.mediaType === "image/png",
  )!;
  expect(original.entries.get(originalItem.path)!.bytes.equals(source)).toBe(
    true,
  );
});
