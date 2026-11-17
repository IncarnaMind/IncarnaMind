/**
 * A sign word apart from a bracketed amount, on a real model, through a Note's check (#2578).
 * "The reserve is negative." then more than 470 characters of other lease terms, then "The reserve
 * now stands at ninety-five thousand dollars ($95,000.00)." On `main` the figure reader reads that
 * bracket as the same positive amount when the sign word is out of its reach, so a positive claim
 * gets a figure ✓ from the code and its sentence verdict is the model's alone. Written on
 * 2026-11-16, before any request of it, to decide whether the sign rule has to grow at all (a code
 * rule needs a real-model failure behind it).
 *
 * Three layouts, each in English and Chinese (the texts are tests/helpers/signScope.ts):
 * - "far" (box 1): the sign sentence, more than 470 characters of other terms, the amount's
 *   sentence. The reserve is negative: the positive claim is wrong, the minus claim is right.
 * - "before" (box 3): "The balance was negative. It was ninety-five thousand dollars ($95,000.00)."
 *   The positive claim is wrong, the minus claim is right.
 * - "other" (box 2): "The Landlord is not liable for any loss of business. The annual rent is
 *   ninety-five thousand dollars ($95,000.00)." The positive claim is right, the minus claim wrong.
 * - "tied" (#3228): "Party A made a loss. Its result for the year was $2.6 million ($2,600,000)."
 *   The loss is the amount's: the positive claim is wrong, the minus claim right.
 * - "tiedFar" (#3228): the same, with more than 470 characters of other terms between the loss and
 *   the amount's sentence (the probes' D02 and D04).
 * - "tiedPlain" (#3228): the loss is the amount's, with no pronoun to say so: "Party A made a
 *   loss. The result for the year was $2.6 million ($2,600,000)."
 * Each runs a claim that is wrong ("decoy") and one that is right ("twin"), 3 rounds each. The "far"
 * layout also runs a decoy that names its subject ("The reserve is $95,000.").
 *
 * Two arms, the same pairs: `main`, and a local variant of the figure reader where only a sign word
 * in the amount's own sentence (or its table row or "Less:" line) keeps the bracket's minus.
 *
 * The rule, fixed before the first run:
 * - On `main`, box 1's wrong ✓ is the model's too, and box 1 gets a code rule, when a "far" decoy
 *   reads Supported by the Note's check in at least 1 of the 3 rounds of the issue's own decoy in
 *   either language, or in at least 2 of the 6 rounds of the subject decoys.
 * - On the variant, the sign rule can shrink to the amount's own sentence, the model deciding the
 *   rest, when no decoy of any layout reads Supported in more than 1 of its 3 rounds in either
 *   language, and the twins of "other" read Supported in at least 2 of 3 rounds.
 * - A round whose Note check ends in no verdict (refused, failed, not checked) counts as no round
 *   and is run again by hand; a run with a failed request is void.
 *
 * The confirm run, on the branch that gives a state word ("negative", "minus", 负 ...) a reach of
 * 2,000 characters before the text read (#2578), written on 2026-11-16 before it ran: the six "far"
 * pairs, 3 rounds each (INCARNAMIND_LIVE_PAIRS=far-own-en,far-subject-en,far-minus-en,far-own-zh,
 * far-subject-zh,far-minus-zh), about US$0.06 from the first runs' US$0.0033 a pair-round, stop
 * US$0.10. On `main` the decoys read Supported in 7 of 12 rounds and the twins in 0 of 6.
 * - Bar 1: no "far" decoy (the issue's own and the subject's, English and Chinese) reads Supported
 *   by the Note's check: 0 of 12 rounds.
 * - Bar 2: the "far" twins (the minus claim, English and Chinese) read Supported in at least 3 of
 *   6 rounds.
 * - A round with no verdict, or with a refused, failed or timed out request, is void: not counted,
 *   and run again. A missed bar goes to the lead before the merge.
 *
 * The first confirm run (2026-11-16): bar 1 met (0 of 12), bar 2 missed (0 of 6). One round of each
 * twin showed the model refusing "The amount is -$95,000." on its wording: its figure is "the
 * reserve", not "the amount" (准备金，而不是金额). Bar 2 stands as written. A follow-up, written before
 * it ran, with twins that name the subject ("The reserve is -$95,000."; pairs far-minus-subject-en and
 * far-minus-subject-zh), 3 rounds each, about US$0.03, stop US$0.05:
 * - Bar 3: those twins read Supported in at least 3 of 6 rounds (on `main`, the same Document's
 *   subject decoy read Supported 6 of 6, so the model's own reading of it is positive).
 *
 * The branch missed bar 3 (2 of 6). The same twins run on `main`'s figure reader, the same model
 * and harness (the CEO's question, written before the run, about US$0.03, stop US$0.05), with the
 * requests that did not settle counted: at or under 2 of 6 Supported means the change gives up
 * nothing on that Document, above 2 means it costs a right ✓ there. A run with any request that did
 * not settle is void and run again.
 *
 * A variant measured for #3228 on 2026-11-17, not merged: the reader keeps its rule. In it a loss or
 * deduction noun in a sentence other than the amount's own left a bracketed amount's sign open (the
 * amount "may be negative"), and the figure check asked the model once for the reading, as it does
 * for "(250)"; a reply that gave none ended Not checked. Bars were written before any request.
 * English and Chinese, 3 rounds a pair, DeepSeek V4.1 Flash, `main` run in the same session; the
 * pairs are the ones below. Supported rounds of 6 (English and Chinese together), `main` first:
 * - First run, any loss word in another sentence leaves the sign open: other-rent (right) 0 then 6,
 *   other-minus (wrong) 0 then 0, before-own (wrong) 0 then 0, before-minus (right) 3 then 3,
 *   tied-own (wrong) 0 then 4, tied-minus (right) 4 then 2, tiedfar-own (wrong) 5 then 5,
 *   tiedfar-minus (right) 0 then 0. Spend US$0.2611 on `main`, US$0.2704 on the variant.
 * - Second run, the same with the minus kept by the code when the amount's sentence starts with a
 *   pronoun for the subject (Its, Their, His, Her, It; 其, 它, 她, 他): tied-own 0 then 0, tied-minus
 *   4 then 3, other-rent 0 then 6, other-minus 0 then 0, and tiedplain-own (wrong, the loss is the
 *   amount's with no pronoun) 0 then 4, tiedplain-minus (right) 2 then 1. Spend US$0.0471 on
 *   `main`, US$0.1340 on the variant.
 * Result: the rent sentences are right in 6 of 6 rounds, but the model takes a tied minus for a plus
 * when the tie is a pronoun (4 of 6) and, with the pronoun kept by the code, when the tie is only
 * the next sentence's subject (4 of 6), so the second box of #3228 stays as `main` has it. The far
 * tied decoy (tiedfar-own) is wrong in 5 of 6 rounds on `main` itself: #3252.
 *
 * The run for #3252, written on 2026-11-17 before any request of it. On `main` the wrong plus sentence
 * about a loss stated far above its amount (tiedfar-own) read Supported in 5 of 6 rounds and its
 * right minus twin (tiedfar-minus) in 0 of 6: the reader sees a loss noun in the 400 characters above
 * the quote only, and the amount's paragraph is in sight. The change: an amount's sentence that
 * starts with a pronoun for a subject (Its, Their, His, Her, It; 其 它 她 他) keeps the bracket's
 * minus when a loss or deduction noun is anywhere in the 2,000 characters above, as a state word is.
 * The branch only, `main`'s numbers being those above (same model, same day): the pairs tiedfar-own,
 * tiedfar-minus, tied-own, tied-minus, other-rent and other-minus in English and Chinese (12 pairs),
 * 3 rounds each, DeepSeek V4.1 Flash, stop US$0.25.
 * - Bar 1: tiedfar-own reads Supported in 0 of 6 rounds (`main`: 5 of 6).
 * - Bar 2: tiedfar-minus reads Supported in at least 3 of 6 (`main`: 0 of 6).
 * - Bar 3: the pairs this does not touch read as on `main`: tied-own in 0 of 6 rounds, tied-minus in
 *   at least 3 of 6 (`main`: 4 of 6), other-minus in 0 of 6. other-rent is `main`'s 0 of 6 and stays
 *   there: a loss clause about something else still keeps the minus (#3228).
 * - A round with a refused, failed or timed out request is void and run again by hand.
 *
 * INCARNAMIND_LIVE_PAIRS limits the run to those pairs, by key; INCARNAMIND_LIVE_ROUNDS sets the rounds.
 * Runs only with INCARNAMIND_LIVE_DEEPSEEK_KEY (DeepSeek V4.1 Flash, `deepseek-flash`, or
 * INCARNAMIND_LIVE_DEEPSEEK_MODEL when set); INCARNAMIND_LIVE_REPORT keeps one JSON line per pair.
 */
