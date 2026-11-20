import path from "node:path";
import { sha256 } from "./hash.js";
import { modes, widths, type QaPlan } from "./qa-plan.js";
import type { Page } from "@playwright/test";
import type { Document as XmlDocument } from "@xmldom/xmldom";
import { AxeBuilder } from "@axe-core/playwright";
import type { Diagnostic } from "./model.js";
import { checkAbort, diagnostic } from "./errors.js";
import { elements, NS } from "./xml.js";
import { ready } from "./qa-ready.js";
import { checkPageLinks } from "./qa-links.js";
import { checkPagination } from "./qa-pagination.js";

type QaMode = (typeof modes)[number];

interface PageIssue {
  code: string;
  message: string;
}

export interface PageScreenshot {
  file: string;
  document: string;
  reason: string;
  bytes: number;
}

function browserReadFonts(): string[] {
  return Array.from(document.fonts)
    .map((font) => `${font.family}:${font.status}`)
    .toSorted((a, b) => a.localeCompare(b, "en"));
}

function browserCheckTypography(expected: {
  text: string;
  font: boolean;
  spacing: boolean;
  scale: number;
}): PageIssue[] {
  const issues: PageIssue[] = [];
  if (document.body.textContent !== expected.text)
    issues.push({
      code: "TEXT_INTEGRITY",
      message: "Rendered body text differs from packaged XHTML",
    });
  for (const paragraph of Array.from(document.querySelectorAll("p, li"))) {
    const style = getComputedStyle(paragraph);
    if (expected.font && !style.fontFamily.includes("monospace"))
      issues.push({
        code: "FONT_OVERRIDE",
        message: "Reader font override did not take effect",
      });
    if (
      expected.spacing &&
      Math.abs(
        Number.parseFloat(style.lineHeight) /
          Number.parseFloat(style.fontSize) -
          2,
      ) > 0.05
    )
      issues.push({
        code: "SPACING_OVERRIDE",
        message: "Reader line spacing did not take effect",
      });
    if (expected.scale === 2 && Number.parseFloat(style.fontSize) < 31.9)
      issues.push({
        code: "TEXT_SCALE",
        message: "Body text did not scale to 200%",
      });
  }
  return issues;
}

function browserCheckDocumentBox() {
  const issues: PageIssue[] = [];
  const body = document.body;
  const vertical = Array.from(body.children).some(
    (e) => getComputedStyle(e).writingMode === "vertical-rl",
  );
  if (!body.textContent?.trim() && !document.images.length)
    issues.push({ code: "EMPTY", message: "No visible book content" });
  const bodyRect = body.getBoundingClientRect();
  if (bodyRect.width === 0 || bodyRect.height === 0)
    issues.push({ code: "ZERO_SIZE", message: "Zero-sized document body" });
  if (!vertical && document.documentElement.scrollWidth > innerWidth + 2)
    issues.push({
      code: "OVERFLOW",
      message: `Horizontal overflow: ${document.documentElement.scrollWidth}/${innerWidth}`,
    });
  return {
    issues,
    textLength: body.textContent?.length ?? 0,
    width: document.documentElement.scrollWidth,
    height: document.documentElement.scrollHeight,
    vertical,
  };
}

function browserCheckHeadingOverlaps(vertical: boolean): PageIssue[] {
  if (vertical) return [];
  const issues: PageIssue[] = [];
  for (const element of Array.from(
    document.querySelectorAll("h1,h2,h3,h4,h5,h6"),
  )) {
    const next = element.nextElementSibling;
    if (!/^H[1-6]$/.test(element.tagName) || !next?.textContent?.trim())
      continue;
    const rect = element.getBoundingClientRect();
    const following = next.getBoundingClientRect();
    if (
      following.top < rect.bottom - 1 &&
      following.bottom > rect.top + 1 &&
      following.left < rect.right &&
      following.right > rect.left
    )
      issues.push({
        code: "HEADING_OVERLAP",
        message: "Heading overlaps its following content",
      });
  }
  return issues;
}

function browserCheckElementVisibility(): PageIssue[] {
  const issues: PageIssue[] = [];
  for (const element of Array.from(
    document.querySelectorAll(
      "p,h1,h2,h3,h4,h5,h6,pre,figure,table,math,img,aside",
    ),
  )) {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    const hasContent = Boolean(
      element.textContent?.trim() || element.tagName.toLowerCase() === "img",
    );
    const hidden =
      style.display === "none" ||
      style.visibility === "hidden" ||
      Number(style.opacity) === 0 ||
      rect.width === 0 ||
      rect.height === 0;
    if (hasContent && hidden)
      issues.push({
        code: "HIDDEN",
        message: `Hidden/empty ${element.tagName}`,
      });
    if (
      ["hidden", "clip"].includes(style.overflowY) &&
      element.scrollHeight > element.clientHeight + 2
    )
      issues.push({
        code: "CLIPPING",
        message: `Clipped ${element.tagName}`,
      });
  }
  return issues;
}

