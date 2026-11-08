import { describe, expect, test } from "vitest";
import { periodCounts, statedFigure } from "../../src/core/answers/checks/calculated";
import { readClaimParts } from "../../src/core/answers/checks/claims";
import { readEvidence, readVerdict } from "../../src/core/answers/checks/prompt";
import { wholeNumberWords } from "../../src/shared/numberWords";
import { listedSentences, SAME_DETAIL, sentenceOf } from "../helpers/checks";
import { setUpWithDocuments, shownPassages } from "../helpers/citations";
import { type GenerateCall, type ModelCall, scriptedModel } from "../helpers/models";

type Part = { kind: "fact" | "opinion"; text: string };
type Outcome = {
  quotes: string[];
  sourceQuotes?: string[];
  judgement?: "same" | "conflict" | "neither";
  reply?: string;
  recovery?: { marker: number; quote: string }[];
  recoveryError?: { status: number; message: string };
  calculation?: {
    as?: "number" | "currency";
    stated: string;
    formula: string;
    inputs: { name: string; quote: string; number: string }[];
  };
  repair?: Outcome["calculation"];
  /** An empty calculate list sent beside the cite, as Claude Haiku 5.5 sends one. */
  emptyCalculate?: boolean;
  /** `reply` is sent as written; otherwise one with no Duty line gets the same Duty and Condition. */
  asWritten?: true;
  /** The fields-only second reply of a check that disagreed with itself. */
  again?: string;
  /** What a judgement of the sentence beside a quote says, by the quote; `judgement` when absent. */
  judge?: (quote: string) => "same" | "neither";
};

/** Requests whose Run was still going when they were made: one made after it stopped never leaves the computer. */
const going = new WeakSet<ModelCall>();
const sent = (call: ModelCall) => going.has(call);

const INCREASES = "SUM(MAX(SIGN(r2023-r2022),0),MAX(SIGN(r2024-r2023),0),MAX(SIGN(r2025-r2024),0))";

async function check(
  claim: string,
  parts: Part[] | null,
  outcomes: Record<string, Outcome>,
  language: "en" | "zh-CN" = "en",
  context?: string,
) {
  const calls: ModelCall[] = [];
  const judgements: string[] = [];
  const recoveries: GenerateCall[] = [];
  const sorts: GenerateCall[] = [];
  const looks = new Map<string, number>();
  const quotes = [
    ...new Set(
      Object.values(outcomes).flatMap(
        (outcome) =>
          outcome.sourceQuotes ?? [
            ...outcome.quotes,
            ...(outcome.calculation?.inputs.map((input) => input.quote) ?? []),
          ],
      ),
    ),
  ];
  const model = scriptedModel(
    (call) => {
      calls.push(call);
      if (!call.options.abortSignal?.aborted) going.add(call);
      const outcome = outcomes[sentenceOf(call)] ?? { quotes: [] };
      const searches = call.results.filter((result) => result.tool === "search_documents");
      if (searches.length === 0)
        return {
          // A check with no sorted parts names them in its first turn, as the sorter would.
          ...(parts !== null &&
            call.system.includes("Parts:") && { text: `Parts: ${JSON.stringify(parts)}` }),
          calls: [{ tool: "search_documents", input: { query: quotes.join(" ") } }],
        };
      const shown = searches.flatMap((result) => shownPassages(result.text));
      if (outcome.quotes.length && !call.results.some((result) => result.tool === "cite")) {
        return {
          calls: [
            {
              tool: "cite",
              input: {
                citations: outcome.quotes.map((quote, index) => ({
                  marker: index + 1,
                  passage:
                    shown.find((passage) => passage.text.includes(quote))?.id ?? shown[0]?.id,
                  quote,
                })),
              },
            },
            ...(outcome.emptyCalculate ? [{ tool: "calculate", input: { figures: [] } }] : []),
          ],
        };
      }
      const calculated = call.results.filter((result) => result.tool === "calculate").length;
      const calculation = calculated === 0 ? outcome.calculation : outcome.repair;
      if (calculation && calculated < (outcome.repair ? 2 : 1)) {
        return {
          calls: [
            {
              tool: "calculate",
              input: {
                figures: [
                  {
                    marker: 1,
                    label: "Consecutive annual increases",
                    relation: "equals",
                    as: "number",
                    ...calculation,
                    inputs: calculation.inputs.map((input) => ({
                      ...input,
                      label: input.name,
                      passage: shown.find((passage) => passage.text.includes(input.quote))?.id,
                    })),
                  },
                ],
              },
            },
          ],
        };
      }
      const text =
        outcome.reply ??
        `Verdict: supported\nAbsence: no\nScope: none, same\nTopic: found\nRoles: ${sentenceOf(call)} / ${outcome.quotes.join(" ")}, same\nThe Documents establish this.\nEvidence: ${JSON.stringify(outcome.quotes.map((_, index) => index + 1))}\nCalculation: ${outcome.repair?.stated ?? outcome.calculation?.stated ?? "none"}`;
      return {
        text: outcome.asWritten || /^Duty:/m.test(text) ? text : `${text}\n${SAME_DETAIL}`,
      };
    },
    {
      generate: (call) => {
        if (call.system.startsWith("You sort the sentences")) {
          sorts.push(call);
          return {
            text: JSON.stringify({
              sentences:
                parts === null
                  ? []
                  : listedSentences(call.prompt).map(({ number }) => ({ number, parts })),
            }),
          };
        }
        if (call.system.startsWith("Compare a sentence")) {
          judgements.push(call.system);
          const target = /<sentence>\n([\s\S]*?)\n<\/sentence>/.exec(call.prompt)?.[1] ?? "";
          const quote = /<quote>\n([\s\S]*?)\n<\/quote>/.exec(call.prompt)?.[1] ?? "";
          return {
            text: outcomes[target]?.judge?.(quote) ?? outcomes[target]?.judgement ?? "neither",
          };
        }
        if (call.system.startsWith("Your last check of this sentence")) {
          const target = /<sentence>\n([\s\S]*?)\n<\/sentence>/.exec(call.prompt)?.[1] ?? "";
          looks.set(target, (looks.get(target) ?? 0) + 1);
          return {
            text:
              outcomes[target]?.again ??
              `Verdict: supported\nAbsence: no\nScope: none, same\nTopic: found\nRoles: ${target} / ${target}, same\n${SAME_DETAIL}\nThe Documents establish this.\nEvidence: [1]`,
          };
        }
        if (call.system.startsWith("You checked a sentence")) {
          recoveries.push(call);
          const target = /<sentence>\n([\s\S]*?)\n<\/sentence>/.exec(call.prompt)?.[1] ?? "";
          const passages = [
            ...call.prompt.matchAll(/<passage id="([^"]+)">\n([\s\S]*?)\n<\/passage>/g),
          ];
          const records = outcomes[target]?.recovery;
          const failure = outcomes[target]?.recoveryError;
          if (failure) return { error: failure };
          if (records)
            return {
              text: JSON.stringify({
                citations: records.map(({ marker, quote }) => ({
                  marker,
                  passage: passages.find((passage) => passage[2]?.includes(quote))?.[1] ?? "P999",
                  quote,
                })),
              }),
            };
        }
        return { text: JSON.stringify({ passage: null }) };
      },
    },
  );
  const { core } = await setUpWithDocuments(
    model,
    quotes.map((quote, index) => ({
      name: `source-${index + 1}.md`,
      contents: `# Source ${index + 1}\n\n${quote}\n`,
    })),
  );
  core.on("consent.requested", (event) => void core.respondToConsent(event.requestId, true));
  await core.saveChatProvider({
    kind: "anthropic",
    apiKey: "synthetic-test-key",
    modelId: "claude-haiku-5-5",
  });
  await core.updateSettings({ user: { language } });
  return {
    result: await core.checkClaim({ claim, context }),
    calls,
    judgements,
    recoveries,
    sorts,
    looks,
  };
}

/** A part's verdict, and how many times its check asked the second look. */
function partOutcome(checked: Awaited<ReturnType<typeof check>>, claim: string, part: string) {
  return {
    verdict: checked.result.parts?.find(
      (each) => claim.slice(each.span.start, each.span.end) === part,
    )?.verdict,
    looks: checked.looks.get(part) ?? 0,
  };
}

const unsupportedUnasked = { verdict: "unsupported", looks: 0 };
const notCheckedAsked = { verdict: "not-checked", looks: 1 };

