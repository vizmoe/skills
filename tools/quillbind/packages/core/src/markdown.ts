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
function trimHyphens(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === "-") start++;
  while (end > start && value[end - 1] === "-") end--;
  return value.slice(start, end);
}

export function slug(text: string) {
  const normalized = trimHyphens(
    text
      .normalize("NFC")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}_-]+/gu, "-"),
  );
  return "s-" + (normalized || "section");
}

function isBackslashEscaped(text: string, index: number): boolean {
  let slashes = 0;
  let pos = index;
  while (pos > 0 && text[--pos] === "\\") slashes++;
  return slashes % 2 === 1;
}

function findReferenceEnd(line: string, start: number, close1: number): number {
  if (line[start + 1] === "^" && close1 > start + 2) return close1;
  if (close1 > start + 1 && line[close1 + 1] === "[") {
    const close2 = line.indexOf("]", close1 + 2);
    if (close2 > close1 + 2) return close2;
  }
  return -1;
}

function lineHasUnescapedReference(line: string): boolean {
  let i = line.indexOf("[");
  let close1 = -1;
  while (i >= 0) {
    if (close1 <= i) close1 = line.indexOf("]", i + 1);
    if (close1 < 0) return false;
    const end = findReferenceEnd(line, i, close1);
    if (end >= 0) {
      if (!isBackslashEscaped(line, i) && !isBackslashEscaped(line, end))
        return true;
      i = line.indexOf("[", end + 1);
    } else {
      i = line.indexOf("[", i + 1);
    }
  }
  return false;
}

function hasUnescapedReference(rawText: string): boolean {
  for (const line of rawText.split("\n")) {
    if (lineHasUnescapedReference(line)) return true;
  }
  return false;
}

function extractTrailingHeadingId(
  text: string,
  pattern: RegExp,
): { id: string; prefixEnd: number } | undefined {
  if (!text.endsWith("}")) return undefined;
  const open = text.lastIndexOf("{#");
  if (open <= 0) return undefined;
  const candidate = text.slice(open + 2, -1);
  if (!pattern.test(candidate)) return undefined;
  let prefixEnd = open;
  while (prefixEnd > 0 && /\s/.test(text[prefixEnd - 1])) prefixEnd--;
  if (prefixEnd === open) return undefined;
  return { id: candidate, prefixEnd };
}

function headingChildText(child: Inline): string {
  if ("text" in child) return child.text;
  if (child.kind === "math") return child.expression.tex;
  return "";
}

function headingInlineText(value: Inline): string {
  if ("text" in value) return value.text;
  if ("children" in value) return value.children.map(headingChildText).join("");
  if (value.kind === "math") return value.expression.tex;
  return "";
}

function singleInlineText(value: Inline): string {
  if ("children" in value) return inlineText(value.children);
  if (value.kind === "break") return " ";
  if ("text" in value) return value.text;
  if (value.kind === "image") return value.alt;
  if (value.kind === "math") return value.expression.tex;
  return "";
}

function inlineText(values: Inline[]): string {
  return values.map(singleInlineText).join("");
}

function parseChapterFrontmatter(
  input: string,
  project: BookProject,
  source: string,
) {
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
  return {
    metadata,
    title: metadata.title,
    chapterId,
    language,
    blog,
    body: input.slice(front[0].length),
    lineOffset: front[0].split("\n").length - 1,
  };
}

interface ChapterParseContext {
  project: BookProject;
  source: string;
  body: string;
  lineOffset: number;
  blog: boolean;
  compileMath: ReturnType<typeof createMathCompiler>;
  githubSlugger: GithubSlugger;
  definitions: Map<string, Node>;
  noteDefinitions: Map<string, Node>;
  usedIds: Set<string>;
  notes: Map<string, Footnote>;
  noteCount: number;
}

function sourceOfNode(ctx: ChapterParseContext, node: Node): SourceLocation {
  return {
    source: ctx.source,
    line: node.position ? node.position.start.line + ctx.lineOffset : undefined,
    column: node.position?.start.column,
  };
}

function resolveImageTarget(ctx: ChapterParseContext, target: string): string {
  if (!ctx.blog) return target;
  const resolved = localTarget(ctx.source, target);
  if (resolved.fragment)
    fail("IMAGE_FRAGMENT", `${ctx.source}: image fragments are not supported`);
  return resolved.path;
}

function allocateChapterId(
  ctx: ChapterParseContext,
  value: string,
  explicit = false,
): string {
  let candidate = value;
  if (explicit && ctx.usedIds.has(value))
    fail("DUPLICATE_ID", `${ctx.source}: ${value}`);
  let suffix = 2;
  while (ctx.usedIds.has(candidate)) candidate = `${value}-${suffix++}`;
  ctx.usedIds.add(candidate);
  return candidate;
}

