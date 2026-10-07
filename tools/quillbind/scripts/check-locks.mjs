import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";

const root = path.resolve(import.meta.dirname, "..");
const read = (file) => fs.readFile(path.join(root, file), "utf8");
const readJson = async (file) => JSON.parse(await read(file));
const tools = await readJson("standards/tools.lock.json");
const workspace = await readJson("package.json");
const core = await readJson("packages/core/package.json");
const cli = await readJson("packages/cli/package.json");
const dependencies = await readJson("standards/dependencies.lock.json");

assert.equal(
  (await read(".node-version")).trim(),
  tools.node,
  ".node-version drifted from tools lock",
);
assert.equal(workspace.engines.node, tools.node, "Node engine drifted");
assert.equal(
  workspace.packageManager,
  `pnpm@${tools.pnpm}`,
  "pnpm pin drifted",
);
assert.equal(
  workspace.devDependencies["@playwright/test"],
  tools.playwright,
  "Browser test version drifted",
);
assert.equal(
  core.dependencies["@playwright/test"],
  tools.playwright,
  "Browser runtime version drifted",
);
assert.equal(core.dependencies["@daisy/ace"], tools.ace, "Ace version drifted");

const docker = await read("Dockerfile.qa");
assert.equal(
  docker.match(/^FROM node:([^-]+)/m)?.[1],
  tools.node,
  "Node container pin drifted",
);
assert.equal(
  docker.match(/^FROM mcr\.microsoft\.com\/playwright:v([^-]+)/m)?.[1],
  tools.playwright,
  "Playwright container pin drifted",
);
assert.equal(
  docker.match(/npm install --global pnpm@([\d.]+)/)?.[1],
  tools.pnpm,
  "Container pnpm pin drifted",
);

for (const manifest of [workspace, core, cli]) {
  for (const [name, specifier] of Object.entries({
    ...manifest.dependencies,
    ...manifest.devDependencies,
  })) {
    if (specifier.startsWith("workspace:")) continue;
    const alias = /^npm:((?:@[^/]+\/)?[^@]+)@(.+)$/.exec(specifier);
    const actualName = alias?.[1] ?? name;
    const version = alias?.[2] ?? specifier;
    assert.match(
      version,
      /^\d+\.\d+\.\d+$/,
      `${name} must have an exact stable version`,
    );
    assert.ok(
      dependencies.packages.some(
        (entry) =>
          entry.name === actualName &&
          entry.version === version &&
          entry.integrity?.startsWith("sha512-"),
      ),
      `${actualName}@${version} missing from dependency integrity ledger`,
    );
  }
}

// Temporary compiler/API split; migration and removal criteria are in docs/development.md.
const compilerVersion = "7.0.2";
const lintApiVersion = "6.0.3";
const require = createRequire(import.meta.url);
for (const [alias, name, version] of [
  ["@typescript/native", "typescript", compilerVersion],
  ["typescript", "@typescript/typescript6", "6.0.2"],
]) {
  assert.equal(
    workspace.devDependencies[alias],
    `npm:${name}@${version}`,
    `${alias} TypeScript alias drifted; review the compiler/API transition`,
  );
  const installed = require(`${alias}/package.json`);
  assert.equal(installed.name, name, `${alias} resolves to the wrong package`);
  assert.equal(
    installed.version,
    version,
    `${alias} installed version drifted`,
  );
}
// The compatibility package re-exports a separately locked TypeScript 6 API.
assert.equal(
  require("typescript").version,
  lintApiVersion,
  "Lint TypeScript API version drifted",
);
const eslintRequire = createRequire(require.resolve("typescript-eslint"));
const estreeRequire = createRequire(
  eslintRequire.resolve("@typescript-eslint/typescript-estree"),
);
const projectServiceRequire = createRequire(
  estreeRequire.resolve("@typescript-eslint/project-service"),
);
assert.equal(
  projectServiceRequire.resolve("typescript"),
  require.resolve("typescript"),
  "ESLint projectService must resolve the pinned lint TypeScript API",
);
const compiler = await promisify(execFile)(
  path.join(root, "node_modules/.bin/tsc"),
  ["--version"],
  { encoding: "utf8", timeout: 10000 },
);
assert.equal(
  compiler.stdout.trim(),
  `Version ${compilerVersion}`,
  "tsc must resolve to the pinned native build compiler",
);
process.stdout.write(
  `Runtime, container and direct-dependency pins agree; tsc ${compilerVersion}, lint API ${lintApiVersion}.\n`,
);