function browserCheckImages(): PageIssue[] {
  const issues: PageIssue[] = [];
  for (const element of Array.from(document.querySelectorAll("img"))) {
    if (!(element instanceof HTMLImageElement)) continue;
    if (!element.complete || !element.naturalWidth) {
      issues.push({ code: "IMAGE_DECODE", message: element.alt });
      continue;
    }
    const rect = element.getBoundingClientRect();
    if (
      Math.abs(
        rect.width / rect.height - element.naturalWidth / element.naturalHeight,
      ) > 0.05
    )
      issues.push({ code: "IMAGE_RATIO", message: element.alt });
  }
  return issues;
}

function browserCheckTables(): PageIssue[] {
  const issues: PageIssue[] = [];
  for (const element of Array.from(document.querySelectorAll("table"))) {
    if (element.getBoundingClientRect().width <= innerWidth) continue;
    const parent = element.parentElement;
    if (
      !parent ||
      !["auto", "scroll"].includes(getComputedStyle(parent).overflowX) ||
      !parent.hasAttribute("tabindex")
    )
      issues.push({
        code: "TABLE_OVERFLOW",
        message: "Wide table is not keyboard-scrollable",
      });
  }
  return issues;
}

async function evaluatePageMetrics(
  page: Page,
  expected: { text: string; font: boolean; spacing: boolean; scale: number },
) {
  const box = await page.evaluate(browserCheckDocumentBox);
  const [typography, headings, visibility, images, tables] = await Promise.all([
    page.evaluate(browserCheckTypography, expected),
    page.evaluate(browserCheckHeadingOverlaps, box.vertical),
    page.evaluate(browserCheckElementVisibility),
    page.evaluate(browserCheckImages),
    page.evaluate(browserCheckTables),
  ]);
  return {
    issues: [
      ...typography,
      ...box.issues,
      ...headings,
      ...visibility,
      ...images,
      ...tables,
    ],
    textLength: box.textLength,
    width: box.width,
    height: box.height,
    vertical: box.vertical,
  };
}

function modeStyleSheet(mode: QaMode): string {
  const scheme = mode.dark ? "dark" : "light";
  const color = mode.dark ? "#eee" : "#111";
  const background = mode.dark ? "#111" : "#fff";
  const font = mode.font ? "font-family: monospace !important;" : "";
  const spacing = mode.spacing ? "line-height: 2 !important;" : "";
  const grayscale = mode.grayscale ? "filter: grayscale(1) !important;" : "";
  const blockFont = mode.font
    ? "p, li, blockquote {font-family: monospace !important;}"
    : "";
  const blockSpacing = mode.spacing
    ? "p, li, blockquote {line-height: 2 !important;}"
    : "";
  return `html {color-scheme:${scheme};font-size: ${16 * mode.scale}px !important;} body {color:${color} !important;background:${background} !important;${font}${spacing}${grayscale}} ${blockFont} ${blockSpacing}`;
}

function screenshotReason(
  failed: boolean,
  policy: QaPlan["screenshots"]["policy"],
): string {
  if (failed) return "failure";
  if (policy === "all") return "all";
  return "sample";
}

interface PageCheckContext {
  page: Page;
  packagedDocument: XmlDocument;
  name: string;
  origin: string;
  signal?: AbortSignal;
  assignment: QaPlan["assignments"][number];
  screenshotPolicy: QaPlan["screenshots"]["policy"];
  diagnostics: Diagnostic[];
  cases: unknown[];
  errorCount: () => number;
  capture: (id: string, reason: string) => Promise<string>;
  addAxeFailure: () => void;
}

async function runInitialPageChecks(ctx: PageCheckContext): Promise<string[]> {
  const { page, packagedDocument, name, origin, signal, diagnostics } = ctx;
  await page.goto(`${origin}/${name}`, { waitUntil: "load" });
  await ready(page);
  const axe = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  for (const violation of axe.violations) {
    ctx.addAxeFailure();
    diagnostics.push(
      diagnostic(
        `AXE_${violation.id}`,
        `${violation.help}: ${violation.nodes.map((n) => n.target.join(" ")).join("; ")}`,
        name,
        violation.helpUrl,
      ),
    );
  }
  const fontSet = await page.evaluate(browserReadFonts);
  const expectedCode = elements(packagedDocument, "pre", NS.xhtml).map(
    (el) => el.textContent ?? "",
  );
  const actualCode = await page.locator("pre").allTextContents();
  if (JSON.stringify(expectedCode) !== JSON.stringify(actualCode))
    diagnostics.push(
      diagnostic(
        "QA_CODE_INTEGRITY",
        "Rendered code differs from packaged text",
        name,
      ),
    );
  diagnostics.push(...(await checkPageLinks(page, { name, origin, signal })));
  if (ctx.errorCount()) await ctx.capture("initial", "failure");
  return fontSet;
}

