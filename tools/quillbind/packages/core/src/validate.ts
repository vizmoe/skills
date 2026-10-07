import fs from "node:fs/promises";
import path from "node:path";
import valueParser from "postcss-value-parser";
import postcss from "postcss";
import { validateOcf } from "./zip.js";
import { inspectBytes, type EpubInspection } from "./epub.js";
export {
  inspectBytes,
  type EpubInspection,
  type ManifestItem,
} from "./epub.js";
import { elements, attr, NS, passiveSvg, hasLegacyDoctype } from "./xml.js";
import { diagnostic, result, fail } from "./errors.js";
import { localTarget } from "./paths.js";
import { EPUB, A11Y } from "./standards.js";
import { run } from "./process.js";
import { json, readJson } from "./json.js";
import { repoRoot, javaExecutable } from "./runtime.js";
import { exists, readSourceFile } from "./files.js";
import { validLanguage } from "./config.js";
import { lintCss } from "./css.js";
import { describeInspection } from "./inspection.js";
import type { Diagnostic } from "./model.js";
import { externalHyperlink } from "./hyperlinks.js";

export async function inspectEpub(file: string) {
  const bytes = await readSourceFile(file);
  return describeInspection(inspectBytes(bytes), bytes.length);
}
export function validateInternal(input: Uint8Array | EpubInspection) {
  const diagnostics: Diagnostic[] = [];
  let inspection: EpubInspection;
  try {
    if (input instanceof Uint8Array) inspection = inspectBytes(input, true);
    else {
      inspection = input;
      validateOcf(inspection.entries);
    }
  } catch (error) {
    const e = error as Error & { code?: string };
    return result([
      diagnostic(e.code ?? "EPUB_INVALID", e.message, undefined, EPUB),
    ]);
  }
  const add = (code: string, message: string, source?: string, url = EPUB) =>
    diagnostics.push(diagnostic(code, message, source, url));
  const { manifest, spine, documents, packageDocument, packagePath, entries } =
    inspection;
  if (inspection.version !== "3.0")
    add("OPF_VERSION", "EPUB 3.3 requires package version 3.0", packagePath);
  if (inspection.unsupported.length)
    add("UNSUPPORTED_EPUB", inspection.unsupported.join(", "));
  if (!inspection.title.trim())
    add("METADATA_TITLE", "Missing title", packagePath);
  if (!validLanguage(inspection.language))
    add("METADATA_LANGUAGE", "Missing or invalid BCP 47 language", packagePath);
  const identifierId = attr(
    packageDocument.documentElement!,
    "unique-identifier",
  );
  if (
    !elements(packageDocument, "identifier", NS.dc).some(
      (el) => attr(el, "id") === identifierId && el.textContent?.trim(),
    )
  )
    add(
      "METADATA_IDENTIFIER",
      "Invalid unique identifier reference",
      packagePath,
    );
  const modified =
    elements(packageDocument, "meta", NS.opf).find(
      (el) => attr(el, "property") === "dcterms:modified",
    )?.textContent ?? "";
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(modified) ||
    !Number.isFinite(Date.parse(modified))
  )
    add(
      "METADATA_MODIFIED",
      "Missing or invalid dcterms:modified",
      packagePath,
    );
  if (
    new Set(manifest.map((m) => m.id)).size !== manifest.length ||
    manifest.some((m) => !m.id)
  )
    add(
      "MANIFEST_IDS",
      "Manifest IDs must be nonempty and unique",
      packagePath,
    );
  if (new Set(manifest.map((m) => m.path)).size !== manifest.length)
    add(
      "MANIFEST_DUPLICATE",
      "Resource appears multiple times in manifest",
      packagePath,
    );
  if (!spine.length || spine.some((id) => !manifest.some((m) => m.id === id)))
    add("SPINE_INVALID", "Spine has missing item references", packagePath);
  if (new Set(spine).size !== spine.length)
    add("SPINE_DUPLICATE", "Duplicate spine item", packagePath);
  for (const item of manifest)
    if (!entries.has(item.path))
      add(
        "MANIFEST_MISSING",
        `Missing manifest resource ${item.path}`,
        packagePath,
      );
  for (const name of entries.keys())
    if (
      name !== "mimetype" &&
      !name.startsWith("META-INF/") &&
      name !== packagePath &&
      !manifest.some((m) => m.path === name)
    )
      add(
        "UNMANIFESTED_RESOURCE",
        `Unmanifested resource ${name}`,
        packagePath,
      );
  const navs = manifest.filter((m) => m.properties.includes("nav"));
  if (navs.length !== 1)
    add(
      "NAV_REQUIRED",
      "Exactly one navigation document is required",
      packagePath,
    );
  else {
    const nav = documents.get(navs[0].path);
    if (
      !nav ||
      !elements(nav, "nav", NS.xhtml).some(
        (el) =>
          attr(el, "epub:type").split(" ").includes("toc") &&
          elements(el, "a", NS.xhtml).length,
      )
    )
      add("TOC_REQUIRED", "Navigation requires a nonempty TOC", navs[0].path);
  }
  const ids = new Map<string, Set<string>>();
  for (const [name, doc] of documents) {
    if (hasLegacyDoctype(entries.get(name)!.bytes.toString()))
      add(
        "LEGACY_XHTML",
        "Legacy XHTML DTD must be normalized for the canonical artifact",
        name,
      );
    const set = new Set<string>();
    for (const el of elements(doc)) {
      const id = attr(el, "id");
      if (id && set.has(id)) add("DUPLICATE_ID", `Duplicate ID ${id}`, name);
      if (id) set.add(id);
    }
    ids.set(name, set);
  }
  const checkLink = (name: string, href: string, externalAllowed = false) => {
    if (externalAllowed && externalHyperlink(href)) return;
    try {
      const target = localTarget(name, href);
      if (!entries.has(target.path))
        add("LINK_MISSING", `Missing target ${href}`, name);
      else if (target.fragment && !ids.get(target.path)?.has(target.fragment))
        add("FRAGMENT_MISSING", `Missing fragment ${href}`, name);
    } catch (error) {
      add("UNSAFE_URI", String(error), name);
    }
  };
  for (const [name, doc] of documents) {
    const root = doc.documentElement!;
    if (root.namespaceURI !== NS.xhtml)
      add("XHTML_NAMESPACE", "Invalid XHTML namespace", name);
    if (!validLanguage(attr(root, "xml:lang") || attr(root, "lang")))
      add("DOCUMENT_LANGUAGE", "Document language missing/invalid", name, A11Y);
    let previous = 0;
    let mainText = "";
    for (const el of elements(doc)) {
      const tag = el.localName ?? "";
      if (
        [
          "script",
          "iframe",
          "object",
          "embed",
          "form",
          "input",
          "video",
          "audio",
        ].includes(tag)
      )
        add("ACTIVE_CONTENT", `Unsupported active content: ${tag}`, name);
      for (const a of Array.from(el.attributes))
        if (/^on/i.test(a.name))
          add("EVENT_HANDLER", "Event handlers are forbidden", name);
      if (el.hasAttribute("style"))
        diagnostics.push(
          ...lintCss(`p {${attr(el, "style")}}`, name).diagnostics,
        );
      if (tag === "a") {
        if (
          el.hasAttribute("href") &&
          !el.textContent?.trim() &&
          !attr(el, "aria-label") &&
          !elements(el, "img").length
        )
          add("LINK_NAME", "Link has no accessible name", name, A11Y);
        if (el.hasAttribute("href")) checkLink(name, attr(el, "href"), true);
      }
      if (["img", "image"].includes(tag)) {
        const src =
          attr(el, "src") || attr(el, "href") || attr(el, "xlink:href");
        checkLink(name, src);
        if (
          tag === "img" &&
          (!el.hasAttribute("alt") ||
            (!attr(el, "alt").trim() && attr(el, "role") !== "presentation"))
        )
          add(
            "IMAGE_ALT",
            "Image requires alt or explicit decoration role",
            name,
            A11Y,
          );
      }
      if (tag === "link" && attr(el, "rel") === "stylesheet")
        checkLink(name, attr(el, "href"));
      if (tag === "table") {
        if (
          !elements(el, "caption").length ||
          !elements(el, "th").length ||
          elements(el, "th").some((th) => !attr(th, "scope"))
        )
          add(
            "TABLE_SEMANTICS",
            "Table needs caption and scoped headers",
            name,
            A11Y,
          );
      }
      if (/^h[1-6]$/.test(tag)) {
        const level = Number(tag[1]);
        if (level > previous + 1)
          add(
            "HEADING_SEQUENCE",
            `Heading skips from ${previous} to ${level}`,
            name,
            A11Y,
          );
        previous = level;
      }
      if (tag === "body") mainText = el.textContent ?? "";
      if (attr(el, "epub:type").split(" ").includes("noteref")) {
        const target = localTarget(name, attr(el, "href"));
        const foot = documents.get(target.path);
        const note = foot
          ? elements(foot).find((n) => attr(n, "id") === target.fragment)
          : undefined;
        if (
          !note ||
          !elements(note, "a").some((a) => {
            try {
              const back = localTarget(target.path, attr(a, "href"));
              return back.path === name && back.fragment === attr(el, "id");
            } catch {
              return false;
            }
          })
        )
          add("FOOTNOTE_BACKLINK", "Footnote has no return link", name, A11Y);
      }
    }
    if (
      !mainText.trim() &&
      !elements(doc, "img").length &&
      !elements(doc, "image", "http://www.w3.org/2000/svg").length
    )
      add("EMPTY_DOCUMENT", "Document is empty", name);
    const item = manifest.find((m) => m.path === name);
    if (
      elements(doc, "math", NS.math).length &&
      !item?.properties.includes("mathml")
    )
      add("MATHML_PROPERTY", "MathML manifest property required", name);
  }
  for (const item of manifest)
    if (item.mediaType === "image/svg+xml" && entries.has(item.path)) {
      try {
        passiveSvg(entries.get(item.path)!.bytes.toString(), item.path);
      } catch (error) {
        add("SVG_ACTIVE", String(error), item.path);
      }
    }
  for (const entry of entries.values())
    if (entry.name.endsWith(".css")) {
      diagnostics.push(
        ...lintCss(entry.bytes.toString(), entry.name).diagnostics,
      );
      try {
        postcss.parse(entry.bytes.toString()).walkDecls((decl) => {
          valueParser(decl.value).walk((node) => {
            if (node.type === "function" && node.value.toLowerCase() === "url")
              checkLink(
                entry.name,
                valueParser.stringify(node.nodes).replace(/^['"]|['"]$/g, ""),
              );
          });
        });
      } catch (error) {
        add("CSS_INVALID", String(error), entry.name);
      }
    }
  for (const property of [
    "schema:accessMode",
    "schema:accessModeSufficient",
    "schema:accessibilityFeature",
    "schema:accessibilityHazard",
    "schema:accessibilitySummary",
  ])
    if (
      !elements(packageDocument, "meta", NS.opf).some(
        (m) => attr(m, "property") === property && m.textContent?.trim(),
      )
    )
      add("ACCESSIBILITY_METADATA", `Missing ${property}`, packagePath, A11Y);
  return result(diagnostics);
}
export { compatibilityLint } from "./compatibility.js";
export async function validateEpub(
  file: string,
  options: { reports?: string; signal?: AbortSignal } = {},
) {
  return validateInspectedEpub(file, await readSourceFile(file), options);
}

/** The caller owns the candidate file and its matching inspection for this gate run. */
export async function validateInspectedEpub(
  file: string,
  input: Uint8Array | EpubInspection,
  options: { reports?: string; signal?: AbortSignal } = {},
) {
  const internal = validateInternal(input);
  const reports = options.reports ?? path.join(path.dirname(file), "reports");
  await json(path.join(reports, "diagnostics.json"), internal);
  if (internal.status === "fail") return { status: "fail" as const, internal };
  const external = await checkEpubConformance(file, { ...options, reports });
  return { ...external, internal };
}

/** External format findings are useful for existing books independently of authoring policy. */
export async function checkEpubConformance(
  file: string,
  options: { reports: string; signal?: AbortSignal },
) {
  const reports = options.reports;
  const tools = await readJson<{ epubcheck: { version: string } }>(
    path.join(repoRoot, "standards/tools.lock.json"),
  );
  const jar = path.join(
    repoRoot,
    `.cache/tools/epubcheck-${tools.epubcheck.version}/epubcheck.jar`,
  );
  if (!(await exists(jar)))
    fail("ENVIRONMENT_ERROR", "EPUBCheck is missing; run pnpm tools:install");
  const external = await run(
    await javaExecutable(),
    [
      "-jar",
      jar,
      path.resolve(file),
      "--json",
      path.join(reports, "epubcheck.json"),
    ],
    { signal: options.signal, timeout: 120000 },
  );
  await fs.writeFile(
    path.join(reports, "epubcheck.txt"),
    external.stdout + external.stderr,
  );
  await json(path.join(reports, "epubcheck-execution.json"), {
    ...external,
    version: tools.epubcheck.version,
  });
  const report = await readJson<{
    messages?: { severity: string; ID?: string; message?: string }[];
  }>(path.join(reports, "epubcheck.json"));
  const errors = (report.messages ?? []).filter((m) =>
    ["FATAL", "ERROR", "WARNING"].includes(m.severity),
  );
  return {
    status:
      external.exitCode === 0 && !errors.length
        ? ("pass" as const)
        : ("fail" as const),
    epubcheck: {
      version: tools.epubcheck.version,
      exitCode: external.exitCode,
      messages: errors,
    },
  };
}
