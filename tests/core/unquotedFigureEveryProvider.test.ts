/**
 * A figure no quote states and no calculation worked out is never Supported, on any provider
 * (#3022). Where the check offers `calculate` (Anthropic, OpenAI) the number rule decides by it;
 * everywhere else the sentence ends as it does there, Not checked, and the check asks the model
 * nothing more. A figure its quote states keeps its ✓, and a sentence with no figure is unchanged.
 * In a Note the sentence's figures go with it, and each is compared with its quote's on every
 * provider. Through the core's public interface, with a model scripted to call each sentence
 * supported and to cite its Document's line, in English and Chinese, in Documents and a Meeting's
 * Transcript.
 */
import { describe, expect, test } from "vitest";
import type { Core, SaveChatProviderInput } from "../../src/core";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import {
  checkGenerate,
  checkingModel,
  checkReply,
  isCheckRun,
  type Plan,
  SAME_DETAIL,
  sentenceOf,
} from "../helpers/checks";
import { setUpWithDocuments, shownPassages } from "../helpers/citations";
import { checkClock } from "../helpers/heldClock";
import { readMind, writeMind } from "../helpers/minds";
import { type ModelCall, type ScriptedReply, scriptedModel } from "../helpers/models";

interface Row {
  claim: string;
  /** The Document's line the model cites for it. */
  line: string;
  /** The Document that holds the line: its own unless named, a Transcript for `.vtt`. */
  in?: string;
}

/** Sentences whose figure no quote states. */
const WRONG: readonly Row[] = [
  { claim: "Margin rose 7%.", line: "Margin rose 6 percentage points." },
  { claim: "Margin rose 7 percentage points.", line: "Margin rose 6 percentage points." },
  { claim: "Sales rose 7%.", line: "Sales rose 6%." },
  { claim: "Revenue was $55m.", line: "Revenue was $54m." },
  { claim: "利润率上升了7%。", line: "利润率上升了6个百分点。" },
  { claim: "收入为5500万美元。", line: "收入为5400万美元。" },
  { claim: "Headcount rose by 14 people.", line: "Headcount rose by 12 people.", in: "Call.vtt" },
  { claim: "员工人数增加了14人。", line: "员工人数增加了12人。", in: "通话.vtt" },
];

const IN_WORDS: Row = {
  claim: "The supplier quoted £39,500.",
  line: "The supplier quote came in at thirty-nine thousand five hundred pounds.",
};

/** Sentences whose figure their quote states, and one with no figure. */
const KEPT: readonly Row[] = [
  { claim: "Sales rose 6%.", line: "Sales rose 6%." },
  { claim: "Revenue was $54m.", line: "Revenue was $54m." },
  { claim: "The spread widened 230 bps.", line: "The spread widened 2.3 percentage points." },
  { claim: "收入为5400万美元。", line: "收入为5400万美元。" },
  IN_WORDS,
  { claim: "Headcount rose by 12 people.", line: "Headcount rose by 12 people.", in: "Call.vtt" },
  { claim: "The lease has a break clause.", line: "The lease has a break clause." },
  { claim: "租约包含提前解约条款。", line: "租约包含提前解约条款。" },
];

const ROWS = [...WRONG, ...KEPT];

/** Each Document's text: a line a Document, a Transcript's lines a few seconds apart. */
function documents(): { name: string; contents: string }[] {
  const lines = new Map<string, string[]>();
  const own = [...new Set(ROWS.filter((row) => !row.in).map((row) => row.line))];
  for (const row of ROWS) {
    const name = row.in ?? `Figures ${own.indexOf(row.line) + 1}.txt`;
    lines.set(name, [...new Set([...(lines.get(name) ?? []), row.line])]);
  }
  const at = (second: number) => `00:00:${String(second).padStart(2, "0")}.000`;
  return [...lines].map(([name, held]) => ({
    name,
    contents: name.endsWith(".vtt")
      ? `WEBVTT\n\n${held.map((line, n) => `${at(n * 4 + 1)} --> ${at(n * 4 + 4)}\n${line}`).join("\n\n")}\n`
      : `Figures\n${held.join("\n")}\n`,
  }));
}

