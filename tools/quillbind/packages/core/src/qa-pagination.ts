import type { Page } from "@playwright/test";
import type { Document as XmlDocument } from "@xmldom/xmldom";
import type { Diagnostic } from "./model.js";
import { elements, NS } from "./xml.js";
import { diagnostic } from "./errors.js";
import { ready } from "./qa-ready.js";

export function paginationPreservesContent(
  expectedText: string | null | undefined,
  actualText: string | null,
  metrics: {
    hiddenText: number;
    fragments: number;
    images: number;
    hiddenImages: number;
  },
) {
  return (
    actualText === expectedText &&
    metrics.hiddenText === 0 &&
    metrics.hiddenImages === 0 &&
    (expectedText?.trim() ? metrics.fragments > 0 : metrics.images > 0)
  );
}
export async function checkPagination(
  page: Page,
  packagedDocument: XmlDocument,
  { name, origin }: { name: string; origin: string },
) {
  const diagnostics: Diagnostic[] = [];
  // A CSS-column harness exercises pagination against the same packaged XHTML.
  await page.setViewportSize({ width: 768, height: 844 });
  await page.goto(`${origin}/${name}`);
  await page.addStyleTag({
    content: "body { column-width: 22em; column-gap: 2em; height: 40em; }",
  });
  await ready(page);
  const paginatedText = await page.locator("body").textContent();
  const expectedText = elements(packagedDocument, "body", NS.xhtml)[0]
    ?.textContent;
  const pagination = await page.evaluate(() => {
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
    );
    let hiddenText = 0,
      fragments = 0;
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (
        !node.textContent?.trim() ||
        ["STYLE", "SCRIPT"].includes(node.parentElement?.tagName ?? "")
      )
        continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const visible = Array.from(range.getClientRects()).filter(
        (r) => r.width > 0 && r.height > 0,
      );
      fragments += visible.length;
      if (!visible.length) hiddenText++;
    }
    const images = Array.from(document.images);
    const hiddenImages = images.filter((image) => {
      const rect = image.getBoundingClientRect();
      const style = getComputedStyle(image);
      return (
        !image.complete ||
        !image.naturalWidth ||
        style.display === "none" ||
        style.visibility === "hidden" ||
        Number(style.opacity) === 0 ||
        rect.width === 0 ||
        rect.height === 0
      );
    }).length;
    return { hiddenText, fragments, images: images.length, hiddenImages };
  });
  const paginationPass = paginationPreservesContent(
    expectedText,
    paginatedText,
    pagination,
  );
  if (!paginationPass)
    diagnostics.push(
      diagnostic("QA_PAGINATION", "Pagination lost content", name),
    );
  const testCase = {
    document: name,
    mode: "pagination",
    status: paginationPass ? "pass" : "fail",
    metrics: pagination,
  };
  return { diagnostics, case: testCase };
}
