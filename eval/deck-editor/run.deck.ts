/**
 * The slide editor bake-off over the pinned decks (README.md). The "a"
 * phase fetches the decks, chooses what to edit in each (./targets) and
 * makes arm A's copies through the same function the editor's edits go to
 * (applyShapeEdits): saved with no edit, with three text edits, and with
 * three shapes moved and sized. The "compare" phase measures every arm's
 * copies against their originals the same way (./compare). The "person" phase
 * makes the ten files a person opens in PowerPoint and WPS (#149), each a deck
 * of its own edited through the core as the viewer edits one, one gesture at a
 * time, with CHECK.md saying what changed and what to send back.
 */
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vitest";
import { applyShapeEdits } from "../../src/core/exports/pptxPatch/edits";
import { createTempDataFolder, startCore } from "../../tests/helpers/core";
import { addAndProcess, createSourceFolder } from "../../tests/helpers/documents";
import { fetchPinned } from "../pptx/pinned";
import { type CopyReport, compareCopy, type Kind } from "./compare";
import { DECKS } from "./corpus";
import { chooseTargets, type DeckTargets, editsOf } from "./targets";

const workDir = process.env.INCARNAMIND_EVAL_CACHE ?? "";
const phase = process.env.DECK_EDITOR_PHASE ?? "a";
const decksDir = join(workDir, "decks", "cache");
const outDir = join(workDir, "out");
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

/** The decks a person opens, and what is done to each: words typed, or shapes moved and sized. */
const PERSON: readonly (readonly [string, "text" | "box", string])[] = [
  ["c84", "text", "English words typed into three text boxes"],
  ["c73", "text", "Chinese words typed into three text boxes"],
  ["c51", "text", "Chinese words typed into shapes PowerPoint stores twice"],
  ["z04", "text", "Chinese words typed, a deck saved by WPS"],
  ["z05", "text", "Chinese words typed into long paragraphs"],
  ["c32", "box", "shapes and a picture moved and sized"],
  ["c44", "box", "shapes moved and sized"],
  ["c22", "box", "shapes moved and sized"],
  ["c00", "box", "shapes moved and sized"],
  ["c71", "box", "pictures moved and sized"],
];

const said = (target: DeckTargets, kind: "text" | "box") =>
  kind === "text"
    ? target.text.map(
        (each) =>
          `slide ${each.slide}: “${target.cjk ? "（已核对）" : " (checked)"}” typed at the end of the first paragraph of shape ${each.shapeId}`,
      )
    : target.box.map(
        (each) =>
          `slide ${each.slide}: shape ${each.shapeId} moved 24 px right and 12 px down, and made a tenth wider`,
      );

async function personCheck(): Promise<void> {
  const into = join(workDir, "person-check");
  await mkdir(into, { recursive: true });
  const dataDir = await createTempDataFolder();
  const files = await createSourceFolder();
  const core = startCore(dataDir);
  const sections: string[] = [];
  const rows: string[] = [];
  try {
    for (const [index, [id, kind, what]] of PERSON.entries()) {
      const entry = DECKS.find((each) => each.id === id);
      if (!entry) throw new Error(`${id} isn't in the corpus.`);
      const bytes = await fetchPinned(entry.url, entry.sha256, decksDir);
      const targets = await chooseTargets(id, bytes, entry.has.includes("cjk"));
      const prefix = `${String(index + 1).padStart(2, "0")}-${id}`;
      const path = join(files, `${prefix}-edited.pptx`);
      await writeFile(path, bytes);
      const [document] = await addAndProcess(core, [path]);
      if (!document) throw new Error(`${id} wasn't added.`);
      let sittingId: string | null = null;
      for (const edit of editsOf(targets, kind)) {
        const result = await core.editDeck({
          documentId: document.id,
          sittingId,
          shown: document.contentHash,
          edits: [edit],
        });
        if (result.kind !== "saved") throw new Error(`${id} couldn't be written: ${result.why}`);
        sittingId = result.sittingId;
      }
      await writeFile(join(into, `${prefix}-original.pptx`), bytes);
      await writeFile(join(into, `${prefix}-edited.pptx`), readFileSync(path));
      sections.push(
        [
          `## ${prefix}: ${what}`,
          "",
          `- \`${prefix}-original.pptx\` is the deck as published.`,
          `- \`${prefix}-edited.pptx\` was edited by hand in IncarnaMind and saved over itself, one gesture at a time:`,
          ...said(targets, kind).map((line) => `  - ${line}`),
          "  - Everything else should look as it does in the original.",
        ].join("\n"),
      );
      rows.push(`| ${prefix}-edited.pptx | | | |`);
    }
  } finally {
    core.close();
  }
  const check = [
    "# Decks edited by hand: PowerPoint, WPS and an input method",
    "",
    "Ten public decks, each edited by hand in IncarnaMind and saved over itself, beside the deck as published. About 30 minutes.",
    "",
    "## 1. Opening the saved files",
    "",
    "Open each `-edited.pptx` in PowerPoint, and then in WPS. Note whether either offers to repair the file, and whether anything looks different from the original apart from what its section says changed.",
    "",
    ...sections.flatMap((section) => [section, ""]),
    "## 2. Typing through an input method, on macOS and on Windows",
    "",
    "In IncarnaMind, add a copy of `02-c73-original.pptx` from this folder and open it. Double-click a text box with Chinese words, put the caret in the middle of a word, and type a few words with the system's Chinese input method (Pinyin), picking candidates with the space bar and with the number keys. Then press Esc.",
    "",
    "- Do the words appear once, where the caret was, in the box's font and colour?",
    "- Does the box show nothing odd while the input method's candidate window is open?",
    "- Opened again in PowerPoint, does the file show the words?",
    "",
    "## What to send back",
    "",
    "| File | PowerPoint asks to repair? | WPS asks to repair? | Looks different, apart from the edit? |",
    "|---|---|---|---|",
    ...rows,
    "",
    "| Input method | Words once, where the caret was? | Anything odd while composing? | PowerPoint shows them? |",
    "|---|---|---|---|",
    "| macOS, Pinyin | | | |",
    "| Windows, Microsoft Pinyin | | | |",
    "",
  ].join("\n");
  await writeFile(join(into, "CHECK.md"), check);
}

test("the slide editor bake-off", async () => {
  if (!workDir) throw new Error("Set DECK_EDITOR_DIR to the folder for decks and copies.");
  if (phase === "a") await produceArmA();
  else if (phase === "person") await personCheck();
  else await compareArms();
});
