import type { Element } from "@xmldom/xmldom";
import postcss from "postcss";
import valueParser from "postcss-value-parser";
import type { EpubInspection } from "./epub.js";
import { attr, elements, NS, xml, ncxXml } from "./xml.js";
import { localTarget } from "./paths.js";
import { sha256 } from "./hash.js";
import { diagnostic } from "./errors.js";
import type { Diagnostic } from "./model.js";

const NCX = "http://www.daisy.org/z3986/2005/ncx/";
const children = (element: Element, name?: string) =>
  Array.from(element.childNodes).filter(
    (node): node is Element =>
      node.nodeType === 1 && (!name || (node as Element).localName === name),
  );
const label = (element?: Element) =>
  (element?.textContent ?? "").replace(/\s+/g, " ").trim();

export interface ResourceReference {
  source: string;
  elementId?: string;
  kind: string;
  href: string;
  path?: string;
  fragment?: string;
  resolution:
    | "resolved"
    | "external"
    | "missing-resource"
    | "missing-fragment"
    | "unverified-fragment"
    | "unsafe";
}
export interface InspectedNavigationNode {
  label: string;
  id?: string;
  target?: ResourceReference;
  children: InspectedNavigationNode[];
}
export interface InspectedNavigation {
  format: "nav" | "ncx";
  source: string;
  type: string;
  title: string;
  items: InspectedNavigationNode[];
}

