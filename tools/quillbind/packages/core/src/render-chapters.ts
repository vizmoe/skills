import { fail } from "./errors.js";
import { escapeXml as e, xml } from "./xml.js";
import { localTarget } from "./paths.js";
import { chapterDisplayDate, linkChapterTitle } from "./chapter-metadata.js";
import { highlightCode } from "./highlight.js";
import { shell, relative } from "./xhtml.js";
import type {
  Publication,
  Block,
  Inline,
  Document,
  Footnote,
} from "./model.js";

interface ChapterContext {
  publication: Publication;
  doc: Document;
  chapterSource?: string;
  byline: string;
  hasMath: boolean;
  usedCitations: Set<string>;
}

async function mapSequential<T, U>(
  items: readonly T[],
  fn: (item: T) => Promise<U>,
): Promise<U[]> {
  const results: U[] = [];
  let chain = Promise.resolve();
  for (const item of items) {
    chain = chain.then(() =>
      fn(item).then((value) => {
        results.push(value);
      }),
    );
  }
  await chain;
  return results;
}

function findResource(publication: Publication, source: string) {
  const found = publication.resources.find(
    (r) => r.source === source || r.sourceAliases?.includes(source),
  );
  if (!found) fail("RESOURCE_MISSING", source);
  return found;
}

function buildChapterHead(doc: Document): string {
  const chapter = doc.chapterMetadata;
  return [
    ...(chapter?.authors ?? []).map(
      (author) => `<meta name="author" content="${e(author)}"/>`,
    ),
    ...(chapter?.date
      ? [`<meta name="dc.date" content="${e(chapter.date)}"/>`]
      : []),
    ...(chapter?.source
      ? [`<meta name="dc.source" content="${e(chapter.source)}"/>`]
      : []),
  ].join("");
}

function buildChapterByline(doc: Document): string {
  const chapter = doc.chapterMetadata;
  const displayDate = chapter?.date
    ? chapterDisplayDate(chapter.date)
    : undefined;
  const parts = [
    ...(chapter?.authors
      ? [`<span>${e(chapter.authors.join(", "))}</span>`]
      : []),
    ...(displayDate
      ? [`<time datetime="${displayDate}">${displayDate}</time>`]
      : []),
  ];
  if (chapter?.display !== "byline" || !parts.length) return "";
  return `<p class="chapter-meta"><small>${parts.join(" · ")}</small></p>`;
}

function resolveChapterLink(ctx: ChapterContext, target: string): string {
  if (/^https:\/\//i.test(target)) return target;
  if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(target))
    fail("LINK_SCHEME", `Only HTTPS external links are allowed: ${target}`);
  const sourceTarget = localTarget(ctx.doc.source, target);
  const chapter = ctx.publication.documents.find(
    (d) => d.source === sourceTarget.path,
  );
  if (chapter)
    return (
      relative(ctx.doc.href, chapter.href) +
      (sourceTarget.fragment ? `#${sourceTarget.fragment}` : "")
    );
  if (target.startsWith("#")) return target;
  fail("LINK_TARGET", `Unknown chapter target: ${target}`);
}

function renderImage(
  ctx: ChapterContext,
  target: string,
  alt: string | undefined,
  title?: string,
  inline = false,
): string {
  const res = findResource(ctx.publication, target);
  if (alt === undefined || (!alt.trim() && title !== "decorative"))
    fail(
      "IMAGE_ALT",
      `${target}: provide descriptive alt, or empty alt and title "decorative"`,
    );
  const titleAttr =
    title && title !== "decorative" ? ` title="${e(title)}"` : "";
  const classAttr = inline ? ' class="inline-image"' : "";
  const roleAttr = alt === "" ? ' role="presentation"' : "";
  return `<img src="${e(relative(ctx.doc.href, res.href))}" alt="${e(alt)}"${titleAttr}${classAttr}${roleAttr}/>`;
}

