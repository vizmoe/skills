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

async function loadBuiltInStyles(
  theme: BookProject["config"]["theme"],
): Promise<Resource[]> {
  const entries = [
    ["base.css", "base/epub.css"],
    ["theme.css", `themes/${theme}.css`],
    ["frontmatter.css", "base/frontmatter.css"],
  ] as const;
  return Promise.all(
    entries.map(async ([name, relative]) => ({
      id: name.replace(".", "-"),
      href: `EPUB/styles/${name}`,
      mediaType: "text/css",
      bytes: await fs.readFile(path.join(repoRoot, "styles", relative)),
    })),
  );
}

async function loadAuthorStyle(
  project: BookProject,
  source: string,
  index: number,
): Promise<Resource> {
  const bytes = await safeRead(project.root, source);
  const lint = lintCss(bytes.toString(), source);
  if (lint.status === "fail")
    fail("CSS_LINT", "Author stylesheet failed", lint.diagnostics);
  return {
    id: `author-style-${index}`,
    href: `EPUB/styles/author-${index}.css`,
    mediaType: "text/css",
    bytes,
    source,
  };
}

async function loadAuthorFont(
  project: BookProject,
  font: BookProject["config"]["fonts"][number],
  index: number,
): Promise<Resource[]> {
  const bytes = await safeRead(project.root, font.path);
  const isTtf = bytes.length >= 4 && bytes.readUInt32BE(0) === 0x00010000;
  const isOtf = bytes.subarray(0, 4).toString() === "OTTO";
  if (!isTtf && !isOtf)
    fail("FONT_TYPE", "Only OpenType/TrueType fonts are accepted");
  const ext = isTtf ? "ttf" : "otf";
  return [
    {
      id: `font-${index}`,
      href: `EPUB/fonts/font-${index}.${ext}`,
      bytes,
      mediaType: isTtf ? "font/ttf" : "font/otf",
      source: font.path,
    },
    {
      id: `font-css-${index}`,
      href: `EPUB/styles/font-${index}.css`,
      mediaType: "text/css",
      bytes: Buffer.from(
        `@font-face { font-family: '${font.family}'; src: url('../fonts/font-${index}.${ext}'); }\n`,
      ),
    },
  ];
}

async function loadPublicationImage(
  project: BookProject,
  source: string,
): Promise<Resource> {
  const bytes = await safeRead(project.root, source);
  const prepared = await prepareImage(
    bytes,
    source,
    project.config.build.optimizeImages,
  );
  const { mediaType, extension, processing } = prepared;
  const hash = processing.outputSha256;
  return {
    id: `img-${hash.slice(0, 16)}`,
    href: `EPUB/images/${hash}.${extension}`,
    bytes: prepared.bytes,
    mediaType,
    source,
    imageProcessing: [{ source, ...processing }],
    properties: project.config.cover?.path === source ? ["cover-image"] : [],
  };
}

async function collectSequential<T, U>(
  items: readonly T[],
  fn: (item: T, index: number) => Promise<U>,
): Promise<U[]> {
  const results: U[] = [];
  let chain = Promise.resolve();
  for (const [index, item] of items.entries()) {
    chain = chain.then(() =>
      fn(item, index).then((value) => {
        results.push(value);
      }),
    );
  }
  await chain;
  return results;
}

function deduplicateResources(resources: Resource[]): Resource[] {
  const unique: Resource[] = [];
  for (const resource of resources) {
    const existing = unique.find((r) => r.href === resource.href);
    if (!existing) {
      unique.push(resource);
      continue;
    }
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
  }
  return unique;
}

function buildSectionTree(sections: Section[], href: string): NavigationTree[] {
  return sections.map((s) => ({
    title: s.title,
    href: `${href}#${s.id}`,
    children: buildSectionTree(s.children, href),
  }));
}

function buildGroupedNavigation(
  entries: NavigationEntry[],
  documentNavigation: Map<string, NavigationTree>,
): NavigationTree[] {
  return entries.map((entry) => {
    if (typeof entry === "string") {
      const document = documentNavigation.get(entry);
      if (!document)
        fail("NAVIGATION_CHAPTERS", `Unknown navigation chapter: ${entry}`);
      return document;
    }
    const children = buildGroupedNavigation(entry.children, documentNavigation);
    return { title: entry.title, href: children[0].href, children };
  });
}

function buildNavigation(
  project: BookProject,
  documents: Document[],
): NavigationTree[] {
  const documentNavigation = new Map(
    documents.map((d) => [
      d.source,
      {
        title: d.title,
        href: d.href,
        children: buildSectionTree(d.sections[0]?.children ?? [], d.href),
      },
    ]),
  );
  return project.config.navigation
    ? buildGroupedNavigation(project.config.navigation, documentNavigation)
    : [...documentNavigation.values()];
}

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
  const builtInStyles = await loadBuiltInStyles(project.config.theme);
  const authorStyles = await collectSequential(
    project.config.styles,
    (source, i) => loadAuthorStyle(project, source, i),
  );
  const authorFonts = (
    await collectSequential(project.config.fonts, (font, i) =>
      loadAuthorFont(project, font, i),
    )
  ).flat();
  const imagePaths = imageSources(documents);
  if (project.config.cover) imagePaths.add(project.config.cover.path);
  const sortedImages = [...imagePaths].sort((a, b) => a.localeCompare(b, "en"));
  const imageResources = await collectSequential(sortedImages, (source) =>
    loadPublicationImage(project, source),
  );
  const unique = deduplicateResources([
    ...builtInStyles,
    ...authorStyles,
    ...authorFonts,
    ...imageResources,
  ]);
  const coverPath = project.config.cover?.path;
  return {
    metadata: lock.metadata,
    documents,
    resources: unique,
    theme: project.config.theme,
    pageProgression:
      project.config.pageProgression ??
      (project.config.writingMode === "vertical-rl"
        ? "rtl"
        : project.config.direction),
    navigation: buildNavigation(project, documents),
    citations: project.config.references,
    cover: coverPath
      ? unique.find(
          (r) => r.source === coverPath || r.sourceAliases?.includes(coverPath),
        )?.href
      : undefined,
  };
}
