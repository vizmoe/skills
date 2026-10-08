import {
  planFromBytes,
  guessMedia,
  type RepairPlan,
  type RepairAction,
  REPAIR_RULE_VERSION,
} from "./repair-plan.js";
import { fingerprint } from "./repair-content.js";
import {
  imageCenteringRepairs,
  standaloneReadingImages,
} from "./repair-images.js";
import { externalHyperlink } from "./hyperlinks.js";
import { missingFontFaces, missingFontSources } from "./repair-fonts.js";
import { repairableCss } from "./repair-css.js";
import {
  readingCss,
  readingCssPath,
  readingImageClass,
} from "./repair-reflow.js";
export {
  planFromBytes,
  type RepairPlan,
  type RepairAction,
} from "./repair-plan.js";
import fs from "node:fs/promises";
import path from "node:path";
import postcss from "postcss";
import { inspectBytes } from "./epub.js";
import { validateInternal } from "./validate.js";
import { ncxXml, serialize, elements, attr, NS } from "./xml.js";
import { pack } from "./zip.js";
import { sha256 } from "./hash.js";
import { fail, checkAbort } from "./errors.js";
import { json, stable, readJson } from "./json.js";
import { localTarget } from "./paths.js";
import { escapeXml as e } from "./xml.js";
import { exists, readSourceFile } from "./files.js";
import { repoRoot } from "./runtime.js";
import { releaseGates, doctor } from "./pipeline.js";
import { ReleaseReporter } from "./reporting.js";

