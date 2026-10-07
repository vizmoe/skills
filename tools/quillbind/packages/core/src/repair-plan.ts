import { inspectBytes, type EpubInspection } from "./epub.js";
import { validateOcf } from "./zip.js";
import { xml, elements, attr, NS, hasLegacyDoctype, ncxXml } from "./xml.js";
import { localTarget } from "./paths.js";
import { stable } from "./json.js";
import postcss from "postcss";
import { imageCenteringRepairs } from "./repair-images.js";
import { externalHyperlink } from "./hyperlinks.js";
import { validLanguage } from "./config.js";
import { missingFontFaces, missingFontSources } from "./repair-fonts.js";
import { repairableCss } from "./repair-css.js";
import { readingReflowNeeded } from "./repair-reflow.js";

export const REPAIR_RULE_VERSION = "1.2.0";

export interface RepairAction {
  ruleId: string;
  classification: "safe" | "review-required" | "unsupported";
  resource: string;
  message: string;
}
export interface RepairPlan {
  schemaVersion: 1;
  inputSha256: string;
  ruleVersion: typeof REPAIR_RULE_VERSION;
  purpose: "publication" | "reading";
  actions: RepairAction[];
}
export const guessMedia = (name: string, bytes: Buffer) => {
  if (
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216) return "image/jpeg";
  if (bytes.subarray(0, 4).toString() === "OTTO") return "font/otf";
  if (bytes.length >= 4 && bytes.readUInt32BE(0) === 0x00010000)
    return "font/ttf";
  if (name.endsWith(".css")) return "text/css";
  try {
    const doc = xml(bytes.toString(), name);
    const root = doc.documentElement!;
    if (root.namespaceURI === NS.xhtml) return "application/xhtml+xml";
    if (root.localName === "svg") return "image/svg+xml";
    if (root.localName === "ncx") return "application/x-dtbncx+xml";
  } catch {
    return undefined;
  }
  return undefined;
};
export function planFromBytes(
  input: Uint8Array | EpubInspection,
  purpose: RepairPlan["purpose"] = "publication",
): RepairPlan {
  const info = input instanceof Uint8Array ? inspectBytes(input) : input;
  const actions: RepairAction[] = [];
  const add = (
    ruleId: string,
    classification: RepairAction["classification"],
    resource: string,
    message: string,
  ) => {
    if (
      purpose === "reading" &&
      ["epub3-package", "modified", "accessibility-discovery"].includes(ruleId)
    )
      return;
    if (
      purpose === "reading" &&
      info.version === "2.0" &&
      ["navigation", "package-language"].includes(ruleId)
    )
      return;
    actions.push({ ruleId, classification, resource, message });
  };
  for (const feature of info.unsupported)
    add("unsupported-feature", "unsupported", info.packagePath, feature);
  if (purpose === "reading" && readingReflowNeeded(info))
    add(
      "reading-reflow",
      "safe",
      info.packagePath,
      "Contain block widths, wrap oversized headings and fit standalone images to the reading area without resampling",
    );
  if (info.version === "2.0")
    add(
      "epub3-package",
      "safe",
      info.packagePath,
      "Migrate package to EPUB 3 and derive EPUB 3 navigation",
    );
  else if (info.version !== "3.0")
    add(
      "package-version",
      "unsupported",
      info.packagePath,
      `Unsupported package version ${info.version}`,
    );
  const nav = info.manifest.find((m) => m.properties.includes("nav"));
  if (!nav || !info.entries.has(nav.path))
    add(
      "navigation",
      "safe",
      info.packagePath,
      "Create navigation from NCX, or existing spine headings",
    );
  if (
    !elements(info.packageDocument, "meta", NS.opf).some(
      (el) => attr(el, "property") === "dcterms:modified",
    )
  )
    add(
      "modified",
      "safe",
      info.packagePath,
      "Add deterministic modification date",
    );
  if (!attr(info.packageDocument.documentElement!, "xml:lang") && info.language)
    add(
      "package-language",
      "safe",
      info.packagePath,
      "Copy existing dc:language to package xml:lang",
    );
  const identifiers = elements(info.packageDocument, "identifier", NS.dc);
  const uniqueIdentifier = attr(
    info.packageDocument.documentElement!,
    "unique-identifier",
  );
  if (
    !identifiers.some((el) => attr(el, "id") === uniqueIdentifier) &&
    identifiers.length === 1 &&
    attr(identifiers[0], "id") &&
    identifiers[0].textContent?.trim()
  )
    add(
      "identifier-reference",
      "safe",
      info.packagePath,
      "Point unique-identifier to the sole existing identifier without changing its value",
    );
  const identifier =
    identifiers.find((el) => attr(el, "id") === uniqueIdentifier) ??
    (identifiers.length === 1 ? identifiers[0] : undefined);
  if (identifier?.textContent?.trim())
    for (const item of info.manifest.filter(
      (item) =>
        item.mediaType === "application/x-dtbncx+xml" &&
        info.entries.has(item.path),
    )) {
      try {
        const document = ncxXml(
          info.entries.get(item.path)!.bytes.toString(),
          item.path,
        );
        const uid = elements(document, "meta").find(
          (el) => attr(el, "name") === "dtb:uid",
        );
        if (uid && !attr(uid, "content").trim())
          add(
            "ncx-identifier",
            "safe",
            item.path,
            "Fill an empty NCX dtb:uid from the declared publication identifier",
          );
      } catch {
        /* unsupported NCX remains available for explicit review */
      }
    }
  for (const key of ["title", "language", "identifier"])
    if (
      !elements(info.packageDocument, key, NS.dc).some((el) =>
        el.textContent?.trim(),
      )
    )
      add(
        "metadata-value",
        "review-required",
        info.packagePath,
        `Supply missing dc:${key}; bibliographic values are not inferred`,
      );
  for (const item of info.manifest) {
    const entry = info.entries.get(item.path);
    if (!entry)
      add(
        "missing-resource",
        "review-required",
        item.path,
        "Original resource is absent",
      );
    else {
      const type = guessMedia(item.path, entry.bytes);
      if (type && type !== item.mediaType)
        add("media-type", "safe", item.path, `Set sniffed media type ${type}`);
    }
  }
  for (const [name, entry] of info.entries)
    if (
      name !== "mimetype" &&
      !name.startsWith("META-INF/") &&
      name !== info.packagePath &&
      !info.manifest.some((m) => m.path === name)
    )
      add(
        "manifest-add",
        guessMedia(name, entry.bytes) ? "safe" : "review-required",
        name,
        "Declare existing resource in manifest",
      );
  for (const [name, document] of info.documents) {
    const images = imageCenteringRepairs(document);
    if (images.repairs.length)
      add(
        "standalone-image-centering",
        "safe",
        name,
        `Center ${images.repairs.length} standalone image(s) within the available line; preserve captions, links and image dimensions`,
      );
    if (images.invalidStyles)
      add(
        "standalone-image-style",
        "review-required",
        name,
        `${images.invalidStyles} standalone image(s) have inline CSS that cannot be parsed safely`,
      );
    if (hasLegacyDoctype(info.entries.get(name)!.bytes.toString()))
      add(
        "legacy-xhtml",
        "safe",
        name,
        "Remove recognized legacy XHTML DTD without fetching external entities",
      );
    const ids = new Map<string, number>();
    for (const el of elements(document)) {
      const id = attr(el, "id");
      if (id) ids.set(id, (ids.get(id) ?? 0) + 1);
    }
    for (const [id, count] of ids)
      if (count > 1) {
        const referenced = [...info.documents].some(([from, doc]) =>
          elements(doc, "a").some((a) => {
            try {
              const target = localTarget(from, attr(a, "href"));
              return target.path === name && target.fragment === id;
            } catch {
              return false;
            }
          }),
        );
        add(
          "duplicate-id",
          referenced ? "review-required" : "safe",
          name,
          `Duplicate ID ${id}${referenced ? " has ambiguous inbound references" : ""}`,
        );
      }
    const root = document.documentElement!;
    if (!attr(root, "lang") && attr(root, "xml:lang"))
      add("language-attribute", "safe", name, "Copy existing xml:lang to lang");
    if (
      !attr(root, "lang") &&
      !attr(root, "xml:lang") &&
      validLanguage(info.language)
    )
      add(
        "document-language",
        "safe",
        name,
        "Use the declared publication language for a document with no language attributes",
      );
    if (
      elements(document, "math", NS.math).length &&
      !info.manifest.find((m) => m.path === name)?.properties.includes("mathml")
    )
      add("mathml-property", "safe", name, "Declare existing MathML");
    for (const a of elements(document, "a")) {
      const href = attr(a, "href");
      if (!href || externalHyperlink(href)) continue;
      try {
        const target = localTarget(name, href);
        if (!info.entries.has(target.path)) {
          const matches = [...info.entries.keys()].filter(
            (key) => key.toLowerCase() === target.path.toLowerCase(),
          );
          if (matches.length === 1)
            add(
              "link-case",
              "safe",
              name,
              `Resolve unique case-insensitive resource ${href}`,
            );
          else
            add(
              "link-target",
              "review-required",
              name,
              `Missing target ${href}`,
            );
        }
      } catch {
        add("link-target", "review-required", name, `Unsafe target ${href}`);
      }
    }
  }
  for (const [name, entry] of info.entries)
    if (name.endsWith(".css")) {
      try {
        const normalized = repairableCss(entry.bytes.toString());
        const css = postcss.parse(normalized.source);
        if (normalized.changed)
          add(
            "css-punctuation",
            "safe",
            name,
            "Replace full-width declaration semicolons outside strings and comments where the corrected stylesheet parses successfully",
          );
        const missingFonts = missingFontFaces(css, name, info);
        if (missingFonts.length)
          add(
            "missing-font-face",
            "safe",
            name,
            `Remove ${missingFonts.length} unavailable font-face rule(s); retain reader font fallback`,
          );
        if (missingFontSources(css, name, info).length)
          add(
            "missing-font-source",
            "safe",
            name,
            "Remove absent font URL alternatives while preserving local() and available sources",
          );
        let fixed = false;
        css.walkRules((rule) => {
          if (/^(html|body|p)(\s*,\s*(html|body|p))*$/.test(rule.selector))
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
                fixed = true;
            });
        });
        if (fixed)
          add(
            "body-defaults",
            "safe",
            name,
            "Remove explicit body metrics to permit reader controls",
          );
      } catch {
        add(
          "css-invalid",
          "review-required",
          name,
          "CSS cannot be parsed safely",
        );
      }
    }
  const fields = [
    "schema:accessMode",
    "schema:accessModeSufficient",
    "schema:accessibilityFeature",
    "schema:accessibilityHazard",
    "schema:accessibilitySummary",
  ];
  if (
    fields.some(
      (key) =>
        !elements(info.packageDocument, "meta", NS.opf).some(
          (m) => attr(m, "property") === key,
        ),
    )
  )
    add(
      "accessibility-discovery",
      "safe",
      info.packagePath,
      "Add conservative discovery metadata without certification",
    );
  try {
    validateOcf(info.entries);
  } catch (error) {
    add(
      "ocf-packaging",
      "safe",
      "mimetype",
      `Normalize OCF packaging: ${String(error)}`,
    );
  }
  return {
    schemaVersion: 1,
    inputSha256: info.sha256,
    ruleVersion: REPAIR_RULE_VERSION,
    purpose,
    actions: actions.filter(
      (a, i) => actions.findIndex((b) => stable(a) === stable(b)) === i,
    ),
  };
}
