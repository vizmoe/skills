import { unpack, type ZipEntry } from "./zip.js";
import type { Document as XmlDocument } from "@xmldom/xmldom";
import { xml, contentXml, elements, attr, NS } from "./xml.js";
import { fail } from "./errors.js";
import { localTarget } from "./paths.js";
import { sha256 } from "./hash.js";
import { scriptingDocuments } from "./epub-notes.js";

export interface ManifestItem {
  id: string;
  href: string;
  path: string;
  mediaType: string;
  properties: string[];
}
export interface EpubInspection {
  sha256: string;
  entries: Map<string, ZipEntry>;
  packagePath: string;
  packageDocument: XmlDocument;
  manifest: ManifestItem[];
  spine: string[];
  documents: Map<string, XmlDocument>;
  version: string;
  language: string;
  title: string;
  unsupported: string[];
}
export function inspectBytes(
  bytes: Uint8Array,
  strict = false,
): EpubInspection {
  const entries = unpack(bytes, { strictOcf: strict });
  const container = entries.get("META-INF/container.xml");
  if (!container) fail("OCF_CONTAINER", "Missing container.xml");
  const rootfiles = elements(
    xml(container.bytes.toString(), "container.xml"),
    "rootfile",
    NS.container,
  );
  if (!rootfiles.length) fail("OCF_ROOTFILE", "No package document");
  const packagePath = attr(rootfiles[0], "full-path");
  const packageEntry = entries.get(packagePath);
  if (!packageEntry) fail("OPF_MISSING", "Package rootfile does not exist");
  const packageDocument = xml(packageEntry.bytes.toString(), packagePath);
  const manifest = elements(packageDocument, "item", NS.opf).map((el) => ({
    id: attr(el, "id"),
    href: attr(el, "href"),
    path: localTarget(packagePath, attr(el, "href")).path,
    mediaType: attr(el, "media-type"),
    properties: attr(el, "properties").split(/\s+/).filter(Boolean),
  }));
  const spine = elements(packageDocument, "itemref", NS.opf).map((el) =>
    attr(el, "idref"),
  );
  const documents = new Map<string, XmlDocument>();
  for (const item of manifest)
    if (
      (item.mediaType === "application/xhtml+xml" ||
        item.href.endsWith(".xhtml") ||
        item.href.endsWith(".html")) &&
      entries.has(item.path)
    )
      documents.set(
        item.path,
        contentXml(entries.get(item.path)!.bytes.toString(), item.path),
      );
  const unsupported: string[] = [];
  if (rootfiles.length > 1) unsupported.push("multiple-renditions");
  if (
    elements(packageDocument, "meta", NS.opf).some(
      (m) =>
        attr(m, "property") === "rendition:layout" &&
        m.textContent === "pre-paginated",
    ) ||
    elements(packageDocument, "itemref", NS.opf).some((el) =>
      attr(el, "properties").includes("pre-paginated"),
    )
  )
    unsupported.push("fixed-layout");
  if (scriptingDocuments({ manifest, documents }).length)
    unsupported.push("interactive-content");
  if (entries.has("META-INF/encryption.xml")) {
    const encryption = xml(
      entries.get("META-INF/encryption.xml")!.bytes.toString(),
      "encryption.xml",
    );
    const methods = elements(encryption, "EncryptionMethod").map((el) =>
      attr(el, "Algorithm"),
    );
    if (
      !methods.length ||
      methods.some(
        (m) =>
          ![
            "http://www.idpf.org/2008/embedding",
            "http://ns.adobe.com/pdf/enc#RC",
          ].includes(m),
      )
    )
      unsupported.push("encrypted-content");
  }
  return {
    sha256: sha256(bytes),
    entries,
    packagePath,
    packageDocument,
    manifest,
    spine,
    documents,
    version: attr(packageDocument.documentElement!, "version"),
    language:
      elements(packageDocument, "language", NS.dc)[0]?.textContent ?? "",
    title: elements(packageDocument, "title", NS.dc)[0]?.textContent ?? "",
    unsupported,
  };
}