describe("literal sentence parts", () => {
  test.each([
    [
      "We think it is risky because costs rose 40%, and we find the timing unfortunate.",
      "We think it is risky",
      "costs rose 40%",
      "we find the timing unfortunate",
    ],
    [
      "我们认为风险很高，因为成本上涨了40%，而且我们觉得时机不妥。",
      "我们认为风险很高",
      "成本上涨了40%",
      "我们觉得时机不妥",
    ],
  ])(
    "retains two omitted opinions around a checked fact: %s",
    async (claim, prefix, fact, suffix) => {
      const parts: Part[] = [
        { kind: "opinion", text: prefix },
        { kind: "fact", text: fact },
        { kind: "opinion", text: suffix },
      ];
      const quote = fact.startsWith("costs") ? "In 2025, costs rose 40%." : "2025年成本上涨了40%。";
      const { result, calls } = await check(claim, parts, { [fact]: { quotes: [quote] } });
      expect(
        result.verdict,
        result.verdict === "not-checked"
          ? `${result.reason}: ${result.detail}; parts=${result.parts?.map((part) => `${part.kind}:${part.verdict}:${part.reason}`).join(",")}`
          : undefined,
      ).toBe("supported");
      expect(result.parts?.map((part) => [part.kind, part.verdict])).toEqual([
        ["opinion", null],
        ["fact", "supported"],
        ["opinion", null],
      ]);
      expect(result.parts?.map((part) => claim.slice(part.span.start, part.span.end))).toEqual([
        prefix,
        fact,
        suffix,
      ]);
      expect(result.parts?.[1]?.evidence.map((citation) => citation.quote)).toEqual([quote]);
      // The whole sentence is read once, in the first turn that names its parts.
      expect(
        calls
          .filter(sent)
          .map(sentenceOf)
          .filter((each) => each === claim),
      ).toHaveLength(1);
      expect([...new Set(calls.filter(sent).slice(1).map(sentenceOf))]).toEqual([fact]);
      expect(result.parts?.[1]?.coverage).toBeUndefined();
    },
  );

  test.each([
    {
      language: "en" as const,
      claim: "Customer churn fell to 3.9 per cent after the onboarding redesign.",
      first: "Customer churn fell to 3.9 per cent",
      timing: "after the onboarding redesign",
      quote: "Customer churn fell to 4.2 per cent after the onboarding redesign.",
      reason:
        "The Document says churn fell to 4.2 per cent, not 3.9 per cent. The sentence's onboarding-redesign link is otherwise as stated in that Document.",
    },
    {
      language: "zh-CN" as const,
      claim: "客户流失率降至 3.9%，时点在引导流程重新设计之后。",
      first: "客户流失率降至 3.9%",
      timing: "时点在引导流程重新设计之后",
      quote: "客户流失率降至 4.2%，时点在引导流程重新设计之后。",
      reason: "文件写的是 4.2%，不是 3.9%；引导流程重新设计的时点在文件中已有说明。",
    },
  ])(
    "a part the quote states on its own is asked once more, and Not checked, never Supported, though the reply called the sentence contradicted ($language, #2816)",
    async ({ language, claim, first, timing, quote, reason }) => {
      const { result } = await check(
        claim,
        [
          { kind: "fact", text: first },
          { kind: "fact", text: timing },
        ],
        {
          [first]: {
            quotes: [quote],
            reply: `Verdict: contradicted\nThe Document gives another figure.\nEvidence: [1]`,
            judgement: "conflict",
          },
          [timing]: {
            quotes: [quote],
            reply: `Verdict: contradicted\nRoles: ${timing} / ${timing}, same\n${reason}\nEvidence: [1]`,
            judgement: "same",
          },
        },
        language,
      );

      // The figure's part is contradicted; the part that says when it happened is stated by the
      // very quote, so it isn't drawn as a card of what the Documents cover and don't (#2313).
      expect(
        result.verdict,
        result.verdict === "not-checked" ? `${result.reason}: ${result.detail}` : undefined,
      ).toBe("contradicted");
      expect(result.parts?.map((part) => part.verdict)).toEqual(["contradicted", "not-checked"]);
      const judged = result.parts?.[1];
      expect(judged?.says).toBeNull();
      expect(judged?.unsupported).toBeNull();
      expect(judged?.evidence.map((citation) => citation.quote)).toEqual([quote]);
    },
  );

  test.each([
    { field: "Roles", said: "Roles: the Tenant pays / the Landlord pays, differs" },
    {
      field: "Time",
      said:
        "Roles: the Tenant pays / the Tenant pays, same\n" +
        "Time: has closed / will close next year, differs",
    },
    {
      field: "Scope",
      said: "Roles: the Tenant pays / the Tenant pays, same\nScope: staff, wider",
    },
  ])(
    "a part whose own $field differ keeps the judge's verdict, not Support (#2313)",
    async ({ said }) => {
      const claim = "Under the lease, the Tenant pays the Landlord's repair costs.";
      const first = "Under the lease";
      const part = "the Tenant pays the Landlord's repair costs";
      const reply = (fields: string) =>
        `Verdict: contradicted\n${fields}\nThe Document gives it the other way.\nEvidence: [1]`;
      const run = (fields: string, stated = claim) =>
        check(
          claim,
          [
            { kind: "fact", text: first },
            { kind: "fact", text: part },
          ],
          {
            [first]: { quotes: [stated] },
            [part]: { quotes: [stated], reply: reply(fields), judgement: "same" },
          },
        );

      expect(partOutcome(await run(said), claim, part)).toEqual(unsupportedUnasked);
      // Paired: with its own Roles, Time and Scope agreeing, the same part is asked once more,
      // which can't make it Supported (#2816).
      expect(
        partOutcome(
          await run(
            "Roles: the Tenant pays / the Tenant pays, same\nTime: none / none, same\nScope: none, same",
            claim,
          ),
          claim,
          part,
        ),
      ).toEqual(notCheckedAsked);
    },
  );

  test.each([
    {
      name: "en",
      claim: "Under the lease, the Tenant pays the Landlord's repair costs.",
      first: "Under the lease",
      part: "the Tenant pays the Landlord's repair costs",
      quote: "Under the lease, the Landlord pays the Tenant's repair costs.",
      own: "the Tenant pays the Landlord's repair costs",
      other: "the Landlord pays the Tenant's repair costs",
    },
    {
      name: "zh-CN",
      claim: "根据协议，人力资源总监向乙方汇报。",
      first: "根据协议",
      part: "人力资源总监向乙方汇报",
      quote: "根据协议，乙方向人力资源总监汇报。",
      own: "人力资源总监向乙方汇报",
      other: "乙方向人力资源总监汇报",
    },
  ])(
    "a part whose Roles line copies the Passage, then says same, is not Supported ($name, #2313)",
    async ({ claim, first, part, quote, own, other }) => {
      const run = (side: string, stated = quote) =>
        check(
          claim,
          [
            { kind: "fact", text: first },
            { kind: "fact", text: part },
          ],
          {
            [first]: { quotes: [stated] },
            [part]: {
              quotes: [stated],
              reply: `Verdict: contradicted\nRoles: ${side} / ${side}, same\nThe Document gives it the other way.\nEvidence: [1]`,
              judgement: "same",
            },
          },
        );

      expect(partOutcome(await run(other), claim, part)).toEqual(unsupportedUnasked);
      // The quote states the part, and the reply's Roles line copies other words: the fields-only
      // second look is what keeps it from being read as support.
      expect(partOutcome(await run(other, claim), claim, part)).toEqual(unsupportedUnasked);
      const noSides = await check(
        claim,
        [
          { kind: "fact", text: first },
          { kind: "fact", text: part },
        ],
        {
          [first]: { quotes: [claim] },
          [part]: {
            quotes: [claim],
            reply:
              "Verdict: contradicted\nRoles: same\nThe Document gives it the other way.\nEvidence: [1]",
            judgement: "same",
          },
        },
      );
      expect(partOutcome(noSides, claim, part)).toEqual(unsupportedUnasked);
      // Paired: with its own words as the Roles line's first side, and the quote stating it, the
      // part is asked once more, which can't make it Supported (#2816).
      expect(partOutcome(await run(own, claim), claim, part)).toEqual(notCheckedAsked);
    },
  );

  test("a part whose own detail is only part of a quote's word, or its negation, stays Unsupported (#2313)", async () => {
    const claim = "The harbour office publishes the times of high water every week.";
    const first = "The harbour office publishes the times of high water";
    const part = "every week";
    const run = (quote: string) =>
      check(
        claim,
        [
          { kind: "fact", text: first },
          { kind: "fact", text: part },
        ],
        {
          [first]: { quotes: [quote] },
          [part]: {
            quotes: [quote],
            reply: `Verdict: contradicted\nRoles: ${part} / ${part}, same\nThe Document gives it another way.\nEvidence: [1]`,
            judgement: "same",
          },
        },
      );
    expect(
      partOutcome(
        await run("The harbour office publishes the times of high water every weekday."),
        claim,
        part,
      ),
    ).toEqual(unsupportedUnasked);
    expect(
      partOutcome(
        await run("The harbour office publishes the times of high water every week."),
        claim,
        part,
      ),
    ).toEqual(notCheckedAsked);

    const negated = "The fee is not capped.";
    const negatedPart = "not capped";
    const runNegated = (quote: string) =>
      check(
        negated,
        [
          { kind: "fact", text: "The fee is" },
          { kind: "fact", text: negatedPart },
        ],
        {
          "The fee is": { quotes: [quote] },
          [negatedPart]: {
            quotes: [quote],
            reply: `Verdict: contradicted\nRoles: ${negatedPart} / ${negatedPart}, same\nThe Document gives it another way.\nEvidence: [1]`,
            judgement: "same",
          },
        },
      );
    expect(partOutcome(await runNegated("The fee is capped."), negated, negatedPart)).toEqual(
      unsupportedUnasked,
    );
    expect(partOutcome(await runNegated("The fee is not capped."), negated, negatedPart)).toEqual(
      notCheckedAsked,
    );
  });

  test("a part settled by its working keeps the working's Citation, not the reply's quote (#2313)", async () => {
    const claim = "According to the covenant, the leverage was 3.25x.";
    const first = "According to the covenant";
    const part = "the leverage was 3.25x";
    const calculation = {
      stated: "3.25x",
      formula: "n1 / n2",
      inputs: [
        { name: "n1", quote: "Net debt of £528.9m", number: "528.9" },
        { name: "n2", quote: "EBITDA of £162.7m", number: "162.7" },
      ],
    };
    const { result } = await check(
      claim,
      [
        { kind: "fact", text: first },
        { kind: "fact", text: part },
      ],
      {
        [first]: { quotes: ["The leverage was 3.25x."] },
        // The judge's own Supported: a working never overturns its Contradicted (#1766, #1708).
        [part]: { quotes: ["The leverage was 3.25x."], calculation },
      },
    );

    const judged = result.parts?.[1];
    expect(judged?.verdict).toBe("supported");
    // Its working read the two figures: the card names that quote first, never the reply's own.
    expect(judged?.evidence[0]?.quote).toBe("Net debt of £528.9m");
    expect(judged?.calculation?.figure.inputs.map((input) => input.citation.quote)).toEqual([
      "Net debt of £528.9m",
      "EBITDA of £162.7m",
    ]);
  });

  test.each([
    {
      name: "en not capped",
      claim: "Under the agreement, the fee is capped.",
      first: "Under the agreement",
      part: "the fee is capped",
      quote: "Under the agreement, the fee is not capped.",
      own: "Under the agreement, the fee is capped.",
    },
    {
      name: "en isn't capped",
      claim: "Under the agreement, the fee is capped.",
      first: "Under the agreement",
      part: "the fee is capped",
      quote: "Under the agreement, the fee isn't capped.",
      own: "Under the agreement, the fee is capped.",
    },
    {
      name: "en isn’t capped with a typographic apostrophe",
      claim: "Under the agreement, the fee is capped.",
      first: "Under the agreement",
      part: "the fee is capped",
      quote: "Under the agreement, the fee isn’t capped.",
      own: "Under the agreement, the fee is capped.",
    },
    {
      name: "en never capped",
      claim: "Under the agreement, the fee is capped.",
      first: "Under the agreement",
      part: "the fee is capped",
      quote: "Under the agreement, the fee is never capped.",
      own: "Under the agreement, the fee is capped.",
    },
    {
      name: "zh 不应当",
      claim: "根据合同，乙方应当支付违约金。",
      first: "根据合同",
      part: "乙方应当支付违约金",
      quote: "根据合同，乙方不应当支付违约金。",
      own: "根据合同，乙方应当支付违约金。",
      language: "zh-CN" as const,
    },
    {
      name: "zh 不 added later in the same run",
      claim: "根据合同，乙方应当支付违约金。",
      first: "根据合同",
      part: "乙方应当支付违约金",
      quote: "根据合同，乙方应当支付违约金的说法不成立。",
      own: "根据合同，乙方应当支付违约金。",
      language: "zh-CN" as const,
    },
  ])(
    "a negation only the quote has is not the part's own detail ($name, #2313)",
    async ({ claim, first, part, quote, own, language }) => {
      const run = (said: string) =>
        check(
          claim,
          [
            { kind: "fact", text: first },
            { kind: "fact", text: part },
          ],
          {
            [first]: { quotes: [said] },
            [part]: {
              quotes: [said],
              reply: `Verdict: contradicted\nRoles: ${part} / ${part}, same\nThe Document gives it another way.\nEvidence: [1]`,
              judgement: "same",
            },
          },
          language ?? "en",
        );

      expect(partOutcome(await run(quote), claim, part)).toEqual(unsupportedUnasked);
      // Paired: the same words with the part's own negation (or none) are asked once more, which
      // can't make them Supported (#2816).
      expect(partOutcome(await run(own), claim, part)).toEqual(notCheckedAsked);
    },
  );

  test.each([
    {
      name: "en Q2 vs Q3",
      claim: "Gross margin fell in Q2, mostly in online.",
      first: "Gross margin fell",
      part: "in Q2, mostly in online",
      quote: "Gross margin fell in Q3, mostly in online.",
      own: "Gross margin fell in Q2, mostly in online.",
    },
    {
      name: "en FY2024 vs FY2025",
      claim: "Revenue grew in FY2024, mostly in online.",
      first: "Revenue grew",
      part: "in FY2024, mostly in online",
      quote: "Revenue grew in FY2025, mostly in online.",
      own: "Revenue grew in FY2024, mostly in online.",
    },
    {
      name: "zh a digit in the run",
      claim: "根据通知，港口办公室自2025年起每年公布一次高潮时间。",
      first: "根据通知",
      part: "港口办公室自2025年起每年公布一次高潮时间",
      quote: "根据通知，港口办公室自2025年起每周公布一次高潮时间。",
      own: "根据通知，港口办公室自2025年起每年公布一次高潮时间。",
      language: "zh-CN" as const,
    },
  ])(
    "a period label or a year in a longer run must be the quote's own ($name, #2313)",
    async ({ claim, first, part, quote, own, language }) => {
      const run = (said: string) =>
        check(
          claim,
          [
            { kind: "fact", text: first },
            { kind: "fact", text: part },
          ],
          {
            [first]: { quotes: [said] },
            [part]: {
              quotes: [said],
              reply: `Verdict: contradicted\nRoles: ${part} / ${part}, same\nThe Document gives it another way.\nEvidence: [1]`,
              judgement: "same",
            },
          },
          language ?? "en",
        );

      expect(partOutcome(await run(quote), claim, part)).toEqual(unsupportedUnasked);
      expect(partOutcome(await run(own), claim, part)).toEqual(notCheckedAsked);
    },
  );

  test.each([
    {
      name: "en revenue fell in Q2, quote says rose in Q2 and fell in Q3",
      claim: "Revenue fell in Q2, and costs rose in Q2.",
      first: "Revenue fell in Q2",
      part: "costs rose in Q2",
      quote: "Revenue rose in Q2, and costs fell in Q2.",
      own: "Revenue fell in Q2, and costs rose in Q2.",
    },
    {
      name: "en every year, quote says every week of the year",
      claim: "The harbour office publishes the times of high water every year.",
      first: "The harbour office publishes the times of high water",
      part: "every year",
      quote: "The harbour office publishes the times of high water every week of the year.",
      own: "The harbour office publishes the times of high water every year.",
    },
    {
      name: "en not capped, quote says capped but not refundable",
      claim: "Under the agreement, the fee is not capped.",
      first: "Under the agreement",
      part: "the fee is not capped",
      quote: "Under the agreement, the fee is capped but not refundable.",
      own: "Under the agreement, the fee is not capped.",
    },
    {
      name: "zh every year, quote says every week with the year elsewhere",
      claim: "据通知，港口办公室每年公布一次高潮时间。",
      first: "据通知",
      part: "港口办公室每年公布一次高潮时间",
      quote: "据通知，港口办公室每周公布一次高潮时间，全年如此。",
      own: "据通知，港口办公室每年公布一次高潮时间。",
      language: "zh-CN" as const,
    },
  ])(
    "a part's own words must be adjacent in the quote, not only present ($name, #2313)",
    async ({ claim, first, part, quote, own, language }) => {
      const run = (said: string) =>
        check(
          claim,
          [
            { kind: "fact", text: first },
            { kind: "fact", text: part },
          ],
          {
            [first]: { quotes: [said] },
            [part]: {
              quotes: [said],
              reply: `Verdict: contradicted\nRoles: ${part} / ${part}, same\nThe Document gives it another way.\nEvidence: [1]`,
              judgement: "same",
            },
          },
          language ?? "en",
        );

      expect(partOutcome(await run(quote), claim, part)).toEqual(unsupportedUnasked);
      expect(partOutcome(await run(own), claim, part)).toEqual(notCheckedAsked);
    },
  );

  test.each([
    {
      name: "en is not / isn't",
      claim: "Under the agreement, the fee is not capped.",
      first: "Under the agreement",
      part: "the fee is not capped",
      quote: "Under the agreement, the fee isn't capped.",
    },
    {
      name: "en is not / isn’t with a typographic apostrophe",
      claim: "Under the agreement, the fee is not capped.",
      first: "Under the agreement",
      part: "the fee is not capped",
      quote: "Under the agreement, the fee isn’t capped.",
    },
    {
      name: "en cannot / can't",
      claim: "Under the agreement, the board cannot approve the plan.",
      first: "Under the agreement",
      part: "the board cannot approve the plan",
      quote: "Under the agreement, the board can't approve the plan.",
    },
    {
      name: "en does not / doesn't",
      claim: "Under the agreement, the board does not approve the plan.",
      first: "Under the agreement",
      part: "the board does not approve the plan",
      quote: "Under the agreement, the board doesn't approve the plan.",
    },
  ])(
    "a contraction says the same words as its expansion ($name, #2313)",
    async ({ claim, first, part, quote }) => {
      const run = (said: string) =>
        check(
          claim,
          [
            { kind: "fact", text: first },
            { kind: "fact", text: part },
          ],
          {
            [first]: { quotes: [said] },
            [part]: {
              quotes: [said],
              reply: `Verdict: contradicted\nRoles: ${part} / ${part}, same\nThe Document gives it another way.\nEvidence: [1]`,
              judgement: "same",
            },
          },
        );

      expect(partOutcome(await run(quote), claim, part)).toEqual(notCheckedAsked);
      expect(partOutcome(await run(claim), claim, part)).toEqual(notCheckedAsked);
    },
  );

  test("full-width letters compare after NFKC, while 应当 and 应该 stay a recall miss (#2313)", async () => {
    const claim = "根据公告，ＡＢＣ公司每年公布一次报告。";
    const first = "根据公告";
    const part = "ＡＢＣ公司每年公布一次报告";
    const run = (said: string) =>
      check(
        claim,
        [
          { kind: "fact", text: first },
          { kind: "fact", text: part },
        ],
        {
          [first]: { quotes: [said] },
          [part]: {
            quotes: [said],
            reply: `Verdict: contradicted\nRoles: ${part} / ${part}, same\nThe Document gives it another way.\nEvidence: [1]`,
            judgement: "same",
          },
        },
        "zh-CN",
      );

    expect(partOutcome(await run("根据公告，ABC公司每年公布一次报告。"), claim, part)).toEqual(
      notCheckedAsked,
    );
    expect(partOutcome(await run(claim), claim, part)).toEqual(notCheckedAsked);

    const dutyClaim = "根据合同，乙方应当支付违约金。";
    const dutyPart = "乙方应当支付违约金";
    const duty = (said: string) =>
      check(
        dutyClaim,
        [
          { kind: "fact", text: "根据合同" },
          { kind: "fact", text: dutyPart },
        ],
        {
          根据合同: { quotes: [said] },
          [dutyPart]: {
            quotes: [said],
            reply: `Verdict: contradicted\nRoles: ${dutyPart} / ${dutyPart}, same\nThe Document gives it another way.\nEvidence: [1]`,
            judgement: "same",
          },
        },
        "zh-CN",
      );

    expect(partOutcome(await duty("根据合同，乙方应该支付违约金。"), dutyClaim, dutyPart)).toEqual(
      unsupportedUnasked,
    );
  });

  test.each([
    {
      name: "en 3.9 against 4.2",
      claim: "Customer churn fell to 3.9 per cent after the onboarding redesign.",
      part: "Customer churn fell to 3.9 per cent",
      other: "after the onboarding redesign",
      quote: "Customer churn fell to 4.2 per cent after the onboarding redesign.",
    },
    {
      name: "en 6 months against 9",
      claim: "The term is 6 months, and the rent is due monthly.",
      part: "The term is 6 months",
      other: "the rent is due monthly",
      quote: "The term is 9 months, and the rent is due monthly.",
    },
    {
      name: "en 5% against 7%",
      claim: "The rate is 5%, and the fee is fixed.",
      part: "The rate is 5%",
      other: "the fee is fixed",
      quote: "The rate is 7%, and the fee is fixed.",
    },
    {
      name: "en 2.5% against 3.5%",
      claim: "The rate is 2.5%, and the fee is fixed.",
      part: "The rate is 2.5%",
      other: "the fee is fixed",
      quote: "The rate is 3.5%, and the fee is fixed.",
    },
    {
      name: "en 2 points against 5",
      claim: "Sales fell 2 points, and costs rose.",
      part: "Sales fell 2 points",
      other: "costs rose",
      quote: "Sales fell 5 points, and costs rose.",
    },
    {
      name: "en 8% against 9%",
      claim: "Revenue grew 8%, and costs fell.",
      part: "Revenue grew 8%",
      other: "costs fell",
      quote: "Revenue grew 9%, and costs fell.",
    },
    {
      name: "zh 3.9% against 4.2%",
      claim: "客户流失率降至3.9%，时点在引导流程重新设计之后。",
      part: "客户流失率降至3.9%",
      other: "时点在引导流程重新设计之后",
      quote: "客户流失率降至4.2%，时点在引导流程重新设计之后。",
      language: "zh-CN" as const,
    },
    {
      name: "zh 6个月 against 9个月",
      claim: "租期为6个月，租金按月支付。",
      part: "租期为6个月",
      other: "租金按月支付",
      quote: "租期为9个月，租金按月支付。",
      language: "zh-CN" as const,
    },
  ])(
    "a part's whole figure is compared, single digits and decimals alike ($name, #2313)",
    async ({ claim, part, other, quote, language }) => {
      const run = (said: string) =>
        check(
          claim,
          [
            { kind: "fact", text: part },
            { kind: "fact", text: other },
          ],
          {
            [part]: {
              quotes: [said],
              reply: `Verdict: contradicted\nRoles: ${part} / ${part}, same\nThe Document gives it another way.\nEvidence: [1]`,
              judgement: "same",
            },
            [other]: { quotes: [said] },
          },
          language ?? "en",
        );

      expect(partOutcome(await run(quote), claim, part)).toEqual(unsupportedUnasked);
      expect(partOutcome(await run(claim), claim, part)).toEqual(notCheckedAsked);
    },
  );

  test.each([
    {
      name: "zh swapped parties elsewhere in the quote",
      claim: "乙方向甲方支付货款，并在月底结算。",
      part: "乙方向甲方支付货款",
      other: "并在月底结算",
      quote: "甲方向乙方支付货款，乙方向甲方交付货物。",
    },
    {
      name: "zh a moved negation",
      claim: "甲方支付违约金，乙方交付货物。",
      part: "甲方支付违约金",
      other: "乙方交付货物",
      quote: "乙方支付违约金，甲方免责。",
    },
  ])(
    "a Chinese part's own run stands whole, not by characters elsewhere ($name, #2313)",
    async ({ claim, part, other, quote }) => {
      const run = (said: string) =>
        check(
          claim,
          [
            { kind: "fact", text: part },
            { kind: "fact", text: other },
          ],
          {
            [part]: {
              quotes: [said],
              reply: `Verdict: contradicted\nRoles: ${part} / ${part}, same\nThe Document gives it another way.\nEvidence: [1]`,
              judgement: "same",
            },
            [other]: { quotes: [said] },
          },
          "zh-CN",
        );

      expect(partOutcome(await run(quote), claim, part)).toEqual(unsupportedUnasked);
      expect(partOutcome(await run(claim), claim, part)).toEqual(notCheckedAsked);
    },
  );

  test("the walk's part is Not checked when the re-asked judge agrees, as when it still disagrees with itself, and Unsupported when a field differs (#2313, #2816)", async () => {
    const claim = "Customer churn fell to 3.9 per cent after the onboarding redesign.";
    const part = "after the onboarding redesign";
    const quote = "Customer churn fell to 4.2 per cent after the onboarding redesign.";
    const run = (again: string) =>
      check(
        claim,
        [
          { kind: "fact", text: "Customer churn fell to 3.9 per cent" },
          { kind: "fact", text: part },
        ],
        {
          [part]: {
            quotes: [quote],
            reply: `Verdict: contradicted\nRoles: ${part} / ${part}, same\nThe Document gives 4.2 per cent.\nEvidence: [1]`,
            judgement: "same",
            again,
          },
          "Customer churn fell to 3.9 per cent": { quotes: [quote] },
        },
      );
    const judged = (result: Awaited<ReturnType<typeof check>>["result"]) =>
      result.parts?.find((each) => claim.slice(each.span.start, each.span.end) === part);

    const agreedRun = await run(
      `Verdict: supported\nAbsence: no\nScope: none, same\nTopic: found\nRoles: ${part} / ${part}, same\n${SAME_DETAIL}\nThe Document states it.\nEvidence: [1]`,
    );
    expect(judged(agreedRun.result)?.verdict).toBe("not-checked");
    expect(agreedRun.looks.get(part)).toBe(1);

    const still = judged(
      (
        await run(
          `Verdict: contradicted\nScope: none, same\nTopic: found\nRoles: ${part} / ${part}, same\nThe Document gives 4.2 per cent.\nEvidence: [1]`,
        )
      ).result,
    );
    expect(still?.verdict).toBe("not-checked");
    expect(still?.reason).toBe("malformed");

    const explained = judged(
      (
        await run(
          `Verdict: contradicted\nScope: none, same\nTopic: found\nRoles: ${part} / the redesign, differs\nThe Document gives it another way.\nEvidence: [1]`,
        )
      ).result,
    );
    expect(explained?.verdict).toBe("unsupported");
  });

  test.each([
    {
      language: "en" as const,
      claim: "Customer churn fell to 3.9 per cent after the onboarding redesign.",
      first: "Customer churn fell to 3.9 per cent",
      part: "after the onboarding redesign",
      quote: "Customer churn fell to 4.2 per cent after the onboarding redesign.",
    },
    {
      language: "zh-CN" as const,
      claim: "客户流失率降至 3.9%，时点在引导流程重新设计之后。",
      first: "客户流失率降至 3.9%",
      part: "时点在引导流程重新设计之后",
      quote: "客户流失率降至 4.2%，时点在引导流程重新设计之后。",
    },
  ])(
    "a second reply with every line the same is Not checked, and one whose field differs is Unsupported ($language, #2816)",
    async ({ language, claim, first, part, quote }) => {
      const judged = async (again: string) =>
        (
          await check(
            claim,
            [
              { kind: "fact", text: first },
              { kind: "fact", text: part },
            ],
            {
              [part]: {
                quotes: [quote],
                reply: `Verdict: contradicted\nAbsence: no\nRoles: ${part} / ${part}, same\nThe Document gives another figure.\nEvidence: [1]`,
                judgement: "same",
                again,
              },
              [first]: { quotes: [quote] },
            },
            language,
          )
        ).result.parts?.find((each) => claim.slice(each.span.start, each.span.end) === part)
          ?.verdict;

      expect(
        await judged(
          `Verdict: supported\nAbsence: no\nScope: none, same\nTopic: found\nRoles: ${part} / ${part}, same\nTime: none / none, same\nCondition: none / none, same\nThe Document states it.\nEvidence: [1]`,
        ),
      ).toBe("not-checked");
      expect(
        await judged(
          `Verdict: supported\nAbsence: no\nScope: none, same\nTopic: found\nRoles: ${part} / ${part}, same\nTime: has happened / is still to happen, differs\nThe Document states it.\nEvidence: [1]`,
        ),
      ).toBe("unsupported");
    },
  );

  test.each([
    {
      name: "Roles other",
      roles: "Roles: the Tenant pays / someone else, other",
      ends: { verdict: "not-checked", reason: "malformed" },
    },
    {
      name: "a Roles side copied from the Passage",
      roles: "Roles: the Passage's words / the Passage's words, same",
      ends: { verdict: "not-checked", reason: "malformed" },
    },
    {
      name: "Topic not found",
      topic: "Topic: not found",
      ends: { verdict: "not-checked", reason: "malformed" },
    },
    {
      name: "Evidence none",
      evidence: "Evidence: none",
      ends: { verdict: "not-checked", reason: "malformed" },
    },
    { name: "Scope wider", scope: "Scope: staff, wider", ends: { verdict: "unsupported" } },
    {
      name: "Time differs",
      time: "Time: has closed / will close, differs",
      ends: { verdict: "unsupported" },
    },
  ])(
    "a supported second reply passes the first reply's checks ($name, #2313)",
    async ({ roles, topic, evidence, scope, time, ends }) => {
      const claim = "Customer churn fell to 3.9 per cent after the onboarding redesign.";
      const part = "after the onboarding redesign";
      const quote = "Customer churn fell to 4.2 per cent after the onboarding redesign.";
      const run = (again: string) =>
        check(
          claim,
          [
            { kind: "fact", text: "Customer churn fell to 3.9 per cent" },
            { kind: "fact", text: part },
          ],
          {
            [part]: {
              quotes: [quote],
              reply: `Verdict: contradicted\nRoles: ${part} / ${part}, same\nThe Document gives 4.2 per cent.\nEvidence: [1]`,
              judgement: "same",
              again,
            },
            "Customer churn fell to 3.9 per cent": { quotes: [quote] },
          },
        );
      const judged = (result: Awaited<ReturnType<typeof check>>["result"]) =>
        result.parts?.find((each) => claim.slice(each.span.start, each.span.end) === part);
      const said = [
        "Verdict: supported",
        "Absence: no",
        scope ?? "Scope: none, same",
        topic ?? "Topic: found",
        roles ?? `Roles: ${part} / ${part}, same`,
        SAME_DETAIL,
        time ?? "The Document states it.",
        evidence ?? "Evidence: [1]",
      ].join("\n");
      const ran = await run(said);
      expect(judged(ran.result)).toMatchObject(ends);
      expect(ran.looks.get(part)).toBe(1);
    },
  );

  test("a supported second reply with no Absence line is Not checked (#2313)", async () => {
    const claim = "Customer churn fell to 3.9 per cent after the onboarding redesign.";
    const part = "after the onboarding redesign";
    const quote = "Customer churn fell to 4.2 per cent after the onboarding redesign.";
    const result = await check(
      claim,
      [
        { kind: "fact", text: "Customer churn fell to 3.9 per cent" },
        { kind: "fact", text: part },
      ],
      {
        [part]: {
          quotes: [quote],
          reply: `Verdict: contradicted\nRoles: ${part} / ${part}, same\nThe Document gives 4.2 per cent.\nEvidence: [1]`,
          judgement: "same",
          again: `Verdict: supported\nScope: none, same\nTopic: found\nRoles: ${part} / ${part}, same\n${SAME_DETAIL}\nThe Document states it.\nEvidence: [1]`,
        },
        "Customer churn fell to 3.9 per cent": { quotes: [quote] },
      },
    );
    const judged = result.result.parts?.find(
      (each) => claim.slice(each.span.start, each.span.end) === part,
    );
    expect(judged?.verdict).toBe("not-checked");
  });

  test("a unit problem on a contradicted part is refused before the second look (#2313)", async () => {
    const claim = "According to the covenant, the leverage was £3.1 million.";
    const first = "According to the covenant";
    const part = "the leverage was £3.1 million";
    const quote = "According to the covenant, the leverage was 3.1 million.";
    const result = await check(
      claim,
      [
        { kind: "fact", text: first },
        { kind: "fact", text: part },
      ],
      {
        [first]: { quotes: [quote] },
        [part]: {
          quotes: [quote],
          reply: `Verdict: contradicted\nRoles: ${part} / ${part}, same\nThe Document gives 3.1 million.\nEvidence: [1]`,
          judgement: "same",
        },
      },
    );
    const judged = result.result.parts?.find(
      (each) => claim.slice(each.span.start, each.span.end) === part,
    );
    expect(judged?.verdict).toBe("unsupported");
    expect(result.looks.get(part) ?? 0).toBe(0);
  });

  test("the unsupported path asks only with an Absence line and a quote that states the part (#2313)", async () => {
    const claim = "Customer churn fell to 3.9 per cent after the onboarding redesign.";
    const part = "after the onboarding redesign";
    const quote = "Customer churn fell to 4.2 per cent after the onboarding redesign.";
    const run = (absence: string, said: string) =>
      check(
        claim,
        [
          { kind: "fact", text: "Customer churn fell to 3.9 per cent" },
          { kind: "fact", text: part },
        ],
        {
          [part]: {
            quotes: [said],
            reply: `Verdict: unsupported\n${absence}Scope: none, same\nTopic: found\nRoles: ${part} / ${part}, same\nThe Documents do not say it.\nEvidence: [1]`,
          },
          "Customer churn fell to 3.9 per cent": { quotes: [said] },
        },
      );
    const noAbsence = await run("", quote);
    expect(noAbsence.looks.get(part) ?? 0).toBe(0);
    const lacksDetail = await run("Absence: no\n", "Customer churn fell to 4.2 per cent.");
    expect(lacksDetail.looks.get(part) ?? 0).toBe(0);
    const asks = await run("Absence: no\n", quote);
    expect(asks.looks.get(part)).toBe(1);
  });

  test("an unsupported reply whose own fields say the claim is stated is asked once more (#2313)", async () => {
    const claim = "Customer churn fell to 3.9 per cent after the onboarding redesign.";
    const part = "after the onboarding redesign";
    const quote = "Customer churn fell to 4.2 per cent after the onboarding redesign.";
    const result = await check(
      claim,
      [
        { kind: "fact", text: "Customer churn fell to 3.9 per cent" },
        { kind: "fact", text: part },
      ],
      {
        [part]: {
          quotes: [quote],
          reply: `Verdict: unsupported\nAbsence: no\nScope: none, same\nTopic: found\nRoles: ${part} / ${part}, same\nThe Documents do not say it.\nEvidence: [1]`,
        },
        "Customer churn fell to 3.9 per cent": { quotes: [quote] },
      },
    );
    const judged = result.result.parts?.find(
      (each) => claim.slice(each.span.start, each.span.end) === part,
    );
    expect(judged?.verdict).toBe("not-checked");
    expect(result.looks.get(part)).toBe(1);
  });

  test.each([
    { name: "no Roles line", fields: "" },
    { name: "Roles: same", fields: "Roles: same\n" },
    { name: "none / none", fields: "Roles: none / none, same\n" },
    { name: "empty sides", fields: "Roles:  / , same\n" },
  ])(
    "reversed parties are not Supported from a reply that gives no own-words Roles sides ($name, #2313)",
    async ({ fields }) => {
      const claim = "Under the contract, the Buyer indemnifies the Seller.";
      const first = "Under the contract";
      const part = "the Buyer indemnifies the Seller";
      const quote = "Under the contract, the Seller indemnifies the Buyer.";
      const run = (reply: string, stated = quote) =>
        check(
          claim,
          [
            { kind: "fact", text: first },
            { kind: "fact", text: part },
          ],
          {
            [first]: { quotes: [stated] },
            [part]: { quotes: [stated], reply, judgement: "same" },
          },
        );

      expect(
        partOutcome(
          await run(
            `Verdict: contradicted\n${fields}The Document gives it the other way.\nEvidence: [1]`,
          ),
          claim,
          part,
        ),
      ).toEqual(unsupportedUnasked);
      // The quote states the part; the reply's Roles line gives no side to compare.
      expect(
        partOutcome(
          await run(
            "Verdict: contradicted\nRoles: same\nThe Document gives it the other way.\nEvidence: [1]",
            claim,
          ),
          claim,
          part,
        ),
      ).toEqual(unsupportedUnasked);
      // Paired: the part's own words as the Roles line's first side are asked once more, which
      // can't make them Supported (#2816).
      expect(
        partOutcome(
          await run(
            `Verdict: contradicted\nRoles: ${part} / ${part}, same\nThe Document gives it the other way.\nEvidence: [1]`,
            claim,
          ),
          claim,
          part,
        ),
      ).toEqual(notCheckedAsked);
    },
  );

  test("a part whose own detail the quote does not state stays Unsupported (#2313)", async () => {
    const claim = "The harbour office publishes the times of high water every year.";
    const first = "The harbour office publishes the times of high water";
    const part = "every year";
    const run = (quote: string) =>
      check(
        claim,
        [
          { kind: "fact", text: first },
          { kind: "fact", text: part },
        ],
        {
          [first]: { quotes: [quote] },
          [part]: {
            quotes: [quote],
            reply: `Verdict: contradicted\nRoles: ${part} / ${part}, same\nThe Document gives it another way.\nEvidence: [1]`,
            judgement: "same",
          },
        },
      );

    expect(
      partOutcome(
        await run("The harbour office publishes the times of high water every week."),
        claim,
        part,
      ),
    ).toEqual(unsupportedUnasked);
    // Paired: the same part, stated by the quote, is asked once more, which can't make it
    // Supported (#2816).
    expect(
      partOutcome(
        await run("The harbour office publishes the times of high water every year."),
        claim,
        part,
      ),
    ).toEqual(notCheckedAsked);
  });

  test("a part whose quote states its figure without its unit stays Unsupported (#2313)", async () => {
    const claim = "The fee is £3.1m in total.";
    const first = "The fee is";
    const part = "£3.1m in total";
    const run = (quote: string) =>
      check(
        claim,
        [
          { kind: "fact", text: first },
          { kind: "fact", text: part },
        ],
        {
          [first]: { quotes: [quote] },
          [part]: {
            quotes: [quote],
            reply: `Verdict: contradicted\nRoles: ${part} / ${part}, same\nThe quote gives the number without its unit.\nEvidence: [1]`,
            judgement: "same",
          },
        },
      );

    expect(partOutcome(await run("The fee is 3,100,000 in total."), claim, part)).toEqual(
      unsupportedUnasked,
    );
    // Paired: the same value with its unit stated in the quote is asked once more, which can't
    // make it Supported (#2816).
    expect(partOutcome(await run("The fee is £3.1 million in total."), claim, part)).toEqual(
      notCheckedAsked,
    );
  });

  test("a part whose worked-out figure doesn't settle its other quantity stays Not checked (#2313)", async () => {
    const claim = "The leverage was 3.25x and profit rose 10%.";
    const first = "The leverage was";
    const quote = "Net debt of £528.9m over EBITDA of £162.7m gave leverage of 3.25x.";
    const calculation = {
      stated: "3.25x",
      formula: "n1 / n2",
      inputs: [
        { name: "n1", quote: "Net debt of £528.9m", number: "528.9" },
        { name: "n2", quote: "EBITDA of £162.7m", number: "162.7" },
      ],
    };
    const run = (extraClaim: string) =>
      check(
        extraClaim,
        [
          { kind: "fact", text: first },
          { kind: "fact", text: extraClaim.slice(first.length + 1) },
        ],
        {
          [first]: { quotes: [quote] },
          [extraClaim.slice(first.length + 1)]: { quotes: [quote], calculation },
        },
      );

    const unsolved = await run(claim);
    expect(unsolved.result.parts?.[1]).toMatchObject({
      verdict: "not-checked",
      reason: "no-evidence",
    });
    // Paired: with every quantity it states settled, the part stands on its working.
    const settled = await run("The leverage was 3.25x.");
    expect(settled.result.parts?.[1]?.verdict).toBe("supported");
  });

  test("a whole sentence whose only part drops its closing stop is no part (#2313)", async () => {
    const claim = "The rate is 36.8%.";
    const part = "The rate is 36.8%";
    const quote = "The rate is 36.8%.";
    const outcome = {
      quotes: [quote],
      reply: `Verdict: contradicted\nThe Document says it another way.\nEvidence: [1]`,
      judgement: "same" as const,
    };
    const whole = await check(claim, [{ kind: "fact", text: part }], { [part]: outcome });
    expect(whole.result.parts?.[0]).toMatchObject({
      verdict: "not-checked",
      reason: "no-evidence",
    });
    expect(whole.looks.get(part) ?? 0).toBe(0);
    // Paired: the walk's real part, with words around it, is asked once more on its quote, which
    // can't make it Supported (#2816).
    const genuine = await check(
      "Customer churn fell to 4.2 per cent after the onboarding redesign.",
      [
        { kind: "fact", text: "Customer churn fell to 4.2 per cent" },
        { kind: "fact", text: "after the onboarding redesign" },
      ],
      {
        "Customer churn fell to 4.2 per cent": {
          quotes: ["Customer churn fell to 4.2 per cent after the onboarding redesign."],
        },
        "after the onboarding redesign": {
          quotes: ["Customer churn fell to 4.2 per cent after the onboarding redesign."],
          reply: `Verdict: contradicted\nRoles: after the onboarding redesign / after the onboarding redesign, same\nThe sentence's link is otherwise as stated.\nEvidence: [1]`,
          judgement: "same",
        },
      },
    );
    expect(genuine.result.parts?.[1]?.verdict).toBe("not-checked");
    expect(genuine.looks.get("after the onboarding redesign")).toBe(1);
  });

  test("keeps independent facts and their separate Sources without quantified coverage", async () => {
    const first = "Rook's North branch opened in March 2025";
    const second = "its South branch opened in July 2025";
    const claim = `${first} and ${second}.`;
    const { result } = await check(
      claim,
      [
        { kind: "fact", text: first },
        { kind: "fact", text: second },
      ],
      {
        [first]: { quotes: ["Rook's North branch opened in March 2025."] },
        [second]: { quotes: ["Rook's South branch opened in July 2025."] },
      },
    );
    expect(
      result.verdict,
      result.verdict === "not-checked"
        ? `${result.reason}: ${result.detail}; parts=${result.parts?.map((part) => `${part.kind}:${part.verdict}:${part.reason}`).join(",")}`
        : undefined,
    ).toBe("supported");
    expect(result.parts).toHaveLength(2);
    expect(result.parts?.map((part) => part.evidence.length)).toEqual([1, 1]);
    expect(result.parts?.every((part) => part.coverage === undefined)).toBe(true);
    expect(result.versions).toHaveLength(2);
  });

  test("a legal prefix binds later literal parts but a neighbouring paragraph does not", async () => {
    const first = "rent is paid";
    const second = "the Landlord maintains the roof";
    const prefix = "Under [2024] UKSC 5";
    const claim = `${prefix}, ${first} and ${second}.`;
    const plans: Part[] = [
      { kind: "fact", text: first },
      { kind: "fact", text: second },
    ];
    const outcomes = {
      [first]: { quotes: ["The contract says rent is paid."] },
      // The prefix the parts leave out is a condition of the fact after it, so it is checked with it.
      [`${prefix}, ${first}`]: { quotes: ["The contract says rent is paid."] },
      [second]: { quotes: ["The Landlord maintains the roof."] },
    };
    const legal = await check(claim, plans, outcomes);
    expect(legal.result.verdict).toBe("supported");
    expect(legal.result.parts?.map((part) => claim.slice(part.span.start, part.span.end))).toEqual([
      `${prefix}, ${first}`,
      second,
    ]);
    expect(legal.result.parts?.map((part) => part.citedCaseUnchecked)).toEqual([true, true]);
    const ordinary = await check(
      `${first} and ${second}.`,
      plans,
      outcomes,
      "en",
      "A neighbouring sentence mentions [2024] UKSC 5.",
    );
    expect(ordinary.result.verdict).toBe("supported");
    expect(ordinary.result.parts?.map((part) => part.citedCaseUnchecked)).toEqual([false, false]);
  });

  test.each([
    ["Rook's North branch opened\nin March 2025", "its South branch opened in July 2025"],
    ["北区分店于2025年3月\n开业", "南区分店于2025年7月开业"],
  ])("literal parts preserve a hard break: %s", async (first, second) => {
    const claim = `${first} and ${second}.`;
    const { result } = await check(
      claim,
      [
        { kind: "fact", text: first },
        { kind: "fact", text: second },
      ],
      {
        [first]: { quotes: [first.replaceAll("\n", " ") + "."] },
        [second]: { quotes: [second + "."] },
      },
    );
    expect(result.verdict).toBe("supported");
    expect(result.parts?.map((part) => claim.slice(part.span.start, part.span.end))).toEqual([
      first,
      second,
    ]);
  });

  test("an explicit standalone check preserves two distinct opinion spans", async () => {
    const first = "We find this risky";
    const second = "we find the timing unfortunate";
    const claim = `${first}, and ${second}.`;
    const { result } = await check(
      claim,
      [
        { kind: "opinion", text: first },
        { kind: "opinion", text: second },
      ],
      {
        [first]: {
          quotes: ["This is a proposal."],
          reply: "Verdict: unsupported\nEvidence: [1]\nCalculation: none",
        },
        [second]: {
          quotes: ["It will be discussed on Tuesday."],
          reply: "Verdict: unsupported\nEvidence: [1]\nCalculation: none",
        },
      },
    );
    expect(result.verdict).toBe("unsupported");
    expect(
      result.parts?.map((part) => [
        claim.slice(part.span.start, part.span.end),
        part.kind,
        part.verdict,
      ]),
    ).toEqual([
      [first, "opinion", "unsupported"],
      [second, "opinion", "unsupported"],
    ]);
  });

  test("a single literal fact retains every complementary checked quote", async () => {
    const claim = "Rook operated North and South branches.";
    const quotes = ["Rook operated the North branch.", "Rook operated the South branch."];
    const { result } = await check(claim, [{ kind: "fact", text: claim }], { [claim]: { quotes } });
    expect(result.verdict).toBe("supported");
    expect(result.parts?.[0]?.evidence.map((citation) => citation.quote)).toEqual(quotes);
    expect(new Set(result.parts?.[0]?.evidence.map((citation) => citation.documentId)).size).toBe(
      2,
    );
  });

  test("an unfound named quote cannot be replaced by an earlier valid marker", async () => {
    const claim = "The North branch operated.";
    const { result } = await check(claim, [{ kind: "fact", text: claim }], {
      [claim]: {
        quotes: [claim],
        reply: "Verdict: supported\nAbsence: no\nEvidence: [1, 99]\nCalculation: none",
      },
    });
    expect(
      result.verdict,
      result.verdict === "not-checked"
        ? `${result.reason}: ${result.detail}; parts=${result.parts?.map((part) => `${part.kind}:${part.verdict}:${part.reason}`).join(",")}`
        : undefined,
    ).toBe("not-checked");
    expect(result.parts?.[0]?.verdict).toBe("not-checked");
  });

  test.each(["en", "zh-CN"] as const)(
    "typed forecast certainty retains Source words and exact %s reason",
    async (language) => {
      const claim =
        language === "en"
          ? "Larch's revenue will reach GBP 10 million in 2027."
          : "Larch 2027年的收入将达到1000万英镑。";
      const quote =
        language === "en"
          ? "Larch forecasts 2027 revenue of GBP 10 million."
          : "Larch预测2027年的收入为1000万英镑。";
      const { result } = await check(
        claim,
        [{ kind: "fact", text: claim }],
        {
          [claim]: {
            quotes: [quote],
            reply:
              "Verdict: unsupported\nTopic: found\nReason kind: forecast-certainty\nEvidence: [1]\nCalculation: none",
          },
        },
        language,
      );
      expect(
        result.verdict,
        result.verdict === "not-checked"
          ? `${result.reason}: ${result.detail}; parts=${result.parts?.map((part) => `${part.kind}:${part.verdict}:${part.reason}`).join(",")}`
          : undefined,
      ).toBe("unsupported");
      expect(result.parts?.[0]?.unsupported).toMatchObject({
        kind: "forecast-certainty",
        reason:
          language === "en"
            ? "The Document forecasts this but doesn’t say it will happen"
            : "文档只是作出预测，没有说这一定会发生",
        quoted: { quote },
      });
    },
  );

  test("two established events do not prove their causal link", async () => {
    const claim = "Costs rose, profits fell, and the cost rise caused the fall.";
    const quotes = ["Costs rose in 2025.", "Profits fell in 2025."];
    const { result } = await check(claim, [{ kind: "fact", text: claim }], {
      [claim]: {
        quotes,
        reply:
          "Verdict: unsupported\nTopic: found\nReason kind: unbacked-cause\nEvidence: [1, 2]\nCalculation: none",
      },
    });
    expect(
      result.verdict,
      result.verdict === "not-checked"
        ? `${result.reason}: ${result.detail}; parts=${result.parts?.map((part) => `${part.kind}:${part.verdict}:${part.reason}`).join(",")}`
        : undefined,
    ).toBe("unsupported");
    expect(result.parts?.[0]?.unsupported).toMatchObject({
      kind: "unbacked-cause",
      reason: "The Documents state both, but not that one caused the other.",
    });
    expect(result.parts?.[0]?.evidence).toHaveLength(2);
  });

  test.each([true, false])(
    "quantified members keep domain evidence separate, complete=%s",
    async (complete) => {
      const claim = "All stores passed the inspection.";
      const quotes = [
        "North passed the inspection.",
        "North and South are the complete store network.",
      ];
      const coverage = {
        unit: "stores",
        quantifier: "all",
        complete,
        members: [
          { label: "North", verdict: "supported", evidence: [1] },
          { label: "South", verdict: "unsupported", evidence: [] },
        ],
        domainEvidence: [2],
      };
      const { result } = await check(claim, [{ kind: "fact", text: claim }], {
        [claim]: {
          quotes,
          reply: `Verdict: supported\nAbsence: no\nTopic: found\nEvidence: [1, 2]\nCoverage: ${JSON.stringify(coverage)}\nCalculation: none`,
        },
      });
      expect(
        result.verdict,
        result.verdict === "not-checked"
          ? `${result.reason}: ${result.detail}; parts=${result.parts?.map((part) => `${part.kind}:${part.verdict}:${part.reason}`).join(",")}`
          : undefined,
      ).toBe("unsupported");
      expect(
        result.parts?.[0]?.coverage?.members.map((member) => [
          member.label,
          member.verdict,
          member.evidence.length,
        ]),
      ).toEqual([
        ["North", "supported", 1],
        ["South", "unsupported", 0],
      ]);
      expect(result.parts?.[0]?.coverage?.domainEvidence.map((citation) => citation.quote)).toEqual(
        [quotes[1]],
      );
    },
  );

  test.each([
    ["all", "unsupported"],
    ["most", "supported"],
  ] as const)(
    "%s keeps an unknown fourth member in the denominator",
    async (quantifier, expected) => {
      const claim = `${quantifier === "all" ? "All" : "Most"} stores passed the inspection.`;
      const quotes = [
        "North passed the inspection.",
        "South passed the inspection.",
        "East passed the inspection.",
        "North, South, East and West are the complete store network.",
      ];
      const coverage = {
        unit: "stores",
        quantifier,
        complete: true,
        members: ["North", "South", "East"]
          .map((label, index) => ({ label, verdict: "supported", evidence: [index + 1] }))
          .concat([{ label: "West", verdict: "not-checked", evidence: [] }]),
        domainEvidence: [4],
      };
      const { result } = await check(claim, [{ kind: "fact", text: claim }], {
        [claim]: {
          quotes,
          reply: `Verdict: supported\nAbsence: no\nTopic: found\nEvidence: [1,2,3,4]\nCoverage: ${JSON.stringify(coverage)}\nCalculation: none`,
        },
      });
      expect(result.verdict).toBe(expected);
      expect(result.parts?.[0]?.coverage).toMatchObject({
        quantifier,
        complete: true,
        members: expect.any(Array),
      });
      expect(result.parts?.[0]?.coverage?.members).toHaveLength(4);
    },
  );

  test.each([
    ["three", "Elm recorded three consecutive years of revenue growth ending in 2025."],
    ["三年", "截至2025年，榆木公司的收入连续三年增长。"],
  ])("a derived count %s has a real receipt", async (stated, claim) => {
    const inputs = [100, 110, 120, 130].map((number, index) => ({
      name: `r${2022 + index}`,
      number: String(number),
      quote: `Revenue for ${2022 + index} was GBP ${number}.`,
    }));
    const { result } = await check(claim, [{ kind: "fact", text: claim }], {
      [claim]: {
        quotes: [],
        calculation: {
          stated,
          inputs,
          formula: INCREASES,
        },
      },
    });
    expect(result.verdict).toBe("supported");
    expect(result.parts?.[0]?.calculation).toMatchObject({
      stated: expect.stringContaining(stated[0] ?? ""),
      agrees: true,
      figure: { value: 3, inputs: expect.any(Array) },
    });
    expect(result.parts?.[0]?.calculation?.figure.inputs).toHaveLength(4);
  });

  test.each([
    "Elm recorded three consecutive years of revenue growth ending in 2025.",
    "截至2025年，榆木公司的收入连续三年增长。",
  ])("annual inputs without calculation cannot establish the count: %s", async (claim) => {
    const quotes = [2022, 2023, 2024, 2025].map(
      (year, index) => `Revenue for ${year} was ${100 + index * 10}.`,
    );
    const { result } = await check(claim, [{ kind: "fact", text: claim }], { [claim]: { quotes } });
    expect(result.verdict).toBe("not-checked");
    expect(result.parts?.[0]?.calculation).toBeNull();
  });

  test.each([
    [
      "Elm recorded three consecutive years of revenue growth ending in 2025.",
      "Elm recorded 3 consecutive years of revenue growth ending in 2025.",
    ],
    ["截至2025年，榆木公司的收入连续三年增长。", "截至2025年，榆木公司的收入连续3年增长。"],
    ["Elm's revenue rose in 2025.", "Elm's revenue rose in 2025."],
    ["Three stores reported last year.", "Three stores reported last year."],
  ])(
    "a directly quoted count or calendar statement needs no arithmetic: %s",
    async (claim, quote) => {
      const { result, calls } = await check(claim, [{ kind: "fact", text: claim }], {
        [claim]: { quotes: [quote] },
      });
      expect(result.verdict).toBe("supported");
      expect(calls.some((call) => call.results.some((result) => result.tool === "calculate"))).toBe(
        false,
      );
    },
  );

  test("direct months contradict only after the existing two confirmations", async () => {
    const claim = "The lease lasts 6 months.";
    const { result, judgements } = await check(claim, [{ kind: "fact", text: claim }], {
      [claim]: {
        quotes: ["The lease lasts 12 months."],
        judgement: "conflict",
        reply:
          "Verdict: contradicted\nScope: none, same\nTopic: found\nRoles: none, same\nIt lasts 12 months rather than 6 months. [^1]\nEvidence: [1]\nCalculation: none",
      },
    });
    expect(result.verdict).toBe("contradicted");
    expect(judgements).toHaveLength(2);
  });

  test("a computed count that disagrees cannot become Supported", async () => {
    const claim = "Elm recorded three consecutive years of revenue growth ending in 2025.";
    const inputs = [100, 110, 105, 130].map((number, index) => ({
      name: `r${2022 + index}`,
      number: String(number),
      quote: `Revenue for ${2022 + index} was GBP ${number}.`,
    }));
    const { result } = await check(claim, [{ kind: "fact", text: claim }], {
      [claim]: {
        quotes: [],
        calculation: {
          stated: "three",
          inputs,
          formula: INCREASES,
        },
      },
    });
    expect(result.verdict).toBe("contradicted");
    expect(result.parts?.[0]?.calculation).toMatchObject({ agrees: false, figure: { value: 2 } });
  });

  test.each([
    [100, 110, 110, 130, 2],
    [100, 100, 100, 100, 0],
  ])(
    "flat annual steps have a numeric count without division by zero: %j",
    async (a, b, c, d, count) => {
      const claim = "Elm recorded three consecutive years of revenue growth ending in 2025.";
      const inputs = [a, b, c, d].map((number, index) => ({
        name: `r${2022 + index}`,
        number: String(number),
        quote: `Revenue for ${2022 + index} was GBP ${number}.`,
      }));
      const { result } = await check(claim, [{ kind: "fact", text: claim }], {
        [claim]: { quotes: [], calculation: { stated: "three", inputs, formula: INCREASES } },
      });
      expect(result.verdict).toBe("contradicted");
      expect(result.parts?.[0]?.calculation).toMatchObject({
        agrees: false,
        figure: { value: count, unit: { kind: "plain" }, inputs: expect.any(Array) },
      });
      expect(result.parts?.[0]?.calculation?.figure.inputs).toHaveLength(4);
    },
  );

  describe.each(["en", "zh-CN"] as const)("%s monetary receipts", (language) => {
    test.each([100, 0, -100])(
      "a dimensionless SIGN result is not a monetary amount: %s",
      async (balance) => {
        const claim = language === "en" ? "The balance is GBP 1." : "余额为1英镑。";
        const quote =
          language === "en" ? `The balance is GBP ${balance}.` : `余额为${balance}英镑。`;
        const { result, calls } = await check(
          claim,
          [{ kind: "fact", text: claim }],
          {
            [claim]: {
              quotes: [],
              calculation: {
                stated: language === "en" ? "GBP 1" : "1英镑",
                formula: "SIGN(balance)",
                inputs: [{ name: "balance", number: String(balance), quote }],
              },
            },
          },
          language,
        );
        const replies = calls.flatMap((call) => call.results);
        expect(replies.find((reply) => reply.tool === "calculate")?.text).toMatch(
          /^Recorded \[=1\] = /,
        );
        expect(result).toMatchObject({ verdict: "not-checked", reason: "no-evidence" });
        expect(result.parts?.[0]?.calculation).toBeNull();
      },
    );

    test.each([100, 99])(
      "a genuine currency result retains its matching monetary unit: %s",
      async (stated) => {
        const claim = language === "en" ? `The balance is GBP ${stated}.` : `余额为${stated}英镑。`;
        const quote = language === "en" ? "The balance is GBP 100." : "余额为100英镑。";
        const { result } = await check(
          claim,
          [{ kind: "fact", text: claim }],
          {
            [claim]: {
              quotes: [],
              calculation: {
                as: "currency",
                stated: language === "en" ? `GBP ${stated}` : `${stated}英镑`,
                formula: "SUM(balance)",
                inputs: [{ name: "balance", number: "100", quote }],
              },
            },
          },
          language,
        );
        expect(result.verdict).toBe(stated === 100 ? "supported" : "contradicted");
        expect(result.parts?.[0]?.calculation).toMatchObject({
          agrees: stated === 100,
          figure: {
            value: 100,
            unit: { kind: "currency", code: "GBP" },
            inputs: [{ number: { unit: { kind: "currency", code: "GBP" } } }],
          },
        });
      },
    );

    test("the legacy currency fallback keeps actually plain inputs", async () => {
      const claim = language === "en" ? "The balance is GBP 50." : "余额为50英镑。";
      const quote = language === "en" ? "The account is denominated in GBP." : "账户以英镑计价。";
      const inputs = [
        {
          name: "opening",
          number: "40",
          quote: language === "en" ? "The opening balance is 40." : "期初余额为40。",
        },
        {
          name: "adjustment",
          number: "10",
          quote: language === "en" ? "The adjustment is 10." : "调整额为10。",
        },
      ];
      const { result } = await check(
        claim,
        [{ kind: "fact", text: claim }],
        {
          [claim]: {
            quotes: [quote],
            calculation: {
              stated: language === "en" ? "GBP 50" : "50英镑",
              formula: "SUM(opening,adjustment)",
              inputs,
            },
          },
        },
        language,
      );
      expect(result.verdict).toBe("supported");
      expect(result.parts?.[0]?.calculation).toMatchObject({
        agrees: true,
        figure: {
          value: 50,
          unit: { kind: "plain" },
          inputs: [
            { number: { unit: { kind: "plain" } } },
            { number: { unit: { kind: "plain" } } },
          ],
        },
      });
    });

    test.each([false, true])(
      "a measured input cannot hide behind a plain input: %s",
      async (first) => {
        const claim = language === "en" ? "The balance is GBP 1." : "余额为1英镑。";
        const measured = {
          name: "balance",
          number: "100",
          quote: language === "en" ? "The balance is GBP 100." : "余额为100英镑。",
        };
        const plain = {
          name: "adjustment",
          number: "0",
          quote: language === "en" ? "The adjustment is 0." : "调整额为0。",
        };
        const { result, calls } = await check(
          claim,
          [{ kind: "fact", text: claim }],
          {
            [claim]: {
              quotes: [],
              calculation: {
                stated: language === "en" ? "GBP 1" : "1英镑",
                formula: "SUM(SIGN(balance),SIGN(adjustment))",
                inputs: first ? [measured, plain] : [plain, measured],
              },
            },
          },
          language,
        );
        expect(
          calls.flatMap((call) => call.results).find((reply) => reply.tool === "calculate")?.text,
        ).toMatch(/^Recorded \[=1\] = /);
        expect(result).toMatchObject({ verdict: "not-checked", reason: "no-evidence" });
        expect(result.parts?.[0]?.calculation).toBeNull();
      },
    );
  });

  test("an unavailable base-year input quote cannot provide a count receipt", async () => {
    const claim = "Elm recorded three consecutive years of revenue growth ending in 2025.";
    const inputs = [100, 110, 120, 130].map((number, index) => ({
      name: `r${2022 + index}`,
      number: String(number),
      quote: `Revenue for ${2022 + index} was GBP ${number}.`,
    }));
    const { result } = await check(claim, [{ kind: "fact", text: claim }], {
      [claim]: {
        quotes: [],
        sourceQuotes: inputs.slice(1).map((input) => input.quote),
        calculation: {
          stated: "three",
          inputs,
          formula: INCREASES,
        },
      },
    });
    expect(result.verdict).toBe("not-checked");
  });
});

