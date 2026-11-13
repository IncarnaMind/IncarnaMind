/**
 * A sentence that joins a cited fact to what it says is missing, on Documents too long to read
 * whole (#3019): it reads Not checked, and its line says the fact is supported and the rest wasn't
 * checked. Only the line changes: the stored result, and every other mix of parts, read as before.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import { GENERATED_MARK } from "../../src/core";
import { sentenceReasonText } from "../../src/renderer/src/cost";
import { claimsOf } from "../../src/renderer/src/editor/claimChecks";
import { translate } from "../../src/shared/i18n";
import { checkGenerate, checkReply, type Plan } from "../helpers/checks";
import { setUpWithDocuments } from "../helpers/citations";
import { readMind, writeMind } from "../helpers/minds";
import {
  type GenerateCall,
  type ModelCall,
  type ScriptedReply,
  scriptedModel,
} from "../helpers/models";
import { buildPdf } from "../helpers/pdf";

const TERM = "The landlord is Harbour Estates Ltd.";
const BREAK = "Either party may end this lease with 30 days' notice.";

/** A lease of 41 pages: past the 40 a whole read takes, so what a sentence says is missing goes unread. */
const LEASE = {
  name: "Lease.pdf",
  contents: buildPdf([
    { lines: ["Parties", TERM] },
    { lines: ["Break clause", BREAK] },
    ...Array.from({ length: 39 }, (_, index) => ({
      lines: [`Page ${index + 3}`, "Rent schedule"],
    })),
  ]),
};

const TERM_ZH = "出租人为港湾地产有限公司。";

/** The same lease in Chinese, its 41 sections each a Unit, as long for a whole read. */
const LEASE_ZH = {
  name: "租约.md",
  contents: [
    "# 租约",
    "## 当事人",
    TERM_ZH,
    ...Array.from({ length: 40 }, (_, index) => `## 第 ${index + 2} 节\n\n租金表。`),
  ].join("\n\n"),
};

const looks = (call: Pick<GenerateCall, "question">) =>
  call.question === "presence" || call.question === "strict-presence";

/** A first turn that names the sentence's parts, as the check asks before its first search. */
function withParts(
  call: ModelCall,
  reply: ScriptedReply,
  parts: readonly [string, string][],
): ScriptedReply {
  const first = !call.results.some((result) => result.tool === "search_documents");
  if (!first || !call.system.includes("Parts:")) return reply;
  const named = parts.map(([kind, text]) => ({ kind, text }));
  return { ...reply, text: `Parts: ${JSON.stringify(named)}` };
}

const LINES = {
  en: {
    line: "What the sentence says is missing wasn’t checked: that needs its Documents read whole. The rest of it is supported.",
    conclusion:
      "The assistant’s own conclusion wasn’t checked. The rest of the sentence is supported.",
    absenceOnly: "A sentence that says something is absent needs its Document read whole.",
  },
  zh: {
    line: "句中说没有的内容未核对：这需要通读文档。其余部分有依据。",
    conclusion: "助手自己的结论未核对。句子的其余部分有依据。",
    absenceOnly: "说某样东西不存在的句子，需要通读文档才能核对。",
  },
} as const;

const WORDS = {
  en: {
    term: "The landlord is Harbour Estates Ltd",
    absence: "the company never disclosed a second warehouse",
    join: ", and ",
    stop: ".",
    opinion: "so it is a safe deal",
    wrong: "the rent is paid weekly",
  },
  zh: {
    term: "出租人为港湾地产有限公司",
    absence: "公司从未披露第二个仓库",
    join: "，",
    stop: "。",
    opinion: "所以这是一笔稳妥的交易",
    wrong: "租金按周支付",
  },
} as const;

type Language = keyof typeof WORDS;

/** The sentence made of `parts`, each [kind, words, plan], checked in a Note, read as the card reads it. */
async function readInNote(
  language: Language,
  parts: [kind: "fact" | "opinion", words: string, plan: Plan][],
  { ai = false }: { ai?: boolean } = {},
) {
  const words = WORDS[language];
  const claim = `${parts.map(([, text]) => text).join(words.join)}${words.stop}`;
  // A sentence of one part is checked as the sentence, its stop included.
  const [only] = parts.length === 1 ? parts : [];
  const plans = Object.fromEntries([
    ...parts.map(([, text, plan]) => [text, plan]),
    ...(only ? [[claim, only[2]]] : []),
  ]);
  const model = scriptedModel(
    (call) =>
      withParts(
        call,
        checkReply(call, plans),
        parts.map(([kind, text]) => [kind, text]),
      ),
    {
      generate: (call) => (looks(call) ? { text: "Judgement: there" } : checkGenerate(plans)(call)),
    },
  );
  const { core, client, mind } = await setUpWithDocuments(model, [
    language === "zh" ? LEASE_ZH : LEASE,
  ]);
  if (language === "zh") await core.updateSettings({ user: { language: "zh-CN" } });
  writeMind(client, [
    {
      type: "paragraph",
      attrs: { id: "one" },
      content: [{ type: "text", text: claim, ...(ai && { marks: [{ type: GENERATED_MARK }] }) }],
    },
  ]);
  await client.settled();
  await core.checkSentences({
    requestId: randomUUID(),
    mindId: mind.id,
    action: "check-against-documents",
    from: { blockId: "one", offset: 0 },
    to: { blockId: "one", offset: claim.length },
  });
  await client.settled();
  const [claimed] = claimsOf(readMind(client), {
    footing: "not-yet-known",
    versions: null,
    folderId: null,
    scope: null,
  }).claims;
  if (!claimed) throw new Error("The sentence wasn't checked.");
  const lang = language === "zh" ? "zh-CN" : "en";
  const line =
    claimed.shown.state === "not-checked"
      ? sentenceReasonText(
          (key, params) => translate(lang, key, params),
          lang,
          claimed.shown,
          claimed.reads,
        )
      : null;
  return { shown: claimed.shown, stored: [claimed.check.state, claimed.check.reason], line };
}

