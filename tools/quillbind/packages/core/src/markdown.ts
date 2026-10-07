import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkDirective from "remark-directive";
import remarkCjkFriendly from "remark-cjk-friendly/parseOnly";
import remarkCjkStrikethrough from "remark-cjk-friendly-gfm-strikethrough/parseOnly";
import GithubSlugger from "github-slugger";
import { parseYaml, type BookProject, validLanguage } from "./config.js";
import { safeRead } from "./files.js";
import { fail } from "./errors.js";
import { sha256 } from "./hash.js";
import { localTarget } from "./paths.js";
import { chapterMetadata } from "./chapter-metadata.js";
import { createMathCompiler } from "./math.js";
import type {
  Document,
  Block,
  Inline,
  Footnote,
  Section,
  SourceLocation,
} from "./model.js";

interface Node {
  type: string;
  value?: string;
  children?: Node[];
  depth?: number;
  url?: string;
  title?: string;
  alt?: string;
  identifier?: string;
  name?: string;
  label?: string;
  attributes?: Record<string, string>;
  lang?: string;
  meta?: string;
  ordered?: boolean;
  checked?: boolean;
  start?: number;
  spread?: boolean;
  align?: ("left" | "center" | "right" | null)[];
  position?: {
    start: { line: number; column: number; offset?: number };
    end: { line: number; column: number; offset?: number };
  };
}
const createParser = () =>
  unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkMath)
    .use(remarkDirective);
const standardParser = createParser();
const cjkParser = createParser()
  .use(remarkCjkFriendly)
  .use(remarkCjkStrikethrough);
const plain = (node: Node): string =>
  node.value ?? node.children?.map(plain).join("") ?? "";
