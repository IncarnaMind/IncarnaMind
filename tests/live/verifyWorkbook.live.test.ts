/**
 * A workbook someone else built, checked on a real model (#3278): four invented workbooks (two
 * English, two Chinese; tests/live/verifyWorkbook.cases.ts), each of eight rows with typed-in
 * numbers for two columns and a total row of formulas, are verified through the core as the Verify
 * command does (sheet chosen, claims found, claims checked) against a Document that says what a
 * row's numbers are, say another number for it, or says nothing of it. Each workbook's second
 * total is saved wrong. Runs only with INCARNAMIND_LIVE_ANTHROPIC_KEY (Claude Haiku 5.5 by
 * default), or, with INCARNAMIND_LIVE_PROVIDER=deepseek, INCARNAMIND_LIVE_DEEPSEEK_KEY (DeepSeek
 * V4.1 Flash). Bars, written 2026-11-18 before any workbook was run (the counts of rows were
 * mistaken in the first writing: the cases hold 9 differing, 15 matching and 8 no-source rows, and
 * the thresholds below are unchanged):
 * - every request succeeds: a workbook whose claims weren't all found and checked makes the run void;
 * - a row whose Document gives another number never reads supported: 0 of its 9 rows;
 * - at least 80% of the rows whose Document gives the same numbers read supported (of 15);
 * - at least 90% of the rows the Documents say nothing of don't read supported (of 8);
 * - the formulas are worked out again with no model: the wrong total is flagged in every workbook,
 *   and no other formula is.
 * Result, DeepSeek V4.1 Flash (Claude Haiku 5.5 meant), 2026-11-18, three draws of the four
 * workbooks: no run void; differing rows
 * read supported 0 of 27; matching rows read supported 45 of 45; rows with no source read supported
 * 0 of 24; the wrong total flagged 12 of 12, no other formula flagged. About a minute a draw.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { catalogProvider } from "../../src/core/providers/catalog/providers";
import { createAiSdkChatModel } from "../../src/core/providers/models";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { claimCheckShown } from "../../src/shared/claimChecks";
import { verificationOf } from "../../src/shared/verification";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { readMind } from "../helpers/minds";
import { sourceOf, WORKBOOK_CASES, workbookOf } from "./verifyWorkbook.cases";

const DEEPSEEK = process.env.INCARNAMIND_LIVE_PROVIDER === "deepseek";
const KEY = DEEPSEEK
  ? process.env.INCARNAMIND_LIVE_DEEPSEEK_KEY
  : process.env.INCARNAMIND_LIVE_ANTHROPIC_KEY;
const MODEL = DEEPSEEK
  ? (process.env.INCARNAMIND_LIVE_DEEPSEEK_MODEL ??
    (catalogProvider("deepseek")?.roles.quickTasks as string))
  : (process.env.INCARNAMIND_LIVE_ANTHROPIC_MODEL ??
    (catalogProvider("anthropic")?.roles.quickTasks as string));
const ONLY = process.env.INCARNAMIND_LIVE_ONLY?.split(",");

describe("a workbook someone else built, live", () => {
  test.skipIf(KEY === undefined)(
    `${MODEL}: ${WORKBOOK_CASES.length} workbooks`,
    { timeout: 3_600_000 },
    async () => {
      const lines: string[] = [];
      const tally = {
        workbooks: 0,
        void: 0,
        differsRows: 0,
        differsSupported: 0,
        matchRows: 0,
        matchSupported: 0,
        noneRows: 0,
        noneSupported: 0,
        flagged: 0,
        falseFlags: 0,
      };
      for (const each of WORKBOOK_CASES.filter((one) => !ONLY || ONLY.includes(one.id))) {
        const core = startCore(await createTempDataFolder(), {
          createChatModel: createAiSdkChatModel,
        });
        core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
        await core.saveChatProvider({
          kind: DEEPSEEK ? "deepseek" : "anthropic",
          apiKey: KEY ?? "",
          modelId: MODEL,
        });
        const sources = await createTempDataFolder();
        await addAndProcess(core, [
          await writeSourceFile(sources, each.source.name, sourceOf(each)),
        ]);
        const path = join(sources, each.file);
        await writeFile(path, workbookOf(each));
        tally.workbooks++;

        const made = await core.verifyDocument({ path, sheet: each.sheet });
        if (!made.ok) {
          tally.void++;
          lines.push(`${each.id}: not made, ${made.reason}`);
          core.close();
          continue;
        }
        const client = await connectToMind(core, made.mind.id);
        await client.settled();
        const found = await core.findClaims({
          requestId: crypto.randomUUID(),
          mindId: made.mind.id,
        });
        const checked = await core.verifyClaims({
          requestId: crypto.randomUUID(),
          mindId: made.mind.id,
        });
        await client.settled();
        const workbook = verificationOf(client.doc)?.workbook;
        const flagged = workbook?.differs.map((one) => one.cell) ?? [];
        const total = each.rows.length + 2;
        if (flagged.includes(`C${total}`)) tally.flagged++;
        tally.falseFlags += flagged.filter((cell) => cell !== `C${total}`).length;

        const versions = new Map(
          (await core.listDocuments()).map((one) => [one.id, one.contentHash]),
        );
        const states = new Map(
          claimSpans(readMind(client)).map((span) => [
            span.sentence.text,
            claimCheckShown(span.check, {
              footing: "not-yet-known",
              text: span.sentence.text,
              versions,
              folderId: null,
              scope: null,
            }).state,
          ]),
        );
        const ok =
          found.kind === "found" &&
          checked.kind === "checked" &&
          checked.checked === checked.claims &&
          checked.claims === each.rows.length;
        if (!ok) tally.void++;
        lines.push(
          `${each.id}: found ${JSON.stringify(found)}, checked ${JSON.stringify(checked)}, flagged ${flagged.join(",") || "none"}`,
        );
        for (const row of each.rows) {
          const state = states.get(row.label) ?? "missing";
          lines.push(`  ${row.kind} · ${row.label} (${row.values.join(", ")}): ${state}`);
          if (row.kind === "differs") {
            tally.differsRows++;
            if (state === "supported") tally.differsSupported++;
          } else if (row.kind === "match") {
            tally.matchRows++;
            if (state === "supported") tally.matchSupported++;
          } else {
            tally.noneRows++;
            if (state === "supported") tally.noneSupported++;
          }
        }
        core.close();
      }
      lines.push(
        `workbooks ${tally.workbooks}, void ${tally.void}; differing rows read supported ${tally.differsSupported} of ${tally.differsRows}; matching rows read supported ${tally.matchSupported} of ${tally.matchRows}; rows with no source read supported ${tally.noneSupported} of ${tally.noneRows}; wrong total flagged ${tally.flagged} of ${tally.workbooks}, other formulas flagged ${tally.falseFlags}`,
      );
      console.log(lines.join("\n"));
      expect(tally.workbooks).toBeGreaterThan(0);
    },
  );
});
