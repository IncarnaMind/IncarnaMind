/**
 * The scale a calculated figure takes on a real model, in paired English and Chinese cases
 * (#2365): a scale above the rows in their own table (the control), a scale in another table, a
 * scale below the rows, and a scale in another currency than the rows. The wrong scale is never
 * recorded: each case is right, or refused where the scale can't be settled. It grades the first
 * recorded calculated figure of each Answer, and pairs one English and one Chinese case per kind
 * rather than a larger matrix; a number written without the calculate Tool isn't graded.
 *
 * INCARNAMIND_LIVE_SET=pairs runs it, with INCARNAMIND_LIVE_PROVIDER ("deepseek"),
 * INCARNAMIND_LIVE_KEY, INCARNAMIND_LIVE_MODEL ("deepseek-flash" by default), and optionally
 * INCARNAMIND_LIVE_MAX_USD, INCARNAMIND_LIVE_REPORT.
 */
import { appendFile } from "node:fs/promises";
import { describe, expect, onTestFinished, test } from "vitest";
import type { ChatProviderKind, Core } from "../../src/core";
import { answerEnded } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { billedModels } from "../helpers/liveBilling";
import { buildPdf } from "../helpers/pdf";

const RUNS = process.env.INCARNAMIND_LIVE_SET === "pairs";
const PROVIDER: ChatProviderKind =
  process.env.INCARNAMIND_LIVE_PROVIDER === "deepseek" ? "deepseek" : "anthropic";
const KEY = process.env.INCARNAMIND_LIVE_KEY;
const MODEL =
  process.env.INCARNAMIND_LIVE_MODEL ??
  (PROVIDER === "deepseek" ? "deepseek-flash" : "claude-haiku-5-5");
const MAX_USD = Number(process.env.INCARNAMIND_LIVE_MAX_USD ?? Number.POSITIVE_INFINITY);
const REPORT = process.env.INCARNAMIND_LIVE_REPORT;
const { createChatModel, spent, tokens } = billedModels(MODEL, PROVIDER);

interface Case {
  name: string;
  file: { name: string; contents: Uint8Array };
  question: string;
  /** Values a right answer records (the scale applied); [] when it may only refuse. */
  ok: readonly number[];
  /** A value a wrong scale records; never allowed. */
  wrong: readonly number[];
  /** The scale each input is read at when the figure is recorded. */
  inputScale: number;
  /** A refusal is a right answer too: the scale can't be settled where the rows are. */
  refuses: boolean;
}

const pdf = (name: string, lines: readonly string[], chinese = false) => ({
  name: `${name}.pdf`,
  contents: chinese ? buildPdf([{ chineseLines: lines }]) : buildPdf([{ lines }]),
});

const CASES: readonly Case[] = [
  {
    name: "EN control: (in thousands) above its own rows",
    file: pdf("Control", ["Revenue", "(in thousands)", "Revenue 1,234.5", "Costs 334.5"]),
    question: "How much is revenue minus costs?",
    ok: [900_000],
    wrong: [900],
    inputScale: 1000,
    refuses: false,
  },
  {
    name: "EN wrong table: Table 1's (in thousands) for Table 2",
    file: pdf("Wrong table", [
      "Table 1 Headcount (in thousands)",
      "Employees 1,200",
      "Table 2 Revenue",
      "Revenue 1,234.5",
      "Costs 334.5",
    ]),
    question: "How much is Table 2's revenue minus costs?",
    ok: [900],
    wrong: [900_000],
    inputScale: 1,
    refuses: true,
  },
  {
    name: "EN future scale: (in thousands) below the rows",
    file: pdf("Future scale", [
      "Table 2 Revenue",
      "Revenue 1,234.5",
      "Costs 334.5",
      "Table 1 Headcount (in thousands)",
      "Employees 1,200",
    ]),
    question: "How much is Table 2's revenue minus costs?",
    ok: [900],
    wrong: [900_000],
    inputScale: 1,
    refuses: true,
  },
  {
    name: "EN currency control: £m above $ rows",
    file: pdf("Currency", ["(in £m)", "Revenue $1,234.5", "Costs $334.5"]),
    question: "How much is revenue minus costs?",
    ok: [900],
    wrong: [900_000_000],
    inputScale: 1,
    refuses: true,
  },
  {
    name: "ZH control: 单位：千元 above its own rows",
    file: pdf("对照", ["表1 收入", "单位：千元", "收入 1,200", "成本 300"], true),
    question: "收入减去成本是多少？",
    ok: [900_000],
    wrong: [900],
    inputScale: 1000,
    refuses: false,
  },
  {
    name: "ZH wrong table: 表1's 单位：千元 for 表2",
    file: pdf(
      "错表",
      ["表1 员工人数（单位：千元）", "员工 1,200", "表2 收入", "收入 1,200", "成本 300"],
      true,
    ),
    question: "表2的收入减去成本是多少？",
    ok: [900],
    wrong: [900_000],
    inputScale: 1,
    refuses: true,
  },
  {
    name: "ZH future scale: 单位：千元 below the rows",
    file: pdf(
      "表后",
      ["表2 收入", "收入 1,200", "成本 300", "表1 员工人数（单位：千元）", "员工 1,200"],
      true,
    ),
    question: "表2的收入减去成本是多少？",
    ok: [900],
    wrong: [900_000],
    inputScale: 1,
    refuses: true,
  },
  {
    name: "ZH currency control: 万英镑 above 元 rows",
    file: pdf("币种", ["金额单位：万英镑", "收入（元） 1,200", "成本（元） 300"], true),
    question: "收入减去成本是多少？",
    ok: [900],
    wrong: [9_000_000],
    inputScale: 1,
    refuses: true,
  },
];