export function slug(text: string) {
  const normalized = text
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return "s-" + (normalized || "section");
}
export async function parseChapter(
  project: BookProject,
  source: string,
  index: number,
  compileMath = createMathCompiler(),
): Promise<Document> {
  const input = (await safeRead(project.root, source))
    .toString("utf8")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n");
  const front = /^---\n([\s\S]*?)\n---\n/.exec(input);
  if (!front)
    fail("CHAPTER_FRONTMATTER", `Chapter requires YAML frontmatter: ${source}`);
  let parsed: unknown;
  try {
    parsed = parseYaml(front[1]);
  } catch {
    fail(
      "CHAPTER_FRONTMATTER",
      `${source}: invalid YAML frontmatter; use plain HTTPS source URLs or quote Markdown links. YAML aliases are not supported.`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    fail("CHAPTER_METADATA", `${source}: frontmatter must be a YAML mapping`);
  const metadata = parsed as Record<string, unknown>;
  const blog = project.config.markdown.profile === "blog";
  const chapterId =
    metadata.id === undefined && blog
      ? `chapter-${sha256(source).slice(0, 16)}`
      : metadata.id;
  if (
    !metadata ||
    typeof chapterId !== "string" ||
    !/^[a-zA-Z][\w-]*$/.test(chapterId) ||
    typeof metadata.title !== "string" ||
    !metadata.title.trim()
  )
    fail("CHAPTER_METADATA", `Chapter requires stable id and title: ${source}`);
  const language =
    typeof metadata.lang === "string"
      ? metadata.lang
      : project.config.book.language;
  if (!validLanguage(language))
    fail("LANGUAGE_INVALID", `${source}: invalid language`);
  const body = input.slice(front[0].length);
  const lineOffset = front[0].split("\n").length - 1;
  const emphasis = project.config.markdown.cjkEmphasis;
  const cjk =
    emphasis === "on" ||
    (emphasis === "auto" &&
      ["Hans", "Hant", "Jpan", "Kore"].includes(
        new Intl.Locale(language).maximize().script ?? "",
      ));
  const tree = (cjk ? cjkParser : standardParser).parse(body) as Node;
  const importedMetadata = chapterMetadata(
    metadata,
    project.config.markdown.chapterMetadata,
    source,
  );
  const githubSlugger = new GithubSlugger();
  const imageTarget = (target: string) => {
    if (!blog) return target;
    const resolved = localTarget(source, target);
    if (resolved.fragment)
      fail("IMAGE_FRAGMENT", `${source}: image fragments are not supported`);
    return resolved.path;
  };
  const definitions = new Map<string, Node>();
  const noteDefinitions = new Map<string, Node>();
  const sourceOf = (node: Node): SourceLocation => ({
    source,
    line: node.position ? node.position.start.line + lineOffset : undefined,
    column: node.position?.start.column,
  });
  const collect = (node: Node) => {
    const id = node.identifier?.toLowerCase();
    if (node.type === "definition" && id) {
      if (definitions.has(id)) fail("DUPLICATE_DEFINITION", `${source}: ${id}`);
      definitions.set(id, node);
    }
    if (node.type === "footnoteDefinition" && id) {
      if (noteDefinitions.has(id))
        fail("DUPLICATE_FOOTNOTE", `${source}: ${id}`);
      noteDefinitions.set(id, node);
    }
    if (node.type === "html")
      fail(
        "RAW_HTML_FORBIDDEN",
        `${source}:${sourceOf(node).line}: raw HTML is disabled`,
      );
    const rawText =
      node.type === "text" && node.position
        ? body.slice(node.position.start.offset, node.position.end.offset)
        : "";
    const unescapedReference = [
      ...rawText.matchAll(/\[\^[^\]\n]+\]|\[[^\]\n]+\]\[[^\]\n]+\]/g),
    ].some((match) => {
      const escaped = (at: number) => {
        let slashes = 0;
        while (at > 0 && rawText[--at] === "\\") slashes++;
        return slashes % 2 === 1;
      };
      return (
        !escaped(match.index) && !escaped(match.index + match[0].length - 1)
      );
    });
    if (unescapedReference)
      fail(
        "REFERENCE_MISSING",
        `${source}: unresolved chapter-local reference; use inline code for literal reference syntax`,
      );
    if (typeof node.checked === "boolean")
      fail(
        "UNSUPPORTED_MARKDOWN",
        `${source}: interactive task lists are not supported`,
      );
    if (node.type === "code" && node.position) {
      const lines = body.split("\n");
      const first = lines[node.position.start.line - 1];
      const fence = /^ {0,3}(`{3,}|~{3,})/.exec(first);
      if (fence) {
        const last = lines[node.position.end.line - 1];
        if (
          node.position.end.line === node.position.start.line ||
          !new RegExp(`^ {0,3}${fence[1][0]}{${fence[1].length},}\\s*$`).test(
            last,
          )
        )
          fail(
            "UNCLOSED_FENCE",
            `${source}: fenced code must close in this chapter`,
          );
      }
    }
    node.children?.forEach(collect);
  };
  collect(tree);
  const usedIds = new Set<string>();
  let noteCount = 0;
  const notes = new Map<string, Footnote>();
  const id = (value: string, explicit = false) => {
    let candidate = value;
    if (explicit && usedIds.has(value))
      fail("DUPLICATE_ID", `${source}: ${value}`);
    let suffix = 2;
    while (usedIds.has(candidate)) candidate = `${value}-${suffix++}`;
    usedIds.add(candidate);
    return candidate;
  };
  const inline = (node: Node): Inline => {
    const children = () => node.children?.map(inline) ?? [];
    const common = { source: sourceOf(node) };
    switch (node.type) {
      case "text":
        return { kind: "text", text: node.value ?? "", ...common };
      case "emphasis":
      case "strong":
      case "delete":
        return { kind: node.type, children: children(), ...common };
      case "inlineCode":
        return { kind: "code", text: node.value ?? "", ...common };
      case "break":
        return { kind: "break", ...common };
      case "link":
        return {
          kind: "link",
          target: node.url!,
          title: node.title,
          children: children(),
          ...common,
        };
      case "image":
        return {
          kind: "image",
          target: imageTarget(node.url!),
          alt: node.alt ?? "",
          title: node.title,
          ...common,
        };
      case "inlineMath":
        return {
          kind: "math",
          expression: compileMath(node.value ?? "", false),
          ...common,
        };
      case "linkReference":
      case "imageReference": {
        const definition = definitions.get(node.identifier!.toLowerCase());
        if (!definition)
          fail("REFERENCE_MISSING", `${source}: ${node.identifier}`);
        return node.type === "linkReference"
          ? {
              kind: "link",
              target: definition.url!,
              title: definition.title,
              children: children(),
              ...common,
            }
          : {
              kind: "image",
              target: imageTarget(definition.url!),
              alt: node.alt ?? "",
              title: definition.title,
              ...common,
            };
      }
      case "footnoteReference": {
        const key = node.identifier!.toLowerCase();
        if (!noteDefinitions.has(key))
          fail("FOOTNOTE_MISSING", `${source}: ${key}`);
        let note = notes.get(key);
        if (!note) {
          note = { id: id("fn-" + slug(key)), blocks: [], references: [] };
          notes.set(key, note);
        }
        const ref = id(`noteref-${++noteCount}`);
        note.references.push(ref);
        return {
          kind: "footnoteRef",
          target: note.id,
          id: ref,
          text: String([...notes.keys()].indexOf(key) + 1),
          ...common,
        };
      }
      case "textDirective": {
        if (node.name === "ruby") {
          if (!node.attributes?.reading)
            fail("RUBY_READING", `${source}: ruby requires reading`);
          return {
            kind: "ruby",
            children: children(),
            annotation: node.attributes.reading,
            ...common,
          };
        }
        if (node.name === "cite") {
          const key = plain(node);
          if (!project.config.references.some((r) => r.id === key))
            fail("CITATION_MISSING", `${source}: ${key}`);
          return {
            kind: "citation",
            target: `ref-${key}`,
            text: key,
            ...common,
          };
        }
        return fail(
          "UNSUPPORTED_MARKDOWN",
          `${source}: unsupported inline directive ${node.name}`,
        );
      }
      default:
        fail(
          "UNSUPPORTED_MARKDOWN",
          `${source}: unsupported inline ${node.type}`,
        );
    }
  };
  const blocks = (nodes: Node[]): Block[] => {
    const output: Block[] = [];
    let caption: string | undefined;
    for (const node of nodes) {
      const common = { source: sourceOf(node) };
      const inlines = () => node.children?.map(inline) ?? [];
      switch (node.type) {
        case "definition":
        case "footnoteDefinition":
          continue;
        case "paragraph":
          output.push({ kind: "paragraph", inlines: inlines(), ...common });
          break;
        case "heading": {
          const text = plain(node);
          const explicit = /\s+\{#([a-zA-Z][\w-]*)\}$/.exec(text);
          if (explicit) {
            const last = node.children?.at(-1);
            if (last?.type !== "text")
              fail("HEADING_ID", `${source}: explicit id must end a heading`);
            last.value = last.value!.replace(/\s+\{#[\w-]+\}$/, "");
          }
          output.push({
            kind: "heading",
            level: node.depth!,
            id: id(
              explicit?.[1] ??
                (blog
                  ? githubSlugger.slug(plain(node)) || "section"
                  : slug(plain(node))),
              !!explicit || blog,
            ),
            inlines: inlines(),
            ...common,
          });
          break;
        }
        case "blockquote":
          output.push({
            kind: "quote",
            children: blocks(node.children ?? []),
            ...common,
          });
          break;
        case "list":
          output.push({
            kind: "list",
            ordered: node.ordered ?? false,
            start: node.start,
            spread: node.spread,
            children: blocks(node.children ?? []),
            ...common,
          });
          break;
        case "listItem":
          output.push({
            kind: "listItem",
            children: blocks(node.children ?? []),
            ...common,
          });
          break;
        case "code":
          output.push({
            kind: "code",
            text: node.value ?? "",
            language: node.lang ?? "text",
            caption: node.meta?.match(/caption="([^"]+)"/)?.[1],
            ...common,
          });
          break;
        case "math":
          output.push({
            kind: "math",
            expression: compileMath(node.value ?? "", true),
            ...common,
          });
          break;
        case "thematicBreak":
          output.push({ kind: "thematicBreak", ...common });
          break;
        case "table":
          if (!caption)
            fail(
              "TABLE_CAPTION",
              `${source}: put ::caption[Text] immediately before each table`,
            );
          output.push({
            kind: "table",
            caption,
            alignment: node.align,
            rows:
              node.children?.map(
                (row) =>
                  row.children?.map(
                    (cell) => cell.children?.map(inline) ?? [],
                  ) ?? [],
              ) ?? [],
            ...common,
          });
          caption = undefined;
          break;
        case "leafDirective":
        case "containerDirective": {
          const attrs = node.attributes ?? {};
          if (node.name === "caption") {
            if (caption)
              fail("TABLE_CAPTION", `${source}: consecutive captions`);
            caption = plain(node);
            continue;
          }
          if (node.name === "pagebreak") {
            output.push({
              kind: "pagebreak",
              id: id(attrs.id ?? `page-${output.length}`),
              title: attrs.label,
              ...common,
            });
            break;
          }
          if (node.name === "bibliography") {
            output.push({ kind: "bibliography", ...common });
            break;
          }
          if (node.name === "figure") {
            if (!attrs.src || attrs.alt === undefined)
              fail("FIGURE_METADATA", `${source}: figure requires src and alt`);
            output.push({
              kind: "figure",
              target: attrs.src,
              alt: attrs.alt,
              caption: plain(node),
              ...common,
            });
            break;
          }
          if (node.name === "admonition") {
            output.push({
              kind: "admonition",
              title: attrs.title ?? "Note",
              children: blocks(node.children ?? []),
              ...common,
            });
            break;
          }
          if (node.name === "definition") {
            if (!attrs.term)
              fail("DEFINITION_TERM", `${source}: definition requires term`);
            output.push({
              kind: "definition",
              title: attrs.term,
              children: blocks(node.children ?? []),
              ...common,
            });
            break;
          }
          if (node.name === "poem") {
            output.push(
              ...blocks(node.children ?? []).map((b) => ({
                ...b,
                classes: ["poem"],
              })),
            );
            break;
          }
          return fail(
            "UNSUPPORTED_MARKDOWN",
            `${source}: unsupported block directive ${node.name}`,
          );
        }
        default:
          fail(
            "UNSUPPORTED_MARKDOWN",
            `${source}: unsupported block ${node.type}`,
          );
      }
      if (caption && node.type !== "table")
        fail(
          "TABLE_CAPTION",
          `${source}: caption must directly precede a table`,
        );
    }
    if (caption) fail("TABLE_CAPTION", `${source}: caption has no table`);
    return output;
  };
  const bodyBlocks = blocks(tree.children ?? []);
  for (const [key, note] of notes) {
    note.blocks = blocks(noteDefinitions.get(key)!.children ?? []);
  }
  if (
    blog &&
    !bodyBlocks.some((block) => block.kind === "heading" && block.level === 1)
  )
    bodyBlocks.unshift({
      kind: "heading",
      level: 1,
      id: id(`${chapterId}-title`),
      inlines: [{ kind: "text", text: metadata.title }],
    });
  const headings = bodyBlocks.filter((b) => b.kind === "heading");
  if (
    headings.filter((h) => h.level === 1).length !== 1 ||
    bodyBlocks[0]?.kind !== "heading" ||
    bodyBlocks[0].level !== 1
  )
    fail("CHAPTER_H1", `${source}: start with exactly one H1`);
  const headingText = headings[0].inlines
    ?.map((i) =>
      "text" in i
        ? i.text
        : "children" in i
          ? i.children
              .map((c) =>
                "text" in c
                  ? c.text
                  : c.kind === "math"
                    ? c.expression.tex
                    : "",
              )
              .join("")
          : i.kind === "math"
            ? i.expression.tex
            : "",
    )
    .join("");
  if (headingText?.normalize("NFC") !== metadata.title.normalize("NFC"))
    fail("CHAPTER_TITLE", `${source}: frontmatter title must match H1`);
  let level = 0;
  for (const heading of headings) {
    if (heading.level > level + 1)
      fail(
        "HEADING_SEQUENCE",
        `${source}: heading level skips from ${level} to ${heading.level}`,
      );
    level = heading.level;
  }
  for (let i = 0; i < bodyBlocks.length; i++)
    if (
      bodyBlocks[i].kind === "paragraph" &&
      (i === 0 || ["heading", "thematicBreak"].includes(bodyBlocks[i - 1].kind))
    )
      bodyBlocks[i].classes = [...(bodyBlocks[i].classes ?? []), "no-indent"];
  const sections: Section[] = [];
  const stack: Section[] = [];
  const inlineText = (values: Inline[]): string =>
    values
      .map((value) =>
        "children" in value
          ? inlineText(value.children)
          : value.kind === "break"
            ? " "
            : "text" in value
              ? value.text
              : value.kind === "image"
                ? value.alt
                : value.kind === "math"
                  ? value.expression.tex
                  : "",
      )
      .join("");
  for (const h of headings) {
    const section: Section = {
      id: h.id,
      title: inlineText(h.inlines ?? []),
      level: h.level,
      children: [],
    };
    while (stack.length && stack.at(-1)!.level >= section.level) stack.pop();
    if (stack.length) stack.at(-1)!.children.push(section);
    else sections.push(section);
    stack.push(section);
  }
  return {
    id: chapterId,
    title: metadata.title,
    language,
    direction: project.config.direction,
    writingMode: project.config.writingMode,
    source,
    href: `EPUB/text/${String(index + 1).padStart(4, "0")}-${chapterId}.xhtml`,
    blocks: bodyBlocks,
    sections,
    footnotes: [...notes.values()],
    ...(importedMetadata ? { chapterMetadata: importedMetadata } : {}),
  };
}
export { preflightBook } from "./preflight.js";