async function runModeCheck(
  ctx: PageCheckContext,
  width: number,
  mode: QaMode,
  expectedBodyText: string,
) {
  const { page, name, origin, signal, assignment, screenshotPolicy } = ctx;
  const before = ctx.errorCount();
  checkAbort(signal);
  await page.setViewportSize({ width, height: 844 });
  await page.emulateMedia({ colorScheme: mode.dark ? "dark" : "light" });
  await page.goto(`${origin}/${name}`, { waitUntil: "load" });
  await page.addStyleTag({ content: modeStyleSheet(mode) });
  await ready(page);
  if (width === 390 && (mode.dark || mode.grayscale)) {
    const contrast = await new AxeBuilder({ page })
      .withRules(["color-contrast"])
      .analyze();
    for (const violation of contrast.violations) {
      ctx.addAxeFailure();
      ctx.diagnostics.push(
        diagnostic(
          `AXE_${violation.id}`,
          `${mode.id}: ${violation.help}`,
          name,
          violation.helpUrl,
        ),
      );
    }
  }
  const metrics = await evaluatePageMetrics(page, {
    text: expectedBodyText,
    font: mode.font,
    spacing: mode.spacing,
    scale: mode.scale,
  });
  for (const issue of metrics.issues)
    ctx.diagnostics.push(
      diagnostic(
        `QA_${issue.code}`,
        `${width}px ${mode.id}: ${issue.message}`,
        name,
      ),
    );
  const failed = ctx.errorCount() > before;
  const retain =
    failed ||
    screenshotPolicy === "all" ||
    (assignment.screenshotSample && width === 390);
  const screenshot = retain
    ? await ctx.capture(
        `${width}-${mode.id}`,
        screenshotReason(failed, screenshotPolicy),
      )
    : undefined;
  ctx.cases.push({
    document: name,
    width,
    mode: mode.id,
    status: failed ? "fail" : "pass",
    metrics,
    screenshot,
  });
}

export async function runPageChecks(
  page: Page,
  packagedDocument: XmlDocument,
  {
    name,
    origin,
    output,
    signal,
    assignment,
    screenshotPolicy,
    observedErrors,
  }: {
    name: string;
    origin: string;
    output: string;
    signal?: AbortSignal;
    assignment: QaPlan["assignments"][number];
    screenshotPolicy: QaPlan["screenshots"]["policy"];
    observedErrors?: () => number;
  },
) {
  const diagnostics: Diagnostic[] = [];
  const errorCount = () => diagnostics.length + (observedErrors?.() ?? 0);
  const cases: unknown[] = [];
  let axeFailures = 0;
  let fontSet: string[] = [];
  const screenshots: PageScreenshot[] = [];
  const capture = async (id: string, reason: string) => {
    const file = `${sha256(name).slice(0, 16)}-${path.posix.basename(name)}-${id}.png`;
    const bytes = await page.screenshot({
      path: path.join(output, "screenshots", file),
      fullPage: true,
      animations: "disabled",
    });
    screenshots.push({ file, document: name, reason, bytes: bytes.length });
    return file;
  };
  const ctx: PageCheckContext = {
    page,
    packagedDocument,
    name,
    origin,
    signal,
    assignment,
    screenshotPolicy,
    diagnostics,
    cases,
    errorCount,
    capture,
    addAxeFailure: () => {
      axeFailures++;
    },
  };
  try {
    fontSet = await runInitialPageChecks(ctx);
    const expectedBodyText =
      elements(packagedDocument, "body", NS.xhtml)[0]?.textContent ?? "";
    const activeModes = modes.filter((mode) =>
      assignment.modes.includes(mode.id),
    );
    const matrix = widths.flatMap((width) =>
      activeModes.map((mode) => ({ width, mode })),
    );
    let chain = Promise.resolve();
    for (const { width, mode } of matrix)
      chain = chain.then(() =>
        runModeCheck(ctx, width, mode, expectedBodyText),
      );
    await chain;
    const pagination = await checkPagination(page, packagedDocument, {
      name,
      origin,
    });
    diagnostics.push(...pagination.diagnostics);
    cases.push(pagination.case);
    if (pagination.diagnostics.length) await capture("pagination", "failure");
  } catch (error) {
    checkAbort(signal);
    diagnostics.push(diagnostic("QA_EXECUTION", String(error), name));
    try {
      await capture("execution", "failure");
    } catch (error) {
      diagnostics.push(diagnostic("QA_SCREENSHOT", String(error), name));
    }
  }
  return { diagnostics, cases, axeFailures, fontSet, screenshots };
}
