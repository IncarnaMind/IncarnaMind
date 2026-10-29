import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const root = fileURLToPath(new URL("../..", import.meta.url));
const SOURCE = /\.(?:[cm]?[jt]sx?)$/;

function sources(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) return sources(path);
    return SOURCE.test(entry.name) ? [path] : [];
  });
}

const files = sources(join(root, "src")).map((path) => ({
  path: relative(root, path),
  text: readFileSync(path, "utf8"),
}));

/** Every loader made with engineModule (src/core/engineModules.ts): its name, and the package it loads. */
const loaders = files.flatMap(({ path, text }) =>
  [...text.matchAll(/export const (\w+) = engineModule\(\s*"([^"]+)"/g)].map(
    ([, name, module]) => ({ path, name: name as string, module: module as string }),
  ),
);
const packageOf = (module: string) =>
  module
    .split("/")
    .slice(0, module.startsWith("@") ? 2 : 1)
    .join("/");
const packages = [...new Set(loaders.map(({ module }) => packageOf(module)))];

/** What the engine check loads: each engine process's list, and the main process's modules. */
const checked = new Set(
  files.flatMap(({ path, text }) => {
    const lists = [...text.matchAll(/answerEngineCheck\(\w+, \[([^\]]*)\]\)/g)].map(
      ([, list]) => list as string,
    );
    const main = path === join("src", "main", "engineCheck.ts") ? [text] : [];
    return [...lists, ...main].flatMap((list) => list.match(/\b[A-Z][A-Z0-9_]+\b/g) ?? []);
  }),
);

// The engine processes' lists are written by hand (#1239): a loader an engine starts to use must
// also be in its process's list, and in the packaged spec's expected modules.
test("the engine check loads every engine module's loader", () => {
  expect(loaders.map(({ name }) => name).sort()).toEqual(
    ["CANVAS", "ONNX_RUNTIME", "SANDBOX_RUNTIME", "SHERPA", "SHERPA_ADDON", "TOKENIZERS"].sort(),
  );
  expect(loaders.filter(({ name }) => !checked.has(name)).map(({ name }) => name)).toEqual([]);
  const spec = readFileSync(join(root, "e2e", "packaged", "engines.packaged.ts"), "utf8");
  expect(
    loaders.filter(({ module }) => !spec.includes(`: ${module}"`)).map(({ module }) => module),
  ).toEqual([]);
});

/** Where a loader made with engineModule imports its package: `engineModule("…", async () => exportsOf(await `. */
const IN_A_LOADER =
  /engineModule\(\s*"[^"]+",\s*(?:async\s*)?(?:\(\)\s*)?(?:=>\s*)?(?:exportsOf\(\s*)?(?:await\s*)?$/;

test("an engine package is loaded only through its loader", () => {
  const raw = files.flatMap(({ path, text }) =>
    packages.flatMap((name) => {
      const quoted = `"${name}(?:/[^"]*)?"`;
      const dynamic = new RegExp(`(?:await|=>)\\s*import\\(\\s*${quoted}\\s*\\)`, "g");
      const staticValue = new RegExp(`^import\\s+(?!type\\b)[^;]*?from\\s+${quoted}`, "gm");
      return [...text.matchAll(dynamic), ...text.matchAll(staticValue)]
        .filter((found) => {
          const lead = found[0].slice(0, found[0].indexOf("import"));
          return !IN_A_LOADER.test(text.slice(Math.max(0, found.index - 150), found.index) + lead);
        })
        .map((found) => `${path}: ${found[0]}`);
    }),
  );
  expect(raw).toEqual([]);
});
