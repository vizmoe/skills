import type { Document as XmlDocument } from "@xmldom/xmldom";
import type { ZipEntry } from "./zip.js";

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