import { randomUUID } from "node:crypto";
import { appendFile } from "node:fs/promises";
import type { JSONContent } from "@tiptap/core";
import { expect, test } from "vitest";
import { createAiSdkChatModel } from "../../src/core/providers/models";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { createTempDataFolder, queryDatabase, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { readMind, writeMind } from "../helpers/minds";
import { OTHER_TERMS, SIGN_SCOPE } from "../helpers/signScope";

const KEY = process.env.INCARNAMIND_LIVE_DEEPSEEK_KEY;
const MODEL = process.env.INCARNAMIND_LIVE_DEEPSEEK_MODEL ?? "deepseek-flash";
const ROUNDS = Number(process.env.INCARNAMIND_LIVE_ROUNDS ?? 3) || 3;
const REPORT = process.env.INCARNAMIND_LIVE_REPORT;
const ONLY = process.env.INCARNAMIND_LIVE_PAIRS?.split(",") ?? null;

type Layout = "far" | "before" | "other" | "tied" | "tiedFar" | "tiedPlain";
type Language = "en" | "zh-CN";

interface Pair {
  key: string;
  language: Language;
  layout: Layout;
  /** The claim is wrong (a decoy), or right (a twin). */
  decoy: boolean;
  /** The issue's own decoy. */
  own?: true;
  claim: string;
}

const claimOf = (language: Language, layout: Layout, minus: boolean) => {
  const probe = SIGN_SCOPE[language][layout];
  return probe.claim(`${minus ? "-" : ""}${probe.shown}`);
};

const PAIRS: readonly Pair[] = (["en", "zh-CN"] as const).flatMap((language) => {
  const tag = language === "en" ? "en" : "zh";
  const subject = language === "en" ? "The reserve is $95,000." : "该项准备金为¥95,000。";
  return [
    // The reserve is negative: a positive claim is wrong.
    {
      key: `far-own-${tag}`,
      language,
      layout: "far",
      decoy: true,
      own: true,
      claim: claimOf(language, "far", false),
    },
    { key: `far-subject-${tag}`, language, layout: "far", decoy: true, claim: subject },
    {
      key: `far-minus-${tag}`,
      language,
      layout: "far",
      decoy: false,
      claim: claimOf(language, "far", true),
    },
    {
      key: `far-minus-subject-${tag}`,
      language,
      layout: "far",
      decoy: false,
      claim: language === "en" ? "The reserve is -$95,000." : "该项准备金为-¥95,000。",
    },
    // The balance was negative, and "It" was the amount.
    {
      key: `before-own-${tag}`,
      language,
      layout: "before",
      decoy: true,
      claim: claimOf(language, "before", false),
    },
    {
      key: `before-minus-${tag}`,
      language,
      layout: "before",
      decoy: false,
      claim: claimOf(language, "before", true),
    },
    // The loss is the amount's ("Its result"): the positive claim is wrong, the minus claim right.
    {
      key: `tied-own-${tag}`,
      language,
      layout: "tied",
      decoy: true,
      claim: claimOf(language, "tied", false),
    },
    {
      key: `tied-minus-${tag}`,
      language,
      layout: "tied",
      decoy: false,
      claim: claimOf(language, "tied", true),
    },
    {
      key: `tiedfar-own-${tag}`,
      language,
      layout: "tiedFar",
      decoy: true,
      claim: claimOf(language, "tiedFar", false),
    },
    {
      key: `tiedfar-minus-${tag}`,
      language,
      layout: "tiedFar",
      decoy: false,
      claim: claimOf(language, "tiedFar", true),
    },
    {
      key: `tiedplain-own-${tag}`,
      language,
      layout: "tiedPlain",
      decoy: true,
      claim: claimOf(language, "tiedPlain", false),
    },
    {
      key: `tiedplain-minus-${tag}`,
      language,
      layout: "tiedPlain",
      decoy: false,
      claim: claimOf(language, "tiedPlain", true),
    },
    // A loss clause about something else: the rent is positive.
    {
      key: `other-rent-${tag}`,
      language,
      layout: "other",
      decoy: false,
      claim: claimOf(language, "other", false),
    },
    {
      key: `other-minus-${tag}`,
      language,
      layout: "other",
      decoy: true,
      claim: claimOf(language, "other", true),
    },
  ] satisfies Pair[];
});

const documentOf = (pair: Pair) => {
  const { sign, amount } = SIGN_SCOPE[pair.language][pair.layout];
  if (pair.layout === "far" || pair.layout === "tiedFar")
    return [sign, ...OTHER_TERMS[pair.language], amount].join("\n\n");
  return [sign, amount].join(pair.language === "en" ? " " : "");
};

const paragraph = (value: string): JSONContent => ({
  type: "paragraph",
  attrs: { id: randomUUID() },
  content: [{ type: "text", text: value }],
});

interface Round {
  state: string;
  figures: string[];
  ran: string;
  /** What the check said, for reading a round that missed. */
  says: string | null;
}

async function roundsOf(pair: Pair) {
  const dataDir = await createTempDataFolder();
  const core = startCore(dataDir, { createChatModel: createAiSdkChatModel });
  core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
  await core.updateSettings({ user: { language: pair.language } });
  await core.saveChatProvider({ kind: "deepseek", apiKey: KEY ?? "", modelId: MODEL });
  const sources = await createTempDataFolder();
  await addAndProcess(core, [
    await writeSourceFile(sources, `${pair.key}.md`, `# Reserve\n\n${documentOf(pair)}\n`),
  ]);
  const rounds: Round[] = [];
  for (let round = 1; round <= ROUNDS; round++) {
    const mind = await core.createMind({ title: `${pair.key} ${round}` });
    const client = await connectToMind(core, mind.id);
    writeMind(client, [paragraph(pair.claim)]);
    await client.settled();
    const ran = await core.checkMind({
      requestId: `${pair.key}-${round}`,
      mindId: mind.id,
      mode: "all",
    });
    await client.settled();
    const [span] = claimSpans(readMind(client));
    rounds.push({
      state: span?.check.state ?? "missing",
      ran: ran.kind,
      says: span?.check.says ?? span?.check.unsupported?.reason ?? null,
      figures: (span?.check.figures ?? []).map((figure) =>
        figure.reason ? `${figure.state} (${figure.reason})` : figure.state,
      ),
    });
  }
  const spent = queryDatabase<{ requests: number; cost: number; notSettled: number }>(
    dataDir,
    `SELECT count(CASE WHEN status = 'settled' THEN 1 END) AS requests,
            coalesce(sum(CASE WHEN status = 'settled' THEN cost END), 0) AS cost,
            count(CASE WHEN status != 'settled' THEN 1 END) AS notSettled
     FROM model_requests WHERE deleted_at IS NULL`,
  )[0];
  core.close();
  return { rounds, spent };
}

test.skipIf(KEY === undefined)(
  "a bracketed amount's sign, read from words apart from it, on a real model",
  { timeout: 3_600_000 },
  async () => {
    const lines: string[] = [`## ${MODEL} (#2578), ${ROUNDS} rounds`];
    const total = { requests: 0, cost: 0, notSettled: 0 };
    for (const pair of PAIRS.filter((each) => !ONLY || ONLY.includes(each.key))) {
      const { rounds, spent } = await roundsOf(pair);
      total.requests += spent?.requests ?? 0;
      total.cost += spent?.cost ?? 0;
      total.notSettled += spent?.notSettled ?? 0;
      const supported = rounds.filter((each) => each.state === "supported").length;
      lines.push(
        `${pair.decoy ? "decoy" : "twin "} ${pair.key}: Note ✓ ${supported}/${ROUNDS} (${rounds
          .map((each) => `${each.state} [${each.figures.join(", ")}]`)
          .join("; ")})`,
      );
      if (REPORT) await appendFile(REPORT, `${JSON.stringify({ pair, rounds, spent })}\n`);
    }
    lines.push(
      `spent ${total.requests} requests, ${total.cost}; ${total.notSettled} not settled (a run with any is void)`,
    );
    console.log(lines.join("\n"));
    if (REPORT) await appendFile(REPORT, `${lines.join("\n")}\n`);
    expect(lines.length).toBeGreaterThan(1);
  },
);