describe("structural part and declared-count readers", () => {
  test("a literal span retains UTF16 positions after an astral character", () => {
    const sentence = "🌳 我认为时机不妥，但成本上涨了40%。";
    const opinion = "我认为时机不妥";
    const literal = "成本上涨了40%";
    const parts = [
      { kind: "opinion", text: opinion },
      { kind: "fact", text: literal },
    ];
    expect(
      readClaimParts(JSON.stringify({ sentences: [{ number: 1, parts }] }), [
        { number: 1, text: sentence },
      ])?.get(1),
    ).toEqual([
      {
        kind: "opinion",
        span: { start: sentence.indexOf(opinion), end: sentence.indexOf(opinion) + opinion.length },
      },
      {
        kind: "fact",
        span: { start: sentence.indexOf(literal), end: sentence.indexOf(literal) + literal.length },
      },
    ]);
  });

  test.each([
    { claims: [1] },
    { sentences: [{ number: 2, parts: [] }] },
    { sentences: [{ number: 1, parts: [{ kind: "fact", text: "rewritten" }] }] },
    {
      sentences: [
        {
          number: 1,
          parts: [
            { kind: "fact", text: "second" },
            { kind: "fact", text: "first" },
          ],
        },
      ],
    },
  ])("rejects missing or rewritten inventories: %j", (reply) => {
    expect(
      readClaimParts(JSON.stringify(reply), [{ number: 1, text: "first and second" }]),
    ).toBeNull();
  });

  test.each([
    ["three", 3],
    ["one hundred and twenty-eight", 128],
    ["four five", null],
    ["three years", null],
    ["three and four", null],
  ])("whole number words %s", (word, value) => {
    expect(wholeNumberWords(String(word))).toBe(value);
  });

  test.each([
    ["three", "three years, then three consecutive years.", null],
    ["three", "Three consecutive years.", null],
    ["三年", "收入连续三年增长。", 3],
  ])("reads only an exact unique declared count %s", (stated, sentence, value) => {
    expect(
      statedFigure(String(sentence), String(stated), { language: "zh-CN" })?.value ?? null,
    ).toBe(value);
  });

  test("engine-placed Citation markers do not corrupt metadata JSON", () => {
    const coverage = {
      unit: "stores",
      quantifier: "all",
      complete: false,
      members: [
        { label: "North", verdict: "supported", evidence: [1] },
        { label: "South", verdict: "unsupported", evidence: [] },
      ],
      domainEvidence: [2],
    };
    expect(
      readVerdict(
        `Verdict: unsupported\nEvidence: [1,2][^1]\nCoverage: ${JSON.stringify(coverage)}[^2]`,
      ),
    ).toMatchObject({ evidence: [1, 2], coverage });
  });

  test.each([
    ["three consecutive years", 3, "year"],
    ["four successive quarters", 4, "quarter"],
    ["6 months", 6, "month"],
    ["two weeks", 2, "week"],
    ["five days", 5, "day"],
    ["连续三年", 3, "year"],
    ["三个月", 3, "month"],
    ["两周", 2, "week"],
    ["三天", 3, "day"],
    ["连续三季度", 3, "quarter"],
  ])("count-unit grammar %s", (text, value, unit) => {
    expect(periodCounts(String(text), {})).toMatchObject([
      { value, unit: { kind: "other", word: unit } },
    ]);
  });
  test.each(["2025年3月1日", "2025年第三季度", "year 2025", "three stores reported last year"])(
    "calendar or nonadjacent words stay out: %s",
    (text) => {
      expect(periodCounts(text, {})).toEqual([]);
    },
  );

  test("display markers do not turn Calculation none into an arithmetic declaration", () => {
    expect(readVerdict("Verdict: supported\nCalculation: none[^1][^2]")?.calculations).toEqual([]);
    expect(readVerdict("Verdict: supported\nCalculation: 2.0x[=1]")?.calculations).toEqual([
      "2.0x",
    ]);
    expect(readVerdict("Verdict: supported\nCalculation: [1]")?.calculations).toEqual(["[1]"]);
    const quote = "The Source prints [^1] and [=2] literally.";
    expect(readEvidence(JSON.stringify({ passage: "P1", quote }))?.quote).toBe(quote);
    expect(
      readClaimParts(
        JSON.stringify({ sentences: [{ number: 1, parts: [{ kind: "fact", text: quote }] }] }),
        [{ number: 1, text: quote }],
      )?.get(1),
    ).toEqual([{ kind: "fact", span: { start: 0, end: quote.length } }]);
  });

  test("a bare array is not a completed calculation", async () => {
    const claim = "The lease lasts 3 years.";
    const { result } = await check(claim, [{ kind: "fact", text: claim }], {
      [claim]: {
        quotes: [claim],
        reply: "Verdict: supported\nAbsence: no\nEvidence: [1]\nCalculation: [1]",
      },
    });
    expect(result.verdict).toBe("not-checked");
  });

  test("invalid evidence and coverage declarations remain invalid", () => {
    expect(readVerdict("Verdict: supported\nEvidence: [1, 1]")?.evidence).toBeNull();
    expect(
      readVerdict('Verdict: supported\nCoverage: {"unit":"stores","members":[]}')?.coverage,
    ).toBeNull();
  });
});

