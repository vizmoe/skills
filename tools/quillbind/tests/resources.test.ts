import { expect, it } from "vitest";
import { deflateRawSync } from "node:zlib";
import { pack, unpack } from "../packages/core/src/zip.js";
import { parseYaml } from "../packages/core/src/config.js";
import { xml } from "../packages/core/src/xml.js";
import { lintCss } from "../packages/core/src/css.js";

it("accepts ZIP input beyond the old archive, resource and total byte ceilings", () => {
  const payload = Buffer.alloc(257 * 1024 * 1024, 43);
  const archive = pack(
    new Map([
      ["mimetype", Buffer.from("application/epub+zip")],
      [
        "META-INF/container.xml",
        Buffer.from(
          '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"/>',
        ),
      ],
      ["large-source", payload],
    ]),
    946684800,
  );
  expect(
    unpack(archive, { strictOcf: true })
      .get("large-source")!
      .bytes.equals(payload),
  ).toBe(true);
}, 60000);

it("accepts valid highly compressible input and enforces its declared data length", () => {
  const payload = Buffer.alloc(2 * 1024 * 1024, 42);
  const stored = pack(new Map([["mimetype", payload]]), 946684800);
  const compressed = deflateRawSync(payload, { level: 9 });
  expect(payload.length / compressed.length).toBeGreaterThan(200);
  const headerLength = 30 + Buffer.byteLength("mimetype");
  const local = Buffer.from(stored.subarray(0, headerLength));
  const central = Buffer.from(
    stored.subarray(headerLength + payload.length, -22),
  );
  const end = Buffer.from(stored.subarray(-22));
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(compressed.length, 18);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(compressed.length, 20);
  end.writeUInt32LE(headerLength + compressed.length, 16);
  const bytes = Buffer.concat([local, compressed, central, end]);
  expect(unpack(bytes).get("mimetype")!.bytes.equals(payload)).toBe(true);
  bytes.writeUInt32LE(payload.length - 1, 22);
  bytes.writeUInt32LE(
    payload.length - 1,
    headerLength + compressed.length + 24,
  );
  expect(() => unpack(bytes)).toThrow("Invalid compressed data");
});

it("accepts large YAML and XML sources without fixed byte ceilings", () => {
  const metadata = "A".repeat(1024 * 1024 + 1);
  expect(parseYaml(`description: ${metadata}\n`)).toEqual({
    description: metadata,
  });
  const content = "A".repeat(16 * 1024 * 1024 + 1);
  expect(
    xml(`<book>${content}</book>`).documentElement!.textContent?.length,
  ).toBe(content.length);
});

it("permits relative image sizing while retaining text and ancestor selector safeguards", () => {
  expect(
    lintCss(
      "img.inline-image {height:1em;width:auto} figure > img {height:50vh;width:100%;object-fit:contain}",
      "images.css",
    ).status,
  ).toBe("pass");
  for (const source of [
    "p {height:50vh}",
    "img, p {height:1em}",
    "img p {height:1em}",
    "pre p {font-size:12px}",
    ":has(img) {height:50vh}",
  ])
    expect(lintCss(source, "text.css").status).toBe("fail");
});
