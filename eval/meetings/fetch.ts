/**
 * `npm run eval:meetings:fetch [-- <case id>...]` (eval/meetings/README.md): puts the meeting
 * audio set in the evaluation's cache (~/.cache/incarnamind-eval/meetings, or INCARNAMIND_EVAL_CACHE).
 *
 * - Every download is checked against the SHA-256 in sources.json, and every case built from them
 *   against the one in cases.json. Nothing that doesn't match is kept.
 * - A case already built and checked is left alone, and needs no network.
 * - `--pin` is for moving the pins: it keeps what it builds and writes the new hashes to
 *   cases.json and sources.json.
 *
 * Everything fetched is untrusted data: nothing here opens or runs it.
 */
import { readFile, writeFile } from "node:fs/promises";
import { ensureCases, loadSources } from "./build";
import { casesFile, meetingsCache, sourcesFile } from "./cache";

const args = process.argv.slice(2);
const pin = args.includes("--pin");
const ids = args.filter((arg) => !arg.startsWith("--"));

const sources = await loadSources();
const { cases, entries } = await ensureCases(
  { cache: meetingsCache(), fetchFn: fetch, log: (message) => console.log(message), sources },
  ids,
  { pin },
);

if (pin) {
  const file = JSON.parse(await readFile(casesFile, "utf8")) as { cases: { id: string }[] };
  file.cases = file.cases.map((c) => cases.find((built) => built.id === c.id) ?? c);
  await writeFile(casesFile, `${JSON.stringify(file, null, 2)}\n`);
  for (const measured of entries) {
    const entry = sources.alimeeting.entries.find((e) => e.name === measured.name);
    if (entry) Object.assign(entry, measured);
  }
  await writeFile(sourcesFile, `${JSON.stringify(sources, null, 2)}\n`);
  console.log("Pinned. Review the diff of cases.json and sources.json.");
}
const cells = new Map<string, number>();
for (const c of cases) {
  const key = `${c.language} ${c.setting}`;
  cells.set(key, (cells.get(key) ?? 0) + c.durationSeconds / 60);
}
console.log(
  `${cases.length} cases in ${meetingsCache()}: ${[...cells].map(([cell, minutes]) => `${cell} ${minutes.toFixed(1)} min`).join(", ")}`,
);
