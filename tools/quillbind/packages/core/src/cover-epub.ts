import path from "node:path";
import type { Element } from "@xmldom/xmldom";
import { inspectBytes } from "./epub.js";
import { describeInspection } from "./inspection.js";
import { openMetadata, setModified } from "./metadata-file.js";
import { attr, elements, NS, serialize, escapeXml } from "./xml.js";
import { localTarget } from "./paths.js";
import { fail } from "./errors.js";
import type { CoverImage } from "./cover-image.js";

const tokens = (value: string) => value.split(/\s+/).filter(Boolean);
const uri = (from: string, to: string) =>
  path.posix
    .relative(path.posix.dirname(from), to)
    .split("/")
    .map(encodeURIComponent)
    .join("/");
export function coverClaims(bytes: Buffer) {
  const info = inspectBytes(bytes, true);
  const images = [
    ...info.manifest
      .filter((item) => item.properties.includes("cover-image"))
      .map((item) => item.path),
    ...elements(info.packageDocument, "meta", NS.opf)
      .filter((node) => attr(node, "name") === "cover")
      .map(
        (node) =>
          info.manifest.find((item) => item.id === attr(node, "content"))
            ?.path ?? `missing-id:${attr(node, "content")}`,
      ),
  ];
  const documents = elements(info.packageDocument, "reference", NS.opf)
    .filter((node) => tokens(attr(node, "type")).includes("cover"))
    .map((node) => localTarget(info.packagePath, attr(node, "href")).path);
  for (const item of info.manifest.filter((item) =>
    item.properties.includes("nav"),
  )) {
    const nav = info.documents.get(item.path);
    if (!nav) fail("COVER_NAV", "Missing navigation document");
    for (const link of elements(nav, "a", NS.xhtml))
      if (tokens(link.getAttributeNS(NS.epub, "type") ?? "").includes("cover"))
        documents.push(localTarget(item.path, attr(link, "href")).path);
  }
  return { images: [...new Set(images)], documents: [...new Set(documents)] };
}
/** Display the complete raster; empty viewport space is not added to the image. */
export function coverDocument(
  href: string,
  language: string,
  ids: string[] = [],
) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<html xmlns="${NS.xhtml}" xml:lang="${escapeXml(language || "und")}"><head><title>Cover</title><style type="text/css">html, body { margin: 0; padding: 0; } body { text-align: center; } img { display: block; margin: 0 auto; width: auto; height: auto; max-width: 100%; max-height: 100vh; object-fit: contain; }</style></head><body><div>${ids.map((id) => `<span id="${escapeXml(id)}"></span>`).join("")}<img src="${escapeXml(href)}" alt="Cover" /></div></body></html>`;
}
export function epubCover(
  bytes: Buffer,
  image: Buffer,
  details: CoverImage,
  target: { image: string | null; document: string | null },
  modified: string,
) {
  const file = openMetadata(bytes, "epub"),
    info = inspectBytes(bytes, true),
    document = file.document;
  const manifest = elements(document, "manifest", NS.opf)[0],
    spine = elements(document, "spine", NS.opf)[0];
  if (
    !manifest ||
    !spine ||
    new Set(info.manifest.map((item) => item.path)).size !==
      info.manifest.length ||
    new Set(info.manifest.map((item) => item.id)).size !== info.manifest.length
  )
    fail("COVER_MANIFEST", "Ambiguous manifest or spine");
  const replacements = new Map<string, Buffer>(),
    additions = new Map<string, Buffer>();
  const put = (name: string, content: Buffer) =>
    (file.entries.has(name) ? replacements : additions).set(name, content);
  const unique = (suffix: string) => {
    const name = path.posix.join(
      path.posix.dirname(file.location),
      `quillbind-cover-${details.sha256.slice(0, 12)}${suffix}`,
    );
    if (
      [...file.entries.keys()].some(
        (key) => key.toLowerCase() === name.toLowerCase(),
      ) ||
      info.manifest.some((item) => item.path === name)
    )
      fail("COVER_COLLISION", `Cover resource already exists: ${name}`);
    return name;
  };
  let imageItem = target.image
    ? info.manifest.find((item) => item.path === target.image)
    : undefined;
  if (target.image && (!imageItem || !imageItem.mediaType.startsWith("image/")))
    fail(
      "COVER_TARGET",
      "Select an existing image manifest item or null to add a resource",
    );
  if (imageItem && imageItem.mediaType !== details.mediaType)
    imageItem = undefined;
  const imagePath = imageItem?.path ?? unique(details.extension);
  const documentItem = target.document
    ? info.manifest.find((item) => item.path === target.document)
    : undefined;
  if (
    target.document &&
    (!documentItem || documentItem.mediaType !== "application/xhtml+xml")
  )
    fail("COVER_TARGET", "Select an XHTML cover document or null");
  const documentPath = documentItem?.path ?? unique(".xhtml");
  const cover = documentItem ? info.documents.get(documentPath) : undefined;
  let ids: string[] = [];
  if (documentItem) {
    if (!cover) fail("COVER_CONTENT", "Selected cover document is missing");
    const body = elements(cover, "body", NS.xhtml)[0];
    const images = [
      ...elements(cover, "img", NS.xhtml),
      ...elements(cover, "image", "http://www.w3.org/2000/svg"),
    ];
    if (
      !body ||
      body.textContent?.trim() ||
      images.length !== 1 ||
      elements(body).some(
        (node) =>
          !["div", "p", "span", "a", "img", "svg", "image", "g"].includes(
            node.localName ?? "",
          ),
      )
    )
      fail(
        "COVER_CONTENT",
        "Selected document contains content beyond a single cover image",
      );
    ids = elements(cover)
      .map((node) => attr(node, "id"))
      .filter(Boolean);
    if (new Set(ids).size !== ids.length)
      fail("COVER_CONTENT", "Duplicate cover document anchors");
  }
  if (imageItem) {
    const inventory = describeInspection(info, bytes.length);
    if (
      inventory.references.some(
        (reference) =>
          reference.path === imagePath &&
          ![documentPath, info.packagePath].includes(reference.source),
      ) ||
      inventory.diagnostics.some((item) => item.code === "INSPECT_CSS")
    )
      fail(
        "COVER_SHARED",
        "Selected image is used outside the cover or shared CSS cannot be inspected; choose null to add a separate cover image",
      );
  }
  const newId = (stem: string) => {
    const used = new Set(elements(document).map((node) => attr(node, "id")));
    let id = stem;
    for (let n = 1; used.has(id); n++) id = `${stem}-${n}`;
    return id;
  };
  const addItem = (name: string, type: string, stem: string) => {
    const item = document.createElementNS(NS.opf, "item"),
      id = newId(stem);
    item.setAttribute("id", id);
    item.setAttribute("href", uri(file.location, name));
    item.setAttribute("media-type", type);
    manifest.appendChild(item);
    return item;
  };
  const imageNode = imageItem
    ? elements(manifest, "item", NS.opf).find(
        (node) => attr(node, "id") === imageItem!.id,
      )!
    : addItem(imagePath, details.mediaType, "quillbind-cover-image");
  const pageNode = documentItem
    ? elements(manifest, "item", NS.opf).find(
        (node) => attr(node, "id") === documentItem.id,
      )!
    : addItem(documentPath, "application/xhtml+xml", "quillbind-cover-page");
  const properties = tokens(attr(pageNode, "properties")).filter(
    (value) => !["svg", "mathml", "scripted"].includes(value),
  );
  if (properties.length)
    pageNode.setAttribute("properties", properties.join(" "));
  else pageNode.removeAttribute("properties");
  for (const item of elements(manifest, "item", NS.opf)) {
    const values = tokens(attr(item, "properties")).filter(
      (value) => value !== "cover-image",
    );
    if (file.version === "3.0" && item === imageNode)
      values.push("cover-image");
    if (values.length) item.setAttribute("properties", values.join(" "));
    else item.removeAttribute("properties");
  }
  const metas = elements(file.metadata, "meta", NS.opf).filter(
    (node) => attr(node, "name") === "cover",
  );
  if (metas.some((node) => attr(node, "id") || attr(node, "refines")))
    fail(
      "COVER_REFERENCE",
      "Refined legacy cover metadata needs explicit repair",
    );
  for (const meta of metas) file.metadata.removeChild(meta);
  const meta = document.createElementNS(NS.opf, "meta");
  meta.setAttribute("name", "cover");
  meta.setAttribute("content", attr(imageNode, "id"));
  file.metadata.appendChild(meta);
  if (!info.spine.includes(attr(pageNode, "id"))) {
    const itemref = document.createElementNS(NS.opf, "itemref");
    itemref.setAttribute("idref", attr(pageNode, "id"));
    spine.insertBefore(itemref, spine.firstChild);
  }
  let guide = elements(document, "guide", NS.opf)[0];
  if (!guide && file.version === "2.0") {
    guide = document.createElementNS(NS.opf, "guide");
    document.documentElement!.appendChild(guide);
  }
  if (guide) {
    const covers = elements(guide, "reference", NS.opf).filter((node) =>
      tokens(attr(node, "type")).includes("cover"),
    );
    for (const reference of covers) guide.removeChild(reference);
    const reference = document.createElementNS(NS.opf, "reference");
    reference.setAttribute("type", "cover");
    reference.setAttribute("title", "Cover");
    reference.setAttribute("href", uri(file.location, documentPath));
    guide.appendChild(reference);
  }
  if (file.version === "3.0")
    for (const item of info.manifest.filter((item) =>
      item.properties.includes("nav"),
    )) {
      if (item.path === documentPath)
        fail("COVER_CONTENT", "Navigation is not a replaceable cover page");
      const nav = info.documents.get(item.path)!;
      nav.documentElement!.setAttribute("xmlns:epub", NS.epub);
      const coverLinks = elements(nav, "a", NS.xhtml).filter((link) =>
        tokens(link.getAttributeNS(NS.epub, "type") ?? "").includes("cover"),
      );
      if (coverLinks.length > 1)
        fail("COVER_NAV", "Duplicate cover landmarks need explicit repair");
      const landmarks = elements(nav, "nav", NS.xhtml).filter((node) =>
        tokens(node.getAttributeNS(NS.epub, "type") ?? "").includes(
          "landmarks",
        ),
      );
      if (landmarks.length > 1)
        fail("COVER_NAV", "Ambiguous landmarks navigation");
      let landmark: Element | undefined = landmarks[0];
      if (!landmark) {
        landmark = nav.createElementNS(NS.xhtml, "nav");
        landmark.setAttributeNS(NS.epub, "epub:type", "landmarks");
        landmark.setAttribute("hidden", "hidden");
        elements(nav, "body", NS.xhtml)[0].appendChild(landmark);
        const ol = nav.createElementNS(NS.xhtml, "ol");
        landmark.appendChild(ol);
      }
      const lists = elements(landmark, "ol", NS.xhtml);
      if (lists.length !== 1)
        fail(
          "COVER_NAV",
          "Complex landmarks need an explicit navigation repair",
        );
      if (coverLinks.length)
        coverLinks[0].setAttribute("href", uri(item.path, documentPath));
      else {
        const li = nav.createElementNS(NS.xhtml, "li"),
          a = nav.createElementNS(NS.xhtml, "a");
        a.setAttributeNS(NS.epub, "epub:type", "cover");
        a.setAttribute("href", uri(item.path, documentPath));
        a.textContent = "Cover";
        li.appendChild(a);
        lists[0].appendChild(li);
      }
      put(item.path, Buffer.from(serialize(nav)));
    }
  put(imagePath, image);
  put(
    documentPath,
    Buffer.from(
      coverDocument(uri(documentPath, imagePath), info.language, ids),
    ),
  );
  setModified(file, modified);
  put(file.location, Buffer.from(serialize(document)));
  return { replacements, additions, imagePath, documentPath };
}