const PROVIDERS: Record<string, { input: SaveChatProviderInput | null; calculates: boolean }> = {
  "Ollama, a model on this computer": { input: null, calculates: false },
  "Anthropic, Claude Haiku 5.5": {
    input: { kind: "anthropic", apiKey: "sk-ant-test", modelId: "claude-haiku-5-5" },
    calculates: true,
  },
  "OpenAI, GPT-6 Luna": {
    input: { kind: "openai", apiKey: "sk-proj-test", modelId: "gpt-6-luna" },
    calculates: true,
  },
  "Google, Gemini 3 Flash (preview)": {
    input: { kind: "google", apiKey: "AIza-test", modelId: "gemini-3-flash-preview" },
    calculates: false,
  },
  "DeepSeek, DeepSeek V4.1 Flash": {
    input: { kind: "deepseek", apiKey: "sk-test", modelId: "deepseek-flash" },
    calculates: false,
  },
  "Qwen, Qwen Plus": {
    input: { kind: "qwen", apiKey: "sk-test", modelId: "qwen-plus" },
    calculates: false,
  },
  "Kimi, Kimi K2.6": {
    input: { kind: "kimi", apiKey: "sk-test", modelId: "kimi-k2.6" },
    calculates: false,
  },
  "GLM, GLM-5.1": {
    input: { kind: "glm", apiKey: "sk-test", modelId: "glm-5.1" },
    calculates: false,
  },
  "SiliconFlow, DeepSeek V4 Flash": {
    input: { kind: "siliconflow", apiKey: "sk-test", modelId: "deepseek-ai/DeepSeek-V4-Flash" },
    calculates: false,
  },
  "Mistral, Mistral Large": {
    input: { kind: "mistral", apiKey: "sk-test", modelId: "mistral-large-2512" },
    calculates: false,
  },
  "xAI, Grok 4.3": {
    input: { kind: "xai", apiKey: "xai-test", modelId: "grok-4.3" },
    calculates: false,
  },
  "OpenRouter, Claude Haiku": {
    input: { kind: "openrouter", apiKey: "sk-or-test", modelId: "~anthropic/claude-haiku-latest" },
    calculates: false,
  },
  "An OpenAI-compatible server": {
    input: {
      kind: "openai-compatible",
      baseUrl: "https://models.example.test/v1",
      apiKey: "sk-test",
      modelId: "served-model",
    },
    calculates: false,
  },
};

const NOTE = "The numerical check is incomplete.";

/** Makes `input` the core's model, its checks allowed; none: the model on this computer. */
async function onProvider(core: Core, input: SaveChatProviderInput | null) {
  if (!input) return;
  core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
  const saved = await core.saveChatProvider(input);
  if (saved.service) await core.allowDataFlow("checks", saved.service.id);
}

/** A core on `input`'s provider, every row's Document added, and each check's requests. */
async function setUp(input: SaveChatProviderInput | null) {
  const plans: Record<string, Plan> = Object.fromEntries(
    ROWS.map((row) => [row.claim, { verdict: "supported", quote: row.line, says: row.line }]),
  );
  const calls: ModelCall[] = [];
  // A judge's questions only: a model on this computer also tags the new Documents meanwhile.
  let judged = 0;
  const judge = checkGenerate(plans);
  const model = scriptedModel(
    (call) => {
      calls.push(call);
      return checkReply(call, plans);
    },
    {
      generate: (call) => {
        if (call.question) judged++;
        return judge(call);
      },
    },
  );
  const { core, client, mind } = await setUpWithDocuments(model, documents());
  await onProvider(core, input);
  /** The check of `claim`: what it ended as, and what it asked the model. */
  const check = async (claim: string) => {
    const from = calls.length;
    const judgedBefore = judged;
    const result = await core.checkClaim({ claim });
    const asked = calls.slice(from).filter(isCheckRun);
    return {
      ended: result.verdict === "not-checked" ? `not-checked: ${result.reason}` : result.verdict,
      requests: asked.length + judged - judgedBefore,
      offeredCalculate: asked.some((call) => call.tools.includes("calculate")),
      toldToCalculate: asked.some((call) => call.prompt.includes(NOTE)),
    };
  };
  return { check, core, client, mind };
}