describe.each(["en", "zh-CN"] as const)("%s reply lines that declare nothing", (language) => {
  const claim = language === "en" ? "The North store sold 120 units." : "北店售出120件商品。";

  // protects=an empty calculate list beside a cite works nothing out, so the quote alone decides a sentence it states (#2002); fails_when=the empty list counts as failed arithmetic and leaves the sentence Not checked; no_claim=how often a real model sends one.
  test("an empty calculate list beside a cite leaves the quote to decide", async () => {
    const { result } = await check(
      claim,
      [{ kind: "fact", text: claim }],
      {
        [claim]: { quotes: [claim], emptyCalculate: true },
      },
      language,
    );
    expect(result.verdict).toBe("supported");
  });

  // protects=a Coverage line that says there is none reads as no Coverage line, so an ordinary sentence's verdict stands (#2002); fails_when=Coverage: none or 无 turns the verdict into Not checked; no_claim=a malformed domain, which stays malformed.
  test("a Coverage line of none is no Coverage line", async () => {
    const none = language === "en" ? "none" : "无";
    const { result } = await check(
      claim,
      [{ kind: "fact", text: claim }],
      {
        [claim]: {
          quotes: [],
          sourceQuotes: [
            language === "en" ? "The South store sold 80 units." : "南店售出80件商品。",
          ],
          reply: `Verdict: unsupported\nScope: none, same\nTopic: not found\nRoles: none, same\nNo Passage gives the North store's sales.\nEvidence: []\nCoverage: ${none}`,
        },
      },
      language,
    );
    expect(result.verdict).toBe("unsupported");
    expect(readVerdict(`Verdict: unsupported\nCoverage: ${none}`)).not.toHaveProperty("coverage");
  });
});

