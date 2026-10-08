import fs from "node:fs/promises";
import path from "node:path";
import type { Document, Element } from "@xmldom/xmldom";
import { inspectBytes } from "./epub.js";
import { unpack, type ZipEntry } from "./zip.js";
import { maintenanceLimits, patchZip } from "./zip-patch.js";
import { xml, elements, attr, NS, serialize } from "./xml.js";
import { checkAbort, fail } from "./errors.js";
import { readSourceFile } from "./files.js";
import { sha256 } from "./hash.js";
import { checkEpubConformance } from "./validate.js";
import { run } from "./process.js";
import { repoRoot } from "./runtime.js";
import { json } from "./json.js";

export type MetadataFormat = "epub" | "cbz";
export interface MetadataFile {
  format: MetadataFormat;
  entries: Map<string, ZipEntry>;
  location: string;
  document: Document;
  metadata: Element;
  version?: string;
}
export function metadataFormat(file: string): MetadataFormat {
  const extension = path.extname(file).toLowerCase();
  if (extension !== ".epub" && extension !== ".cbz")
    fail("METADATA_FORMAT", "Choose an EPUB or CBZ file");
  return extension.slice(1) as MetadataFormat;
}
export function openMetadata(
  bytes: Buffer,
  format: MetadataFormat,
): MetadataFile {
  const entries = unpack(bytes, {
    ...maintenanceLimits,
    strictOcf: format === "epub",
  });
  if (format === "epub") {
    const info = inspectBytes(bytes, true);
    if (
      !["2.0", "3.0"].includes(info.version) ||
      info.unsupported.length ||
      [...entries.keys()].some(
        (name) => name.toLowerCase() === "meta-inf/signatures.xml",
      )
    )
      fail(
        "METADATA_UNSUPPORTED",
        "Unsupported, ambiguous or protected EPUB",
        info.unsupported,
      );
    const nodes = elements(info.packageDocument, "metadata", NS.opf);
    if (
      nodes.length !== 1 ||
      nodes[0].parentNode !== info.packageDocument.documentElement
    )
      fail("METADATA_LOCATION", "Expected one package metadata element");
    return {
      format,
      entries,
      location: info.packagePath,
      document: info.packageDocument,
      metadata: nodes[0],
      version: info.version,
    };
  }
  const locations = [...entries.keys()].filter(
    (name) => path.posix.basename(name).toLowerCase() === "comicinfo.xml",
  );
  if (locations.length !== 1 || locations[0] !== "ComicInfo.xml")
    fail("METADATA_LOCATION", "Expected exactly one root ComicInfo.xml");
  const document = xml(
      entries.get("ComicInfo.xml")!.bytes.toString(),
      "ComicInfo.xml",
    ),
    metadata = document.documentElement!;
  if (metadata.localName !== "ComicInfo" || metadata.namespaceURI)
    fail("COMICINFO_PROFILE", "Expected namespace-free ComicInfo 2.0");
  const seen = new Set<string>();
  for (const node of children(metadata)) {
    const key = `${node.namespaceURI ?? ""}:${node.localName}`;
    if (seen.has(key))
      fail("METADATA_AMBIGUOUS", `Duplicate ComicInfo field: ${key}`);
    seen.add(key);
  }
  return { format, entries, location: "ComicInfo.xml", document, metadata };
}
export const children = (element: Element) =>
  Array.from(element.childNodes).filter(
    (node): node is Element => node.nodeType === 1,
  );
