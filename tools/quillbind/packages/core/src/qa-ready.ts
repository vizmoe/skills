import type { Page } from "@playwright/test";

export async function ready(page: Page) {
  await page.waitForLoadState("load");
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      Array.from(document.images).map((image) => image.decode()),
    );
    let previous = "",
      stable = 0;
    for (let i = 0; i < 120; i++) {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
      const value = [
        document.documentElement.scrollWidth,
        document.documentElement.scrollHeight,
        document.body.getBoundingClientRect().width,
        document.body.getBoundingClientRect().height,
      ].join(":");
      if (value === previous) stable++;
      else stable = 0;
      previous = value;
      if (stable >= 3) return;
    }
    throw new Error("Layout did not stabilize");
  });
}
