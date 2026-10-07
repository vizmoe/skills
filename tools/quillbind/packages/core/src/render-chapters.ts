import { fail } from "./errors.js";
import { escapeXml as e } from "./xml.js";
import { localTarget } from "./paths.js";
import { chapterDisplayDate, linkChapterTitle } from "./chapter-metadata.js";
import { xml } from "./xml.js";
import { highlightCode } from "./highlight.js";
import { shell, relative } from "./xhtml.js";
import type { Publication, Block, Inline, Document } from "./model.js";

export async function renderChapters(publication: Publication) {
  const entries = new Map<string, Uint8Array>();
  const set = (name: string, value: string | Uint8Array) =>
    entries.set(name, typeof value === "string" ? Buffer.from(value) : value);
  const resource = (source: string) => {
    const found = publication.resources.find(
      (r) => r.source === source || r.sourceAliases?.includes(source),
    );
    if (!found) fail("RESOURCE_MISSING", source);
    return found;
  };
  const documentEntries: { doc: Document; properties: string[] }[] = [];
  for (const doc of publication.documents) {
    let hasMath = false;
    const usedCitations = new Set<string>();
    const chapter = doc.chapterMetadata;
    const chapterSource =
      chapter?.display === "byline" ? chapter.source : undefined;
    const chapterHead = [
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
    const displayDate = chapter?.date
      ? chapterDisplayDate(chapter.date)
      : undefined;
    const bylineParts = [
      ...(chapter?.authors
        ? [`<span>${e(chapter.authors.join(", "))}</span>`]
        : []),
      ...(displayDate
        ? [`<time datetime="${displayDate}">${displayDate}</time>`]
        : []),
    ];
    const byline =
      chapter?.display === "byline" && bylineParts.length
        ? `<p class="chapter-meta"><small>${bylineParts.join(" · ")}</small></p>`
        : "";
    const link = (target: string) => {
      if (/^https:\/\//i.test(target)) return target;
      if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(target))
        fail("LINK_SCHEME", `Only HTTPS external links are allowed: ${target}`);
      const sourceTarget = localTarget(doc.source, target);
      const chapter = publication.documents.find(
        (d) => d.source === sourceTarget.path,
      );
      if (chapter)
        return (
          relative(doc.href, chapter.href) +
          (sourceTarget.fragment ? `#${sourceTarget.fragment}` : "")
        );
      if (target.startsWith("#")) return target;
      fail("LINK_TARGET", `Unknown chapter target: ${target}`);
    };
    const image = (
      target: string,
      alt: string | undefined,
      title?: string,
      inline = false,
    ) => {
      const res = resource(target);
      if (alt === undefined || (!alt.trim() && title !== "decorative"))
        fail(
          "IMAGE_ALT",
          `${target}: provide descriptive alt, or empty alt and title "decorative"`,
        );
      return `<img src="${e(relative(doc.href, res.href))}" alt="${e(alt)}"${title && title !== "decorative" ? ` title="${e(title)}"` : ""}${inline ? ' class="inline-image"' : ""}${alt === "" ? ' role="presentation"' : ""}/>`;
    };
    const inlines = (values: Inline[]): string =>
      values
        .map((value) => {
          switch (value.kind) {
            case "text":
              return e(value.text ?? "");
            case "emphasis":
              return `<em>${inlines(value.children ?? [])}</em>`;
            case "strong":
              return `<strong>${inlines(value.children ?? [])}</strong>`;
            case "delete":
              return `<del>${inlines(value.children ?? [])}</del>`;
            case "code":
              return `<code>${e(value.text ?? "")}</code>`;
            case "break":
              return "<br/>";
            case "link":
              return `<a href="${e(link(value.target))}"${value.title ? ` title="${e(value.title)}"` : ""}>${inlines(value.children ?? [])}</a>`;
            case "image":
              return image(value.target, value.alt, value.title, true);
            case "math":
              hasMath = true;
              return value.expression.mathml;
            case "ruby":
              return `<ruby>${inlines(value.children ?? [])}<rt>${e(value.annotation)}</rt></ruby>`;
            case "citation":
              usedCitations.add(value.text);
              return `<a epub:type="biblioref" role="doc-biblioref" href="#${e(value.target)}">[${e(value.text)}]</a>`;
            case "footnoteRef":
              return `<a epub:type="noteref" role="doc-noteref" id="${e(value.id)}" href="#${e(value.target)}"><sup>${e(value.text)}</sup></a>`;
          }
        })
        .join("");
    const bibliography = () =>
      `<section epub:type="bibliography" role="doc-bibliography"><h2>References</h2><ol>${publication.citations.map((c) => `<li id="ref-${e(c.id)}">${e(c.text)}${c.url ? ` <a href="${e(link(c.url))}">${e(c.url)}</a>` : ""}</li>`).join("")}</ol></section>`;
    const blocks = async (values: Block[], tight = false): Promise<string> => {
      const output: string[] = [];
      for (const value of values) {
        const attrs = value.classes?.length
          ? ` class="${value.classes.map(e).join(" ")}"`
          : "";
        switch (value.kind) {
          case "heading": {
            const title = value.inlines ?? [];
            const isChapterTitle = value === doc.blocks[0];
            output.push(
              `<h${value.level} id="${e(value.id)}">${inlines(isChapterTitle && chapterSource ? linkChapterTitle(title, chapterSource) : title)}</h${value.level}>`,
            );
            if (isChapterTitle && byline) output.push(byline);
            break;
          }
          case "paragraph": {
            const content = value.inlines ?? [];
            if (content.length === 1 && content[0].kind === "image") {
              const img = content[0];
              output.push(
                `<figure${attrs}>${image(img.target, img.alt, img.title)}</figure>`,
              );
            } else
              output.push(
                tight ? inlines(content) : `<p${attrs}>${inlines(content)}</p>`,
              );
            break;
          }
          case "quote":
            output.push(
              `<blockquote>${await blocks(value.children ?? [])}</blockquote>`,
            );
            break;
          case "list":
            output.push(
              `<${value.ordered ? "ol" : "ul"}${value.ordered && value.start !== undefined ? ` start="${value.start}"` : ""}>${await blocks(value.children ?? [], value.spread === false)}</${value.ordered ? "ol" : "ul"}>`,
            );
            break;
          case "listItem":
            output.push(
              `<li>${await blocks(value.children ?? [], tight)}</li>`,
            );
            break;
          case "code": {
            const content = await highlightCode(value.text, value.language);
            const code = `<pre><code>${content}</code></pre>`;
            output.push(
              value.caption
                ? `<figure><figcaption>${e(value.caption)}</figcaption>${code}</figure>`
                : code,
            );
            break;
          }
          case "thematicBreak":
            output.push("<hr/>");
            break;
          case "math":
            hasMath = true;
            output.push(
              `<div class="math-display" tabindex="0" role="region" aria-label="Mathematical expression">${value.expression.mathml}</div>`,
            );
            break;
          case "figure":
            output.push(
              `<figure>${image(value.target, value.alt, value.alt === "" ? "decorative" : undefined)}<figcaption>${e(value.caption ?? "")}</figcaption></figure>`,
            );
            break;
          case "table": {
            const alignment = (column: number) =>
              value.alignment?.[column]
                ? ` class="align-${value.alignment[column]}"`
                : "";
            output.push(
              `<div class="table-container" tabindex="0" role="region" aria-label="${e(value.caption)}"><table><caption>${e(value.caption)}</caption><thead><tr>${value.rows[0].map((cell, column) => `<th scope="col"${alignment(column)}>${inlines(cell)}</th>`).join("")}</tr></thead><tbody>${value
                .rows!.slice(1)
                .map(
                  (row) =>
                    `<tr>${row.map((cell, column) => `<td${alignment(column)}>${inlines(cell)}</td>`).join("")}</tr>`,
                )
                .join("")}</tbody></table></div>`,
            );
            break;
          }
          case "admonition":
            output.push(
              `<aside aria-label="${e(value.title)}"><p><strong>${e(value.title)}</strong></p>${await blocks(value.children ?? [])}</aside>`,
            );
            break;
          case "definition":
            output.push(
              `<dl><dt>${e(value.title)}</dt><dd>${await blocks(value.children ?? [])}</dd></dl>`,
            );
            break;
          case "pagebreak":
            output.push(
              value.title
                ? `<span class="pagebreak" id="${e(value.id)}" epub:type="pagebreak" role="doc-pagebreak" aria-label="${e(value.title)}"/>`
                : `<hr class="pagebreak" id="${e(value.id)}"/>`,
            );
            break;
          case "bibliography":
            output.push(bibliography());
            break;
        }
      }
      return output.join("\n");
    };
    let body = await blocks(doc.blocks);
    if (doc.footnotes.length) {
      body += '<section class="footnotes" epub:type="footnotes"><h2>Notes</h2>';
      for (const note of doc.footnotes)
        body += `<aside epub:type="footnote" role="doc-footnote" id="${e(note.id)}">${await blocks(note.blocks)}<p>${note.references.map((ref, i) => `<a role="doc-backlink" href="#${e(ref)}">Return to reference ${i + 1}</a>`).join(" ")}</p></aside>`;
      body += "</section>";
    }
    if (
      usedCitations.size &&
      !doc.blocks.some((b) => b.kind === "bibliography")
    )
      body += bibliography();
    body = `<main epub:type="bodymatter">${body}</main>`;
    const value = shell(
      doc.title,
      doc.language,
      body,
      publication.resources
        .filter(
          (r) =>
            r.mediaType === "text/css" &&
            r.href !== "EPUB/styles/frontmatter.css",
        )
        .map((r) => relative(doc.href, r.href)),
      ` dir="${doc.direction}"${doc.writingMode === "vertical-rl" ? ' class="vertical"' : ""}`,
      chapterHead,
    );
    xml(value, doc.href);
    set(doc.href, value);
    documentEntries.push({ doc, properties: [...(hasMath ? ["mathml"] : [])] });
  }
  return { entries, documentEntries };
}
