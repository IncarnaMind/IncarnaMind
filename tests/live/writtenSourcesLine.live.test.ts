/**
 * The issue's two requests (#2768) against a real model: a short summary written into the Note
 * during a meeting, in Chinese, and a summary of two named Documents with a section for each, in
 * English, beside a third Document "report" fits. Once the Note's text is cited, the line above
 * the Answer names its sources and its search counts them used; no "I read … · Use others" names
 * a Document the request didn't. Runs only with INCARNAMIND_LIVE_ANTHROPIC_KEY;
 * INCARNAMIND_LIVE_ANTHROPIC_MODEL picks the model, Claude Haiku 5.5 by default.
 *
 * Set INCARNAMIND_LIVE_REPORT to a file to keep what each run gave back.
 */
import { appendFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import type { ConversationAnswer, Core } from "../../src/core";
import { createAiSdkChatModel } from "../../src/core/providers/models";
import { foldedLine, stepRows } from "../../src/renderer/src/answerSteps";
import { foldedWords } from "../../src/renderer/src/answerStepWords";
import { translate } from "../../src/shared/i18n";
import { answerEnded, answerJudged } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, createSourceFolder, writeSourceFile } from "../helpers/documents";
import { transcribingCore, until } from "../helpers/transcription";

const API_KEY = process.env.INCARNAMIND_LIVE_ANTHROPIC_KEY;
const MODEL = process.env.INCARNAMIND_LIVE_ANTHROPIC_MODEL ?? "claude-haiku-5-5";

const FILLERS: [string, string][] = [
  ["Parking rota", "Spaces in the basement are given out monthly."],
  ["Travel claims", "Staff fill in a form before they travel."],
  ["Purchasing steps", "A head of department approves each purchase."],
  ["Appraisal guide", "Appraisals happen twice a year in four bands."],
  ["Client list", "Eastern clients: Hollin, Marrow and Sedge."],
  ["Office supplies", "Paper, pens, folders and staplers."],
  ["Staff handbook contents", "Attendance, leave, learning and leaving."],
  ["Induction plan", "New starters spend two days in induction."],
  ["Visitor log", "Visitors sign in at the front desk."],
  ["Fire drill", "The alarm is tested every Thursday at noon."],
];

const CASES = [
  {
    language: "zh-CN" as const,
    meeting: true,
    question: "在这个笔记里写一段海港云企业版价格和服务条款的简短摘要。",
    documents: [
      ["海港云 价格表", "企业版每席位每月 300 元。企业版开通实施费为 80000 元，签三年合同的免收。"],
      [
        "海港云 服务条款",
        "服务条款承诺企业版每月可用性 99.95%。客户数据存放在上海或北京的数据中心，由客户签约时选择。最短合同期 12 个月。",
      ],
      [
        "Harbourline price sheet",
        "The Enterprise plan costs $45 per seat per month. Implementation is $12,000.",
      ],
      [
        "Harbourline service terms",
        "Customer data is stored in Frankfurt or Oregon. Urgent tickets are answered within one hour.",
      ],
      ...FILLERS,
    ],
    named: [] as string[],
  },
  {
    language: "en" as const,
    meeting: false,
    question:
      "Write a detailed summary of the Field Report and the Quarterly Research Update into this note, with a section for each.",
    documents: [
      [
        "Field Report",
        "The spring survey of the northern estuary read twelve tide gauges. Each gauge was calibrated against the datum, and readings were taken every fifteen minutes. The figures are provisional.",
      ],
      [
        "Quarterly Research Update",
        "The tide model now covers the harbour mouth and the upper reach. The median rise is 4.1 mm a year at the harbour mouth and 2.7 mm a year in the upper reach.",
      ],
      [
        "Harlow Basin Annual Report 2022",
        "The basin authority met four times in 2022 and approved the field survey of its tide gauges.",
      ],
      ["Ferry Timetable Report", "Ferries leave the north pier every forty minutes."],
      ...FILLERS,
    ],
    named: ["Field Report", "Quarterly Research Update"],
  },
];

