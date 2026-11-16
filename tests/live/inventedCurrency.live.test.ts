/**
 * A sentence that gives a currency the Document never states, for a value the Document gives both
 * plainly and with a unit (#2251, box 1), on a real model, through a Note's check and through the
 * bare claim check. "The fee was $54,000 for 54,000 tonnes." over "The fee was 54,000 and the mass
 * was 54,000 t." has its `$` from nowhere; the code's guard `same.some(unit.kind !== "plain")` says
 * nothing of it, so the verdict is the model's alone. Written on 2026-11-16, before any request of
 * it, to decide whether the guard needs fixing (a code guard needs a real-model failure behind it).
 *
 * Six invented pairs: three sentences that invent a currency ("decoys"), each in English and in
 * Chinese, the first being the issue's own, and the same three Documents with the currency stated,
 * of which two are run beside them ("twins", to see the model say ✓ when it should). Each runs
 * 3 rounds on each path.
 *
 * The rule, fixed before the first run:
 * - Build the guard when the model marks an invented currency Supported, as a sentence or as a
 *   figure, in at least 1 of the 3 rounds of the issue's own pair on either path (either language),
 *   or in at least 2 of the other decoys' 12 rounds on either path. A round counts as Supported by
 *   the sentence's own verdict, a Note's or the bare check's; a right figure beside a wrong one is no ✓.
 * - Otherwise the numbers go on the issue and box 1 closes as the model's.
 * - A round with a refused, failed or not-checked request counts as no round, and is run again.
 *
 * INCARNAMIND_LIVE_PAIRS limits the run to those pairs, by key.
 * Runs only with INCARNAMIND_LIVE_DEEPSEEK_KEY (DeepSeek V4.1 Flash, `deepseek-flash`, or INCARNAMIND_LIVE_DEEPSEEK_MODEL
 * when set); INCARNAMIND_LIVE_REPORT keeps one JSON line per pair and path.
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

const KEY = process.env.INCARNAMIND_LIVE_DEEPSEEK_KEY;
const MODEL = process.env.INCARNAMIND_LIVE_DEEPSEEK_MODEL ?? "deepseek-flash";
const ROUNDS = Number(process.env.INCARNAMIND_LIVE_ROUNDS ?? 3) || 3;
const REPORT = process.env.INCARNAMIND_LIVE_REPORT;
const ONLY = process.env.INCARNAMIND_LIVE_PAIRS?.split(",") ?? null;

interface Pair {
  key: string;
  language: "en" | "zh-CN";
  /** The sentence invents a currency (a decoy), or states the Document's (a twin). */
  decoy: boolean;
  /** The issue's own pair. */
  own?: true;
  document: string;
  claim: string;
}

const PAIRS: readonly Pair[] = [
  {
    key: "fee-en",
    language: "en",
    decoy: true,
    own: true,
    document: "The fee was 54,000 and the mass was 54,000 t.",
    claim: "The fee was $54,000 for 54,000 tonnes.",
  },
  {
    key: "fee-zh",
    language: "zh-CN",
    decoy: true,
    own: true,
    document: "费用为54,000，产量为54,000吨。",
    claim: "费用为54,000美元，产量为54,000吨。",
  },
  {
    key: "levy-en",
    language: "en",
    decoy: true,
    document: "The levy was 8,200 and the cargo was 8,200 kg.",
    claim: "The levy was £8,200 for 8,200 kg.",
  },
  {
    key: "levy-zh",
    language: "zh-CN",
    decoy: true,
    document: "税款为8,200，货物重8,200千克。",
    claim: "税款为8,200英镑，货物重8,200千克。",
  },
  {
    key: "revenue-en",
    language: "en",
    decoy: true,
    document: "Revenue was 1,500 and the staff numbered 1,500.",
    claim: "Revenue was €1,500 and the staff numbered 1,500.",
  },
  {
    key: "revenue-zh",
    language: "zh-CN",
    decoy: true,
    document: "收入为1,500，员工人数为1,500。",
    claim: "收入为1,500欧元，员工人数为1,500。",
  },
  {
    key: "fee-en-stated",
    language: "en",
    decoy: false,
    document: "The fee was $54,000 and the mass was 54,000 t.",
    claim: "The fee was $54,000 for 54,000 tonnes.",
  },
  {
    key: "fee-zh-stated",
    language: "zh-CN",
    decoy: false,
    document: "费用为54,000美元，产量为54,000吨。",
    claim: "费用为54,000美元，产量为54,000吨。",
  },
];

const paragraph = (value: string): JSONContent => ({
  type: "paragraph",
  attrs: { id: randomUUID() },
  content: [{ type: "text", text: value }],
});

interface Round {
  note: { state: string; figures: string[]; ran: string };
  bare: string;
  /** Why the bare check ended not checked. */
  why: string | null;
}

async function roundsOf(pair: Pair) {
  const dataDir = await createTempDataFolder();
  const core = startCore(dataDir, { createChatModel: createAiSdkChatModel });
  core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
  await core.updateSettings({ user: { language: pair.language } });
  await core.saveChatProvider({ kind: "deepseek", apiKey: KEY ?? "", modelId: MODEL });
  const sources = await createTempDataFolder();
  await addAndProcess(core, [
    await writeSourceFile(sources, `${pair.key}.md`, `# ${pair.key}\n\n${pair.document}\n`),
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
    const bare = await core.checkClaim({ claim: pair.claim });
    rounds.push({
      note: {
        state: span?.check.state ?? "missing",
        ran: ran.kind,
        figures: (span?.check.figures ?? []).map((figure) =>
          figure.reason ? `${figure.state} (${figure.reason})` : figure.state,
        ),
      },
      bare: bare.verdict,
      why:
        bare.verdict === "not-checked"
          ? `${bare.reason}${bare.detail ? `: ${bare.detail}` : ""}`
          : null,
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
  "a currency the Document never states is never Supported, a stated one is",
  { timeout: 3_600_000 },
  async () => {
    const lines: string[] = [`## ${MODEL} (#2251 box 1), ${ROUNDS} rounds`];
    const total = { requests: 0, cost: 0 };
    for (const pair of PAIRS.filter((each) => !ONLY || ONLY.includes(each.key))) {
      const { rounds, spent } = await roundsOf(pair);
      total.requests += spent?.requests ?? 0;
      total.cost += spent?.cost ?? 0;
      // The sentence's own verdict: a figure that is right ("54,000 tonnes") is Supported beside a wrong one.
      const noteSupported = rounds.filter((each) => each.note.state === "supported").length;
      const bareSupported = rounds.filter((each) => each.bare === "supported").length;
      lines.push(
        `${pair.decoy ? "decoy" : "twin "} ${pair.key}: Note ✓ ${noteSupported}/${ROUNDS} (${rounds.map((each) => `${each.note.state} [${each.note.figures.join(", ")}]`).join("; ")}), bare ✓ ${bareSupported}/${ROUNDS} (${rounds.map((each) => each.bare).join(",")})`,
      );
      if (REPORT) await appendFile(REPORT, `${JSON.stringify({ pair, rounds, spent })}\n`);
    }
    lines.push(`spent ${total.requests} requests, ${total.cost}`);
    console.log(lines.join("\n"));
    if (REPORT) await appendFile(REPORT, `${lines.join("\n")}\n`);
    expect(lines.length).toBeGreaterThan(1);
  },
);
