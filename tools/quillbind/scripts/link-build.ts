import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface PackageManifest {
  exports?: Record<string, string>;
  [key: string]: unknown;
}

const root = fileURLToPath(new URL("../", import.meta.url));

function rewriteExportsToJs(manifest: PackageManifest): void {
  if (!manifest.exports) return;
  for (const exportKey of Object.keys(manifest.exports)) {
    const targetPath = manifest.exports[exportKey];
    if (typeof targetPath === "string") {
      manifest.exports[exportKey] = targetPath.replace(/\.ts$/, ".js");
    }
  }
}

async function ensureDirSymlink(target: string, linkPath: string) {
  try {
    await fs.symlink(target, linkPath, "dir");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

async function removeIfSymlink(target: string) {
  try {
    if ((await fs.lstat(target)).isSymbolicLink()) await fs.unlink(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function linkPackage(name: "core" | "cli") {
  const directory = path.join(root, "dist/packages", name);
  const target = path.join(directory, "node_modules");
  const manifest = JSON.parse(
    await fs.readFile(
      path.join(root, "packages", name, "package.json"),
      "utf8",
    ),
  ) as PackageManifest;
  rewriteExportsToJs(manifest);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(directory, "package.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  if (name === "cli") {
    await removeIfSymlink(target);
    const scope = path.join(target, "@quillbind");
    await fs.mkdir(scope, { recursive: true });
    await ensureDirSymlink(
      path.relative(scope, path.join(root, "dist/packages/core")),
      path.join(scope, "core"),
    );
    return;
  }
  await ensureDirSymlink(
    path.relative(directory, path.join(root, "packages", name, "node_modules")),
    target,
  );
}

// Compiled private-workspace packages resolve the same frozen dependencies as source.
await linkPackage("core");
await linkPackage("cli");
