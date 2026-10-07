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
  const screenshots: {
    file: string;
    document: string;
    reason: string;
    bytes: number;
  }[] = [];
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
  try {
    await page.goto(`${origin}/${name}`, { waitUntil: "load" });
    await ready(page);
    const axe = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
      .analyze();
    for (const violation of axe.violations) {
      axeFailures++;
      diagnostics.push(
        diagnostic(
          `AXE_${violation.id}`,
          `${violation.help}: ${violation.nodes.map((n) => n.target.join(" ")).join("; ")}`,
          name,
          violation.helpUrl,
        ),
      );
    }
    fontSet = await page.evaluate(() =>
      Array.from(document.fonts)
        .map((font) => `${font.family}:${font.status}`)
        .sort(),
    );
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
    if (errorCount()) await capture("initial", "failure");
    for (const width of widths)
      for (const mode of modes.filter((mode) =>
        assignment.modes.includes(mode.id),
      )) {
        const before = errorCount();
        checkAbort(signal);
        await page.setViewportSize({ width, height: 844 });
        await page.emulateMedia({
          colorScheme: mode.dark ? "dark" : "light",
        });
        await page.goto(`${origin}/${name}`, { waitUntil: "load" });
        await page.addStyleTag({
          content: `html {color-scheme:${mode.dark ? "dark" : "light"};font-size: ${16 * mode.scale}px !important;} body {color:${mode.dark ? "#eee" : "#111"} !important;background:${mode.dark ? "#111" : "#fff"} !important;${mode.font ? "font-family: monospace !important;" : ""}${mode.spacing ? "line-height: 2 !important;" : ""}${mode.grayscale ? "filter: grayscale(1) !important;" : ""}} ${mode.font ? "p, li, blockquote {font-family: monospace !important;}" : ""} ${mode.spacing ? "p, li, blockquote {line-height: 2 !important;}" : ""}`,
        });
        await ready(page);
        if (width === 390 && (mode.dark || mode.grayscale)) {
          const contrast = await new AxeBuilder({ page })
            .withRules(["color-contrast"])
            .analyze();
          for (const violation of contrast.violations) {
            axeFailures++;
            diagnostics.push(
              diagnostic(
                `AXE_${violation.id}`,
                `${mode.id}: ${violation.help}`,
                name,
                violation.helpUrl,
              ),
            );
          }
        }
        const expectedBodyText =
          elements(packagedDocument, "body", NS.xhtml)[0]?.textContent ?? "";
        const metrics = await page.evaluate(
          (expected) => {
            const issues: { code: string; message: string }[] = [];
            const body = document.body;
            if (body.textContent !== expected.text)
              issues.push({
                code: "TEXT_INTEGRITY",
                message: "Rendered body text differs from packaged XHTML",
              });
            for (const paragraph of Array.from(
              document.querySelectorAll("p, li"),
            )) {
              const style = getComputedStyle(paragraph);
              if (expected.font && !style.fontFamily.includes("monospace"))
                issues.push({
                  code: "FONT_OVERRIDE",
                  message: "Reader font override did not take effect",
                });
              if (
                expected.spacing &&
                Math.abs(
                  parseFloat(style.lineHeight) / parseFloat(style.fontSize) - 2,
                ) > 0.05
              )
                issues.push({
                  code: "SPACING_OVERRIDE",
                  message: "Reader line spacing did not take effect",
                });
              if (expected.scale === 2 && parseFloat(style.fontSize) < 31.9)
                issues.push({
                  code: "TEXT_SCALE",
                  message: "Body text did not scale to 200%",
                });
            }
            const vertical = Array.from(body.children).some(
              (e) => getComputedStyle(e).writingMode === "vertical-rl",
            );
            if (!body.textContent?.trim() && !document.images.length)
              issues.push({
                code: "EMPTY",
                message: "No visible book content",
              });
            if (
              body.getBoundingClientRect().width === 0 ||
              body.getBoundingClientRect().height === 0
            )
              issues.push({
                code: "ZERO_SIZE",
                message: "Zero-sized document body",
              });
            if (
              !vertical &&
              document.documentElement.scrollWidth > innerWidth + 2
            )
              issues.push({
                code: "OVERFLOW",
                message: `Horizontal overflow: ${document.documentElement.scrollWidth}/${innerWidth}`,
              });
            for (const element of Array.from(
              document.querySelectorAll(
                "p,h1,h2,h3,h4,h5,h6,pre,figure,table,math,img,aside",
              ),
            )) {
              const style = getComputedStyle(element);
              const rect = element.getBoundingClientRect();
              const next = element.nextElementSibling;
              if (
                !vertical &&
                /^H[1-6]$/.test(element.tagName) &&
                next &&
                next.textContent?.trim()
              ) {
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
              if (
                (element.textContent?.trim() ||
                  element.tagName.toLowerCase() === "img") &&
                (style.display === "none" ||
                  style.visibility === "hidden" ||
                  Number(style.opacity) === 0 ||
                  rect.width === 0 ||
                  rect.height === 0)
              )
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
              if (element instanceof HTMLImageElement) {
                if (!element.complete || !element.naturalWidth)
                  issues.push({
                    code: "IMAGE_DECODE",
                    message: element.alt,
                  });
                else if (
                  Math.abs(
                    rect.width / rect.height -
                      element.naturalWidth / element.naturalHeight,
                  ) > 0.05
                )
                  issues.push({
                    code: "IMAGE_RATIO",
                    message: element.alt,
                  });
              }
              if (
                element.tagName.toLowerCase() === "table" &&
                rect.width > innerWidth
              ) {
                const parent = element.parentElement;
                if (
                  !parent ||
                  !["auto", "scroll"].includes(
                    getComputedStyle(parent).overflowX,
                  ) ||
                  !parent.hasAttribute("tabindex")
                )
                  issues.push({
                    code: "TABLE_OVERFLOW",
                    message: "Wide table is not keyboard-scrollable",
                  });
              }
            }
            return {
              issues,
              textLength: body.textContent?.length ?? 0,
              width: document.documentElement.scrollWidth,
              height: document.documentElement.scrollHeight,
              vertical,
            };
          },
          {
            text: expectedBodyText,
            font: mode.font,
            spacing: mode.spacing,
            scale: mode.scale,
          },
        );
        for (const issue of metrics.issues)
          diagnostics.push(
            diagnostic(
              `QA_${issue.code}`,
              `${width}px ${mode.id}: ${issue.message}`,
              name,
            ),
          );
        const failed = errorCount() > before;
        const retain =
          failed ||
          screenshotPolicy === "all" ||
          (assignment.screenshotSample && width === 390);
        const screenshot = retain
          ? await capture(
              `${width}-${mode.id}`,
              failed
                ? "failure"
                : screenshotPolicy === "all"
                  ? "all"
                  : "sample",
            )
          : undefined;
        cases.push({
          document: name,
          width,
          mode: mode.id,
          status: failed ? "fail" : "pass",
          metrics,
          screenshot,
        });
      }
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