const fact = (language: Language): [kind: "fact", words: string, plan: Plan] => [
  "fact",
  WORDS[language].term,
  { verdict: "supported", quote: language === "zh" ? TERM_ZH : TERM, judgement: "same" },
];
const absent = (language: Language): [kind: "fact", words: string, plan: Plan] => [
  "fact",
  WORDS[language].absence,
  { verdict: "unsupported", absence: true },
];

describe("A cited fact joined to what the sentence says is missing", { timeout: 30_000 }, () => {
  // protects=a sentence whose cited fact is Supported and whose only other part says something is missing that the Documents are too long to read whole reads Not checked, its stored result as before, and its line says the fact is supported and the rest wasn't checked, in English and Chinese, for the User's sentence and the assistant's alike; fails_when=it shows today's line about absence alone, or its stored result or verdict changes; no_claim=reading a long Document whole.
  test.each([
    ["en", false],
    ["zh", false],
    ["en", true],
    ["zh", true],
  ] as const)("%s, the assistant's: %s", async (language, ai) => {
    const read = await readInNote(language, [fact(language), absent(language)], { ai });
    expect(read.shown).toEqual({ state: "not-checked", reason: "absence-read-limit" });
    expect(read.stored).toEqual(["not-checked", "absence-read-limit"]);
    expect(read.line).toBe(LINES[language].line);
  });

  // protects=a sentence that is only what it says is missing keeps today's line, in English and Chinese; fails_when=it reads as if a fact beside it were supported; no_claim=none beyond protects.
  test.each(["en", "zh"] as const)("%s, only the absence", async (language) => {
    // A sentence of one part is its own check: its judge says Supported and Absence: yes.
    const read = await readInNote(language, [
      ["fact", WORDS[language].absence, { verdict: "supported", absence: true }],
    ]);
    expect(read.shown).toEqual({ state: "not-checked", reason: "absence-read-limit" });
    expect(read.line).toBe(LINES[language].absenceOnly);
  });

  // protects=any other mix reads exactly as on main: an Unsupported part beside the absence is the sentence's result, another Not checked reason keeps its own line, and the assistant's own conclusion beside them keeps today's reading, in English and Chinese; fails_when=any of them shows the new line or another result; no_claim=which line those reasons show.
  test.each(["en", "zh"] as const)("%s, other mixes read as before", async (language) => {
    const unsupported = await readInNote(language, [
      fact(language),
      ["fact", WORDS[language].wrong, { verdict: "unsupported" }],
      absent(language),
    ]);
    expect(unsupported.shown.state).toBe("unsupported");
    const notChecked = await readInNote(language, [
      ["fact", WORDS[language].term, { verdict: "supported" }],
      absent(language),
    ]);
    expect(notChecked.shown.state).toBe("not-checked");
    expect(notChecked.line).not.toBe(LINES[language].line);
    const conclusion = await readInNote(
      language,
      [
        fact(language),
        absent(language),
        ["opinion", WORDS[language].opinion, { verdict: "supported" }],
      ],
      { ai: true },
    );
    expect(conclusion.shown.state).toBe("not-checked");
    expect(conclusion.line).not.toBe(LINES[language].line);
  });

  // protects=a sentence with no Citation, its fact supported by a Passage the check found, gets the line, which names nothing as cited, in English and Chinese; fails_when=such a sentence keeps the absence's own line, or the line calls its fact cited; no_claim=Documents read whole.
  test.each(["en", "zh"] as const)("%s, a sentence with no Citation", async (language) => {
    const read = await readInNote(language, [fact(language), absent(language)]);
    expect(read.line).toBe(LINES[language].line);
  });
});

describe("The assistant's own conclusion in a sentence with no Citation", {
  timeout: 30_000,
}, () => {
  // protects=a sentence the assistant wrote with no Citation, whose fact a Passage the check found supports and whose conclusion is its own, reads Not checked for that conclusion, and its line names nothing as cited, in English and Chinese; fails_when=the line says a cited fact is supported where nothing is cited; no_claim=the sentence's verdict, which #3054's tests hold.
  test.each(["en", "zh"] as const)("%s", async (language) => {
    const read = await readInNote(
      language,
      [fact(language), ["opinion", WORDS[language].opinion, { verdict: "supported" }]],
      { ai: true },
    );
    expect(read.shown).toEqual({ state: "not-checked", reason: "assistant-conclusion" });
    expect(read.line).toBe(LINES[language].conclusion);
  });
});
