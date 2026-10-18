// Runs the spike twice, with a temporary home folder: the first run measures and probes, the
// second checks that nothing the first left in storage or files is there. Prints a summary.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

const here = fileURLToPath(new URL(".", import.meta.url));
const electron = createRequire(import.meta.url)("electron");
const home = mkdtempSync(join(tmpdir(), "pyspike-home-"));
const env = { ...process.env, HOME: home, USERPROFILE: home };
for (const run of [1, 2]) {
  const started = Date.now();
  const result = spawnSync(electron, [join(here, "main.cjs"), `--run=${run}`], { env, stdio: "inherit" });
  console.log(`run ${run}: exit ${result.status} in ${Date.now() - started} ms`);
}
// What the bundle adds, raw and as an installer's compression would roughly make it.
const dist = join(here, "dist");
const size = { files: {}, raw: 0, gzip: 0, brotli: 0 };
for (const file of readdirSync(dist)) {
  const bytes = readFileSync(join(dist, file));
  const gzip = gzipSync(bytes, { level: 9 }).length;
  const brotli = brotliCompressSync(bytes, {
    params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
  }).length;
  size.files[file] = { raw: bytes.length, gzip, brotli };
  size.raw += bytes.length;
  size.gzip += gzip;
  size.brotli += brotli;
}
writeFileSync(join(here, "results", "size.json"), JSON.stringify(size, null, 2));
console.log(JSON.stringify({ raw: size.raw, gzip: size.gzip, brotli: size.brotli }));
for (const run of [1, 2]) {
  console.log(readFileSync(join(here, "results", `${process.platform}-run${run}.json`), "utf8"));
}
