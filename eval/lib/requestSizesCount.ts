/**
 * The characters of the requests a paired record's presses would send (./requestSizes), totalled
 * by model and arm, the app's and the judge's apart (#2847). It prints totals and nothing else: no
 * case, no reply.
 *
 *   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./scripts/tsResolve.mjs eval/lib/requestSizesCount.ts <report.json>…
 */
import { readFileSync } from "node:fs";

interface Sized {
  model?: unknown;
  baseline?: { requestSizes?: { kind: string; chars: number }[] };
  candidate?: { requestSizes?: { kind: string; chars: number }[] };
}

const totals = new Map<string, { presses: number; requests: number; app: number; judge: number }>();
for (const path of process.argv.slice(2)) {
  const report = JSON.parse(readFileSync(path, "utf8")) as { rows?: Sized[] };
  for (const row of report.rows ?? []) {
    for (const arm of ["baseline", "candidate"] as const) {
      const sizes = row[arm]?.requestSizes;
      if (!sizes) continue;
      const key = `${String(row.model)} | ${arm}`;
      const total = totals.get(key) ?? { presses: 0, requests: 0, app: 0, judge: 0 };
      total.presses += 1;
      total.requests += sizes.length;
      for (const size of sizes) total[size.kind === "judge" ? "judge" : "app"] += size.chars;
      totals.set(key, total);
    }
  }
}
console.log("model | arm | presses | requests | app characters | judge characters");
for (const [key, total] of [...totals].sort(([a], [b]) => a.localeCompare(b))) {
  console.log(`${key} | ${total.presses} | ${total.requests} | ${total.app} | ${total.judge}`);
}
