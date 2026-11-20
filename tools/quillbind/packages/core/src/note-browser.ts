import path from "node:path";
import {
  chromium,
  devices,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Locator,
  type Page,
  type Request,
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

type NoteActivation = NoteCase["activations"][number];

export interface NoteCaseResult {
  id: string;
  activation: string;
  status: "pass" | "fail";
  screenshot?: string;
  checks?: string[];
  error?: string;
  phase?: string;
}

interface NoteActivationTask {
  test: NoteCase;
  index: number;
  activation: NoteActivation;
}

async function createNoteContext(browser: Browser, activation: NoteActivation) {
  return browser.newContext({
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
}

function decodeResourcePath(target: URL): string {
  try {
    return decodeURIComponent(target.pathname.slice(1));
  } catch {
    return "";
  }
}

function isBlockedNoteRequest(
  request: Request,
  target: URL,
  resource: string,
  origin: string,
  info: EpubInspection,
  page: Page | undefined,
  documentPath: string,
): boolean {
  if (
    target.origin !== origin ||
    request.method() !== "GET" ||
    !info.entries.has(resource)
  )
    return true;
  return (
    request.isNavigationRequest() &&
    (request.frame() !== page?.mainFrame() || resource !== documentPath)
  );
}

async function configureNoteContext(
  context: BrowserContext,
  info: EpubInspection,
  origin: string,
  test: NoteCase,
  add: (code: string, message: string) => void,
  getPage: () => Page | undefined,
) {
  const binding = `quillbind_${randomUUID().replaceAll("-", "")}`;
  await context.exposeBinding(binding, (_source, directive: unknown) => {
    add("NOTE_CSP", `Blocked policy violation: ${String(directive)}`);
  });
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
    const resource = decodeResourcePath(target);
    if (
      isBlockedNoteRequest(
        request,
        target,
        resource,
        origin,
        info,
        getPage(),
        test.document,
      )
    ) {
      add(
        "NOTE_NETWORK",
        `Blocked resource/navigation: ${target.origin === origin ? resource : target.origin} (${request.resourceType()})`,
      );
      await route.abort();
      return;
    }
    await route.continue();
  });
  context.on("page", (opened) => {
    const current = getPage();
    if (current && opened !== current) {
      add("NOTE_POPUP", "Blocked unexpected browser window");
      void opened.close().catch(() => {});
    }
  });
}

function attachNotePageListeners(
  page: Page,
  add: (code: string, message: string) => void,
) {
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
}

async function activateNoteTrigger(
  page: Page,
  context: BrowserContext,
  trigger: Locator,
  activation: NoteActivation,
): Promise<CDPSession | undefined> {
  if (activation === "click") {
    await trigger.click();
    return undefined;
  }
  if (activation === "hover") {
    await trigger.hover();
    return undefined;
  }
  if (activation === "touch") {
    await trigger.scrollIntoViewIfNeeded();
    const box = await trigger.boundingBox();
    if (!box) fail("NOTE_TOUCH", "Reference has no touch target");
    const touch = await context.newCDPSession(page);
    await touch.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }],
    });
    return touch;
  }
  await trigger.focus();
  if (!(await trigger.evaluate((el) => el === document.activeElement)))
    fail("NOTE_FOCUS", "Reference cannot receive keyboard focus");
  await page.keyboard.press("Enter");
  return undefined;
}

