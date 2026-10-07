import { describe, it, expect } from "vitest";
import fc from "fast-check";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { safeName } from "../packages/core/src/paths.js";
import { safeRead } from "../packages/core/src/files.js";
import { run } from "../packages/core/src/process.js";
import { pack, unpack, crc32 } from "../packages/core/src/zip.js";
import { xml } from "../packages/core/src/xml.js";
import { parseYaml } from "../packages/core/src/config.js";
import { lintCss } from "../packages/core/src/css.js";
import {
  isPublicAddress,
  fetchBibliography,
} from "../packages/core/src/metadata.js";
describe("untrusted content boundaries", () => {
  it.each([
    "../x",
    "/etc/passwd",
    "C:/book",
    "a/../../x",
    "a\\b",
    "a//b",
    "a/./b",
    "x\0y",
  ])("rejects archive path %s", (name) =>
    expect(() => safeName(name)).toThrow(),
  );
  it("checks ZIP round trips and CRC on arbitrary bytes", () =>
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 4096 }), (bytes) => {
        const input = new Map<string, Uint8Array>([
          ["mimetype", Buffer.from("application/epub+zip")],
          ["book/data", bytes],
        ]);
        const zip = pack(input, 946684800);
        expect(unpack(zip).get("book/data")?.bytes).toEqual(Buffer.from(bytes));
        expect(crc32(bytes)).toBe(crc32(Buffer.from(bytes)));
      }),
    ));
  it("detects corrupt CRCs and duplicate case-insensitive names", () => {
    const zip = pack(
      new Map([
        ["mimetype", Buffer.from("application/epub+zip")],
        ["book", Buffer.from("hello")],
      ]),
      946684800,
    );
    zip[50] ^= 1;
    expect(() => unpack(zip)).toThrow();
    expect(() =>
      pack(
        new Map([
          ["mimetype", Buffer.from("application/epub+zip")],
          ["Book", Buffer.from("a")],
          ["book", Buffer.from("b")],
        ]),
        946684800,
      ),
    ).toThrow();
  });
  it("rejects inconsistent declared sizes before decompression", () => {
    const zip = pack(
      new Map([["mimetype", Buffer.from("application/epub+zip")]]),
      946684800,
    );
    const central = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    zip.writeUInt32LE(0x7fffffff, central + 24);
    expect(() => unpack(zip)).toThrow("Local sizes/CRC disagree");
  });
  it("rejects XML entities and malformed XML", () => {
    expect(() =>
      xml('<!DOCTYPE x [<!ENTITY a SYSTEM "file:///etc/passwd">]><x>&a;</x>'),
    ).toThrow();
    expect(() => xml("<x><y></x>")).toThrow();
  });
  it("rejects duplicate YAML keys and alias expansion", () => {
    expect(() => parseYaml("a: 1\na: 2")).toThrow();
    expect(() => parseYaml("a: &x [1,2]\nb: *x")).toThrow();
  });
  it.each([
    '@import "https://evil.example/x";',
    "p {background: url(https://evil.example/a)}",
    "p {font-size: 12px}",
    ".text {line-height: 20px}",
    "p {height: 20px; overflow: hidden}",
    "p {font-size: 1em !important}",
    "p {background:u\\72l(https://evil.example/a)}",
  ])("rejects unsafe or locked CSS %s", (css) =>
    expect(lintCss(css, "style.css").status).toBe("fail"),
  );
  it("allows reader-friendly code styles", () =>
    expect(
      lintCss(
        "pre {white-space: pre-wrap; font-family: monospace} h1 {font-size: 2em}",
        "style.css",
      ).status,
    ).toBe("pass"));
  it("rejects private network addresses", () => {
    for (const value of [
      "127.0.0.1",
      "10.0.0.1",
      "169.254.169.254",
      "192.168.1.1",
      "172.16.0.1",
      "::1",
      "::ffff:127.0.0.1",
      "fd00::1",
      "198.51.100.2",
      "203.0.113.8",
      "64:ff9b::7f00:1",
      "2002:7f00:1::",
    ])
      expect(isPublicAddress(value)).toBe(false);
    expect(isPublicAddress("8.8.8.8")).toBe(true);
  });
  it("rejects arbitrary metadata endpoints without making a request", async () => {
    await expect(
      fetchBibliography("http://127.0.0.1:8080/"),
    ).rejects.toHaveProperty("code", "SSRF_BLOCKED");
  });
  it("blocks symlinks outside the book directory", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "quillbind-symlink-"));
    try {
      await fs.symlink("/etc/hosts", path.join(root, "hosts"));
      await expect(safeRead(root, "hosts")).rejects.toHaveProperty(
        "code",
        "SYMLINK_ESCAPE",
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it("passes shell syntax as inert subprocess arguments", async () => {
    const source = "$(echo injected); `id`";
    const output = await run(process.execPath, [
      "-e",
      "process.stdout.write(process.argv[1])",
      source,
    ]);
    expect(output.stdout).toBe(source);
  });
  it("enforces subprocess time and output bounds", async () => {
    await expect(
      run(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
        timeout: 50,
      }),
    ).rejects.toHaveProperty("code", "TOOL_TIMEOUT");
    await expect(
      run(process.execPath, ["-e", 'process.stdout.write("x".repeat(10000))'], {
        limit: 100,
      }),
    ).rejects.toHaveProperty("code", "TOOL_OUTPUT_LIMIT");
  });
});

it("replaces a destination symlink atomically without modifying its target", async () => {
  const { atomicWrite } = await import("../packages/core/src/files.js");
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "quillbind-atomic-"),
  );
  try {
    const original = path.join(directory, "original");
    const output = path.join(directory, "candidate");
    await fs.writeFile(original, "protected");
    await fs.symlink(original, output);
    await atomicWrite(output, "candidate");
    expect(await fs.readFile(original, "utf8")).toBe("protected");
    expect(await fs.readFile(output, "utf8")).toBe("candidate");
    expect((await fs.lstat(output)).isSymbolicLink()).toBe(false);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