/** Describe packaged data without interpreting it as instructions or loading URLs. */
export function describeInspection(info: EpubInspection, size: number) {
  const diagnostics: Diagnostic[] = [];
  const documents = new Map(info.documents);
  documents.set(info.packagePath, info.packageDocument);
  for (const item of info.manifest) {
    if (
      !documents.has(item.path) &&
      info.entries.has(item.path) &&
      [
        "application/x-dtbncx+xml",
        "image/svg+xml",
        "application/smil+xml",
      ].includes(item.mediaType)
    ) {
      try {
        const source = info.entries.get(item.path)!.bytes.toString();
        documents.set(
          item.path,
          item.mediaType === "application/x-dtbncx+xml"
            ? ncxXml(source, item.path)
            : xml(source, item.path),
        );
      } catch (error) {
        diagnostics.push(
          diagnostic(
            "INSPECT_XML",
            String(error),
            item.path,
            undefined,
            "warning",
          ),
        );
      }
    }
  }
  const ids = new Map(
    [...documents].map(([source, document]) => [
      source,
      new Set(
        elements(document)
          .map((el) => attr(el, "id"))
          .filter(Boolean),
      ),
    ]),
  );
  const references: ResourceReference[] = [];
  const reference = (
    source: string,
    href: string,
    kind: string,
    elementId?: string,
  ): ResourceReference => {
    const base = { source, href, kind, ...(elementId ? { elementId } : {}) };
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//"))
      return { ...base, resolution: "external" };
    try {
      const target = localTarget(source, href);
      const resolution = !info.entries.has(target.path)
        ? "missing-resource"
        : target.fragment
          ? !ids.has(target.path)
            ? "unverified-fragment"
            : ids.get(target.path)!.has(target.fragment)
              ? "resolved"
              : "missing-fragment"
          : "resolved";
      return { ...base, ...target, resolution };
    } catch {
      return { ...base, resolution: "unsafe" };
    }
  };
  const addReference = (
    source: string,
    href: string,
    kind: string,
    elementId?: string,
  ) => {
    const target = reference(source, href, kind, elementId);
    references.push(target);
    return target;
  };
  const cssReferences = (source: string, css: string) => {
    const root = postcss.parse(css, { from: source });
    const urls = (value: string) =>
      valueParser(value).walk((node) => {
        if (node.type === "function" && node.value.toLowerCase() === "url") {
          const href = valueParser
            .stringify(node.nodes)
            .trim()
            .replace(/^(['"])(.*)\1$/, "$2");
          if (href) addReference(source, href, "css-url");
          return false;
        }
      });
    root.walkDecls((decl) => {
      urls(decl.value);
    });
    root.walkAtRules("import", (rule) => {
      const first = valueParser(rule.params).nodes[0];
      if (first?.type === "string")
        addReference(source, first.value, "css-import");
      else urls(rule.params);
    });
  };
  for (const [source, document] of documents) {
    for (const element of elements(document)) {
      for (const attribute of Array.from(element.attributes))
        if (
          ["href", "src", "poster", "data"].includes(
            attribute.localName ?? attribute.name,
          )
        )
          addReference(
            source,
            attribute.value,
            `${element.localName}@${attribute.name}`,
            attr(element, "id"),
          );
      try {
        if (element.localName === "style")
          cssReferences(source, element.textContent ?? "");
        if (element.hasAttribute("style"))
          cssReferences(source, `x { ${attr(element, "style")} }`);
      } catch {
        diagnostics.push(
          diagnostic(
            "INSPECT_CSS",
            "Unable to inspect inline CSS references",
            source,
            undefined,
            "warning",
          ),
        );
      }
    }
  }
  for (const item of info.manifest.filter(
    (item) => item.mediaType === "text/css",
  )) {
    const entry = info.entries.get(item.path);
    if (!entry) continue;
    try {
      cssReferences(item.path, entry.bytes.toString());
    } catch {
      diagnostics.push(
        diagnostic(
          "INSPECT_CSS",
          "Unable to inspect stylesheet references",
          item.path,
          undefined,
          "warning",
        ),
      );
    }
  }
  const navigation: InspectedNavigation[] = [];
  const covers: {
    source: string;
    kind: string;
    target: ResourceReference;
    manifestId?: string;
  }[] = [];
  for (const item of info.manifest.filter((item) =>
    item.properties.includes("nav"),
  )) {
    const document = documents.get(item.path);
    if (!document) continue;
    for (const nav of elements(document, "nav", NS.xhtml)) {
      const parseList = (list?: Element): InspectedNavigationNode[] =>
        !list
          ? []
          : children(list, "li").map((li) => {
              const title = children(li).find((el) =>
                ["a", "span"].includes(el.localName ?? ""),
              );
              const href = title?.getAttribute("href");
              const target =
                href === null || href === undefined
                  ? undefined
                  : reference(item.path, href, "navigation", attr(li, "id"));
              if (
                target &&
                title
                  ?.getAttributeNS(NS.epub, "type")
                  ?.split(/\s+/)
                  .includes("cover")
              )
                covers.push({ source: item.path, kind: "landmark", target });
              return {
                label: label(title),
                ...(attr(li, "id") ? { id: attr(li, "id") } : {}),
                ...(target ? { target } : {}),
                children: parseList(children(li, "ol")[0]),
              };
            });
      navigation.push({
        format: "nav",
        source: item.path,
        type: nav.getAttributeNS(NS.epub, "type") ?? "",
        title: label(
          children(nav).find((el) => /^h[1-6]$/.test(el.localName ?? "")),
        ),
        items: parseList(children(nav, "ol")[0]),
      });
    }
  }
  const spineElement = elements(info.packageDocument, "spine", NS.opf)[0];
  const ncxId = spineElement ? attr(spineElement, "toc") : "";
  const ncxItems = info.manifest.filter(
    (item) =>
      item.id === ncxId || item.mediaType === "application/x-dtbncx+xml",
  );
  for (const item of ncxItems) {
    const document = documents.get(item.path);
    if (!document) continue;
    const parsePoints = (
      parent: Element,
      name: string,
    ): InspectedNavigationNode[] =>
      children(parent, name).map((point) => {
        const content = children(point, "content")[0];
        return {
          label: label(children(point, "navLabel")[0]),
          id: attr(point, "id"),
          ...(content
            ? {
                target: reference(
                  item.path,
                  attr(content, "src"),
                  "ncx",
                  attr(point, "id"),
                ),
              }
            : {}),
          children: parsePoints(point, name),
        };
      });
    for (const [container, node, type] of [
      ["navMap", "navPoint", "toc"],
      ["pageList", "pageTarget", "page-list"],
      ["navList", "navTarget", "navigation"],
    ])
      for (const group of elements(document, container, NCX))
        navigation.push({
          format: "ncx",
          source: item.path,
          type,
          title: label(children(group, "navLabel")[0]),
          items: parsePoints(group, node),
        });
  }
  const metadataElement = elements(info.packageDocument, "metadata", NS.opf)[0];
  const records = metadataElement
    ? children(metadataElement).map((el) => ({
        name: el.nodeName,
        namespace: el.namespaceURI,
        value: el.textContent ?? "",
        attributes: Object.fromEntries(
          Array.from(el.attributes).map((a) => [a.name, a.value]),
        ),
      }))
    : [];
  const identifierId = attr(
    info.packageDocument.documentElement!,
    "unique-identifier",
  );
  const coverIds = records
    .filter(
      (r) =>
        r.name.split(":").at(-1) === "meta" && r.attributes.name === "cover",
    )
    .map((r) => r.attributes.content);
  for (const item of info.manifest.filter(
    (item) =>
      item.properties.includes("cover-image") || coverIds.includes(item.id),
  ))
    covers.push({
      source: info.packagePath,
      kind: item.properties.includes("cover-image")
        ? "cover-image"
        : "opf2-meta",
      manifestId: item.id,
      target: reference(info.packagePath, item.href, "cover"),
    });
  for (const guide of elements(
    info.packageDocument,
    "reference",
    NS.opf,
  ).filter((el) => attr(el, "type").split(/\s+/).includes("cover")))
    covers.push({
      source: info.packagePath,
      kind: "guide",
      target: reference(info.packagePath, attr(guide, "href"), "cover"),
    });
  const manifestById = new Map(info.manifest.map((item) => [item.id, item]));
  const readingOrder = elements(info.packageDocument, "itemref", NS.opf).map(
    (el, index) => {
      const item = manifestById.get(attr(el, "idref"));
      return {
        position: index + 1,
        idref: attr(el, "idref"),
        source: info.packagePath,
        linear: attr(el, "linear") || "yes",
        properties: attr(el, "properties").split(/\s+/).filter(Boolean),
        path: item?.path,
        mediaType: item?.mediaType,
        exists: !!item && info.entries.has(item.path),
      };
    },
  );
  const brokenReferences = references.filter((r) =>
    ["unsafe", "missing-resource", "missing-fragment"].includes(r.resolution),
  );
  const manifestByPath = new Map<string, EpubInspection["manifest"]>();
  for (const item of info.manifest) {
    const items = manifestByPath.get(item.path) ?? [];
    items.push(item);
    manifestByPath.set(item.path, items);
  }
  const referencesByPath = new Map<string, ResourceReference[]>();
  for (const ref of references) {
    if (!ref.path) continue;
    const targets = referencesByPath.get(ref.path) ?? [];
    targets.push(ref);
    referencesByPath.set(ref.path, targets);
  }
  const resources = [...info.entries.values()].map((entry) => ({
    path: entry.name,
    size: entry.bytes.length,
    sha256: sha256(entry.bytes),
    compression: entry.method,
    manifestIds: (manifestByPath.get(entry.name) ?? []).map((item) => item.id),
    mediaType: manifestByPath.get(entry.name)?.[0]?.mediaType,
    referencedBy: referencesByPath.get(entry.name) ?? [],
  }));
  const countNodes = (nodes: InspectedNavigationNode[]): number =>
    nodes.reduce((total, node) => total + 1 + countNodes(node.children), 0);
  return {
    schemaVersion: 1,
    operation: "inspect" as const,
    status: "pass" as const,
    sha256: info.sha256,
    version: info.version,
    title: info.title,
    language: info.language,
    packagePath: info.packagePath,
    manifest: info.manifest,
    spine: info.spine,
    unsupported: info.unsupported,
    entries: resources.map(({ path, size, sha256, compression }) => ({
      path,
      size,
      sha256,
      compression,
    })),
    summary: {
      size,
      resources: resources.length,
      spineItems: readingOrder.length,
      nonLinearItems: readingOrder.filter((item) => item.linear === "no")
        .length,
      tocEntries: navigation
        .filter((nav) => nav.type.split(/\s+/).includes("toc"))
        .map((nav) => ({
          format: nav.format,
          source: nav.source,
          count: countNodes(nav.items),
        })),
      covers: covers.length,
      brokenReferences: brokenReferences.length,
      inspectionWarnings: diagnostics.length,
      validation: "not-run" as const,
      externalResourcesFetched: false,
    },
    metadata: {
      uniqueIdentifierId: identifierId,
      uniqueIdentifier: records.find(
        (record) =>
          record.namespace === NS.dc &&
          record.name.split(":").at(-1) === "identifier" &&
          record.attributes.id === identifierId,
      )?.value,
      records,
    },
    readingOrder,
    navigation,
    covers,
    resources,
    references,
    brokenReferences,
    diagnostics,
  };
}

export type InspectionReport = ReturnType<typeof describeInspection>;
export function inspectionSummary(report: InspectionReport) {
  return {
    operation: report.operation,
    status: report.status,
    sha256: report.sha256,
    title: report.title,
    language: report.language,
    version: report.version,
    packagePath: report.packagePath,
    unsupported: report.unsupported,
    ...report.summary,
  };
}
export function formatInspection(report: InspectionReport) {
  return `${report.title || "(no title)"}\nEPUB package ${report.version} · ${report.language || "(no language)"}\nPackage: ${report.packagePath}\nSHA-256: ${report.sha256}\nReading order: ${report.summary.spineItems} items (${report.summary.nonLinearItems} non-linear)\nContents: ${report.summary.tocEntries.map((toc) => `${toc.format}: ${toc.count}`).join(", ") || "not found"}\nResources: ${report.summary.resources} · Cover associations: ${report.summary.covers}\nBroken references: ${report.summary.brokenReferences} · Inspection warnings: ${report.summary.inspectionWarnings}\nMaintenance limitations: ${report.unsupported.join(", ") || "none detected"}\nInspection only; conformance, browser QA and platform checks were not run.\nUse --json for metadata records, navigation trees and resource references.\n`;
}
