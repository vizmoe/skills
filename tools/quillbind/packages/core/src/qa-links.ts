import type { Page } from "@playwright/test";
import { checkAbort, diagnostic } from "./errors.js";
import type { Diagnostic } from "./model.js";
import { ready } from "./qa-ready.js";
import { externalHyperlink } from "./hyperlinks.js";

export async function checkPageLinks(
  page: Page,
  {
    name,
    origin,
    signal,
  }: { name: string; origin: string; signal?: AbortSignal },
) {
  const diagnostics: Diagnostic[] = [];
  const hrefs = await page.locator("a[href]").evaluateAll((anchors) =>
    anchors.map((anchor) => ({
      href: anchor.getAttribute("href")!,
      id: anchor.id,
      footnote: anchor.getAttribute("epub:type") === "noteref",
    })),
  );
  for (const ref of hrefs.filter(
    (h) => !h.footnote && !externalHyperlink(h.href),
  )) {
    checkAbort(signal);
    const destination = new URL(ref.href, `${origin}/${name}`);
    await page.goto(destination.href, { waitUntil: "load" });
    await ready(page);
    if (destination.hash) {
      const visible = await page.evaluate(
        (id) => {
          const element = document.getElementById(id);
          return (
            !!element &&
            (element.getAttribute("epub:type") === "pagebreak" ||
              (element.getBoundingClientRect().width > 0 &&
                element.getBoundingClientRect().height > 0))
          );
        },
        decodeURIComponent(destination.hash.slice(1)),
      );
      if (!visible)
        diagnostics.push(
          diagnostic(
            "QA_LINK_TARGET",
            "Navigation target is not visible",
            name,
          ),
        );
    }
  }
  await page.goto(`${origin}/${name}`, { waitUntil: "load" });
  await ready(page);
  for (const ref of hrefs.filter((h) => h.footnote)) {
    checkAbort(signal);
    const target = page.locator(`[id="${ref.id}"]`);
    await target.click();
    const targetId = decodeURIComponent(new URL(page.url()).hash.slice(1));
    const note = page.locator(`[id="${targetId}"]`);
    if (!(await note.isVisible()))
      diagnostics.push(
        diagnostic("QA_FOOTNOTE", "Footnote target is not visible", name),
      );
    const returns = note.locator("a[href]");
    const returnIndex = await returns.evaluateAll(
      (anchors, expected) =>
        anchors.findIndex((anchor) => {
          const url = new URL(
            anchor.getAttribute("href")!,
            window.location.href,
          );
          return (
            url.origin === expected.origin &&
            url.pathname === expected.pathname &&
            decodeURIComponent(url.hash.slice(1)) === expected.reference
          );
        }),
      {
        origin,
        pathname: new URL(`${origin}/${name}`).pathname,
        reference: ref.id,
      },
    );
    if (returnIndex >= 0) {
      const back = returns.nth(returnIndex);
      await back.click();
      const returned = new URL(page.url());
      if (
        returned.pathname !== new URL(`${origin}/${name}`).pathname ||
        decodeURIComponent(returned.hash.slice(1)) !== ref.id ||
        !(await target.isVisible())
      )
        diagnostics.push(
          diagnostic(
            "QA_FOOTNOTE_RETURN",
            "Footnote did not return to its original reference",
            name,
          ),
        );
    } else
      diagnostics.push(
        diagnostic(
          "QA_FOOTNOTE_RETURN",
          "Footnote has no link to its original reference",
          name,
        ),
      );
  }
  return diagnostics;
}