describe.each([
  {
    language: "en" as const,
    claim: "Pell Logistics opened a depot in Derby.",
    right: "In May, Pell Logistics opened a depot in Derby, its third in the Midlands.",
    again: "Pell Logistics opened a depot in Derby in May 2026.",
    stray: "The office is closed on public holidays.",
    stated: "three",
    count: "Elm recorded three consecutive years of revenue growth ending in 2025.",
  },
  {
    language: "zh-CN" as const,
    claim: "远航食品在成都开设了新工厂。",
    right: "今年五月，远航食品在成都开设了新工厂，这是其在西南地区的第三家工厂。",
    again: "远航食品在成都开设了新工厂，于五月投产。",
    stray: "办公室在法定节假日休息。",
    stated: "三年",
    count: "截至2025年，榆木公司的收入连续三年增长。",
  },
])("$language: a quote given after a Supported verdict, judged on its own (#2816)", (each) => {
  const judge = (quote: string) => (quote.trim() === each.stray ? "neither" : "same");

  test("is no Citation when it doesn't back the sentence, though a quote beside it does", async () => {
    const run = (given: string) =>
      check(
        each.claim,
        [{ kind: "fact", text: each.claim }],
        {
          [each.claim]: {
            quotes: [each.right],
            sourceQuotes: [each.right, each.again, each.stray],
            reply: `Verdict: supported\nAbsence: no\nScope: none, same\nTopic: found\nRoles: ${each.claim} / ${each.right}, same\nThe Documents establish this.\nEvidence: [1, 2]\nCalculation: none`,
            recovery: [{ marker: 2, quote: given }],
            judge,
          },
        },
        each.language,
      );

    const unbacked = (await run(each.stray)).result;
    expect(unbacked).toMatchObject({ verdict: "not-checked", reason: "no-evidence" });
    expect(unbacked.parts?.[0]?.evidence.map((citation) => citation.quote)).toEqual([each.right]);
    const backed = (await run(each.again)).result;
    expect(backed.verdict).toBe("supported");
    expect(backed.parts?.[0]?.evidence.map((citation) => citation.quote)).toEqual([
      each.right,
      each.again,
    ]);
  });

  test("is judged on a figure worked out by calculation too", async () => {
    const inputs = [100, 110, 120, 130].map((number, index) => ({
      name: `r${2022 + index}`,
      number: String(number),
      quote: `Revenue for ${2022 + index} was GBP ${number}.`,
    }));
    const run = (given: string) =>
      check(
        each.count,
        [{ kind: "fact", text: each.count }],
        {
          [each.count]: {
            quotes: [],
            sourceQuotes: inputs.map((input, index) =>
              index === inputs.length - 1 ? `${input.quote} ${each.stray}` : input.quote,
            ),
            calculation: { stated: each.stated, inputs, formula: INCREASES },
            reply: `Verdict: supported\nAbsence: no\nScope: none, same\nTopic: found\nRoles: ${each.count} / ${each.count}, same\nThe Documents establish this.\nEvidence: [5]\nCalculation: ${each.stated}`,
            recovery: [{ marker: 5, quote: given }],
            judge,
          },
        },
        each.language,
      );

    expect((await run(each.stray)).result).toMatchObject({
      verdict: "not-checked",
      reason: "no-evidence",
    });
    expect((await run("Revenue for 2025 was GBP 130.")).result).toMatchObject({
      verdict: "supported",
      calculation: { agrees: true },
    });
  });
});

