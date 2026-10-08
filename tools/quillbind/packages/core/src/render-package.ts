import { bookWalkerOpf } from "./bookwalker-opf.js";
import { escapeXml as e } from "./xml.js";
import { xml, NS } from "./xml.js";
import { shell, relative } from "./xhtml.js";
import type { Publication, Document, NavigationTree } from "./model.js";

export function renderPackage(
  publication: Publication,
  documentEntries: { doc: Document; properties: string[] }[],
) {
  const entries = new Map<string, Uint8Array>();
  const set = (name: string, value: string | Uint8Array) =>
    entries.set(name, typeof value === "string" ? Buffer.from(value) : value);
  const metadata = publication.metadata;
  const assets = publication.resources.map((resource) =>
    resource.href === publication.cover
      ? {
          ...resource,
          properties: [
            ...new Set([...(resource.properties ?? []), "cover-image"]),
          ],
        }
      : resource,
  );
  const locale = new Intl.Locale(metadata.language);
  const contentsLabel =
    locale.language === "zh"
      ? locale.maximize().script === "Hant"
        ? "目錄"
        : "目录"
      : "Contents";
  const contentsPath = "EPUB/contents.xhtml";
  const usedIds = new Set([
    "nav",
    "publication-id",
    ...publication.documents.map((doc) => doc.id),
    ...assets.map((asset) => asset.id),
  ]);
  const reserveId = (base: string) => {
    let id = base;
    for (let suffix = 1; usedIds.has(id); suffix++) id = `${base}-${suffix}`;
    usedIds.add(id);
    return id;
  };
  const contentsId = reserveId("contents");
  const coverId = publication.cover ? reserveId("cover-page") : undefined;
  const coverLabel = locale.language === "zh" ? "封面" : "Cover";
  const coverEntry = publication.cover
    ? [{ title: coverLabel, href: "EPUB/cover.xhtml", children: [] }]
    : [];
  const frontmatterStyles = ["styles/base.css", "styles/frontmatter.css"];
  const nav = (tree: NavigationTree[], from: string): string =>
    `<ol role="list">${tree.map((node) => `<li><a href="${e(relative(from, node.href))}">${e(node.title)}</a>${node.children.length ? nav(node.children, from) : ""}</li>`).join("")}</ol>`;
  const navigation = [
    ...coverEntry,
    { title: contentsLabel, href: contentsPath, children: [] },
    ...publication.navigation,
  ];
  const pageAttrs = ` dir="${publication.documents[0].direction}"${publication.documents[0].writingMode === "vertical-rl" ? ' class="vertical"' : ""}`;
  set(
    contentsPath,
    shell(
      contentsLabel,
      metadata.language,
      `<main epub:type="frontmatter"><nav role="doc-toc" aria-labelledby="contents-title"><h1 id="contents-title">${contentsLabel}</h1>${nav([...coverEntry, ...publication.navigation], contentsPath)}</nav></main>`,
      frontmatterStyles,
      pageAttrs,
    ),
  );
  const coverLandmark = publication.cover
    ? `<li><a epub:type="cover" href="cover.xhtml">${coverLabel}</a></li>`
    : "";
  const pages = publication.documents.flatMap((d) =>
    d.blocks
      .filter((b) => b.kind === "pagebreak")
      .filter((b) => b.title)
      .map((b) => ({
        title: b.title!,
        href: `${d.href}#${b.id}`,
        children: [],
      })),
  );
  set(
    "EPUB/nav.xhtml",
    shell(
      contentsLabel,
      metadata.language,
      `<nav epub:type="toc" role="doc-toc" aria-label="${contentsLabel}"><h1>${contentsLabel}</h1>${nav(navigation, "EPUB/nav.xhtml")}</nav><nav epub:type="landmarks" aria-label="Landmarks"><h2>Landmarks</h2><ol>${coverLandmark}<li><a epub:type="toc" href="contents.xhtml">${contentsLabel}</a></li><li><a epub:type="bodymatter" href="${e(relative("EPUB/nav.xhtml", publication.documents[0].href))}">Start of text</a></li></ol></nav>${pages.length ? `<nav epub:type="page-list" role="doc-pagelist" aria-label="Pages"><h2>Pages</h2>${nav(pages, "EPUB/nav.xhtml")}</nav>` : ""}`,
      frontmatterStyles,
      pageAttrs,
    ),
  );
  for (const res of assets) set(res.href, res.bytes);
  if (publication.cover) {
    const coverAlt = `${metadata.title} — ${metadata.authors.map((author) => author.name).join(", ")}`;
    set(
      "EPUB/cover.xhtml",
      shell(
        metadata.title,
        metadata.language,
        `<main epub:type="cover"><figure><img src="${e(relative("EPUB/cover.xhtml", publication.cover))}" alt="${e(coverAlt)}"/></figure></main>`,
        frontmatterStyles,
        ` class="cover-document" dir="${publication.documents[0].direction}"`,
      ),
    );
  }
  const coverItem = coverId
    ? `<item id="${coverId}" href="cover.xhtml" media-type="application/xhtml+xml"/>`
    : "";
  const coverSpine = coverId ? `<itemref idref="${coverId}"/>` : "";
  const description = e(metadata.description);
  const visual = assets.some((r) => r.mediaType.startsWith("image/"));
  const opf = `<?xml version="1.0" encoding="utf-8"?>\n<package xmlns="${NS.opf}" version="3.0" unique-identifier="publication-id" dir="${publication.documents[0].direction}" xml:lang="${e(metadata.language)}" prefix="schema: http://schema.org/"><metadata xmlns:dc="${NS.dc}"><dc:identifier id="publication-id">${e(metadata.identifier.value)}</dc:identifier><dc:title>${e(metadata.title)}</dc:title><dc:language>${e(metadata.language)}</dc:language>${metadata.authors.map((a) => `<dc:creator>${e(a.name)}</dc:creator>`).join("")}<dc:description>${description}</dc:description>${metadata.tags.map((t) => `<dc:subject>${e(t.id)}</dc:subject>`).join("")}${metadata.bibliography ? bookWalkerOpf(metadata.bibliography, reserveId) : ""}<meta property="dcterms:modified">${metadata.modified}</meta><meta name="generator" content="Quillbind 0.1.0"/><meta property="schema:accessMode">textual</meta>${visual ? '<meta property="schema:accessMode">visual</meta>' : ""}<meta property="schema:accessModeSufficient">textual</meta><meta property="schema:accessibilityFeature">structuralNavigation</meta><meta property="schema:accessibilityFeature">tableOfContents</meta>${visual ? '<meta property="schema:accessibilityFeature">alternativeText</meta>' : ""}<meta property="schema:accessibilityHazard">none</meta><meta property="schema:accessibilitySummary">Reflowable text with semantic navigation. Automated accessibility checks are reported separately; no certification is claimed.</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>${coverItem}<item id="${contentsId}" href="contents.xhtml" media-type="application/xhtml+xml"/>${documentEntries.map(({ doc, properties }) => `<item id="${e(doc.id)}" href="${e(relative("EPUB/package.opf", doc.href))}" media-type="application/xhtml+xml"${properties.length ? ` properties="${properties.join(" ")}"` : ""}/>`).join("")}${assets.map((r) => `<item id="${e(r.id)}" href="${e(relative("EPUB/package.opf", r.href))}" media-type="${r.mediaType}"${r.properties?.length ? ` properties="${r.properties.join(" ")}"` : ""}/>`).join("")}</manifest><spine page-progression-direction="${publication.pageProgression ?? (publication.documents[0].writingMode === "vertical-rl" ? "rtl" : publication.documents[0].direction)}">${coverSpine}<itemref idref="${contentsId}"/>${publication.documents.map((d) => `<itemref idref="${e(d.id)}"/>`).join("")}</spine></package>\n`;
  xml(opf, "package.opf");
  set("EPUB/package.opf", opf);
  set(
    "META-INF/container.xml",
    `<?xml version="1.0" encoding="utf-8"?>\n<container version="1.0" xmlns="${NS.container}"><rootfiles><rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>\n`,
  );
  set("mimetype", "application/epub+zip");
  return entries;
}