export async function createRepairPlan(
  file: string,
  options: { output?: string; purpose?: RepairPlan["purpose"] } = {},
) {
  const plan = planFromBytes(await readSourceFile(file), options.purpose);
  if (options.output) await json(options.output, plan);
  return plan;
}
export async function auditEpub(file: string) {
  const bytes = await readSourceFile(file);
  const inspection = inspectBytes(bytes);
  return {
    status: inspection.unsupported.length ? "unsupported" : "audited",
    inputSha256: inspection.sha256,
    validation: validateInternal(inspection),
    plan: planFromBytes(inspection),
  };
}
export function applyRepair(
  bytes: Uint8Array,
  plan: RepairPlan,
): { bytes: Buffer; integrity: unknown; changes: RepairAction[] } {
  const info = inspectBytes(bytes);
  if (
    plan.inputSha256 !== sha256(bytes) ||
    plan.ruleVersion !== REPAIR_RULE_VERSION ||
    stable(plan) !== stable(planFromBytes(info, plan.purpose))
  )
    fail(
      "REPAIR_PLAN_STALE",
      "Repair plan differs from current input or rules",
    );
  if (plan.actions.some((a) => a.classification === "unsupported"))
    fail("UNSUPPORTED_EPUB", "Unsupported content remains protected");
  const scriptedContent = plan.actions.some(
    (a) => a.ruleId === "scripted-notes-preserve",
  )
    ? {
        status: "preserved" as const,
        interactions: "not-run" as const,
        resources: [...info.entries]
          .filter(([name]) => ![info.packagePath, "mimetype"].includes(name))
          .map(([name, entry]) => ({ name, sha256: sha256(entry.bytes) })),
      }
    : undefined;
  const before = fingerprint(info);
  const entries = new Map(
    [...info.entries].map(([name, entry]) => [name, entry.bytes]),
  );
  const changes = plan.actions.filter((a) => a.classification === "safe");
  if (!changes.length)
    return {
      bytes: Buffer.from(bytes),
      integrity: {
        status: "pass",
        before,
        after: before,
        unchanged: true,
        ...(scriptedContent ? { scriptedContent } : {}),
      },
      changes,
    };
  const has = (rule: string, resource?: string) =>
    changes.some(
      (a) => a.ruleId === rule && (!resource || a.resource === resource),
    );
  const packageDoc = info.packageDocument;
  const metadata = elements(packageDoc, "metadata", NS.opf)[0];
  const manifest = elements(packageDoc, "manifest", NS.opf)[0];
  if (!metadata || !manifest)
    fail(
      "REPAIR_REVIEW_REQUIRED",
      "Missing metadata/manifest structure requires source metadata",
    );
  const addMeta = (key: string, value: string) => {
    const el = packageDoc.createElementNS(NS.opf, "meta");
    el.setAttribute("property", key);
    el.appendChild(packageDoc.createTextNode(value));
    metadata.appendChild(el);
  };
  if (has("epub3-package"))
    packageDoc.documentElement!.setAttribute("version", "3.0");
  if (has("identifier-reference"))
    packageDoc.documentElement!.setAttribute(
      "unique-identifier",
      attr(elements(packageDoc, "identifier", NS.dc)[0], "id"),
    );
  for (const action of changes.filter(
    (action) => action.ruleId === "ncx-identifier",
  )) {
    const ncx = ncxXml(
      entries.get(action.resource)!.toString(),
      action.resource,
    );
    const identifier = elements(packageDoc, "identifier", NS.dc).find(
      (el) =>
        attr(el, "id") ===
        attr(packageDoc.documentElement!, "unique-identifier"),
    )!;
    elements(ncx, "meta")
      .find((el) => attr(el, "name") === "dtb:uid")!
      .setAttribute("content", identifier.textContent!);
    entries.set(action.resource, Buffer.from(serialize(ncx)));
  }
  if (has("modified")) addMeta("dcterms:modified", "2000-01-01T00:00:00Z");
  if (has("package-language"))
    packageDoc.documentElement!.setAttributeNS(
      "http://www.w3.org/XML/1998/namespace",
      "xml:lang",
      info.language,
    );
  if (has("accessibility-discovery")) {
    const values: Record<string, string> = {
      "schema:accessMode": "textual",
      "schema:accessModeSufficient": "textual",
      "schema:accessibilityFeature": "tableOfContents",
      "schema:accessibilityHazard": "unknown",
      "schema:accessibilitySummary":
        "Existing content preserved. Automated results are reported separately; accessibility has not been certified.",
    };
    for (const [key, value] of Object.entries(values))
      if (
        !elements(packageDoc, "meta", NS.opf).some(
          (m) => attr(m, "property") === key,
        )
      )
        addMeta(key, value);
  }
  if (has("reading-reflow")) {
    const cssPath = readingCssPath(info);
    if (entries.has(cssPath) && entries.get(cssPath)!.toString() !== readingCss)
      fail(
        "REPAIR_COLLISION",
        "Reading stylesheet path is occupied by other content",
      );
    entries.set(cssPath, Buffer.from(readingCss));
    if (!info.manifest.some((item) => item.path === cssPath)) {
      const item = packageDoc.createElementNS(NS.opf, "item");
      let id = "quillbind-reading";
      while (elements(packageDoc).some((el) => attr(el, "id") === id))
        id += "-style";
      item.setAttribute("id", id);
      item.setAttribute("href", path.posix.basename(cssPath));
      item.setAttribute("media-type", "text/css");
      manifest.appendChild(item);
    }
  }
  for (const item of info.manifest) {
    const el = elements(packageDoc, "item", NS.opf).find(
      (e) => attr(e, "id") === item.id,
    )!;
    if (has("media-type", item.path))
      el.setAttribute(
        "media-type",
        guessMedia(item.path, info.entries.get(item.path)!.bytes)!,
      );
    if (has("mathml-property", item.path))
      el.setAttribute("properties", [...item.properties, "mathml"].join(" "));
  }
  for (const action of changes.filter((a) => a.ruleId === "manifest-add")) {
    const el = packageDoc.createElementNS(NS.opf, "item");
    el.setAttribute("id", "resource-" + sha256(action.resource).slice(0, 12));
    el.setAttribute(
      "href",
      path.posix.relative(
        path.posix.dirname(info.packagePath),
        action.resource,
      ),
    );
    el.setAttribute(
      "media-type",
      guessMedia(action.resource, info.entries.get(action.resource)!.bytes)!,
    );
    manifest.appendChild(el);
  }
  if (has("navigation")) {
    const navPath = path.posix.join(
      path.posix.dirname(info.packagePath),
      "quillbind-nav.xhtml",
    );
    if (entries.has(navPath))
      fail("REPAIR_COLLISION", "Navigation output path already exists");
    const ncx = info.manifest.find(
      (m) => m.mediaType === "application/x-dtbncx+xml",
    );
    let toc: string;
    if (ncx && entries.has(ncx.path)) {
      const source = ncxXml(entries.get(ncx.path)!.toString(), ncx.path);
      const map = elements(source, "navMap")[0];
      const renderPoints = (parent: import("@xmldom/xmldom").Element): string =>
        "<ol>" +
        Array.from(parent.childNodes)
          .filter(
            (n) =>
              n.nodeType === 1 &&
              (n as import("@xmldom/xmldom").Element).localName === "navPoint",
          )
          .map((node) => {
            const point = node as import("@xmldom/xmldom").Element;
            const target = localTarget(
              ncx.path,
              attr(elements(point, "content")[0], "src"),
            );
            const href =
              path.posix.relative(path.posix.dirname(navPath), target.path) +
              (target.fragment ? "#" + target.fragment : "");
            return `<li><a href="${e(href)}">${e(elements(point, "text")[0]?.textContent ?? "Chapter")}</a>${Array.from(point.childNodes).some((n) => (n as import("@xmldom/xmldom").Element).localName === "navPoint") ? renderPoints(point) : ""}</li>`;
          })
          .join("") +
        "</ol>";
      toc = map ? renderPoints(map) : "";
    } else toc = "";
    if (!toc)
      toc =
        "<ol>" +
        info.spine
          .map((id) => {
            const item = info.manifest.find((m) => m.id === id)!;
            const doc = info.documents.get(item.path);
            const title = doc
              ? (elements(doc, "h1")[0]?.textContent ??
                elements(doc, "title")[0]?.textContent)
              : undefined;
            if (!title?.trim())
              fail(
                "REPAIR_REVIEW_REQUIRED",
                `No reliable chapter title: ${item.path}`,
              );
            return `<li><a href="${e(path.posix.relative(path.posix.dirname(navPath), item.path))}">${e(title)}</a></li>`;
          })
          .join("") +
        "</ol>";
    const nav = `<?xml version="1.0" encoding="utf-8"?><html xmlns="${NS.xhtml}" xmlns:epub="${NS.epub}" lang="${e(info.language)}" xml:lang="${e(info.language)}"><head><title>Contents</title></head><body><nav epub:type="toc" role="doc-toc" aria-label="Contents"><h1>Contents</h1>${toc}</nav><nav epub:type="landmarks" aria-label="Landmarks"><h2>Landmarks</h2><ol><li><a epub:type="bodymatter" href="${e(path.posix.relative(path.posix.dirname(navPath), info.manifest.find((m) => m.id === info.spine[0])!.path))}">Start of text</a></li></ol></nav></body></html>`;
    entries.set(navPath, Buffer.from(nav));
    for (const el of elements(packageDoc, "item", NS.opf))
      if (attr(el, "properties").includes("nav")) {
        if (!entries.has(localTarget(info.packagePath, attr(el, "href")).path))
          el.parentNode!.removeChild(el);
        else
          el.setAttribute(
            "properties",
            attr(el, "properties")
              .split(" ")
              .filter((p) => p !== "nav")
              .join(" "),
          );
      }
    const el = packageDoc.createElementNS(NS.opf, "item");
    el.setAttribute("id", "quillbind-nav");
    el.setAttribute("href", path.posix.basename(navPath));
    el.setAttribute("media-type", "application/xhtml+xml");
    el.setAttribute("properties", "nav");
    manifest.appendChild(el);
  }
  for (const [name, document] of info.documents) {
    let changed = has("legacy-xhtml", name);
    if (has("reading-reflow")) {
      const cssPath = readingCssPath(info);
      const head = elements(document, "head", NS.xhtml)[0];
      if (!head) fail("REPAIR_REVIEW_REQUIRED", `Missing head: ${name}`);
      const linked = elements(head, "link", NS.xhtml).some((el) => {
        try {
          return (
            attr(el, "rel") === "stylesheet" &&
            localTarget(name, attr(el, "href")).path === cssPath
          );
        } catch {
          return false;
        }
      });
      if (!linked) {
        const link = document.createElementNS(NS.xhtml, "link");
        link.setAttribute("rel", "stylesheet");
        link.setAttribute("type", "text/css");
        link.setAttribute(
          "href",
          path.posix.relative(path.posix.dirname(name), cssPath),
        );
        head.appendChild(link);
        changed = true;
      }
      for (const image of standaloneReadingImages(document)) {
        const classes = attr(image, "class").split(/\s+/).filter(Boolean);
        if (!classes.includes(readingImageClass)) {
          image.setAttribute(
            "class",
            [...classes, readingImageClass].join(" "),
          );
          changed = true;
        }
      }
    }
    if (has("standalone-image-centering", name)) {
      for (const repair of imageCenteringRepairs(document).repairs)
        for (const { element, style } of repair)
          element.setAttribute("style", style);
      changed = true;
    }
    if (has("language-attribute", name)) {
      document.documentElement!.setAttribute(
        "lang",
        attr(document.documentElement!, "xml:lang"),
      );
      changed = true;
    }
    if (has("document-language", name)) {
      document.documentElement!.setAttribute("lang", info.language);
      document.documentElement!.setAttributeNS(
        "http://www.w3.org/XML/1998/namespace",
        "xml:lang",
        info.language,
      );
      changed = true;
    }
    if (has("duplicate-id", name)) {
      const ids = new Set<string>();
      for (const el of elements(document)) {
        const id = attr(el, "id");
        if (!id) continue;
        if (ids.has(id)) {
          let suffix = 2;
          while (
            elements(document).some((e) => attr(e, "id") === `${id}-${suffix}`)
          )
            suffix++;
          el.setAttribute("id", `${id}-${suffix}`);
          changed = true;
        }
        ids.add(id);
      }
    }
    if (has("link-case", name)) {
      for (const a of elements(document, "a")) {
        const href = attr(a, "href");
        if (!href || externalHyperlink(href)) continue;
        const target = localTarget(name, href);
        if (!entries.has(target.path)) {
          const match = [...entries.keys()].find(
            (key) => key.toLowerCase() === target.path.toLowerCase(),
          );
          if (match) {
            a.setAttribute(
              "href",
              path.posix.relative(path.posix.dirname(name), match) +
                (target.fragment ? "#" + target.fragment : ""),
            );
            changed = true;
          }
        }
      }
    }
    if (changed) entries.set(name, Buffer.from(serialize(document)));
  }
  const styles = new Set(
    changes
      .filter((a) =>
        [
          "body-defaults",
          "missing-font-face",
          "missing-font-source",
          "css-punctuation",
        ].includes(a.ruleId),
      )
      .map((a) => a.resource),
  );
  for (const resource of styles) {
    const css = postcss.parse(
      repairableCss(entries.get(resource)!.toString()).source,
    );
    if (has("missing-font-face", resource))
      for (const rule of missingFontFaces(css, resource, info)) rule.remove();
    if (has("missing-font-source", resource))
      for (const repair of missingFontSources(css, resource, info))
        repair.declaration.value = repair.value;
    if (has("body-defaults", resource))
      css.walkRules((rule) => {
        if (/^(html|body|p)(\s*,\s*(html|body|p))*$/.test(rule.selector)) {
          rule.walkDecls((decl) => {
            if (
              [
                "font",
                "font-family",
                "font-size",
                "line-height",
                "height",
                "min-height",
                "max-height",
              ].includes(decl.prop)
            )
              decl.remove();
          });
          if (
            !rule.nodes.some(
              (n) => n.type === "decl" && n.prop === "overflow-wrap",
            )
          )
            rule.append({ prop: "overflow-wrap", value: "break-word" });
        }
      });
    entries.set(resource, Buffer.from(css.toString()));
  }
  entries.set(info.packagePath, Buffer.from(serialize(packageDoc)));
  entries.set("mimetype", Buffer.from("application/epub+zip"));
  const repaired = pack(entries, 946684800);
  if (scriptedContent) {
    for (const resource of scriptedContent.resources)
      if (
        !entries.has(resource.name) ||
        sha256(entries.get(resource.name)!) !== resource.sha256
      )
        fail(
          "SCRIPTED_CONTENT_INTEGRITY",
          `Repair changed a scripted dependency: ${resource.name}`,
        );
    if (entries.size !== info.entries.size)
      fail(
        "SCRIPTED_CONTENT_INTEGRITY",
        "Repair added or removed a scripted dependency",
      );
  }
  const after = fingerprint(
    inspectBytes(repaired),
    [...info.documents.keys()].sort(),
  );
  const equal = stable(before) === stable(after);
  if (!equal)
    fail("CONTENT_INTEGRITY", "Repair changed protected publication content", {
      before,
      after,
    });
  return {
    bytes: repaired,
    integrity: {
      status: "pass",
      before,
      after,
      ...(scriptedContent ? { scriptedContent } : {}),
      unchangedResources: [...info.entries]
        .filter(([name, entry]) => entries.get(name)?.equals(entry.bytes))
        .map(([name]) => name),
    },
    changes,
  };
}
export async function repairEpub(
  file: string,
  options: { plan: RepairPlan; output: string; signal?: AbortSignal },
) {
  if (options.plan.purpose !== "publication")
    fail(
      "REPAIR_PURPOSE",
      "Reading-copy plans use epub repair-copy; publication gates require a publication plan",
    );
  if (
    path.resolve(file) === path.resolve(options.output) ||
    (await exists(options.output))
  )
    fail(
      "OUTPUT_EXISTS",
      "Repair output must be a new path; original EPUB is protected",
    );
  const bytes = await readSourceFile(file);
  const reports = path.join(path.dirname(options.output), "reports");
  await fs.mkdir(path.join(reports, "repair"), { recursive: true });
  const summary = new ReleaseReporter(reports, "repair", path.resolve(file));
  try {
    await summary.save();
    await json(path.join(reports, "build.json"), {
      status: "running",
      runId: summary.runId,
      reports: summary.paths,
    });
    checkAbort(options.signal);
    const environment = await summary.check("environment", () => doctor());
    await json(path.join(reports, "environment.json"), environment);
    if (environment.status === "fail")
      fail(
        "ENVIRONMENT_ERROR",
        "Required toolchain is unavailable",
        environment.checks,
      );
    const applied = await summary.check("content-integrity", async () => {
      await json(
        path.join(reports, "repair/audit.json"),
        await auditEpub(file),
      );
      await json(path.join(reports, "repair/plan.json"), options.plan);
      const applied = applyRepair(bytes, options.plan);
      await json(path.join(reports, "repair/changes.json"), applied.changes);
      await json(
        path.join(reports, "repair/content-integrity.json"),
        applied.integrity,
      );
      const unresolved = options.plan.actions.filter(
        (a) => a.classification !== "safe",
      );
      if (unresolved.length)
        fail(
          "REPAIR_UNRESOLVED",
          "Semantic issues remain; release is blocked",
          unresolved,
        );
      return applied;
    });
    const candidate = options.output + ".candidate.epub";
    await fs.writeFile(candidate, applied.bytes, { flag: "wx" });
    const gates = await releaseGates(candidate, reports, {
      signal: options.signal,
      reporter: summary,
    });
    const equal = await summary.check("reproducibility", async () => {
      const again = applyRepair(applied.bytes, planFromBytes(applied.bytes));
      const equal = again.bytes.equals(applied.bytes);
      await json(path.join(reports, "reproducibility.json"), {
        status: equal ? "pass" : "fail",
        sha256: sha256(applied.bytes),
        idempotent: equal,
      });
      if (!equal)
        fail("REPAIR_NOT_IDEMPOTENT", "A second repair changed bytes");
      return equal;
    });
    await fs.rename(candidate, options.output);
    const report = {
      status: "pass" as const,
      artifact: {
        path: path.resolve(options.output),
        sha256: sha256(applied.bytes),
        size: applied.bytes.length,
        mediaType: "application/epub+zip",
      },
      gates,
      changes: applied.changes,
      integrity: applied.integrity,
      idempotent: equal,
      runId: summary.runId,
      reports: summary.paths,
    };
    await json(
      path.join(reports, "dependencies.json"),
      await readJson(path.join(repoRoot, "standards/dependencies.lock.json")),
    );
    await json(
      path.join(reports, "standards.json"),
      await readJson(path.join(repoRoot, "standards/registry.json")),
    );
    await json(path.join(reports, "build.json"), report);
    await summary.finish(report.artifact);
    return report;
  } catch (error) {
    const e = error as Error & { code?: string; details?: unknown };
    await summary.finish(undefined, error);
    await json(path.join(reports, "build.json"), {
      status: "fail",
      runId: summary.runId,
      reports: summary.paths,
      code: e.code ?? "REPAIR_FAILED",
      message: e.message,
      details: e.details,
    });
    throw error;
  }
}