async function verifyPopupVisibleAndInViewport(
  page: Page,
  popup: Locator,
  expectedText: string,
  checks: string[],
) {
  await unique(popup);
  if (
    !(await visible(popup)) ||
    !normalize(await popup.innerText()).includes(normalize(expectedText))
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
}

async function dismissNotePopup(
  page: Page,
  dismiss: NoteCase["dismiss"],
  touch: CDPSession | undefined,
) {
  if ("selector" in dismiss) {
    const control = await unique(page.locator("css=" + dismiss.selector));
    await control.click();
    return;
  }
  if ("key" in dismiss) {
    await page.keyboard.press(dismiss.key);
    return;
  }
  if (touch) {
    await touch.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    return;
  }
  await page.mouse.move(0, 0);
}

async function verifyNoteReturnState(
  page: Page,
  test: NoteCase,
  origin: string,
  checks: string[],
) {
  if (test.returnFocus) {
    const focusTarget = await unique(page.locator("css=" + test.returnFocus));
    const focused = await focusTarget.evaluate(
      (el) => el === document.activeElement,
    );
    if (!focused)
      fail("NOTE_RETURN", "Dismissal did not restore focus to the reference");
    checks.push("focus-returned");
  }
  const currentUrl = new URL(page.url());
  if (
    currentUrl.origin !== origin ||
    decodeURIComponent(currentUrl.pathname.slice(1)) !== test.document
  )
    fail("NOTE_NAVIGATION", "Note interaction left its source document");
  checks.push("source-document-retained");
}

async function captureFailureScreenshot(
  page: Page | undefined,
  reports: string,
  index: number,
  activation: NoteActivation,
  timeout: number,
): Promise<string | undefined> {
  if (!page || page.isClosed()) return undefined;
  const file = path.join(reports, `${index + 1}-${activation}-failure.png`);
  try {
    await page.screenshot({ path: file, timeout });
    return file;
  } catch {
    /* Keep the interaction error when screenshots are unavailable. */
    return undefined;
  }
}

async function runNoteActivation(
  browser: Browser,
  info: EpubInspection,
  origin: string,
  task: NoteActivationTask,
  options: {
    reports: string;
    signal?: AbortSignal;
    timeout: number;
    findings: NoteFinding[];
    results: NoteCaseResult[];
  },
) {
  const { test, index, activation } = task;
  const { reports, signal, timeout, findings, results } = options;
  checkAbort(signal);
  const context = await createNoteContext(browser, activation);
  const startFinding = findings.length;
  const add = (code: string, message: string) =>
    findings.push({ code, message, caseId: test.id });
  let page: Page | undefined;
  let phase = "load";
  const checks: string[] = [];
  let screenshot: string | undefined;
  const url =
    origin + "/" + test.document.split("/").map(encodeURIComponent).join("/");
  try {
    await configureNoteContext(context, info, origin, test, add, () => page);
    page = await context.newPage();
    page.setDefaultTimeout(timeout);
    attachNotePageListeners(page, add);
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
    const touch = await activateNoteTrigger(page, context, trigger, activation);
    await waitVisibility(page, test.popup, true, timeout);
    checks.push("opened");
    phase = "content";
    await verifyPopupVisibleAndInViewport(
      page,
      popup,
      test.expectedText,
      checks,
    );
    screenshot = path.join(reports, `${index + 1}-${activation}.png`);
    await page.screenshot({ path: screenshot, timeout });
    phase = "dismiss";
    await dismissNotePopup(page, test.dismiss, touch);
    await waitVisibility(page, test.popup, false, timeout);
    checks.push("dismissed");
    phase = "return";
    await verifyNoteReturnState(page, test, origin, checks);
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
    checkAbort(signal);
    const e = error as Error & { code?: string };
    add(e.code ?? "NOTE_INTERACTION", e.message);
    if (!screenshot)
      screenshot = await captureFailureScreenshot(
        page,
        reports,
        index,
        activation,
        timeout,
      );
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
  const results: NoteCaseResult[] = [];
  try {
    checkAbort(options.signal);
    server = await serveEpub(info, { scriptedNotes: true });
    const origin = server.origin;
    const tasks: NoteActivationTask[] = cases.flatMap((test, index) =>
      test.activations.map((activation) => ({ test, index, activation })),
    );
    let chain = Promise.resolve();
    for (const task of tasks)
      chain = chain.then(() =>
        runNoteActivation(browser, info, origin, task, {
          reports: options.reports,
          signal: options.signal,
          timeout,
          findings,
          results,
        }),
      );
    await chain;
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
