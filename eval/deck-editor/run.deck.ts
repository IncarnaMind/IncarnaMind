/**
 * The slide editor bake-off over the pinned decks (README.md). The "a"
 * phase fetches the decks, chooses what to edit in each (./targets) and
 * makes arm A's copies through the same function the editor's edits go to
 * (applyShapeEdits): saved with no edit, with three text edits, and with
 * three shapes moved and sized. The "compare" phase measures every arm's
 * copies against their originals the same way (./compare).
 */
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vitest";
import { applyShapeEdits } from "../../src/core/exports/pptxPatch/edits";
import { fetchPinned } from "../pptx/pinned";
import { type CopyReport, compareCopy, type Kind } from "./compare";
import { DECKS } from "./corpus";
import { chooseTargets, type DeckTargets, editsOf } from "./targets";

const lane = process.env.INCARNAMIND_EVAL_CACHE ?? "";
const phase = process.env.DECK_EDITOR_PHASE ?? "a";
const decksDir = join(lane, "decks", "cache");
const outDir = join(lane, "out");
const KINDS = ["noedit", "text", "box"] as const;

async function produceArmA(): Promise<void> {
  await mkdir(decksDir, { recursive: true });
  await mkdir(join(outDir, "A"), { recursive: true });
  const allTargets: DeckTargets[] = [];
  for (const entry of DECKS) {
    const bytes = await fetchPinned(entry.url, entry.sha256, decksDir);
    const targets = await chooseTargets(entry.id, bytes, entry.has.includes("cjk"));
    allTargets.push(targets);
    const log: Record<string, { ms: number; error: string | null }> = {};
    for (const kind of KINDS) {
      const started = performance.now();
      try {
        const edits = kind === "noedit" ? [] : editsOf(targets, kind);
        const saved = await applyShapeEdits(bytes, edits);
        await writeFile(join(outDir, "A", `${entry.id}-${kind}.pptx`), saved);
        log[kind] = { ms: Math.round(performance.now() - started), error: null };
      } catch (error) {
        log[kind] = {
          ms: Math.round(performance.now() - started),
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
    await writeFile(join(outDir, "A", `${entry.id}.json`), JSON.stringify(log, null, 1));
    console.log(
      `A ${entry.id}: text ${targets.text.length}, box ${targets.box.length}`,
      JSON.stringify(log),
    );
  }
  await writeFile(join(outDir, "targets.json"), JSON.stringify(allTargets, null, 1));
}

async function compareArms(): Promise<void> {
  const targets = JSON.parse(readFileSync(join(outDir, "targets.json"), "utf8")) as DeckTargets[];
  const arms = (await readdir(outDir, { withFileTypes: true }))
    .filter((each) => each.isDirectory())
    .map((each) => each.name);
  for (const arm of arms) {
    const reports: Record<string, Partial<Record<Kind, CopyReport | { error: string }>>> = {};
    for (const entry of DECKS) {
      const deckTargets = targets.find((each) => each.id === entry.id);
      if (!deckTargets) continue;
      const original = await fetchPinned(entry.url, entry.sha256, decksDir);
      const deck: Partial<Record<Kind, CopyReport | { error: string }>> = {};
      for (const kind of [...KINDS, "rebuild" as const]) {
        const file = join(outDir, arm, `${entry.id}-${kind}.pptx`);
        if (kind === "rebuild" && !existsSync(file)) continue;
        if (!existsSync(file)) {
          const log = join(outDir, arm, `${entry.id}.json`);
          const reason = existsSync(log)
            ? (JSON.parse(readFileSync(log, "utf8")) as Record<string, { error: string | null }>)[
                kind
              ]?.error
            : null;
          deck[kind] = { error: reason ?? "no copy" };
          continue;
        }
        try {
          deck[kind] = await compareCopy(
            original,
            new Uint8Array(readFileSync(file)),
            kind,
            deckTargets,
            arm.endsWith("-ui") ? 3 : 1,
          );
        } catch (error) {
          deck[kind] = { error: error instanceof Error ? error.message : String(error) };
        }
      }
      reports[entry.id] = deck;
    }
    await writeFile(join(outDir, `compare-${arm}.json`), JSON.stringify(reports, null, 1));
    console.log(`compared arm ${arm}: ${Object.keys(reports).length} decks`);
  }
}

test("the slide editor bake-off", async () => {
  if (!lane) throw new Error("Set DECK_EDITOR_LANE to the folder for decks and copies.");
  if (phase === "a") await produceArmA();
  else await compareArms();
});
