// Fetches Pyodide's core from npm and numpy, pandas and what they depend on from Pyodide's
// CDN, unmodified, each wheel checked against the sha256 in pyodide-lock.json, into ./dist.
// The app would ship these files as they are; the spike loads them from there, offline.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const VERSION = "314.0.7";
const here = fileURLToPath(new URL(".", import.meta.url));
const dist = join(here, "dist");
const CORE = ["pyodide.mjs", "pyodide.asm.mjs", "pyodide.asm.wasm", "python_stdlib.zip", "pyodide-lock.json"];
const PACKAGES = ["numpy", "pandas"];

async function download(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

await rm(dist, { recursive: true, force: true });
await mkdir(join(dist, "npm"), { recursive: true });
const tarball = join(dist, "npm", "pyodide.tgz");
await writeFile(tarball, await download(`https://registry.npmjs.org/pyodide/-/pyodide-${VERSION}.tgz`));
execFileSync("tar", ["-xzf", "pyodide.tgz"], { cwd: join(dist, "npm") });
for (const file of CORE) {
  await writeFile(join(dist, file), await readFile(join(dist, "npm", "package", file)));
}
await rm(join(dist, "npm"), { recursive: true, force: true });

const lock = JSON.parse(await readFile(join(dist, "pyodide-lock.json"), "utf8"));
const wanted = new Set();
const add = (name) => {
  if (wanted.has(name)) return;
  wanted.add(name);
  for (const dependency of lock.packages[name].depends) add(dependency);
};
for (const name of PACKAGES) add(name);
const packages = [];
for (const name of [...wanted].sort()) {
  const { file_name: file, sha256, version } = lock.packages[name];
  const bytes = await download(`https://cdn.jsdelivr.net/pyodide/v${VERSION}/full/${file}`);
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== sha256) throw new Error(`${file}: sha256 ${actual}, the lock says ${sha256}`);
  await writeFile(join(dist, file), bytes);
  packages.push({ name, version, file });
}
await writeFile(join(dist, "packages.json"), JSON.stringify({ version: VERSION, packages }, null, 2));
console.log(`Pyodide ${VERSION} and ${packages.map((each) => each.name).join(", ")} in ${dist}`);