const near = (a: number | boolean | string | null | undefined, b: number): boolean =>
  typeof a === "number" && Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));

async function ask(core: Core, text: string, mindId: string) {
  const asked = await core.askInConversation({ text, mindId });
  if (!asked.asked) throw new Error(`The Question wasn't asked: ${JSON.stringify(asked)}`);
  const ended = await answerEnded(core, asked.answerId);
  if (ended.event !== "finished") throw new Error(`The Answer failed: ${JSON.stringify(ended)}`);
  const content = await core.getConversation(asked.conversation.id);
  const answer = content.messages.find((message) => message.id === asked.answerId);
  if (answer?.kind !== "answer") throw new Error("No Answer.");
  return answer;
}

describe.skipIf(!RUNS || KEY === undefined)(
  "figure scale pairs, live",
  { timeout: 300_000 },
  () => {
    test.each(CASES)("$name", async (each) => {
      const dataDir = await createTempDataFolder();
      const sources = await createTempDataFolder();
      const core = startCore(dataDir, { createChatModel });
      core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
      const saved = await core.saveChatProvider({ kind: PROVIDER, apiKey: KEY, modelId: MODEL });
      if (saved.service) await core.allowDataFlow("chat", saved.service.id);
      await addAndProcess(core, [
        await writeSourceFile(sources, each.file.name, each.file.contents),
      ]);
      const mind = await core.createMind({ title: "Notes" });
      const answer = await ask(core, each.question, mind.id);
      core.close();

      const figure = answer.figures[0] ?? null;
      const value = figure?.value ?? null;
      const refused = value === null;
      const right = each.ok.some((ok) => near(value, ok));
      const scales = figure?.inputs.map((input) => input.number.scale) ?? [];
      const inputsRight = figure === null || scales.every((scale) => scale === each.inputScale);
      const falseChecked = figure !== null && (!right || !inputsRight);

      const line = `- ${MODEL} | ${each.name} | ${refused ? "refused" : `value ${value}`} | right ${right} | inputs ${scales.join(",") || "n/a"} | false checked ${falseChecked}`;
      if (REPORT) onTestFinished(() => appendFile(REPORT, `${line}\n`));

      expect({
        name: each.name,
        refused,
        right,
        acceptable: right || (each.refuses && refused),
      }).toMatchObject({ acceptable: true });
      expect(falseChecked, line).toBe(false);
    });

    test("the run stays within its spend", () => {
      const used = tokens();
      if (REPORT)
        onTestFinished(() =>
          appendFile(
            REPORT,
            `- ${MODEL}: ${CASES.length} cases, ${used.requests} requests, ${used.input} in / ${used.output} out, spent $${spent().toFixed(4)}\n`,
          ),
        );
      expect(spent()).toBeLessThanOrEqual(MAX_USD);
    });
  },
);