async function asked(core: Core, text: string, mindId: string): Promise<ConversationAnswer> {
  const result = await core.askInConversation({ text, mindId });
  if (!result.asked) throw new Error(`Not asked: ${JSON.stringify(result)}`);
  await answerEnded(core, result.answerId);
  return answerJudged(core, result.conversation.id, result.answerId);
}

describe.skipIf(API_KEY === undefined)(`The line above a cited write, live: ${MODEL}`, () => {
  test.each(CASES)(
    "$language: the line names the Note's sources",
    { timeout: 600_000 },
    async (each) => {
      const t = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) =>
        translate(each.language, key, params);
      const dataDir = await createTempDataFolder();
      const set = each.meeting
        ? await transcribingCore(dataDir, { createChatModel: createAiSdkChatModel })
        : { core: startCore(dataDir, { createChatModel: createAiSdkChatModel }), record: null };
      const { core } = set;
      core.on("consent.requested", (ask) => void core.respondToConsent(ask.requestId, true));
      await core.saveChatProvider({ kind: "anthropic", apiKey: API_KEY ?? "", modelId: MODEL });
      const folder = await createSourceFolder();
      const library = await addAndProcess(
        core,
        await Promise.all(
          each.documents.map(([name, text]) =>
            writeSourceFile(folder, `${name}.md`, `# ${name}\n\n${text}\n`),
          ),
        ),
        60_000,
      );
      let mindId: string;
      if (set.record) {
        const meeting = await core.createMeeting();
        await core.startMeeting({ meetingId: meeting.id });
        set.record(9_000, ["microphone"]);
        await until(core, meeting.id, (transcript) => transcript.lines >= 2);
        mindId = meeting.mindId;
      } else {
        mindId = (await core.createMind({ title: "Estuary" })).id;
      }

      const answer = await asked(core, each.question, mindId);

      const written = answer.toolCalls.flatMap((call) => call.mindChange?.citations ?? []);
      const steps = {
        answer,
        askedFrom: { mindId, name: "", deleted: false },
        meeting: answer.steps?.sent?.transcript === true,
      };
      const line = foldedLine(steps);
      const words = line
        ? foldedWords(t, line, {
            scope: () => t("steps.scope.all"),
            modelOf: (id) => id,
            documentOf: (document) => document.name,
          })
        : "";
      const search = stepRows(steps).find((row) => row.kind === "search");
      const nameOf = new Map(library.map((document) => [document.id, document.name]));
      const coverage = answer.steps?.coverage;
      const report = [
        `## ${MODEL} · ${each.language} (#2768)`,
        `- calls: ${answer.toolCalls.map((call) => `${call.tool}:${call.status}`).join(", ")}`,
        `- reply Citations ${answer.citations.length}; Note Citations ${written.length} from ${[...new Set(written.map((citation) => citation.documentName))].join(", ")}`,
        `- line: ${words}`,
        `- search: ${search?.kind === "search" ? t("steps.search.found", { found: search.found, used: search.used }) : "none"}`,
        `- coverage: ${coverage ? `${coverage.kind} ${coverage.used.map((used) => used.name).join(", ")}; rest ${coverage.rest.map((id) => nameOf.get(id)).join(", ")}` : "none"}`,
        `- spent: ${(await core.getCostSummary()).spent.map((money) => `${money.amount.toFixed(4)} ${money.currency}`).join(", ")}`,
      ];
      if (process.env.INCARNAMIND_LIVE_REPORT) {
        await appendFile(process.env.INCARNAMIND_LIVE_REPORT, `${report.join("\n")}\n\n`);
      }
      core.close();

      expect(written.length).toBeGreaterThan(0);
      expect(words).not.toBe(t("steps.sources.none"));
      expect(line?.kind === "read-passages" && line.citedAfterChecking === 0).toBe(false);
      expect(line && "sources" in line && line.sources).toBeGreaterThan(0);
      if (search?.kind === "search") expect(search.used).toBeGreaterThan(0);
      if (coverage?.kind === "named") {
        expect(each.named).toContain(coverage.used[0]?.name);
      }
    },
  );
});
