import fs from "node:fs/promises";
import path from "node:path";
import { prepareImage } from "./images.js";
import { safeRead } from "./files.js";
import { fail } from "./errors.js";
import { repoRoot } from "./runtime.js";
import { lockedMetadata, type MetadataLock } from "./metadata.js";
import { preflightBook } from "./preflight.js";
import { imageSources } from "./source-files.js";
import { lintCss } from "./css.js";
import type { BookProject, NavigationEntry } from "./config.js";
import type {
  Publication,
  Document,
  Resource,
  NavigationTree,
  Section,
} from "./model.js";

export async function publicationFromBook(
  project: BookProject,
  prepared?: { lock: MetadataLock; documents: Document[] },
): Promise<Publication> {
  const lock = prepared?.lock ?? (await lockedMetadata(project));
  let documents = prepared?.documents;
  if (!documents) {
    const preflight = await preflightBook(project);
    if (preflight.status === "fail")
      fail("PREFLIGHT_FAILED", "Book preflight failed", preflight.diagnostics);
    documents = preflight.documents;
  }
  const resources: Resource[] = [];
  for (const [name, relative] of [
    ["base.css", "base/epub.css"],
    ["theme.css", `themes/${project.config.theme}.css`],
    ["frontmatter.css", "base/frontmatter.css"],
  ]) {
    const bytes = await fs.readFile(path.join(repoRoot, "styles", relative));
    resources.push({
      id: name.replace(".", "-"),
      href: `EPUB/styles/${name}`,
      mediaType: "text/css",
      bytes,
    });
  }
  for (const [i, source] of project.config.styles.entries()) {
    const bytes = await safeRead(project.root, source);
    const lint = lintCss(bytes.toString(), source);
    if (lint.status === "fail")
      fail("CSS_LINT", "Author stylesheet failed", lint.diagnostics);
    resources.push({
      id: `author-style-${i}`,
      href: `EPUB/styles/author-${i}.css`,
      mediaType: "text/css",
      bytes,
      source,
    });
  }
  for (const [i, font] of project.config.fonts.entries()) {
    const bytes = await safeRead(project.root, font.path);
    const isTtf = bytes.length >= 4 && bytes.readUInt32BE(0) === 0x00010000;
    const isOtf = bytes.subarray(0, 4).toString() === "OTTO";
    if (!isTtf && !isOtf)
      fail("FONT_TYPE", "Only OpenType/TrueType fonts are accepted");
    resources.push({
      id: `font-${i}`,
      href: `EPUB/fonts/font-${i}.${isTtf ? "ttf" : "otf"}`,
      bytes,
      mediaType: isTtf ? "font/ttf" : "font/otf",
      source: font.path,
    });
    resources.push({
      id: `font-css-${i}`,
      href: `EPUB/styles/font-${i}.css`,
      mediaType: "text/css",
      bytes: Buffer.from(
        `@font-face { font-family: '${font.family}'; src: url('../fonts/font-${i}.${isTtf ? "ttf" : "otf"}'); }\n`,
      ),
    });
  }
  const imagePaths = imageSources(documents);
  if (project.config.cover) imagePaths.add(project.config.cover.path);
  for (const source of [...imagePaths].sort()) {
    const bytes = await safeRead(project.root, source);
    const prepared = await prepareImage(
      bytes,
      source,
      project.config.build.optimizeImages,
    );
    const { mediaType, extension, processing } = prepared;
    const hash = processing.outputSha256;
    resources.push({
      id: `img-${hash.slice(0, 16)}`,
      href: `EPUB/images/${hash}.${extension}`,
      bytes: prepared.bytes,
      mediaType,
      source,
      imageProcessing: [{ source, ...processing }],
      properties: project.config.cover?.path === source ? ["cover-image"] : [],
    });
  }
  const unique: Resource[] = [];
  for (const resource of resources) {
    const existing = unique.find((r) => r.href === resource.href);
    if (existing) {
      if (resource.imageProcessing)
        existing.imageProcessing = [
          ...(existing.imageProcessing ?? []),
          ...resource.imageProcessing,
        ];
      if (resource.source)
        existing.sourceAliases = [
          ...(existing.sourceAliases ?? []),
          resource.source,
        ];
      existing.properties = [
        ...new Set([
          ...(existing.properties ?? []),
          ...(resource.properties ?? []),
        ]),
      ];
    } else unique.push(resource);
  }
  const tree = (sections: Section[], href: string): NavigationTree[] =>
    sections.map((s) => ({
      title: s.title,
      href: `${href}#${s.id}`,
      children: tree(s.children, href),
    }));
  const documentNavigation = new Map(
    documents.map((d) => [
      d.source,
      {
        title: d.title,
        href: d.href,
        children: tree(d.sections[0]?.children ?? [], d.href),
      },
    ]),
  );
  const groupedNavigation = (entries: NavigationEntry[]): NavigationTree[] =>
    entries.map((entry) => {
      if (typeof entry === "string") {
        const document = documentNavigation.get(entry);
        if (!document)
          fail("NAVIGATION_CHAPTERS", `Unknown navigation chapter: ${entry}`);
        return document;
      }
      const children = groupedNavigation(entry.children);
      return { title: entry.title, href: children[0].href, children };
    });
  return {
    metadata: lock.metadata,
    documents: documents,
    resources: unique,
    theme: project.config.theme,
    pageProgression:
      project.config.pageProgression ??
      (project.config.writingMode === "vertical-rl"
        ? "rtl"
        : project.config.direction),
    navigation: project.config.navigation
      ? groupedNavigation(project.config.navigation)
      : [...documentNavigation.values()],
    citations: project.config.references,
    cover: project.config.cover
      ? unique.find(
          (r) =>
            r.source === project.config.cover?.path ||
            r.sourceAliases?.includes(project.config.cover?.path ?? ""),
        )?.href
      : undefined,
  };
}