describe.each(["en", "zh-CN"] as const)("%s declared evidence recovery", (language) => {
  const claim =
    language === "en" ? "Rook operated North and South branches." : "白鸦公司经营北区和南区分店。";
  const north = language === "en" ? "Rook operated the North branch." : "白鸦公司经营北区分店。";
  const south = language === "en" ? "Rook operated the South branch." : "白鸦公司经营南区分店。";
  const reply = `Verdict: supported\nAbsence: no\nScope: none, same\nTopic: found\nRoles: ${claim} / ${north}, same\nEvidence: [1, 2]\nCalculation: none`;

  test("recovers every missing declared record in one request", async () => {
    const { result, recoveries } = await check(
      claim,
      [{ kind: "fact", text: claim }],
      {
        [claim]: {
          quotes: [],
          sourceQuotes: [north, south],
          reply,
          recovery: [
            { marker: 1, quote: north },
            { marker: 2, quote: south },
          ],
          judgement: "same",
        },
      },
      language,
    );
    expect(result.verdict).toBe("supported");
    expect(result.parts?.[0]?.evidence.map((citation) => [citation.quote, citation.check])).toEqual(
      [
        [north, "found"],
        [south, "found"],
      ],
    );
    expect(recoveries).toHaveLength(1);
    expect(recoveries[0]?.options.maxOutputTokens).toBe(1200);
  });

  test("preserves a found record while recovering only the missing record", async () => {
    const { result, recoveries } = await check(
      claim,
      [{ kind: "fact", text: claim }],
      {
        [claim]: {
          quotes: [north],
          sourceQuotes: [north, south],
          reply,
          recovery: [{ marker: 2, quote: south }],
          judgement: "same",
        },
      },
      language,
    );
    expect(result.verdict).toBe("supported");
    expect(result.parts?.[0]?.evidence.map((citation) => citation.quote)).toEqual([north, south]);
    expect(recoveries).toHaveLength(1);
    expect(recoveries[0]?.options.maxOutputTokens).toBe(600);
  });

  test.each([
    [],
    [{ marker: 1, quote: north }],
    [
      { marker: 1, quote: "" },
      { marker: 2, quote: "" },
    ],
    [
      { marker: 1, quote: north },
      { marker: 1, quote: south },
    ],
    [
      { marker: 1, quote: north },
      { marker: 3, quote: south },
    ],
    [
      { marker: 1, quote: north },
      { marker: 2, quote: "A quote absent from every Document." },
    ],
  ])(
    "missing, duplicate, unexpected or unfound recovered records stay unresolved: %j",
    async (...recovery) => {
      const { result, recoveries } = await check(
        claim,
        [{ kind: "fact", text: claim }],
        {
          [claim]: { quotes: [], sourceQuotes: [north, south], reply, recovery },
        },
        language,
      );
      expect(result).toMatchObject({ verdict: "not-checked", reason: "no-evidence" });
      expect(recoveries).toHaveLength(1);
    },
  );

  test("an existing rejected record is never replaced by a recovered record", async () => {
    const { result, recoveries } = await check(
      claim,
      [{ kind: "fact", text: claim }],
      {
        [claim]: {
          quotes: ["A quote absent from every Document."],
          sourceQuotes: [north, south],
          reply,
          recovery: [
            { marker: 1, quote: north },
            { marker: 2, quote: south },
          ],
        },
      },
      language,
    );
    expect(result).toMatchObject({ verdict: "not-checked", reason: "no-evidence" });
    expect(recoveries).toHaveLength(0);
  });

  test("a found neighbor remains visible beside a failed declared record", async () => {
    const { result, recoveries } = await check(
      claim,
      [{ kind: "fact", text: claim }],
      {
        [claim]: {
          quotes: [north, "A quote absent from every Document."],
          sourceQuotes: [north, south],
          reply,
          recovery: [{ marker: 2, quote: south }],
        },
      },
      language,
    );
    expect(result).toMatchObject({ verdict: "not-checked", reason: "no-evidence" });
    expect(result.parts?.[0]?.evidence.map((citation) => [citation.quote, citation.check])).toEqual(
      [[north, "found"]],
    );
    expect(recoveries).toHaveLength(0);
  });

  test("a recovery provider failure preserves the found neighbor and original failure", async () => {
    const { result, recoveries } = await check(
      claim,
      [{ kind: "fact", text: claim }],
      {
        [claim]: {
          quotes: [north],
          sourceQuotes: [north, south],
          reply,
          recoveryError: { status: 402, message: "Insufficient credits" },
        },
      },
      language,
    );
    expect(result).toMatchObject({ verdict: "not-checked", reason: "out-of-credit" });
    expect(result.parts?.[0]?.evidence.map((citation) => citation.quote)).toEqual([north]);
    expect(recoveries).toHaveLength(1);
  });

  test("coverage-only member and domain references all need checked records", async () => {
    const quantified =
      language === "en" ? "All of Rook's branches operated." : "白鸦公司的全部分店都在营业。";
    const domain =
      language === "en"
        ? "Rook's branches are North and South."
        : "白鸦公司的分店为北区和南区分店。";
    const coverage = {
      unit: "branches",
      quantifier: "all",
      complete: true,
      members: [
        { label: "North", verdict: "supported", evidence: [1] },
        { label: "South", verdict: "supported", evidence: [2] },
      ],
      domainEvidence: [3],
    };
    const { result, recoveries } = await check(
      quantified,
      [{ kind: "fact", text: quantified }],
      {
        [quantified]: {
          quotes: [],
          sourceQuotes: [north, south, domain],
          reply: `Verdict: supported\nAbsence: no\nScope: none, same\nTopic: found\nRoles: ${quantified} / ${domain}, same\nEvidence: []\nCoverage: ${JSON.stringify(coverage)}\nCalculation: none`,
          recovery: [
            { marker: 1, quote: north },
            { marker: 2, quote: south },
            { marker: 3, quote: domain },
          ],
          judgement: "same",
        },
      },
      language,
    );
    expect(result.verdict).toBe("supported");
    expect(result.parts?.[0]?.coverage?.members).toHaveLength(2);
    expect(result.parts?.[0]?.coverage?.domainEvidence).toMatchObject([
      { quote: domain, check: "found" },
    ]);
    expect(result.parts?.[0]?.evidence).toHaveLength(3);
    expect(recoveries).toHaveLength(1);
    expect(recoveries[0]?.options.maxOutputTokens).toBe(1800);
  });

  test("empty evidence on an unsupported reply invents no record", async () => {
    const { result, recoveries } = await check(
      claim,
      [{ kind: "fact", text: claim }],
      {
        [claim]: {
          quotes: [],
          sourceQuotes: [north],
          reply: "Verdict: unsupported\nTopic: not found\nEvidence: []\nCalculation: none",
        },
      },
      language,
    );
    expect(result.verdict).toBe("unsupported");
    expect(result.parts?.[0]?.evidence).toEqual([]);
    expect(recoveries).toHaveLength(0);
  });

  test.each([
    { value: "", valid: false },
    { value: "none", valid: false },
    { value: "[^1]", valid: false },
    { value: "[]", valid: true },
  ])("Evidence: $value remains a strict JSON inventory after cite", async ({ value, valid }) => {
    const reply = `Verdict: unsupported\nTopic: not found\nEvidence: ${value}\nCalculation: none`;
    expect(readVerdict(reply)?.evidence).toEqual(valid ? [] : null);
    const { result, calls, recoveries } = await check(
      claim,
      [{ kind: "fact", text: claim }],
      { [claim]: { quotes: [north], reply } },
      language,
    );
    expect(
      calls.flatMap((call) => call.results).find((result) => result.tool === "cite")?.text,
    ).toMatch(/^Recorded \[\^1\]\./);
    expect(result).toMatchObject(
      valid ? { verdict: "unsupported" } : { verdict: "not-checked", reason: "malformed" },
    );
    expect(recoveries).toHaveLength(0);
  });
});

