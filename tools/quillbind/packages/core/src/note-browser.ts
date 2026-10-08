import path from "node:path";
import {
  chromium,
  devices,
  type CDPSession,
  type Page,
  type Locator,
} from "@playwright/test";
import { randomUUID } from "node:crypto";
import { browserPath, serveEpub } from "./qa-environment.js";
import { checkAbort, fail } from "./errors.js";
import type { EpubInspection } from "./epub.js";
import type { NoteCase } from "./note-cases.js";

export interface NoteFinding {
  code: string;
  message: string;
  caseId?: string;
}
const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
async function unique(locator: Locator) {
  if ((await locator.count()) !== 1)
    fail("NOTE_SELECTOR", "Selector must match exactly one element");
  return locator;
}
async function visible(locator: Locator) {
  return (
    (await locator.count()) === 1 &&
    (await locator.evaluate((el) =>
      el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }),
    ))
  );
}
async function waitVisibility(
  page: Page,
  selector: string,
  expected: boolean,
  timeout: number,
) {
  await page.waitForFunction(
    ({ selector, expected }) => {
      const nodes = document.querySelectorAll(selector);
      const showing =
        nodes.length === 1 &&
        nodes[0].checkVisibility({
          checkOpacity: true,
          checkVisibilityCSS: true,
        });
      return expected ? showing : nodes.length <= 1 && !showing;
    },
    { selector, expected },
    { timeout },
  );
}

