import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface PackageManifest {
  exports?: Record<string, string>;
  [key: string]: unknown;
}

const root = fileURLToPath(new URL("../", import.meta.url));
// Compiled private-workspace packages resolve the same frozen dependencies as source.
for (const name of ["core", "cli"] as const) {
  const directory = path.join(root, "dist/packages", name);
  const target = path.join(directory, "node_modules");
  const manifest = JSON.parse(
    await fs.readFile(
      path.join(root, "packages", name, "package.json"),
      "utf8",
    ),
  ) as PackageManifest;
  if (manifest.exports) {
    for (const exportKey of Object.keys(manifest.exports)) {
      const targetPath = manifest.exports[exportKey];
      if (typeof targetPath === "string") {
        manifest.exports[exportKey] = targetPath.replace(/\.ts$/, ".js");
      }
    }
  }
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(directory, "package.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  if (name === "cli") {
    try {
      if ((await fs.lstat(target)).isSymbolicLink()) await fs.unlink(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const scope = path.join(target, "@quillbind");
    await fs.mkdir(scope, { recursive: true });
    try {
      await fs.symlink(
        path.relative(scope, path.join(root, "dist/packages/core")),
        path.join(scope, "core"),
        "dir",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    continue;
  }
  await fs.mkdir(directory, { recursive: true });
  try {
    await fs.symlink(
      path.relative(
        directory,
        path.join(root, "packages", name, "node_modules"),
      ),
      target,
      "dir",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}