describe("literal stated quantity repair", () => {
  const claim = "截至2025年，榆木公司的收入连续三年增长。";
  const inputs = [10, 12, 14, 16].map((number, index) => ({
    name: `r${2022 + index}`,
    number: String(number),
    quote: `榆木公司${2022 + index}自然年的收入为${number}个单位。`,
  }));

  test.each([undefined, "three", "三年"])(
    "an unreadable binding can be repaired only by a literal quantity: %s",
    async (fixed) => {
      const calculation = { stated: "three", formula: INCREASES, inputs };
      const { result, calls } = await check(
        claim,
        [{ kind: "fact", text: claim }],
        {
          [claim]: {
            quotes: [],
            calculation,
            ...(fixed && { repair: { ...calculation, stated: fixed } }),
          },
        },
        "zh-CN",
      );
      const feedback = calls
        .flatMap((call, index) => call.results.slice(calls[index - 1]?.results.length ?? 0))
        .filter((reply) => reply.tool === "calculate");
      expect(feedback[0]?.text).toContain("stated");
      expect(feedback[0]?.text).toContain('"three"');
      expect(feedback[0]?.text).not.toMatch(/^Recorded/);
      expect(feedback).toHaveLength(fixed ? 2 : 1);
      if (fixed === "三年") {
        expect(result.verdict).toBe("supported");
        expect(result.parts?.[0]?.calculation).toMatchObject({
          agrees: true,
          stated: "三年",
          figure: { value: 3 },
        });
        expect(result.parts?.[0]?.calculation?.figure.inputs).toHaveLength(4);
      } else {
        expect(result).toMatchObject({ verdict: "not-checked", reason: "no-evidence" });
        expect(result.parts?.[0]?.calculation).toBeNull();
      }
    },
  );
});

