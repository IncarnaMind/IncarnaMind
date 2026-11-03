/**
 * The request log on the scripted model: no key, no network and no cost, so
 * `npm run eval:repeats` reports each sentence's requests without a real
 * model. A check of a sentence's parts must log each request it makes against
 * that sentence, and say which part (#2256).
 */
import { expect, test } from "vitest";
import { setUpWithDocuments } from "../../tests/helpers/citations";
import { type ModelCall, scriptedModel } from "../../tests/helpers/models";
import { repeatChecks } from "./repeat";
import { watchRequests } from "./requests";

const SENTENCES = [
  "The salary is 65,000 per year, paid monthly in arrears.",
  "The salary is 61,500 per month.",
  "The Company pays 950 per month for the flat.",
  "At the end of employment the Employee may sell the work laptop to the Company for 450.",
  "The Employee is the landlord of the flat at 14 Mill Lane.",
  "Up to 5 unused holiday days must be carried over into the next year.",
  "The Company contributes 4 percent of salary to the pension and the Employee 6 percent.",
  "The bonus is 10 percent of salary.",
  "The notice period is 3 months after the probation period.",
  "The Employee works 35 hours a week.",
  "The Employee gets 25 days of holiday a year.",
  "The probation period is 6 months.",
  "The travel allowance is 200 per month.",
  "乙方月工资为人民币两万元。",
];

// A Passage for the parts to search, holding none of the sentences as the check's words do,
// so the log is read from the tag alone.
const HANDBOOK = {
  name: "Handbook.md",
  contents:
    "# Handbook\n\nSalary, bonus, holiday, notice, probation, pension, travel, rent and allowance are set out here. Ask the manager about these. 工资、奖金、假期、通知期、试用期、养老金和差旅都写在这里。\n",
};

const CHECKS = 20;

/** Two parts of a sentence: its first words, or in Chinese its first characters. */
function partsOf(sentence: string) {
  const words = sentence.split(" ");
  const cut =
    words.length > 1
      ? words.slice(0, Math.ceil(words.length / 2)).join(" ").length
      : Math.floor(sentence.length / 2);
  return [
    { kind: "fact", text: sentence.slice(0, cut).trim() },
    { kind: "fact", text: sentence.slice(cut).trim() },
  ];
}

const VERDICT = [
  "Verdict: contradicted",
  "Scope: none, same",
  "Topic: found",
  "Roles: none, same",
  "Calculation: none",
  "",
  "The handbook says something else.",
].join("\n");

test("the request log reports each sentence's requests on the scripted model", async () => {
  const received = { judgement: 0, evidence: 0 };
  const model = scriptedModel(
    (call: ModelCall) => {
      const sentence = /<sentence>\n([\s\S]*?)\n<\/sentence>/.exec(call.prompt)?.[1] ?? "";
      if (!call.results.some((result) => result.tool === "search_documents")) {
        // The Run's first turn names the sentence's parts, as a real model's does (#2174).
        if (SENTENCES.includes(sentence))
          return { text: `Parts: ${JSON.stringify(partsOf(sentence))}\nSearching.` };
        return { calls: [{ tool: "search_documents" as const, input: { query: sentence } }] };
      }
      return { text: VERDICT };
    },
    {
      generate: (call) => {
        if (call.system.startsWith("You sort the sentences"))
          return {
            text: JSON.stringify({
              sentences: JSON.parse(
                /\{"sentences":[\s\S]*\}/.exec(call.prompt)?.[0] ?? '{"sentences":[]}',
              ).sentences.map((each: { number: number; text: string }) => ({
                number: each.number,
                parts: partsOf(each.text),
              })),
            }),
          };
        if (call.system.startsWith("Compare a sentence")) {
          received.judgement++;
          return { text: "conflict" };
        }
        if (call.system.startsWith("You checked a sentence the User wrote against Passages"))
          received.evidence++;
        const shown = /<passage id="([^"]+)">\n([\s\S]*?)\n<\/passage>/.exec(call.prompt);
        const quote =
          shown?.[2]
            ?.split("\n")
            .find((line) => line.trim() !== "")
            ?.trim() ?? null;
        return {
          text: JSON.stringify(
            shown && quote
              ? { passage: shown[1], location: "§ Handbook", quote }
              : { passage: null },
          ),
        };
      },
    },
  );
  const watch = watchRequests(SENTENCES);
  const { core } = await setUpWithDocuments(model, [HANDBOOK], {
    createChatModel: watch.chatModels(() => model),
  });
  const provider = await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  const checked = { all: 0, judgement: 0, evidence: 0 };
  const perSentence = new Map<string, number>(SENTENCES.map((sentence) => [sentence, 0]));

  await repeatChecks(core, {
    mind: "Figure sentences",
    sentences: SENTENCES,
    repeats: CHECKS,
    model: { providerId: provider.id, modelId: "local-model" },
    onRepeat: (rows) => {
      const seen = watch.take();
      for (const row of rows) {
        const requests = seen.get(row.sentence) ?? [];
        checked.all += requests.length;
        checked.judgement += requests.filter(
          (each) => each.kind === "confirm" || each.kind === "strict",
        ).length;
        checked.evidence += requests.filter((each) => each.kind === "evidence").length;
        perSentence.set(row.sentence, (perSentence.get(row.sentence) ?? 0) + requests.length);
      }
      return true;
    },
  });

  console.log(
    `- ${checked.all} requests logged against their sentences; the scripted model received ${received.judgement} judgements and ${received.evidence} evidence requests`,
  );
  // Every judgement and evidence request the model received is its sentence's.
  expect(received.judgement).toBeGreaterThan(0);
  expect(received.evidence).toBeGreaterThan(0);
  expect(checked.judgement).toBe(received.judgement);
  expect(checked.evidence).toBe(received.evidence);
  for (const [sentence, requests] of perSentence) {
    expect(requests, sentence).toBeGreaterThan(0);
    console.log(`  ${requests} requests · ${sentence}`);
  }
  console.log(
    `- A sentence's check, on average: ${(checked.all / (CHECKS * SENTENCES.length)).toFixed(2)} requests`,
  );
});