function renderInline(ctx: ChapterContext, value: Inline): string {
  switch (value.kind) {
    case "text":
      return e(value.text ?? "");
    case "emphasis":
      return `<em>${renderInlines(ctx, value.children ?? [])}</em>`;
    case "strong":
      return `<strong>${renderInlines(ctx, value.children ?? [])}</strong>`;
    case "delete":
      return `<del>${renderInlines(ctx, value.children ?? [])}</del>`;
    case "code":
      return `<code>${e(value.text ?? "")}</code>`;
    case "break":
      return "<br/>";
    case "link": {
      const titleAttr = value.title ? ` title="${e(value.title)}"` : "";
      const href = e(resolveChapterLink(ctx, value.target));
      return `<a href="${href}"${titleAttr}>${renderInlines(ctx, value.children ?? [])}</a>`;
    }
    case "image":
      return renderImage(ctx, value.target, value.alt, value.title, true);
    case "math":
      ctx.hasMath = true;
      return value.expression.mathml;
    case "ruby":
      return `<ruby>${renderInlines(ctx, value.children ?? [])}<rt>${e(value.annotation)}</rt></ruby>`;
    case "citation":
      ctx.usedCitations.add(value.text);
      return `<a epub:type="biblioref" role="doc-biblioref" href="#${e(value.target)}">[${e(value.text)}]</a>`;
    case "footnoteRef":
      return `<a epub:type="noteref" role="doc-noteref" id="${e(value.id)}" href="#${e(value.target)}"><sup>${e(value.text)}</sup></a>`;
  }
}

function renderInlines(ctx: ChapterContext, values: Inline[]): string {
  return values.map((value) => renderInline(ctx, value)).join("");
}

function renderBibliography(ctx: ChapterContext): string {
  const items = ctx.publication.citations
    .map((c) => {
      const urlLink = c.url
        ? ` <a href="${e(resolveChapterLink(ctx, c.url))}">${e(c.url)}</a>`
        : "";
      return `<li id="ref-${e(c.id)}">${e(c.text)}${urlLink}</li>`;
    })
    .join("");
  return `<section epub:type="bibliography" role="doc-bibliography"><h2>References</h2><ol>${items}</ol></section>`;
}

function renderTable(
  ctx: ChapterContext,
  value: Extract<Block, { kind: "table" }>,
): string {
  const alignment = (column: number) =>
    value.alignment?.[column]
      ? ` class="align-${value.alignment[column]}"`
      : "";
  const headerCells = value.rows[0]
    .map(
      (cell, column) =>
        `<th scope="col"${alignment(column)}>${renderInlines(ctx, cell)}</th>`,
    )
    .join("");
  const bodyRows = value.rows
    .slice(1)
    .map((row) => {
      const cells = row
        .map(
          (cell, column) =>
            `<td${alignment(column)}>${renderInlines(ctx, cell)}</td>`,
        )
        .join("");
      return `<tr>${cells}</tr>`;
    })
    .join("");
  const caption = e(value.caption);
  return `<div class="table-container" tabindex="0" role="region" aria-label="${caption}"><table><caption>${caption}</caption><thead><tr>${headerCells}</tr></thead><tbody>${bodyRows}</tbody></table></div>`;
}

function renderHeadingBlock(
  ctx: ChapterContext,
  value: Extract<Block, { kind: "heading" }>,
): string[] {
  const title = value.inlines ?? [];
  const isChapterTitle = value === ctx.doc.blocks[0];
  const headingInlines =
    isChapterTitle && ctx.chapterSource
      ? linkChapterTitle(title, ctx.chapterSource)
      : title;
  const heading = `<h${value.level} id="${e(value.id)}">${renderInlines(ctx, headingInlines)}</h${value.level}>`;
  return isChapterTitle && ctx.byline ? [heading, ctx.byline] : [heading];
}

function renderParagraphBlock(
  ctx: ChapterContext,
  value: Extract<Block, { kind: "paragraph" }>,
  attrs: string,
  tight: boolean,
): string {
  const content = value.inlines ?? [];
  if (content.length === 1 && content[0].kind === "image") {
    const img = content[0];
    return `<figure${attrs}>${renderImage(ctx, img.target, img.alt, img.title)}</figure>`;
  }
  return tight
    ? renderInlines(ctx, content)
    : `<p${attrs}>${renderInlines(ctx, content)}</p>`;
}