function validateFencedCodeBlock(ctx: ChapterParseContext, node: Node) {
  if (node.type !== "code" || !node.position) return;
  const lines = ctx.body.split("\n");
  const first = lines[node.position.start.line - 1];
  const fence = /^ {0,3}(`{3,}|~{3,})/.exec(first);
  if (!fence) return;
  const last = lines[node.position.end.line - 1];
  const closingFence = new RegExp(
    String.raw`^ {0,3}${fence[1][0]}{${fence[1].length},}\s*$`,
  );
  if (
    node.position.end.line === node.position.start.line ||
    !closingFence.test(last)
  )
    fail(
      "UNCLOSED_FENCE",
      `${ctx.source}: fenced code must close in this chapter`,
    );
}

function collectChapterNode(ctx: ChapterParseContext, node: Node) {
  const id = node.identifier?.toLowerCase();
  if (node.type === "definition" && id) {
    if (ctx.definitions.has(id))
      fail("DUPLICATE_DEFINITION", `${ctx.source}: ${id}`);
    ctx.definitions.set(id, node);
  }
  if (node.type === "footnoteDefinition" && id) {
    if (ctx.noteDefinitions.has(id))
      fail("DUPLICATE_FOOTNOTE", `${ctx.source}: ${id}`);
    ctx.noteDefinitions.set(id, node);
  }
  if (node.type === "html")
    fail(
      "RAW_HTML_FORBIDDEN",
      `${ctx.source}:${sourceOfNode(ctx, node).line}: raw HTML is disabled`,
    );
  const rawText =
    node.type === "text" && node.position
      ? ctx.body.slice(node.position.start.offset, node.position.end.offset)
      : "";
  if (rawText && hasUnescapedReference(rawText))
    fail(
      "REFERENCE_MISSING",
      `${ctx.source}: unresolved chapter-local reference; use inline code for literal reference syntax`,
    );
  if (typeof node.checked === "boolean")
    fail(
      "UNSUPPORTED_MARKDOWN",
      `${ctx.source}: interactive task lists are not supported`,
    );
  validateFencedCodeBlock(ctx, node);
  node.children?.forEach((child) => collectChapterNode(ctx, child));
}

function convertReferenceInline(
  ctx: ChapterParseContext,
  node: Node,
  common: { source: SourceLocation },
): Inline {
  const definition = ctx.definitions.get(node.identifier!.toLowerCase());
  if (!definition)
    fail("REFERENCE_MISSING", `${ctx.source}: ${node.identifier}`);
  if (node.type === "linkReference")
    return {
      kind: "link",
      target: definition.url!,
      title: definition.title,
      children: node.children?.map((child) => convertInline(ctx, child)) ?? [],
      ...common,
    };
  return {
    kind: "image",
    target: resolveImageTarget(ctx, definition.url!),
    alt: node.alt ?? "",
    title: definition.title,
    ...common,
  };
}

function convertFootnoteReference(
  ctx: ChapterParseContext,
  node: Node,
  common: { source: SourceLocation },
): Inline {
  const key = node.identifier!.toLowerCase();
  if (!ctx.noteDefinitions.has(key))
    fail("FOOTNOTE_MISSING", `${ctx.source}: ${key}`);
  let note = ctx.notes.get(key);
  if (!note) {
    note = {
      id: allocateChapterId(ctx, "fn-" + slug(key)),
      blocks: [],
      references: [],
    };
    ctx.notes.set(key, note);
  }
  const ref = allocateChapterId(ctx, `noteref-${++ctx.noteCount}`);
  note.references.push(ref);
  return {
    kind: "footnoteRef",
    target: note.id,
    id: ref,
    text: String([...ctx.notes.keys()].indexOf(key) + 1),
    ...common,
  };
}

function convertInlineDirective(
  ctx: ChapterParseContext,
  node: Node,
  common: { source: SourceLocation },
): Inline {
  if (node.name === "ruby") {
    if (!node.attributes?.reading)
      fail("RUBY_READING", `${ctx.source}: ruby requires reading`);
    return {
      kind: "ruby",
      children: node.children?.map((child) => convertInline(ctx, child)) ?? [],
      annotation: node.attributes.reading,
      ...common,
    };
  }
  if (node.name === "cite") {
    const key = plain(node);
    if (!ctx.project.config.references.some((r) => r.id === key))
      fail("CITATION_MISSING", `${ctx.source}: ${key}`);
    return {
      kind: "citation",
      target: `ref-${key}`,
      text: key,
      ...common,
    };
  }
  return fail(
    "UNSUPPORTED_MARKDOWN",
    `${ctx.source}: unsupported inline directive ${node.name}`,
  );
}

function convertInline(ctx: ChapterParseContext, node: Node): Inline {
  const children = () =>
    node.children?.map((child) => convertInline(ctx, child)) ?? [];
  const common = { source: sourceOfNode(ctx, node) };
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
        target: resolveImageTarget(ctx, node.url!),
        alt: node.alt ?? "",
        title: node.title,
        ...common,
      };
    case "inlineMath":
      return {
        kind: "math",
        expression: ctx.compileMath(node.value ?? "", false),
        ...common,
      };
    case "linkReference":
    case "imageReference":
      return convertReferenceInline(ctx, node, common);
    case "footnoteReference":
      return convertFootnoteReference(ctx, node, common);
    case "textDirective":
      return convertInlineDirective(ctx, node, common);
    default:
      fail(
        "UNSUPPORTED_MARKDOWN",
        `${ctx.source}: unsupported inline ${node.type}`,
      );
  }
}

function convertHeadingBlock(
  ctx: ChapterParseContext,
  node: Node,
  common: { source: SourceLocation },
): Block {
  const explicit = extractTrailingHeadingId(plain(node), /^[a-zA-Z][\w-]*$/);
  if (explicit) {
    const last = node.children?.at(-1);
    if (last?.type !== "text")
      fail("HEADING_ID", `${ctx.source}: explicit id must end a heading`);
    const stripped = extractTrailingHeadingId(last.value!, /^[\w-]+$/);
    if (stripped) last.value = last.value!.slice(0, stripped.prefixEnd);
  }
  const headingSlug = ctx.blog
    ? ctx.githubSlugger.slug(plain(node)) || "section"
    : slug(plain(node));
  return {
    kind: "heading",
    level: node.depth!,
    id: allocateChapterId(
      ctx,
      explicit?.id ?? headingSlug,
      !!explicit || ctx.blog,
    ),
    inlines: node.children?.map((child) => convertInline(ctx, child)) ?? [],
    ...common,
  };
}

function convertDirectiveBlocks(
  ctx: ChapterParseContext,
  node: Node,
  common: { source: SourceLocation },
  outputLength: number,
): Block[] {
  const attrs = node.attributes ?? {};
  switch (node.name ?? "") {
    case "pagebreak":
      return [
        {
          kind: "pagebreak",
          id: allocateChapterId(ctx, attrs.id ?? `page-${outputLength}`),
          title: attrs.label,
          ...common,
        },
      ];
    case "bibliography":
      return [{ kind: "bibliography", ...common }];
    case "figure":
      if (!attrs.src || attrs.alt === undefined)
        fail("FIGURE_METADATA", `${ctx.source}: figure requires src and alt`);
      return [
        {
          kind: "figure",
          target: attrs.src,
          alt: attrs.alt,
          caption: plain(node),
          ...common,
        },
      ];
    case "admonition":
      return [
        {
          kind: "admonition",
          title: attrs.title ?? "Note",
          children: convertBlocks(ctx, node.children ?? []),
          ...common,
        },
      ];
    case "definition":
      if (!attrs.term)
        fail("DEFINITION_TERM", `${ctx.source}: definition requires term`);
      return [
        {
          kind: "definition",
          title: attrs.term,
          children: convertBlocks(ctx, node.children ?? []),
          ...common,
        },
      ];
    case "poem":
      return convertBlocks(ctx, node.children ?? []).map((b) => ({
        ...b,
        classes: ["poem"],
      }));
    default:
      return fail(
        "UNSUPPORTED_MARKDOWN",
        `${ctx.source}: unsupported block directive ${node.name}`,
      );
  }
}

function convertStandardBlock(
  ctx: ChapterParseContext,
  node: Node,
  common: { source: SourceLocation },
): Block {
  switch (node.type) {
    case "paragraph":
      return {
        kind: "paragraph",
        inlines: node.children?.map((child) => convertInline(ctx, child)) ?? [],
        ...common,
      };
    case "heading":
      return convertHeadingBlock(ctx, node, common);
    case "blockquote":
      return {
        kind: "quote",
        children: convertBlocks(ctx, node.children ?? []),
        ...common,
      };
    case "list":
      return {
        kind: "list",
        ordered: node.ordered ?? false,
        start: node.start,
        spread: node.spread,
        children: convertBlocks(ctx, node.children ?? []),
        ...common,
      };
    case "listItem":
      return {
        kind: "listItem",
        children: convertBlocks(ctx, node.children ?? []),
        ...common,
      };
    case "code":
      return {
        kind: "code",
        text: node.value ?? "",
        language: node.lang ?? "text",
        caption: node.meta?.match(/caption="([^"]+)"/)?.[1],
        ...common,
      };
    case "math":
      return {
        kind: "math",
        expression: ctx.compileMath(node.value ?? "", true),
        ...common,
      };
    case "thematicBreak":
      return { kind: "thematicBreak", ...common };
    default:
      return fail(
        "UNSUPPORTED_MARKDOWN",
        `${ctx.source}: unsupported block ${node.type}`,
      );
  }
}

function convertTableBlock(
  ctx: ChapterParseContext,
  node: Node,
  caption: string | undefined,
  common: { source: SourceLocation },
): Block {
  if (!caption)
    fail(
      "TABLE_CAPTION",
      `${ctx.source}: put ::caption[Text] immediately before each table`,
    );
  return {
    kind: "table",
    caption,
    alignment: node.align,
    rows:
      node.children?.map(
        (row) =>
          row.children?.map(
            (cell) =>
              cell.children?.map((child) => convertInline(ctx, child)) ?? [],
          ) ?? [],
      ) ?? [],
    ...common,
  };
}

function isBlockDirective(node: Node): boolean {
  return node.type === "leafDirective" || node.type === "containerDirective";
}

function appendBlockNode(
  ctx: ChapterParseContext,
  node: Node,
  output: Block[],
  caption: string | undefined,
): string | undefined {
  if (node.type === "definition" || node.type === "footnoteDefinition")
    return caption;
  const common = { source: sourceOfNode(ctx, node) };
  if (node.type === "table") {
    output.push(convertTableBlock(ctx, node, caption, common));
    return undefined;
  }
  if (isBlockDirective(node) && node.name === "caption") {
    if (caption) fail("TABLE_CAPTION", `${ctx.source}: consecutive captions`);
    return plain(node);
  }
  const produced = isBlockDirective(node)
    ? convertDirectiveBlocks(ctx, node, common, output.length)
    : [convertStandardBlock(ctx, node, common)];
  output.push(...produced);
  if (caption)
    fail(
      "TABLE_CAPTION",
      `${ctx.source}: caption must directly precede a table`,
    );
  return undefined;
}

function convertBlocks(ctx: ChapterParseContext, nodes: Node[]): Block[] {
  const output: Block[] = [];
  let caption: string | undefined;
  for (const node of nodes)
    caption = appendBlockNode(ctx, node, output, caption);
  if (caption) fail("TABLE_CAPTION", `${ctx.source}: caption has no table`);
  return output;
}

function validateAndIndexHeadings(
  bodyBlocks: Block[],
  title: string,
  source: string,
): Section[] {
  const headings = bodyBlocks.filter((b) => b.kind === "heading");
  if (
    headings.filter((h) => h.level === 1).length !== 1 ||
    bodyBlocks[0]?.kind !== "heading" ||
    bodyBlocks[0].level !== 1
  )
    fail("CHAPTER_H1", `${source}: start with exactly one H1`);
  const headingText = headings[0].inlines?.map(headingInlineText).join("");
  if (headingText?.normalize("NFC") !== title.normalize("NFC"))
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
  const sections: Section[] = [];
  const stack: Section[] = [];
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
  return sections;
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
  const { metadata, title, chapterId, language, blog, body, lineOffset } =
    parseChapterFrontmatter(input, project, source);
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
  const ctx: ChapterParseContext = {
    project,
    source,
    body,
    lineOffset,
    blog,
    compileMath,
    githubSlugger: new GithubSlugger(),
    definitions: new Map<string, Node>(),
    noteDefinitions: new Map<string, Node>(),
    usedIds: new Set<string>(),
    notes: new Map<string, Footnote>(),
    noteCount: 0,
  };
  collectChapterNode(ctx, tree);
  const bodyBlocks = convertBlocks(ctx, tree.children ?? []);
  for (const [key, note] of ctx.notes)
    note.blocks = convertBlocks(
      ctx,
      ctx.noteDefinitions.get(key)!.children ?? [],
    );
  if (
    blog &&
    !bodyBlocks.some((block) => block.kind === "heading" && block.level === 1)
  )
    bodyBlocks.unshift({
      kind: "heading",
      level: 1,
      id: allocateChapterId(ctx, `${chapterId}-title`),
      inlines: [{ kind: "text", text: title }],
    });
  const sections = validateAndIndexHeadings(bodyBlocks, title, source);
  for (let i = 0; i < bodyBlocks.length; i++) {
    if (
      bodyBlocks[i].kind === "paragraph" &&
      (i === 0 || ["heading", "thematicBreak"].includes(bodyBlocks[i - 1].kind))
    )
      bodyBlocks[i].classes = [...(bodyBlocks[i].classes ?? []), "no-indent"];
  }
  return {
    id: chapterId,
    title,
    language,
    direction: project.config.direction,
    writingMode: project.config.writingMode,
    source,
    href: `EPUB/text/${String(index + 1).padStart(4, "0")}-${chapterId}.xhtml`,
    blocks: bodyBlocks,
    sections,
    footnotes: [...ctx.notes.values()],
    ...(importedMetadata ? { chapterMetadata: importedMetadata } : {}),
  };
}
export { preflightBook } from "./preflight.js";