describe.each(Object.entries(PROVIDERS))("%s", (_, { input, calculates }) => {
  test("a figure no quote states is never Supported; one its quote states, or none, keeps its ✓", async () => {
    const { check } = await setUp(input);
    const checked = new Map<string, Awaited<ReturnType<typeof check>>>();
    for (const row of ROWS) checked.set(row.claim, await check(row.claim));
    const ended = (rows: readonly Row[]) =>
      Object.fromEntries(rows.map((row) => [row.claim, checked.get(row.claim)?.ended]));

    expect(ended(WRONG)).toEqual(
      Object.fromEntries(
        WRONG.map((row) => [
          row.claim,
          `not-checked: ${calculates ? "number-not-worked-out" : "number-unquoted"}`,
        ]),
      ),
    );
    expect(ended(KEPT)).toEqual(Object.fromEntries(KEPT.map((row) => [row.claim, "supported"])));

    const [twin] = KEPT;
    const plain = checked.get(twin?.claim ?? "");
    for (const row of WRONG) {
      const each = checked.get(row.claim);
      // Offered `calculate`, the model is sent back to work the figure out; without it, it is
      // sent nothing more than for the figure's twin.
      expect(each?.offeredCalculate, row.claim).toBe(calculates);
      expect(each?.toldToCalculate, row.claim).toBe(calculates);
      if (!calculates) expect(each?.requests, row.claim).toBe(plain?.requests);
    }
  });
});

describe.each(["DeepSeek, DeepSeek V4.1 Flash", "Anthropic, Claude Haiku 5.5"])("On %s", (name) => {
  test("in a Note, Check against Documents gives no ✓ to a figure no quote states, and keeps its twin's", async () => {
    const { core, client, mind } = await setUp(PROVIDERS[name]?.input ?? null);
    writeMind(
      client,
      ROWS.map((row, index) => ({
        type: "paragraph",
        attrs: { id: `block-${index + 1}` },
        content: [{ type: "text", text: row.claim }],
      })),
    );
    await client.settled();
    await core.checkSentences({
      requestId: crypto.randomUUID(),
      mindId: mind.id,
      action: "check-against-documents",
      from: { blockId: "block-1", offset: 0 },
      to: { blockId: `block-${ROWS.length}`, offset: ROWS.at(-1)?.claim.length ?? 0 },
    });
    await client.settled();
    const spans = claimSpans(readMind(client));
    const state = (row: Row) => spans.find((span) => span.sentence.text === row.claim)?.check.state;

    for (const row of WRONG) expect(state(row), row.claim).not.toBe("supported");
    // The scripted model gives a figure the number its quote writes in digits, and none in words.
    for (const row of KEPT.filter((each) => each !== IN_WORDS))
      expect(state(row), row.claim).toBe("supported");
  });

  test("an absence a whole read finds keeps its ✓, figure and all", async () => {
    const claim = "The lease has no 90-day break clause.";
    const plan: Plan = { verdict: "supported", absence: true };
    const model = scriptedModel((call) => checkReply(call, { [claim]: plan }), {
      generate: (call) =>
        call.question === "absence-read"
          ? { text: JSON.stringify({ absent: "a 90-day break clause", absence: "holds" }) }
          : checkGenerate({ [claim]: plan })(call),
    });
    const { core } = await setUpWithDocuments(model, [
      { name: "Lease.txt", contents: "Lease\nThe lease runs for three years.\n" },
    ]);
    await onProvider(core, PROVIDERS[name]?.input ?? null);

    expect((await core.checkClaim({ claim })).verdict).toBe("supported");
  });
});

