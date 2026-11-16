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

type Layout = "far" | "before" | "other";
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
  if (pair.layout === "far") return [sign, ...OTHER_TERMS[pair.language], amount].join("\n\n");
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
      figures: (span?.check.figures ?? []).map((figure) =>
        figure.reason ? `${figure.state} (${figure.reason})` : figure.state,
      ),
    });
  }
  const spent = queryDatabase<{ requests: number; cost: number }>(
    dataDir,
    `SELECT count(*) AS requests, coalesce(sum(cost), 0) AS cost
     FROM model_requests WHERE deleted_at IS NULL AND status = 'settled'`,
  )[0];
  core.close();
  return { rounds, spent };
}

test.skipIf(KEY === undefined)(
  "a bracketed amount's sign, read from words apart from it, on a real model",
  { timeout: 3_600_000 },
  async () => {
    const lines: string[] = [`## ${MODEL} (#2578), ${ROUNDS} rounds`];
    const total = { requests: 0, cost: 0 };
    for (const pair of PAIRS.filter((each) => !ONLY || ONLY.includes(each.key))) {
      const { rounds, spent } = await roundsOf(pair);
      total.requests += spent?.requests ?? 0;
      total.cost += spent?.cost ?? 0;
      const supported = rounds.filter((each) => each.state === "supported").length;
      lines.push(
        `${pair.decoy ? "decoy" : "twin "} ${pair.key}: Note ✓ ${supported}/${ROUNDS} (${rounds
          .map((each) => `${each.state} [${each.figures.join(", ")}]`)
          .join("; ")})`,
      );
      if (REPORT) await appendFile(REPORT, `${JSON.stringify({ pair, rounds, spent })}\n`);
    }
    lines.push(`spent ${total.requests} requests, ${total.cost}`);
    console.log(lines.join("\n"));
    if (REPORT) await appendFile(REPORT, `${lines.join("\n")}\n`);
    expect(lines.length).toBeGreaterThan(1);
  },
);
