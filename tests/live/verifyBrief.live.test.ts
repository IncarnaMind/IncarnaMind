/**
 * The brief of a verified document on a real model (#3277): twelve invented reports someone else
 * wrote (six English, six Chinese; eight PDFs and four Word files, tests/live/verifyBrief.cases.ts)
 * are verified through the core as the Verify command does, claims found and the brief written, and
 * each brief is kept in a folder (INCARNAMIND_LIVE_DIR) for blind readers. Runs only with
 * INCARNAMIND_LIVE_ANTHROPIC_KEY (Claude Haiku 5.5 by default), or, with
 * INCARNAMIND_LIVE_PROVIDER=deepseek, INCARNAMIND_LIVE_DEEPSEEK_KEY (DeepSeek V4.1 Flash,
 * deepseek-flash); INCARNAMIND_LIVE_RUNS briefs of each report (1). Bars, written 2026-11-17 before
 * any report was run:
 * Counted here, with no reading of words:
 * - a brief is written for 12 of 12 reports; a refused, failed or timed-out request makes the run void;
 * - at least 2 conclusions in 11 of 12 briefs, and at most 3 conclusions and 5 figures in all (the
 *   code's own limit, seen held);
 * - every conclusion is a short sentence: at least 90% of the lines within 25 words (English) or 50
 *   characters (Chinese), none beyond 40 words or 80 characters;
 * - every figure sentence holds a digit, in 95% of them or more, and no figure is named twice.
 * Read blind, by two fresh Sonnet readers and a third on what they disagree on, who see the report
 * and its brief and not this session's reading:
 * - a conclusion's line says what the report says: yes for at least 90% of the lines, and none that
 *   adds a claim the report doesn't make in more than 1 of the lines;
 * - a figure is one a conclusion or recommendation of the report rests on: at least 80%;
 * - the conclusions tell a reader who hasn't read the report its main conclusion: at least 10 of 12;
 * - every line is in the report's language: 12 of 12.
 * Spend: twelve reports, a few requests each, about CNY 0.1; no stop is set for it.
 * Result, DeepSeek V4.1 Flash (Claude Haiku 5.5 meant), 2026-11-17, the PDFs first drawn with lines
 * as long as a page and clipped (the claims ran two sentences together), then with wrapped lines:
 * - counted: a brief for 12 of 12, at least 2 conclusions in 12, at most 3 conclusions and 5 figures;
 *   34 of 34 conclusion lines short (none beyond the limit); 55 of 55 figures hold a digit, none twice;
 * - read blind (two Sonnet readers, a third on the three items they split on): 32 of 34 conclusion
 *   lines say what the report says (two "partly": a Chinese line that took a heading's word into
 *   it, and "demand" for meals served), none adds a claim; 51 of 55 figures are ones a conclusion
 *   rests on (the four that are not are context: cycle counts, bookings twice, the lamp count);
 *   the conclusions give the main conclusion in 10 of 12 (the two English reports that miss it leave
 *   out the recommendation); every line in the report's language, 12 of 12.
 * - seen: in a Chinese PDF a heading with no full stop runs into the sentence under it, so a figure
 *   line can begin with "主要发现"; the claims are found that way before the brief reads them.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { catalogProvider } from "../../src/core/providers/catalog/providers";
import { createAiSdkChatModel } from "../../src/core/providers/models";
import { briefOf } from "../../src/shared/verificationBrief";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { verifyWordFile } from "../helpers/verifiedWord";
import { BRIEF_CASES } from "./verifyBrief.cases";
import { pdfOf, wordOf } from "./verifyBrief.files";

const DEEPSEEK = process.env.INCARNAMIND_LIVE_PROVIDER === "deepseek";
const KEY = DEEPSEEK
  ? process.env.INCARNAMIND_LIVE_DEEPSEEK_KEY
  : process.env.INCARNAMIND_LIVE_ANTHROPIC_KEY;
const MODEL = DEEPSEEK
  ? (process.env.INCARNAMIND_LIVE_DEEPSEEK_MODEL ??
    (catalogProvider("deepseek")?.roles.quickTasks as string))
  : (process.env.INCARNAMIND_LIVE_ANTHROPIC_MODEL ??
    (catalogProvider("anthropic")?.roles.quickTasks as string));
const RUNS = Number(process.env.INCARNAMIND_LIVE_RUNS ?? "1") || 1;
const DIR = process.env.INCARNAMIND_LIVE_DIR;
const ONLY = process.env.INCARNAMIND_LIVE_ONLY?.split(",");

const words = (line: string) => line.trim().split(/\s+/).length;

describe("the brief of a verified document, live", () => {
  test.skipIf(KEY === undefined)(
    `${MODEL}: ${RUNS} brief(s) of each of ${BRIEF_CASES.length} reports`,
    { timeout: 3_600_000 },
    async () => {
      if (DIR) mkdirSync(DIR, { recursive: true });
      const lines: string[] = [];
      const stats = {
        briefs: 0,
        runs: 0,
        twoOrMore: 0,
        conclusions: 0,
        short: 0,
        veryLong: 0,
        figures: 0,
        digits: 0,
        duplicates: 0,
        mostConclusions: 0,
        mostFigures: 0,
      };
      for (const each of BRIEF_CASES.filter((one) => !ONLY || ONLY.includes(one.id))) {
        for (let run = 0; run < RUNS; run++) {
          const core = startCore(await createTempDataFolder(), {
            createChatModel: createAiSdkChatModel,
          });
          core.on(
            "consent.requested",
            (asked) => void core.respondToConsent(asked.requestId, true),
          );
          await core.saveChatProvider({
            kind: DEEPSEEK ? "deepseek" : "anthropic",
            apiKey: KEY ?? "",
            modelId: MODEL,
          });
          const sources = await createTempDataFolder();
          await addAndProcess(core, [
            await writeSourceFile(
              sources,
              "Reference.md",
              "# Reference\n\nA short reference note.\n",
            ),
          ]);
          const name = `${each.title}.${each.format === "pdf" ? "pdf" : "docx"}`;
          const path = join(sources, name);
          await writeFile(path, each.format === "pdf" ? pdfOf(each) : wordOf(each));
          stats.runs++;
          const verified = await verifyWordFile(core, path);
          const found = await core.findClaims({
            requestId: crypto.randomUUID(),
            mindId: verified.mind.id,
          });
          await verified.client.settled();
          const brief = briefOf(verified.client.doc);
          const long = (line: string) =>
            each.language === "English" ? words(line) : [...line].length;
          const limits =
            each.language === "English" ? { short: 25, most: 40 } : { short: 50, most: 80 };
          lines.push(
            `${each.id} (${each.format}): found ${JSON.stringify(found)}, brief ${
              brief
                ? `${brief.conclusions.length} conclusions, ${brief.figures.length} figures`
                : "none"
            }`,
          );
          if (brief) {
            stats.briefs++;
            if (brief.conclusions.length >= 2) stats.twoOrMore++;
            stats.mostConclusions = Math.max(stats.mostConclusions, brief.conclusions.length);
            stats.mostFigures = Math.max(stats.mostFigures, brief.figures.length);
            for (const conclusion of brief.conclusions) {
              stats.conclusions++;
              if (long(conclusion.line) <= limits.short) stats.short++;
              if (long(conclusion.line) > limits.most) stats.veryLong++;
              lines.push(`  conclusion: ${conclusion.line}`);
            }
            const seen = new Set<string>();
            for (const figure of brief.figures) {
              stats.figures++;
              if (/\d/.test(figure.text)) stats.digits++;
              const key = `${figure.blockId}|${figure.text}|${figure.occurrence ?? 0}`;
              if (seen.has(key)) stats.duplicates++;
              seen.add(key);
              lines.push(`  figure: ${figure.text}`);
            }
          }
          if (DIR) {
            writeFileSync(
              join(DIR, `${each.id}-${run + 1}.json`),
              JSON.stringify(
                {
                  id: each.id,
                  language: each.language,
                  format: each.format,
                  report: [each.title, ...each.sections.flatMap((s) => [s.heading, ...s.lines])],
                  conclusions:
                    brief?.conclusions.map((c) => ({ line: c.line, restsOn: c.at.text })) ?? [],
                  figures: brief?.figures.map((f) => f.text) ?? [],
                },
                null,
                2,
              ),
            );
          }
          core.close();
        }
      }
      lines.push(
        `briefs ${stats.briefs} of ${stats.runs}; at least 2 conclusions ${stats.twoOrMore}; most conclusions ${stats.mostConclusions}, most figures ${stats.mostFigures}; short ${stats.short} of ${stats.conclusions}, beyond the limit ${stats.veryLong}; figures with a digit ${stats.digits} of ${stats.figures}, named twice ${stats.duplicates}`,
      );
      console.log(lines.join("\n"));
      if (DIR) appendFileSync(join(DIR, "run.txt"), `${lines.join("\n")}\n`);
      expect(stats.runs).toBeGreaterThan(0);
    },
  );
});