describe("On the model on this computer, which the check doesn't offer calculate", () => {
  const SPREADS = "Spreads\nBond\tSpread (bps)\nAlpha\t230\n";
  const LEVIES = "Levies\nItem\tLevy (‰)\nStamp\t5\n";
  const GROWTH = "Growth\nMetric\tYoY%\nRevenue\t12\n";
  const PIPELINE = "Pipeline\nStage\tDeals\tValue (£k)\nProposal\t17\t830\n";

  /** `claim` checked against one Document, the model scripted to call it supported citing `quote`. */
  const ended = async (claim: string, contents: string, quote: string) => {
    const { core } = await setUpWithDocuments(
      checkingModel({ [claim]: { verdict: "supported", quote, says: quote } }),
      [{ name: "Table.txt", contents }],
    );
    const result = await core.checkClaim({ claim });
    return result.verdict === "not-checked" ? `not-checked: ${result.reason}` : result.verdict;
  };

  test.each([
    ["The spread widened 230 bps.", SPREADS, "Alpha\t230"],
    ["The levy is 5‰.", LEVIES, "Stamp\t5"],
    ["Revenue grew 12% year on year.", GROWTH, "Revenue\t12"],
    ["Seventeen deals worth £830k were at the proposal stage.", PIPELINE, "Proposal\t17\t830"],
  ])(
    "a cell holds %s in the unit its heading names: it keeps its ✓",
    async (claim, contents, quote) => {
      expect(await ended(claim, contents, quote)).toBe("supported");
    },
  );

  test.each([
    ["The spread widened 250 bps.", SPREADS, "Alpha\t230"],
    ["The levy is 7‰.", LEVIES, "Stamp\t5"],
    ["Revenue grew 15% year on year.", GROWTH, "Revenue\t12"],
    ["Seventeen deals worth £880k were at the proposal stage.", PIPELINE, "Proposal\t17\t830"],
  ])("no cell holds %s: it is Not checked", async (claim, contents, quote) => {
    expect(await ended(claim, contents, quote)).toBe("not-checked: number-unquoted");
  });

  test.each([
    ["Growth was 2–3%.", "supported"],
    ["Growth was 2–9%.", "not-checked: number-unquoted"],
    ["增长率为2%至9%。", "not-checked: number-unquoted"],
  ])("a range is held only with both its ends: %s", async (claim, verdict) => {
    const line = "Growth was 2–3%.";
    expect(await ended(claim, `Growth\n${line}\n`, line)).toBe(verdict);
  });

  test("a quote's dash range holds both its ends for a sentence that gives them in words", async () => {
    const line = "10–20 staff will move.";
    expect(await ended("Between 10 and 20 staff will move.", `Moves\n${line}\n`, line)).toBe(
      "supported",
    );
  });

  test.each([
    ["In 2024, revenue was $54m.", "Revenue was $54m."],
    ["Q3 sales rose 12%.", "Sales rose 12%."],
    ["第三季度利润率上升了6个百分点。", "利润率上升了6个百分点"],
  ])(
    "a number that says when, not how much, needs no quote: %s keeps its ✓",
    async (claim, quote) => {
      expect(await ended(claim, `Figures\n${quote}\n`, quote)).toBe("supported");
    },
  );

  // protects=a quote that gives the number in another written form holds it: a unit against the number ("54,000t", "4kg", "$5bn", "£830k", "50bps", "5m") either way round, and a number said in words before points ("six percentage points", "two point three percentage points", "three points to cover"), so the sentence keeps its ✓ without calculate (#3022); fails_when=such a sentence reads Not checked, or a different number in the same form keeps its ✓; no_claim=a sentence whose own number is in words, which the rule doesn't read.
  test.each([
    ["The mill's output was 54,000 tonnes.", "Output was 54,000t."],
    ["The mill's output was 54,000t.", "Output was 54,000 tonnes."],
    ["The parcel weighs 4 kg.", "The parcel weighs 4kg."],
    ["The route is 3 km long.", "The route is 3km long."],
    ["Revenue was $5 billion.", "Revenue was $5bn."],
    ["Profit was $5 million.", "Profit was $5mn."],
    ["Pay was £830,000.", "Pay was £830k."],
    ["Growth was 12 per cent.", "Growth was 12%."],
    ["The spread widened 50 basis points.", "The spread widened 50bps."],
    ["Revenue was 5 million.", "Revenue was 5m."],
    ["It rose 6 percentage points.", "It rose six percentage points."],
    ["It rose 2.3 percentage points.", "It rose two point three percentage points."],
    ["There are 3 points to cover.", "There are three points to cover."],
  ])("%s beside “%s” keeps its ✓", async (claim, quote) => {
    expect(await ended(claim, `Figures\n${quote}\n`, quote)).toBe("supported");
  });

  test.each([
    ["The mill's output was 55,000 tonnes.", "Output was 54,000t."],
    ["The mill's output was 55,000t.", "Output was 54,000 tonnes."],
    ["The parcel weighs 5 kg.", "The parcel weighs 4kg."],
    ["Revenue was $6 billion.", "Revenue was $5bn."],
    ["Pay was £880,000.", "Pay was £830k."],
    ["The spread widened 60 basis points.", "The spread widened 50bps."],
    ["Revenue was 6 million.", "Revenue was 5m."],
    ["It rose 7 percentage points.", "It rose six percentage points."],
    ["It rose 2.4 percentage points.", "It rose two point three percentage points."],
    ["There are 4 points to cover.", "There are three points to cover."],
  ])("%s beside “%s” is Not checked", async (claim, quote) => {
    expect(await ended(claim, `Figures\n${quote}\n`, quote)).toBe("not-checked: number-unquoted");
  });

  test("two figures on two quotes keep their ✓", async () => {
    const claim = "Revenue was $54m and costs were $30m.";
    const lines = ["Revenue was $54m.", "Costs were $30m."];
    const model = scriptedModel(
      (call): ScriptedReply => {
        const searched = call.results.filter((result) => result.tool === "search_documents");
        if (searched.length === 0)
          return { calls: [{ tool: "search_documents", input: { query: "revenue costs" } }] };
        if (!call.results.some((result) => result.tool === "cite")) {
          const shown = searched.flatMap((result) => shownPassages(result.text));
          const citations = lines.map((quote, index) => ({
            marker: index + 1,
            passage: shown.find((passage) => passage.text.includes(quote))?.id,
            quote,
          }));
          return { calls: [{ tool: "cite", input: { citations } }] };
        }
        return {
          text: `Verdict: supported\nAbsence: no\n${SAME_DETAIL}\nThe accounts give both. [^1] [^2]\nEvidence: [1, 2]`,
        };
      },
      { generate: checkGenerate({ [claim]: { verdict: "supported" } }) },
    );
    const { core } = await setUpWithDocuments(model, [
      { name: "Revenue.txt", contents: `Revenue\n${lines[0]}\n` },
      { name: "Costs.txt", contents: `Costs\n${lines[1]}\n` },
    ]);

    expect((await core.checkClaim({ claim })).verdict).toBe("supported");
  });
});