export function setModified(file: MetadataFile, modified: string) {
  if (file.format !== "epub" || file.version !== "3.0") return;
  const values = children(file.metadata).filter(
    (node) =>
      node.namespaceURI === NS.opf &&
      node.localName === "meta" &&
      attr(node, "property") === "dcterms:modified",
  );
  if (values.length > 1 || values.some((node) => attr(node, "refines")))
    fail("METADATA_AMBIGUOUS", "Ambiguous modification timestamp");
  const node = values[0] ?? file.document.createElementNS(NS.opf, "meta");
  node.setAttribute("property", "dcterms:modified");
  node.textContent = modified;
  if (!values.length) file.metadata.appendChild(node);
}
export function writeMetadata(bytes: Buffer, file: MetadataFile) {
  const result = patchZip(
    bytes,
    new Map([[file.location, Buffer.from(serialize(file.document))]]),
  );
  const readback = openMetadata(result, file.format);
  if (serialize(readback.document) !== serialize(file.document))
    fail(
      "METADATA_READBACK",
      "Metadata readback differs from the planned document",
    );
  return {
    bytes: result,
    preserved: [...file.entries]
      .filter(([name]) => name !== file.location)
      .map(([name, entry]) => ({
        name,
        sha256: sha256(entry.bytes),
        method: entry.method,
      })),
  };
}

/** Format-validated maintenance is distinct from a publication release. */
export async function deliverMetadata<Verification = undefined>(
  source: string,
  options: {
    output: string;
    sourceSha256: string;
    format: MetadataFormat;
    bytes: Buffer;
    report: unknown;
    signal?: AbortSignal;
    verify?: (candidate: string, reports: string) => Promise<Verification>;
  },
) {
  checkAbort(options.signal);
  const output = path.resolve(options.output);
  if (metadataFormat(output) !== options.format)
    fail("METADATA_FORMAT", "Output extension must match the source format");
  if (
    path.resolve(source) === output ||
    (await fs.lstat(output).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return false;
      },
    ))
  )
    fail(
      "OUTPUT_EXISTS",
      "Output already exists or is the original; choose a new path",
    );
  if (sha256(await readSourceFile(source)) !== options.sourceSha256)
    fail("METADATA_STALE", "Source hash changed after planning");
  await fs.mkdir(path.dirname(output), { recursive: true });
  const reports = output + ".reports";
  // Exclusive report directory also serializes writers and preserves previous evidence.
  await fs.mkdir(reports);
  const staging = await fs.mkdtemp(
    path.join(path.dirname(output), ".quillbind-metadata-"),
  );
  const candidate = path.join(staging, `candidate.${options.format}`);
  try {
    await fs.writeFile(candidate, options.bytes, { flag: "wx" });
    const actual = await readSourceFile(candidate);
    const opened = openMetadata(actual, options.format);
    let validation;
    if (options.format === "epub")
      validation = await checkEpubConformance(candidate, {
        reports,
        signal: options.signal,
      });
    else {
      const extracted = path.join(staging, "ComicInfo.xml");
      await fs.writeFile(extracted, opened.entries.get(opened.location)!.bytes);
      const result = await run(
        "xmllint",
        [
          "--nonet",
          "--noout",
          "--schema",
          path.join(repoRoot, "standards/comicinfo/ComicInfo-2.0.xsd"),
          extracted,
        ],
        { signal: options.signal },
      );
      validation = {
        status: result.exitCode === 0 ? ("pass" as const) : ("fail" as const),
        comicinfo: result,
      };
      await json(path.join(reports, "comicinfo-validation.json"), validation);
    }
    if (validation.status !== "pass")
      fail(
        "METADATA_VALIDATION",
        "Changed file failed format validation",
        validation,
      );
    const verification = await options.verify?.(candidate, reports);
    checkAbort(options.signal);
    if (sha256(await readSourceFile(source)) !== options.sourceSha256)
      fail("METADATA_STALE", "Source hash changed during validation");
    if (sha256(await readSourceFile(candidate)) !== sha256(options.bytes))
      fail("METADATA_STALE", "Candidate changed during validation");
    await fs.link(candidate, output);
    const result = {
      status: "pass" as const,
      purpose: "file-maintenance",
      source: path.resolve(source),
      sourceSha256: options.sourceSha256,
      output,
      outputSha256: sha256(actual),
      validation,
      ...(verification === undefined ? {} : { verification }),
      metadata: options.report,
      reports,
    };
    await json(path.join(reports, "metadata.json"), result);
    return result;
  } catch (error) {
    await json(path.join(reports, "failure.json"), {
      status: "fail",
      message: (error as Error).message,
    });
    throw error;
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}
