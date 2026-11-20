import type { Document as XmlDocument, Element } from "@xmldom/xmldom";
import postcss from "postcss";
import valueParser from "postcss-value-parser";
import type { EpubInspection } from "./epub.js";
import { attr, elements, NS, xml, ncxXml } from "./xml.js";
import { localTarget } from "./paths.js";
import { sha256 } from "./hash.js";
import { diagnostic } from "./errors.js";
import { inspectNotes } from "./epub-notes.js";
import type { Diagnostic } from "./model.js";

const NCX = NS.ncx;
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

export interface CoverAssociation {
  source: string;
  kind: string;
  target: ResourceReference;
  manifestId?: string;
}

type ResolveReference = (
  source: string,
  href: string,
  kind: string,
  elementId?: string,
) => ResourceReference;

const extraXmlMediaTypes = new Set([
  "application/x-dtbncx+xml",
  "image/svg+xml",
  "application/smil+xml",
]);

function collectExtraDocuments(
  info: EpubInspection,
  documents: Map<string, XmlDocument>,
  diagnostics: Diagnostic[],
) {
  for (const item of info.manifest) {
    if (
      documents.has(item.path) ||
      !info.entries.has(item.path) ||
      !extraXmlMediaTypes.has(item.mediaType)
    )
      continue;
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

function classifyLocalResolution(
  info: EpubInspection,
  ids: Map<string, Set<string>>,
  target: { path: string; fragment?: string },
): ResourceReference["resolution"] {
  if (!info.entries.has(target.path)) return "missing-resource";
  if (!target.fragment) return "resolved";
  const targetIds = ids.get(target.path);
  if (!targetIds) return "unverified-fragment";
  return targetIds.has(target.fragment) ? "resolved" : "missing-fragment";
}

function createReferenceResolver(
  info: EpubInspection,
  ids: Map<string, Set<string>>,
): ResolveReference {
  return (source, href, kind, elementId) => {
    const base = { source, href, kind, ...(elementId ? { elementId } : {}) };
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//"))
      return { ...base, resolution: "external" };
    try {
      const target = localTarget(source, href);
      return {
        ...base,
        ...target,
        resolution: classifyLocalResolution(info, ids, target),
      };
    } catch {
      return { ...base, resolution: "unsafe" };
    }
  };
}

function collectCssReferences(
  source: string,
  css: string,
  addReference: ResolveReference,
) {
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
}

function collectElementReferences(
  source: string,
  element: Element,
  addReference: ResolveReference,
  diagnostics: Diagnostic[],
) {
  for (const attribute of Array.from(element.attributes)) {
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
  }
  try {
    if (element.localName === "style")
      collectCssReferences(source, element.textContent ?? "", addReference);
    if (element.hasAttribute("style"))
      collectCssReferences(
        source,
        `x { ${attr(element, "style")} }`,
        addReference,
      );
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

function collectStylesheetReferences(
  info: EpubInspection,
  addReference: ResolveReference,
  diagnostics: Diagnostic[],
) {
  for (const item of info.manifest.filter(
    (manifestItem) => manifestItem.mediaType === "text/css",
  )) {
    const entry = info.entries.get(item.path);
    if (!entry) continue;
    try {
      collectCssReferences(item.path, entry.bytes.toString(), addReference);
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
}

function parseNavList(
  list: Element | undefined,
  itemPath: string,
  resolveRef: ResolveReference,
  covers: CoverAssociation[],
): InspectedNavigationNode[] {
  if (!list) return [];
  return children(list, "li").map((li) => {
    const title = children(li).find((el) =>
      ["a", "span"].includes(el.localName ?? ""),
    );
    const href = title?.getAttribute("href");
    const target =
      href === null || href === undefined
        ? undefined
        : resolveRef(itemPath, href, "navigation", attr(li, "id"));
    if (
      target &&
      title?.getAttributeNS(NS.epub, "type")?.split(/\s+/).includes("cover")
    )
      covers.push({ source: itemPath, kind: "landmark", target });
    return {
      label: label(title),
      ...(attr(li, "id") ? { id: attr(li, "id") } : {}),
      ...(target ? { target } : {}),
      children: parseNavList(
        children(li, "ol")[0],
        itemPath,
        resolveRef,
        covers,
      ),
    };
  });
}

function collectNavNavigation(
  info: EpubInspection,
  documents: Map<string, XmlDocument>,
  resolveRef: ResolveReference,
  covers: CoverAssociation[],
): InspectedNavigation[] {
  const navigation: InspectedNavigation[] = [];
  for (const item of info.manifest.filter((m) =>
    m.properties.includes("nav"),
  )) {
    const document = documents.get(item.path);
    if (!document) continue;
    for (const nav of elements(document, "nav", NS.xhtml)) {
      navigation.push({
        format: "nav",
        source: item.path,
        type: nav.getAttributeNS(NS.epub, "type") ?? "",
        title: label(
          children(nav).find((el) => /^h[1-6]$/.test(el.localName ?? "")),
        ),
        items: parseNavList(
          children(nav, "ol")[0],
          item.path,
          resolveRef,
          covers,
        ),
      });
    }
  }
  return navigation;
}

function parseNcxPoints(
  parent: Element,
  name: string,
  itemPath: string,
  resolveRef: ResolveReference,
): InspectedNavigationNode[] {
  return children(parent, name).map((point) => {
    const content = children(point, "content")[0];
    return {
      label: label(children(point, "navLabel")[0]),
      id: attr(point, "id"),
      ...(content
        ? {
            target: resolveRef(
              itemPath,
              attr(content, "src"),
              "ncx",
              attr(point, "id"),
            ),
          }
        : {}),
      children: parseNcxPoints(point, name, itemPath, resolveRef),
    };
  });
}

function collectNcxNavigation(
  info: EpubInspection,
  documents: Map<string, XmlDocument>,
  resolveRef: ResolveReference,
): InspectedNavigation[] {
  const navigation: InspectedNavigation[] = [];
  const spineElement = elements(info.packageDocument, "spine", NS.opf)[0];
  const ncxId = spineElement ? attr(spineElement, "toc") : "";
  const ncxItems = info.manifest.filter(
    (item) =>
      item.id === ncxId || item.mediaType === "application/x-dtbncx+xml",
  );
  for (const item of ncxItems) {
    const document = documents.get(item.path);
    if (!document) continue;
    for (const [container, node, type] of [
      ["navMap", "navPoint", "toc"],
      ["pageList", "pageTarget", "page-list"],
      ["navList", "navTarget", "navigation"],
    ]) {
      for (const group of elements(document, container, NCX)) {
        navigation.push({
          format: "ncx",
          source: item.path,
          type,
          title: label(children(group, "navLabel")[0]),
          items: parseNcxPoints(group, node, item.path, resolveRef),
        });
      }
    }
  }
  return navigation;
}

function collectPackageCovers(
  info: EpubInspection,
  records: {
    name: string;
    namespace: string | null;
    value: string;
    attributes: Record<string, string>;
  }[],
  resolveRef: ResolveReference,
  covers: CoverAssociation[],
) {
  const coverIds = new Set(
    records
      .filter(
        (r) =>
          r.name.split(":").at(-1) === "meta" && r.attributes.name === "cover",
      )
      .map((r) => r.attributes.content),
  );
  for (const item of info.manifest.filter(
    (manifestItem) =>
      manifestItem.properties.includes("cover-image") ||
      coverIds.has(manifestItem.id),
  )) {
    covers.push({
      source: info.packagePath,
      kind: item.properties.includes("cover-image")
        ? "cover-image"
        : "opf2-meta",
      manifestId: item.id,
      target: resolveRef(info.packagePath, item.href, "cover"),
    });
  }
  for (const guide of elements(
    info.packageDocument,
    "reference",
    NS.opf,
  ).filter((el) => attr(el, "type").split(/\s+/).includes("cover"))) {
    covers.push({
      source: info.packagePath,
      kind: "guide",
      target: resolveRef(info.packagePath, attr(guide, "href"), "cover"),
    });
  }
}

function buildResourceList(
  info: EpubInspection,
  references: ResourceReference[],
) {
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
  return [...info.entries.values()].map((entry) => ({
    path: entry.name,
    size: entry.bytes.length,
    sha256: sha256(entry.bytes),
    compression: entry.method,
    manifestIds: (manifestByPath.get(entry.name) ?? []).map((item) => item.id),
    mediaType: manifestByPath.get(entry.name)?.[0]?.mediaType,
    referencedBy: referencesByPath.get(entry.name) ?? [],
  }));
}

function countNavigationNodes(nodes: InspectedNavigationNode[]): number {
  return nodes.reduce(
    (total, node) => total + 1 + countNavigationNodes(node.children),
    0,
  );
}

/** Describe packaged data without interpreting it as instructions or loading URLs. */
export function describeInspection(info: EpubInspection, size: number) {
  const diagnostics: Diagnostic[] = [];
  const documents = new Map(info.documents);
  documents.set(info.packagePath, info.packageDocument);
  collectExtraDocuments(info, documents, diagnostics);
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
  const resolveRef = createReferenceResolver(info, ids);
  const addReference: ResolveReference = (source, href, kind, elementId) => {
    const target = resolveRef(source, href, kind, elementId);
    references.push(target);
    return target;
  };
  for (const [source, document] of documents) {
    for (const element of elements(document))
      collectElementReferences(source, element, addReference, diagnostics);
  }
  collectStylesheetReferences(info, addReference, diagnostics);
  const covers: CoverAssociation[] = [];
  const navigation = [
    ...collectNavNavigation(info, documents, resolveRef, covers),
    ...collectNcxNavigation(info, documents, resolveRef),
  ];
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
  collectPackageCovers(info, records, resolveRef, covers);
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
  const resources = buildResourceList(info, references);
  return {
    schemaVersion: 1,
    operation: "inspect" as const,
    notes: inspectNotes(info),
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
          count: countNavigationNodes(nav.items),
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
    notes: {
      kind: report.notes.kind,
      references: report.notes.references.length,
      issues: report.notes.issues.length,
      execution: report.notes.execution,
    },
    ...report.summary,
  };
}
export function formatInspection(report: InspectionReport) {
  const contents =
    report.summary.tocEntries
      .map((toc) => `${toc.format}: ${toc.count}`)
      .join(", ") || "not found";
  return `${report.title || "(no title)"}\nEPUB package ${report.version} · ${report.language || "(no language)"}\nPackage: ${report.packagePath}\nSHA-256: ${report.sha256}\nReading order: ${report.summary.spineItems} items (${report.summary.nonLinearItems} non-linear)\nContents: ${contents}\nResources: ${report.summary.resources} · Cover associations: ${report.summary.covers}\nBroken references: ${report.summary.brokenReferences} · Inspection warnings: ${report.summary.inspectionWarnings}\nNotes: ${report.notes.references.length} references (${report.notes.kind}); interactions not run\nMaintenance limitations: ${report.unsupported.join(", ") || "none detected"}\nInspection only; conformance, browser QA and platform checks were not run.\nUse --json for metadata records, navigation trees and resource references.\n`;
}