describe("Beside a limit on another part of the sentence (#3022)", () => {
  const NUMBER = "Revenue was $55m";
  const LEASE = "the lease has a break clause";
  const PLANS: Record<string, Plan> = {
    [NUMBER]: { verdict: "supported", quote: "Revenue was $54m.", says: "Revenue was $54m." },
    [LEASE]: {
      verdict: "supported",
      quote: "The lease has a break clause.",
      says: "The lease has a break clause.",
    },
  };
  const FILES = [
    { name: "Revenue.txt", contents: "Revenue\nRevenue was $54m.\n" },
    { name: "Lease.txt", contents: "Lease\nThe lease has a break clause.\n" },
  ];

  /**
   * `claim`, named in the parts `parts`, checked on `input`'s provider; `lease` decides what each
   * request of the lease part's check gets, by its count from 1.
   */
  async function checked(
    input: SaveChatProviderInput | null,
    claim: string,
    parts: readonly string[],
    lease: (reply: ScriptedReply, asked: number, core: Core) => ScriptedReply,
    plans: Record<string, Plan> = PLANS,
    numbered?: (call: ModelCall, reply: ScriptedReply, core: Core) => void,
  ) {
    let asked = 0;
    let started: Core | null = null;
    const model = scriptedModel(
      (call) => {
        const reply = checkReply(call, plans);
        if (
          !call.results.some((result) => result.tool === "search_documents") &&
          call.system.includes("Parts:")
        )
          return {
            ...reply,
            text: `Parts: ${JSON.stringify(parts.map((text) => ({ kind: "fact", text })))}`,
          };
        if (started && sentenceOf(call) === LEASE) return lease(reply, ++asked, started);
        if (started && sentenceOf(call) === NUMBER) numbered?.(call, reply, started);
        return reply;
      },
      { generate: checkGenerate(plans) },
    );
    // A rate limit is waited out and the sentence sent again (#2897): its pauses end at once here.
    const { core } = await setUpWithDocuments(model, FILES, { paceTimers: checkClock().timers });
    await onProvider(core, input);
    started = core;
    const result = await core.checkClaim({ claim });
    const verdicts = (result.parts ?? []).map((part) =>
      part.verdict === "not-checked" ? `not-checked: ${part.reason}` : part.verdict,
    );
    return { result, verdicts, asked };
  }

  describe.each([
    ["DeepSeek, DeepSeek V4.1 Flash", "number-unquoted"],
    ["Anthropic, Claude Haiku 5.5", "number-not-worked-out"],
  ])("on %s", (name, number) => {
    const input = PROVIDERS[name]?.input ?? null;
    const claim = `${NUMBER}, and ${LEASE}.`;

    test("a rate limit on the other part is waited out, and the sentence checked again", async () => {
      const { result, verdicts, asked } = await checked(
        input,
        claim,
        [NUMBER, LEASE],
        (reply, n) => (n === 1 ? { error: { status: 429, message: "Too many requests." } } : reply),
      );

      expect(asked).toBeGreaterThan(1);
      expect(verdicts).toEqual([`not-checked: ${number}`, "supported"]);
      expect(result).toMatchObject({ verdict: "not-checked", reason: number });
    });

    test("the monthly cap reached after the number's part, before the other's, ends the check on the cap", async () => {
      // The cap comes with the number part's last request: its verdict, or on a model offered
      // calculate, its verdict once sent back to calculate. The other part waits for it.
      let release = () => {};
      const reached = new Promise<void>((resolve) => {
        release = resolve;
      });
      const calculates = PROVIDERS[name]?.calculates ?? false;
      const { result } = await checked(
        input,
        claim,
        [NUMBER, LEASE],
        (reply, n) => (n === 1 ? { ...reply, pause: { after: 0, until: reached } } : reply),
        PLANS,
        (call, reply, core) => {
          const verdict = "text" in reply && /^Verdict:/m.test(reply.text ?? "");
          if (verdict && (!calculates || call.prompt.includes(NOTE)))
            void core
              .updateSettings({ user: { monthlyCap: { amount: 0, currency: "USD" } } })
              .then(release);
        },
      );

      // The run stops at the cap and leaves the sentence Not checked for it, its parts not kept.
      expect(result).toMatchObject({ verdict: "not-checked", reason: "cost-cap" });
    });

    test("beside a part whose quote isn't found, listed first, the number's own reason shows", async () => {
      const { result, verdicts } = await checked(
        input,
        `${LEASE}, and ${NUMBER}.`,
        [LEASE, NUMBER],
        (reply) => reply,
        { ...PLANS, [LEASE]: { verdict: "supported", quote: "The lease has no break clause." } },
      );

      expect(verdicts).toEqual(["not-checked: no-evidence", `not-checked: ${number}`]);
      expect(result).toMatchObject({ verdict: "not-checked", reason: number });
    });
  });
});