export async function runNoteCases(
  info: EpubInspection,
  cases: NoteCase[],
  options: { reports: string; signal?: AbortSignal; timeoutMs?: number },
) {
  checkAbort(options.signal);
  const timeout = options.timeoutMs ?? 4000;
  if (!Number.isFinite(timeout) || timeout < 100 || timeout > 30000)
    fail(
      "NOTE_TIMEOUT",
      "Note timeout must be between 100 and 30000 milliseconds",
    );
  const executablePath = await browserPath();
  const browser = await chromium
    .launch({ executablePath, headless: true, timeout: 30000 })
    .catch((error: unknown) => {
      checkAbort(options.signal);
      return fail(
        "ENVIRONMENT_ERROR",
        `Chromium could not start: ${String(error)}`,
      );
    });
  let server: Awaited<ReturnType<typeof serveEpub>> | undefined;
  let closing: Promise<void> | undefined;
  const close = () => (closing ??= browser.close());
  const aborted = () => {
    void close().catch(() => {});
  };
  options.signal?.addEventListener("abort", aborted, { once: true });
  const findings: NoteFinding[] = [];
  const results: {
    id: string;
    activation: string;
    status: "pass" | "fail";
    screenshot?: string;
    checks?: string[];
    error?: string;
    phase?: string;
  }[] = [];
  try {
    checkAbort(options.signal);
    server = await serveEpub(info, { scriptedNotes: true });
    const origin = server.origin;
    for (const [index, test] of cases.entries())
      for (const activation of test.activations) {
        checkAbort(options.signal);
        const context = await browser.newContext({
          viewport: { width: 390, height: 844 },
          deviceScaleFactor: 1,
          locale: "en-US",
          timezoneId: "UTC",
          // Opaque-origin CSP sandbox denies service workers. Playwright's
          // serviceWorkers:block init script itself throws in that sandbox.
          ...(activation === "touch"
            ? {
                hasTouch: true,
                isMobile: true,
                userAgent: devices["Pixel 7"].userAgent,
              }
            : {}),
          acceptDownloads: false,
          permissions: [],
        });
        const startFinding = findings.length;
        const add = (code: string, message: string) =>
          findings.push({ code, message, caseId: test.id });
        let page: Page | undefined;
        let touch: CDPSession | undefined;
        let phase = "load";
        const checks: string[] = [];
        let screenshot: string | undefined;
        const url =
          origin +
          "/" +
          test.document.split("/").map(encodeURIComponent).join("/");
        try {
          const binding = `quillbind_${randomUUID().replaceAll("-", "")}`;
          await context.exposeBinding(
            binding,
            (_source, directive: unknown) => {
              add("NOTE_CSP", `Blocked policy violation: ${String(directive)}`);
            },
          );
          await context.addInitScript(
            ({ binding }) => {
              const report = (
                globalThis as unknown as Record<
                  string,
                  (value: string) => Promise<void>
                >
              )[binding];
              document.addEventListener("securitypolicyviolation", (event) => {
                void report(event.violatedDirective).catch(() => {});
              });
            },
            { binding },
          );
          await context.routeWebSocket("**/*", async (socket) => {
            add("NOTE_NETWORK", "Blocked WebSocket");
            await socket.close();
          });
          await context.route("**/*", async (route) => {
            const request = route.request(),
              target = new URL(request.url());
            let resource: string;
            try {
              resource = decodeURIComponent(target.pathname.slice(1));
            } catch {
              resource = "";
            }
            if (
              target.origin !== origin ||
              request.method() !== "GET" ||
              !info.entries.has(resource) ||
              (request.isNavigationRequest() &&
                (request.frame() !== page?.mainFrame() ||
                  resource !== test.document))
            ) {
              add(
                "NOTE_NETWORK",
                `Blocked resource/navigation: ${target.origin === origin ? resource : target.origin} (${request.resourceType()})`,
              );
              await route.abort();
            } else await route.continue();
          });
          context.on("page", (opened) => {
            if (page && opened !== page) {
              add("NOTE_POPUP", "Blocked unexpected browser window");
              void opened.close().catch(() => {});
            }
          });
          page = await context.newPage();
          page.setDefaultTimeout(timeout);
          page.on("pageerror", (error) => {
            add("NOTE_SCRIPT", error.message);
          });
          page.on("console", (message) => {
            if (message.type() === "error") add("NOTE_CONSOLE", message.text());
          });
          page.on("dialog", (dialog) => {
            add("NOTE_DIALOG", `Dismissed ${dialog.type()} dialog`);
            void dialog.dismiss().catch(() => {});
          });
          page.on("download", (download) => {
            add("NOTE_DOWNLOAD", "Blocked download");
            void download.cancel().catch(() => {});
          });
          page.on("response", (response) => {
            if (response.status() >= 400)
              add("NOTE_RESOURCE", `HTTP ${response.status()}`);
          });
          await page.goto(url, { waitUntil: "load", timeout });
          phase = "activate";
          const trigger = await unique(page.locator("css=" + test.trigger));
          const popup = page.locator("css=" + test.popup);
          if (await visible(popup))
            fail(
              "NOTE_ALREADY_VISIBLE",
              "Expected popup is already visible before activation; no popup opening has been demonstrated",
            );
          checks.push("initially-hidden");
          if (activation === "click") await trigger.click();
          else if (activation === "hover") await trigger.hover();
          else if (activation === "touch") {
            await trigger.scrollIntoViewIfNeeded();
            const box = await trigger.boundingBox();
            if (!box) fail("NOTE_TOUCH", "Reference has no touch target");
            touch = await context.newCDPSession(page);
            await touch.send("Input.dispatchTouchEvent", {
              type: "touchStart",
              touchPoints: [
                { x: box.x + box.width / 2, y: box.y + box.height / 2 },
              ],
            });
          } else {
            await trigger.focus();
            if (
              !(await trigger.evaluate((el) => el === document.activeElement))
            )
              fail("NOTE_FOCUS", "Reference cannot receive keyboard focus");
            await page.keyboard.press("Enter");
          }
          await waitVisibility(page, test.popup, true, timeout);
          checks.push("opened");
          phase = "content";
          await unique(popup);
          if (
            !(await visible(popup)) ||
            !normalize(await popup.innerText()).includes(
              normalize(test.expectedText),
            )
          )
            fail(
              "NOTE_CONTENT",
              "Popup does not visibly contain the expected note text",
            );
          checks.push("expected-text");
          const box = await popup.boundingBox(),
            viewport = await page.evaluate(() => ({
              x: window.visualViewport?.offsetLeft ?? 0,
              y: window.visualViewport?.offsetTop ?? 0,
              width: window.visualViewport?.width ?? innerWidth,
              height: window.visualViewport?.height ?? innerHeight,
            }));
          if (
            !box ||
            box.x + box.width <= viewport.x ||
            box.y + box.height <= viewport.y ||
            box.x >= viewport.x + viewport.width ||
            box.y >= viewport.y + viewport.height
          )
            fail("NOTE_OFFSCREEN", "Opened note is outside the viewport");
          checks.push("visible-in-viewport");
          screenshot = path.join(
            options.reports,
            `${index + 1}-${activation}.png`,
          );
          await page.screenshot({ path: screenshot, timeout });
          phase = "dismiss";
          if ("selector" in test.dismiss)
            await (
              await unique(page.locator("css=" + test.dismiss.selector))
            ).click();
          else if ("key" in test.dismiss)
            await page.keyboard.press(test.dismiss.key);
          else if (touch)
            await touch.send("Input.dispatchTouchEvent", {
              type: "touchEnd",
              touchPoints: [],
            });
          else await page.mouse.move(0, 0);
          await waitVisibility(page, test.popup, false, timeout);
          checks.push("dismissed");
          phase = "return";
          if (
            test.returnFocus &&
            !(await (
              await unique(page.locator("css=" + test.returnFocus))
            ).evaluate((el) => el === document.activeElement))
          )
            fail(
              "NOTE_RETURN",
              "Dismissal did not restore focus to the reference",
            );
          if (test.returnFocus) checks.push("focus-returned");
          if (
            new URL(page.url()).origin !== origin ||
            decodeURIComponent(new URL(page.url()).pathname.slice(1)) !==
              test.document
          )
            fail(
              "NOTE_NAVIGATION",
              "Note interaction left its source document",
            );
          checks.push("source-document-retained");
          // Let asynchronous policy/error notifications settle before declaring this case complete.
          await page.waitForTimeout(50);
          if (findings.length !== startFinding)
            fail(
              "NOTE_SIDE_EFFECT",
              "Script errors or blocked side effects occurred during the interaction",
            );
          results.push({
            id: test.id,
            activation,
            status: "pass",
            screenshot,
            checks,
          });
        } catch (error) {
          checkAbort(options.signal);
          const e = error as Error & { code?: string };
          add(e.code ?? "NOTE_INTERACTION", e.message);
          if (!screenshot && page && !page.isClosed()) {
            const file = path.join(
              options.reports,
              `${index + 1}-${activation}-failure.png`,
            );
            try {
              await page.screenshot({ path: file, timeout });
              screenshot = file;
            } catch {
              /* Keep the interaction error when screenshots are unavailable. */
            }
          }
          results.push({
            id: test.id,
            activation,
            status: "fail",
            error: e.message,
            phase,
            checks,
            ...(screenshot ? { screenshot } : {}),
          });
        } finally {
          try {
            await context.close();
          } catch (error) {
            add("NOTE_CLEANUP", String(error));
          }
        }
      }
  } catch (error) {
    checkAbort(options.signal);
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", aborted);
    const cleanup = await Promise.allSettled([close(), server?.close()]);
    for (const outcome of cleanup)
      if (outcome.status === "rejected")
        findings.push({
          code: "NOTE_CLEANUP",
          message: String(outcome.reason),
        });
  }
  checkAbort(options.signal);
  return {
    status:
      findings.length ||
      results.length !== cases.reduce((n, c) => n + c.activations.length, 0)
        ? ("fail" as const)
        : ("pass" as const),
    cases: results,
    findings,
    environment: {
      browser: browser.version(),
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      viewport: { width: 390, height: 844 },
      touchUserAgent: devices["Pixel 7"].userAgent,
      network:
        "packaged GET resources only; connections, workers and frames blocked",
      sourceScripts: "explicitly-enabled",
    },
  };
}
