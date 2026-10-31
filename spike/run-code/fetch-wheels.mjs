// Downloads Pyodide wheels for the named packages and their dependencies into a folder, checked against the lock.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, copyFileSync, statSync } from "node:fs";
import { join } from "node:path";
const [pyodideDir, out, ...want] = process.argv.slice(2);
const lock = JSON.parse(readFileSync(join(pyodideDir, "pyodide-lock.json"), "utf8"));
const { version } = JSON.parse(readFileSync(join(pyodideDir, "package.json"), "utf8"));
for (const f of ["pyodide.mjs","pyodide.asm.mjs","pyodide.asm.wasm","python_stdlib.zip","pyodide-lock.json"]) copyFileSync(join(pyodideDir,f), join(out,f));
const seen = new Map();
const add = (n) => { if (seen.has(n)) return; const p = lock.packages[n]; seen.set(n, p); p.depends.forEach(add); };
want.forEach(add);
const rows = [];
for (const [name, p] of seen) {
  const file = join(out, p.file_name);
  if (!existsSync(file)) {
    const r = await fetch(`https://cdn.jsdelivr.net/pyodide/v${version}/full/${p.file_name}`);
    if (!r.ok) throw new Error(`${p.file_name}: ${r.status}`);
    writeFileSync(file, new Uint8Array(await r.arrayBuffer()));
  }
  const sha = createHash("sha256").update(readFileSync(file)).digest("hex");
  if (sha !== p.sha256) throw new Error(`${p.file_name} sha mismatch`);
  rows.push({ name, version: p.version, file: p.file_name, bytes: statSync(file).size });
}
writeFileSync(join(out, "wheels.json"), JSON.stringify(rows, null, 1));
for (const r of rows) console.log(r.name.padEnd(16), r.version.padEnd(12), (r.bytes/1e6).toFixed(2), "MB");
