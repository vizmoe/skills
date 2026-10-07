import fs from "node:fs/promises";
import path from "node:path";
import { stringify } from "yaml";
import { randomUUID } from "node:crypto";
import { json } from "./json.js";
import { fail } from "./errors.js";
import { exists, safeRead, readSourceFile } from "./files.js";
import { safeName } from "./paths.js";
import { sha256 } from "./hash.js";
import { bookSchema, parseYaml } from "./config.js";
import { preflightBook } from "./preflight.js";
import { resolveMetadata } from "./metadata.js";
import { imageSources } from "./source-files.js";

export async function prepareBook(
  directory: string,
  sourceDirectory: string,
  configFile: string,
) {
  const source = await fs.realpath(sourceDirectory);
  if (!(await fs.stat(source)).isDirectory())
    fail(
      "UNSUPPORTED_FORMAT",
      "--from requires a local Markdown source directory",
    );
  const parsed = bookSchema.safeParse(
    parseYaml((await readSourceFile(configFile)).toString("utf8")),
  );
  if (!parsed.success)
    fail(
      "CONFIG_INVALID",
      parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("\n"),
    );
  const config = parsed.data;
  if (new Set(config.chapters).size !== config.chapters.length)
    fail("DUPLICATE_CHAPTER", "A chapter occurs more than once in book.yaml");
  const configText = stringify(config);
  const preflight = await preflightBook({ root: source, config, configText });
  if (preflight.status === "fail")
    fail(
      "PREFLIGHT_FAILED",
      "Source preparation failed; correct the listed chapter or cover issues before importing",
      preflight.diagnostics,
    );
  const files = new Set([
    ...config.chapters,
    ...imageSources(preflight.documents),
    ...config.styles,
    ...config.fonts.map((font) => font.path),
    ...(config.cover ? [config.cover.path] : []),
  ]);
  for (const file of files) {
    safeName(file);
    if (
      file === "book.yaml" ||
      /^(?:metadata|dist|\.git|\.cache|node_modules)(?:\/|$)/.test(file)
    )
      fail(
        "PREPARATION_PATH",
        `Source path conflicts with project state: ${file}`,
      );
  }
  const root = path.resolve(directory);
  if (await exists(root))
    fail("OUTPUT_EXISTS", "Prepared book requires a new output directory");
  let ancestor = path.dirname(root);
  while (!(await exists(ancestor))) ancestor = path.dirname(ancestor);
  const destination = path.join(
    await fs.realpath(ancestor),
    path.relative(ancestor, root),
  );
  if (destination === source || destination.startsWith(source + path.sep))
    fail(
      "PREPARATION_PATH",
      "Prepared book must be outside the source directory",
    );
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const parent = path.dirname(destination);
  const staging = await fs.mkdtemp(path.join(parent, ".quillbind-prepare-"));
  const copied: { path: string; size: number; sha256: string }[] = [];
  try {
    await fs.writeFile(path.join(staging, "book.yaml"), configText, {
      flag: "wx",
    });
    for (const relative of [...files].sort()) {
      const bytes = await safeRead(source, relative);
      const target = path.join(staging, relative);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, bytes, { flag: "wx" });
      copied.push({
        path: relative,
        size: bytes.length,
        sha256: sha256(bytes),
      });
    }
    const metadata = await resolveMetadata(staging);
    const preparation = {
      schemaVersion: 1,
      status: "initialized" as const,
      root: destination,
      config: path.join(destination, "book.yaml"),
      sourceRoot: source,
      chapters: config.chapters,
      copiedFiles: copied,
      readiness: {
        metadata: metadata.status,
        preflight: preflight.status,
        release: "not-run",
      },
      diagnostics: [...metadata.diagnostics, ...preflight.diagnostics],
      nextCommands:
        metadata.status === "pass"
          ? [["quillbind", "build", destination, "--json"]]
          : [["quillbind", "metadata", "resolve", destination, "--json"]],
    };
    await json(path.join(staging, "metadata/preparation.json"), preparation);
    // mkdir reserves the destination; a competing initializer cannot be overwritten.
    await fs.mkdir(destination);
    try {
      await fs.rename(staging, destination);
    } catch (error) {
      await fs.rmdir(destination);
      throw error;
    }
    return preparation;
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

export async function initBook(
  directory: string,
  options: { theme?: "literature" | "technical" } = {},
) {
  const root = path.resolve(directory);
  if (await exists(root)) {
    const files = await fs.readdir(root);
    if (files.length)
      fail(
        "DIRECTORY_NOT_EMPTY",
        "Book initialization requires an empty directory",
      );
  }
  for (const relative of [
    "chapters",
    "assets/images",
    "assets/fonts",
    "references",
    "styles",
    "metadata",
    "dist",
  ])
    await fs.mkdir(path.join(root, relative), { recursive: true });
  const config = {
    schemaVersion: 1,
    book: {
      title: "",
      authors: [],
      description: "",
      language: "",
      publication: { isbn: null },
      tags: [],
    },
    theme: options.theme ?? "literature",
    chapters: ["chapters/01-introduction.md"],
    build: {
      epoch: 946684800,
      stripImageMetadata: false,
      optimizeImages: true,
    },
  };
  await fs.writeFile(path.join(root, "book.yaml"), stringify(config), {
    flag: "wx",
  });
  await fs.writeFile(
    path.join(root, "chapters/01-introduction.md"),
    "---\nid: introduction\ntitle: Introduction\nlang: en\n---\n\n# Introduction\n\nWrite the chapter here.\n",
    { flag: "wx" },
  );
  await json(path.join(root, "metadata/identity.json"), {
    uuid: `urn:uuid:${randomUUID()}`,
  });
  await json(path.join(root, "metadata/decisions.json"), { fields: {} });
  return {
    status: "initialized",
    root,
    metadata:
      "Fill title, authors, description, language and controlled tags in book.yaml before building.",
    config: path.join(root, "book.yaml"),
    readiness: {
      metadata: "incomplete",
      sourceContent: "placeholder",
      release: "not-run",
    },
    requiredFields: [
      "book.title",
      "book.authors",
      "book.description",
      "book.language",
      "book.tags",
    ],
    nextCommands: [
      ["quillbind", "metadata", "resolve", root, "--json"],
      ["quillbind", "preflight", root, "--json"],
    ],
  };
}