describe.each([
  {
    language: "en",
    fact: "Revenue rose.",
    opinion: "We find the proposal risky.",
    source: "The proposal will be discussed.",
  },
  {
    language: "zh-CN",
    fact: "收入增长。",
    opinion: "我们觉得这项提议有风险。",
    source: "这项提议将会进行讨论。",
  },
] as const)("standalone sorting distinctions: $language", ({ language, fact, opinion, source }) => {
  test("an empty-all reply asked twice remains Not checked and never becomes an opinion", async () => {
    const { result, calls, sorts } = await check(
      fact,
      null,
      { [fact]: { quotes: [fact] } },
      language,
    );
    expect(sorts.map((call) => listedSentences(call.prompt))).toEqual([
      [{ number: 1, text: fact }],
      [{ number: 1, text: fact }],
    ]);
    expect(result).toMatchObject({ verdict: "not-checked", reason: "malformed" });
    expect(result.parts?.map((part) => [part.kind, part.verdict])).toEqual([
      ["fact", "not-checked"],
    ]);
    // A Run that names no parts goes on; nothing it found counts, and no part is checked.
    expect([...new Set(calls.filter(sent).map(sentenceOf))]).toEqual([fact]);
  });

  test("an explicit empty inventory retains the User's standalone check", async () => {
    const { result, calls, sorts } = await check(
      fact,
      [],
      { [fact]: { quotes: [fact] } },
      language,
    );
    expect(sorts).toHaveLength(0);
    expect(calls.map(sentenceOf)).toContain(fact);
    expect(result).toMatchObject({
      verdict: "supported",
      parts: [{ kind: "fact", verdict: "supported", span: { start: 0, end: fact.length } }],
    });
  });

  test("a genuine opinion retains its declared span and explicit check", async () => {
    const { result, calls, sorts } = await check(
      opinion,
      [{ kind: "opinion", text: opinion }],
      {
        [opinion]: {
          quotes: [],
          sourceQuotes: [source],
          reply: "Verdict: unsupported\nTopic: not found\nEvidence: []\nCalculation: none",
        },
      },
      language,
    );
    expect(sorts).toHaveLength(0);
    expect(calls.map(sentenceOf)).toContain(opinion);
    expect(result).toMatchObject({
      verdict: "unsupported",
      parts: [{ kind: "opinion", verdict: "unsupported", span: { start: 0, end: opinion.length } }],
    });
  });
});

describe("a part the quote states keeps its own duty and condition (#1766, #1708)", () => {
  const claim = "The berth costs 40 pounds a night, and berth holders may run a generator.";
  const first = "The berth costs 40 pounds a night";
  const part = "berth holders may run a generator";
  const quote =
    "The berth costs 30 pounds a night, and berth holders may run a generator only if the harbour master agrees.";
  const run = (fields: string, again?: string, said = quote) =>
    check(
      claim,
      [
        { kind: "fact", text: first },
        { kind: "fact", text: part },
      ],
      {
        [first]: { quotes: [said] },
        [part]: {
          quotes: [said],
          reply: `Verdict: contradicted\nRoles: berth holders may run / berth holders may run, same\nTime: none / none, same\nScope: none, same\n${fields}\nThe Document gives another price.\nEvidence: [1]`,
          judgement: "same",
          asWritten: true,
          ...(again !== undefined && { again }),
        },
      },
    );
  const looked = (lines: string) =>
    `Verdict: supported\nAbsence: no\nScope: none, same\nTopic: found\nRoles: ${part} / ${part}, same\n${lines}\nThe Document states it.\nEvidence: [1]`;
  const both = "Duty: may / may, same\nCondition: none / none, same";
  const judged = (
    parts: readonly { span: { start: number; end: number }; verdict: string | null }[],
  ) => parts.find((each) => claim.slice(each.span.start, each.span.end) === part)?.verdict;

  test.each([
    {
      name: "a condition the part leaves out",
      said: "Duty: may / may, same\nCondition: none / only if the harbour master agrees, differs",
    },
    { name: "no Duty or Condition line", said: "" },
    {
      name: "a Condition line with no closing word",
      said: "Duty: may / may, same\nCondition: none",
    },
  ])("$name is not asked again and is never Supported", async ({ said }) => {
    const { result, looks } = await run(said);
    expect(judged(result.parts ?? [])).not.toBe("supported");
    expect(looks.get(part) ?? 0).toBe(0);
    // Paired: with its own duty and condition the same, the reply disagrees with itself and is
    // asked once more.
    expect((await run(both)).looks.get(part)).toBe(1);
  });

  test.each([
    {
      name: "a Condition that differs",
      lines: "Duty: may / may, same\nCondition: none / only if the harbour master agrees, differs",
      verdict: "unsupported",
    },
    {
      name: "a Duty that differs",
      lines: "Duty: may / must, differs\nCondition: none / none, same",
      verdict: "unsupported",
    },
  ])("a Supported second look with $name is never Supported", async ({ lines, verdict }) => {
    const { result, looks } = await run(both, looked(lines));
    expect(looks.get(part)).toBe(1);
    expect(judged(result.parts ?? [])).toBe(verdict);
  });

  test("a Supported second look with both lines the same is Not checked: a second look only lowers (#2816)", async () => {
    const stated = "The berth costs 30 pounds a night, and berth holders may run a generator.";
    const { result, looks } = await run(both, looked(both), stated);
    expect(looks.get(part)).toBe(1);
    expect(judged(result.parts ?? [])).toBe("not-checked");
  });

  test("a part whose own reply is Supported, both lines the same, is Supported as the judge said", async () => {
    const stated = "The berth costs 30 pounds a night, and berth holders may run a generator.";
    const { result, looks } = await check(
      claim,
      [
        { kind: "fact", text: first },
        { kind: "fact", text: part },
      ],
      {
        [first]: { quotes: [stated] },
        // The scripted judge's own Supported reply, its Duty and Condition lines the same.
        [part]: { quotes: [stated] },
      },
    );
    const probe = result.parts?.find(
      (each) => claim.slice(each.span.start, each.span.end) === part,
    );
    expect(probe?.verdict, `${probe?.reason}: ${probe?.detail}`).toBe("supported");
    expect(looks.get(part) ?? 0).toBe(0);
  });
});

describe("a part the judge didn't call Supported stays as it said, its Duty and Condition the same (#1766, #1708)", () => {
  test("an Unsupported part reply with both lines the same stays Unsupported", async () => {
    const claim = "The berth costs 40 pounds a night, and berth holders may run a generator.";
    const part = "berth holders may run a generator";
    const quote = "Berth holders may store a dinghy on the slipway.";
    const { result } = await check(
      claim,
      [
        { kind: "fact", text: "The berth costs 40 pounds a night" },
        { kind: "fact", text: part },
      ],
      {
        "The berth costs 40 pounds a night": { quotes: [quote] },
        [part]: {
          quotes: [quote],
          reply: `Verdict: unsupported\nRoles: berth holders may run / berth holders may store, same\nTime: none / none, same\nScope: none, same\nDuty: may / may, same\nCondition: none / none, same\nThe Document says nothing of a generator.\nEvidence: [1]`,
          asWritten: true,
        },
      },
    );
    const judged = result.parts?.find(
      (each) => claim.slice(each.span.start, each.span.end) === part,
    );
    expect(judged?.verdict).toBe("unsupported");
    expect(judged?.verdict).not.toBe("supported");
  });
});
