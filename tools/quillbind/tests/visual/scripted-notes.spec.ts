import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { noteFixture, noteScript } from "../note-fixture.js";
import { checkNotes } from "../../packages/core/src/check-notes.js";
import { inspectBytes } from "../../packages/core/src/epub.js";
import { applyRepair, planFromBytes } from "../../packages/core/src/repair.js";
import { sha256 } from "../../packages/core/src/hash.js";
import { serveEpub } from "../../packages/core/src/qa-environment.js";

let root: string;
test.beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "quillbind-notes-"));
});
test.afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
async function check(
  bytes: Buffer,
  options: Parameters<typeof checkNotes>[1] = {},
) {
  const file = path.join(root, "source.epub");
  await fs.writeFile(file, bytes);
  const report = await checkNotes(file, {
    executeScripts: true,
    reports: path.join(root, "reports"),
    timeoutMs: 1500,
    ...options,
  });
  expect(await fs.readFile(file)).toEqual(bytes);
  return report;
}

test("runs real popup scripts before and after preservation-only repair", async () => {
  const bytes = noteFixture();
  for (const input of [
    bytes,
    applyRepair(bytes, planFromBytes(bytes, "reading")).bytes,
  ]) {
    const report = await check(input);
    expect(
      report.interactions.status,
      JSON.stringify(report.interactions),
    ).toBe("pass");
    if (report.interactions.status === "not-run")
      throw new Error("Scripts did not run");
    expect(report.interactions.cases).toHaveLength(2);
    expect(
      report.interactions.cases.every((c) =>
        c.checks?.includes("focus-returned"),
      ),
    ).toBe(true);
    for (const c of report.interactions.cases)
      expect((await fs.stat(c.screenshot!)).size).toBeGreaterThan(0);
  }
  const server = await serveEpub(inspectBytes(bytes));
  try {
    expect(
      (await fetch(server.origin + "/OEBPS/chapter.xhtml")).headers.get(
        "content-security-policy",
      ),
    ).toContain("script-src 'none'");
  } finally {
    await server.close();
  }
});

for (const [name, script] of [
  ["never opens", ""],
  [
    "never closes",
    noteScript.replace("document.getElementById('note').hidden = true;", ""),
  ],
  [
    "wrong text",
    noteScript.replace(
      "document.getElementById('note').hidden = false;",
      "document.getElementById('note').firstElementChild.firstChild.textContent = 'Wrong note'; document.getElementById('note').hidden = false;",
    ),
  ],
] as const)
  test(`does not report success when the popup ${name}`, async () => {
    const report = await check(
      noteFixture((entries) =>
        entries.set("OEBPS/notes.js", Buffer.from(script)),
      ),
      { timeoutMs: 300 },
    );
    expect(report.status).toBe("fail");
    expect(report.interactions.status).toBe("fail");
  });

test("blocks script side effects in a fresh context", async () => {
  const report = await check(
    noteFixture((entries) =>
      entries.set(
        "OEBPS/notes.js",
        Buffer.from(
          noteScript +
            `
    fetch('https://example.invalid/notes').catch(() => {});
    try { new WebSocket('wss://example.invalid/notes'); } catch {}
    try { new Worker('notes.js'); } catch {}
    try { eval('window.evaluated = true'); } catch {}
    window.open('https://example.invalid/popup');
    alert('not a note');
    const frame = document.createElement('iframe'); frame.src = 'chapter.xhtml'; document.body.appendChild(frame);
  `,
        ),
      ),
    ),
  );
  expect(report.status).toBe("fail");
  if (report.interactions.status === "not-run")
    throw new Error("Scripts did not run");
  expect(report.interactions.findings.some((f) => f.code === "NOTE_CSP")).toBe(
    true,
  );
  expect(report.interactions.cases.every((c) => c.status === "fail")).toBe(
    true,
  );
});

test("checks hover and touch-release popups, including opacity-only dismissal", async () => {
  const bytes = noteFixture((entries) => {
    entries.set(
      "OEBPS/chapter.xhtml",
      Buffer.from(
        entries
          .get("OEBPS/chapter.xhtml")!
          .toString()
          .replace(' hidden="hidden"', ""),
      ),
    );
    entries.set(
      "OEBPS/notes.css",
      Buffer.from("aside { opacity: 0; } aside.open { opacity: 1; }"),
    );
    entries.set(
      "OEBPS/notes.js",
      Buffer.from(`window.addEventListener('load', () => {
      const link = document.getElementById('ref'), note = document.getElementById('note');
      link.removeAttribute('href');
      link.addEventListener(navigator.maxTouchPoints ? 'touchstart' : 'mouseover', () => note.classList.add('open'));
      link.addEventListener(navigator.maxTouchPoints ? 'touchend' : 'mouseout', () => note.classList.remove('open'));
    });`),
    );
  });
  const report = await check(bytes, {
    cases: {
      schemaVersion: 1,
      inputSha256: sha256(bytes),
      cases: [
        {
          id: "hover-note",
          document: "OEBPS/chapter.xhtml",
          trigger: "#ref",
          popup: "aside#note",
          expectedText: "A popup note.",
          activations: ["hover", "touch"],
          dismiss: { gesture: "release" },
        },
      ],
    },
  });
  expect(report.interactions.status, JSON.stringify(report.interactions)).toBe(
    "pass",
  );
});

test("can test explicit selectors while retaining duplicate-ID findings", async () => {
  const bytes = noteFixture((entries) =>
    entries.set(
      "OEBPS/chapter.xhtml",
      Buffer.from(
        entries
          .get("OEBPS/chapter.xhtml")!
          .toString()
          .replace("<p>A popup note.", '<p id="note">A popup note.'),
      ),
    ),
  );
  const report = await check(bytes, {
    cases: {
      schemaVersion: 1,
      inputSha256: sha256(bytes),
      cases: [
        {
          id: "reviewed-note",
          document: "OEBPS/chapter.xhtml",
          trigger: "#ref",
          popup: "aside#note",
          expectedText: "A popup note.",
          dismiss: { selector: "#back" },
          returnFocus: "#ref",
        },
      ],
    },
  });
  expect(report.interactions.status, JSON.stringify(report.interactions)).toBe(
    "pass",
  );
  expect(report.status).toBe("fail");
  expect(report.notes.issues.some((i) => i.code === "NOTE_DUPLICATE_ID")).toBe(
    true,
  );
  expect(report.coverage.selection).toBe("explicit-cases");
});

test("cancels an in-progress browser check and releases its local server", async () => {
  const servers = () =>
    process.getActiveResourcesInfo().filter((name) => name === "TCPServerWrap")
      .length;
  const before = servers();
  await expect(
    check(
      noteFixture((entries) => entries.set("OEBPS/notes.js", Buffer.from(""))),
      { timeoutMs: 10000, signal: AbortSignal.timeout(1500) },
    ),
  ).rejects.toThrow();
  await expect.poll(servers).toBe(before);
  // A later real check still succeeds after cancellation.
  expect((await check(noteFixture())).interactions.status).toBe("pass");
});