async function renderBlock(
  ctx: ChapterContext,
  value: Block,
  tight: boolean,
): Promise<string[]> {
  const attrs = value.classes?.length
    ? ` class="${value.classes.map(e).join(" ")}"`
    : "";
  switch (value.kind) {
    case "heading":
      return renderHeadingBlock(ctx, value);
    case "paragraph":
      return [renderParagraphBlock(ctx, value, attrs, tight)];
    case "quote":
      return [
        `<blockquote>${await renderBlocks(ctx, value.children ?? [])}</blockquote>`,
      ];
    case "list": {
      const tag = value.ordered ? "ol" : "ul";
      const startAttr =
        value.ordered && value.start !== undefined
          ? ` start="${value.start}"`
          : "";
      const inner = await renderBlocks(
        ctx,
        value.children ?? [],
        value.spread === false,
      );
      return [`<${tag}${startAttr}>${inner}</${tag}>`];
    }
    case "listItem":
      return [
        `<li>${await renderBlocks(ctx, value.children ?? [], tight)}</li>`,
      ];
    case "code": {
      const content = await highlightCode(value.text, value.language);
      const code = `<pre><code>${content}</code></pre>`;
      return [
        value.caption
          ? `<figure><figcaption>${e(value.caption)}</figcaption>${code}</figure>`
          : code,
      ];
    }
    case "thematicBreak":
      return ["<hr/>"];
    case "math":
      ctx.hasMath = true;
      return [
        `<div class="math-display" tabindex="0" role="region" aria-label="Mathematical expression">${value.expression.mathml}</div>`,
      ];
    case "figure": {
      const decorative = value.alt === "" ? "decorative" : undefined;
      return [
        `<figure>${renderImage(ctx, value.target, value.alt, decorative)}<figcaption>${e(value.caption ?? "")}</figcaption></figure>`,
      ];
    }
    case "table":
      return [renderTable(ctx, value)];
    case "admonition": {
      const title = e(value.title);
      const inner = await renderBlocks(ctx, value.children ?? []);
      return [
        `<aside aria-label="${title}"><p><strong>${title}</strong></p>${inner}</aside>`,
      ];
    }
    case "definition":
      return [
        `<dl><dt>${e(value.title)}</dt><dd>${await renderBlocks(ctx, value.children ?? [])}</dd></dl>`,
      ];
    case "pagebreak":
      return [
        value.title
          ? `<span class="pagebreak" id="${e(value.id)}" epub:type="pagebreak" role="doc-pagebreak" aria-label="${e(value.title)}"/>`
          : `<hr class="pagebreak" id="${e(value.id)}"/>`,
      ];
    case "bibliography":
      return [renderBibliography(ctx)];
  }
}

async function renderBlocks(
  ctx: ChapterContext,
  values: Block[],
  tight = false,
): Promise<string> {
  const parts = await mapSequential(values, (value) =>
    renderBlock(ctx, value, tight),
  );
  return parts.flat().join("\n");
}

async function renderFootnote(
  ctx: ChapterContext,
  note: Footnote,
): Promise<string> {
  const noteBody = await renderBlocks(ctx, note.blocks);
  const backlinks = note.references
    .map(
      (ref, i) =>
        `<a role="doc-backlink" href="#${e(ref)}">Return to reference ${i + 1}</a>`,
    )
    .join(" ");
  return `<aside epub:type="footnote" role="doc-footnote" id="${e(note.id)}">${noteBody}<p>${backlinks}</p></aside>`;
}

async function renderChapterDocument(
  publication: Publication,
  doc: Document,
): Promise<{ href: string; value: string; properties: string[] }> {
  const chapter = doc.chapterMetadata;
  const ctx: ChapterContext = {
    publication,
    doc,
    chapterSource: chapter?.display === "byline" ? chapter.source : undefined,
    byline: buildChapterByline(doc),
    hasMath: false,
    usedCitations: new Set<string>(),
  };
  let body = await renderBlocks(ctx, doc.blocks);
  if (doc.footnotes.length) {
    const notes = await mapSequential(doc.footnotes, (note) =>
      renderFootnote(ctx, note),
    );
    body += `<section class="footnotes" epub:type="footnotes"><h2>Notes</h2>${notes.join("")}</section>`;
  }
  if (
    ctx.usedCitations.size &&
    !doc.blocks.some((b) => b.kind === "bibliography")
  )
    body += renderBibliography(ctx);
  body = `<main epub:type="bodymatter">${body}</main>`;
  const stylesheets = publication.resources
    .filter(
      (r) =>
        r.mediaType === "text/css" && r.href !== "EPUB/styles/frontmatter.css",
    )
    .map((r) => relative(doc.href, r.href));
  const verticalClass =
    doc.writingMode === "vertical-rl" ? ' class="vertical"' : "";
  const value = shell(
    doc.title,
    doc.language,
    body,
    stylesheets,
    ` dir="${doc.direction}"${verticalClass}`,
    buildChapterHead(doc),
  );
  xml(value, doc.href);
  return {
    href: doc.href,
    value,
    properties: ctx.hasMath ? ["mathml"] : [],
  };
}

export async function renderChapters(publication: Publication) {
  const entries = new Map<string, Uint8Array>();
  const rendered = await mapSequential(publication.documents, (doc) =>
    renderChapterDocument(publication, doc),
  );
  const documentEntries = rendered.map((item, index) => {
    entries.set(item.href, Buffer.from(item.value));
    return { doc: publication.documents[index], properties: item.properties };
  });
  return { entries, documentEntries };
}
