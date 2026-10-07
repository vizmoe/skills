import type { EpubInspection } from "./epub.js";
import { elements, attr, NS, serialize } from "./xml.js";
import { localTarget } from "./paths.js";
import { sha256 } from "./hash.js";
import { externalHyperlink } from "./hyperlinks.js";

export function fingerprint(
  info: EpubInspection,
  paths = [...info.documents.keys()].sort(),
) {
  const spine = info.spine.map(
    (id) => info.manifest.find((m) => m.id === id)?.path ?? id,
  );
  const resources = [...info.entries]
    .filter(([name]) => /\.(png|jpe?g|gif|svg|ttf|otf|woff2?)$/i.test(name))
    .map(([name, entry]) => ({ name, sha256: sha256(entry.bytes) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const linkIdentity = (name: string, href: string) => {
    if (externalHyperlink(href)) return href;
    try {
      const target = localTarget(name, href);
      const actual = info.entries.has(target.path)
        ? target.path
        : ([...info.entries.keys()].find(
            (n) => n.toLowerCase() === target.path.toLowerCase(),
          ) ?? target.path);
      return actual + (target.fragment ? "#" + target.fragment : "");
    } catch {
      return href;
    }
  };
  const documents = paths.map((name) => {
    const doc = info.documents.get(name);
    if (!doc) return { name };
    const text = (elements(doc, "body", NS.xhtml)[0]?.textContent ?? "")
      .normalize("NFC")
      .replace(/\s+/g, " ")
      .trim();
    return {
      name,
      text,
      headings: elements(doc)
        .filter((el) => /^h[1-6]$/.test(el.localName ?? ""))
        .map((el) => el.textContent),
      code: elements(doc, "pre").map((el) => el.textContent),
      tables: elements(doc, "table").map((el) => el.textContent),
      math: elements(doc, "math").map(serialize),
      captions: elements(doc, "figcaption").map((el) => el.textContent),
      links: elements(doc, "a")
        .filter((el) => el.hasAttribute("href"))
        .map((el) => ({
          text: el.textContent,
          target: linkIdentity(name, attr(el, "href")),
        })),
      footnotes: elements(doc)
        .filter((el) => attr(el, "epub:type").split(" ").includes("footnote"))
        .map((el) => ({ id: attr(el, "id"), text: el.textContent })),
      imageReferences: elements(doc, "img").map((el) => ({
        target: linkIdentity(name, attr(el, "src")),
        alt: attr(el, "alt"),
      })),
      pageMarkers: elements(doc)
        .filter((el) => attr(el, "epub:type").includes("pagebreak"))
        .map((el) => ({ id: attr(el, "id"), label: attr(el, "aria-label") })),
    };
  });
  const protectedMetadata = elements(
    info.packageDocument,
    "metadata",
    NS.opf,
  )[0];
  const metadata = protectedMetadata
    ? Array.from(protectedMetadata.childNodes)
        .filter((node) => node.nodeType === 1)
        .map((node) => node as import("@xmldom/xmldom").Element)
        .filter(
          (el) =>
            !(
              el.localName === "meta" &&
              [
                "dcterms:modified",
                "schema:accessMode",
                "schema:accessModeSufficient",
                "schema:accessibilityFeature",
                "schema:accessibilityHazard",
                "schema:accessibilitySummary",
              ].includes(attr(el, "property"))
            ),
        )
        .map((el) => serialize(el))
    : [];
  return { spine, resources, documents, protectedMetadata: metadata };
}
