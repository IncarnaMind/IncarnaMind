/**
 * An agent cites a whole Note's quotes in one call (#3585): through the same interface Claude Code
 * or Codex use, `cite` checks up to `MAX_CITES` quotes, in order while their answers fit in
 * `READ_PART_TOKENS`, and says how many it left for another call, never refusing a long list.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { MAX_CITES, READ_PART_TOKENS } from "../../src/core/agents/access";
import { estimateTokens } from "../../src/core/answers/context";
import { ALL_SHARED_ID } from "../../src/core/api";
import { translate } from "../../src/shared/i18n";
import { buildAgentShim, connectLegacyAgent, resultText, startAgentsCore } from "../helpers/agents";
import { createSourceFolder, linkAndProcess, writeSourceFile } from "../helpers/documents";
import { replyingModel } from "../helpers/models";

interface Cited {
  citations: {
    passageId: string | null;
    check: string;
    cite: string | null;
    text: string | null;
  }[];
  left?: string;
}

const PLACES = ["Kendal", "Leeds", "Preston", "Bristol", "Inverness", "Lancaster"];

/** An interview of `turns` turns, each said once: no two lines of it are alike. */
const interview = (turns: number) =>
  Array.from({ length: turns }, (_, at) =>
    at % 2 === 0
      ? `Imogen Hale: Question ${at + 1}, about the shop in ${PLACES[at % PLACES.length]}: what happened in week ${at + 3}?`
      : `Dorothy Pennick: In week ${at + 2} we said ${at * 7 + 11} tents came back from ${PLACES[(at * 5) % PLACES.length]}, and ${at + 4} of them had a torn pole sleeve.`,
  ).join("\n");

/** A long interview the agent has read whole, and a quote of each of its lines by Dorothy, with its Passage. */
async function readInterview() {
  const { core } = await startAgentsCore(replyingModel());
  const source = await createSourceFolder();
  await writeSourceFile(source, "Long interview.txt", interview(400));
  const [document] = await linkAndProcess(core, source);
  await core.setAgentsEnabled(true);
  const agent = await connectLegacyAgent(
    (await core.connectAgent({ name: "Claude Code", folderIds: [ALL_SHARED_ID] })).launch,
  );
  const quotes: { passageId: string; quote: string }[] = [];
  for (let args: Record<string, unknown> = { documentId: document?.id }; ; ) {
    const part = (await agent.callTool({ name: "read_passages", arguments: args }))
      .structuredContent as {
      passages: { passageId: string; text: string }[];
      next: string | null;
    };
    for (const passage of part.passages) {
      for (const line of passage.text.split("\n")) {
        if (line.startsWith("Dorothy")) quotes.push({ passageId: passage.passageId, quote: line });
      }
    }
    if (!part.next) break;
    args = { from: part.next };
  }
  const cite = async (citations: unknown[]) => {
    const result = await agent.callTool({ name: "cite", arguments: { citations } });
    return { result, cited: result.structuredContent as Cited, text: resultText(result) };
  };
  return { cite, quotes };
}

describe("an agent citing a whole Note's quotes", () => {
  beforeAll(async () => {
    await buildAgentShim();
  }, 60_000);

  // protects=a Note's quotes are cited in one call up to the most a call checks, and a longer list is never refused: the rest are counted for another call; fails_when=21 or more quotes are refused for their count
  it(`cites up to ${MAX_CITES} quotes in one call, and counts any more for another call`, async () => {
    const { cite, quotes } = await readInterview();
    expect(MAX_CITES).toBe(40);
    const all = await cite(quotes.slice(0, MAX_CITES));
    expect(all.result.isError ?? false).toBe(false);
    expect(all.cited.citations.map((each) => each.check)).toEqual(
      quotes.slice(0, MAX_CITES).map(() => "found"),
    );
    expect(all.cited.left).toBeUndefined();
    expect(estimateTokens(all.text)).toBeLessThanOrEqual(READ_PART_TOKENS);

    const more = await cite(quotes.slice(0, MAX_CITES + 5));
    expect(more.result.isError ?? false).toBe(false);
    expect(more.cited.citations).toHaveLength(MAX_CITES);
    expect(more.cited.left).toBe(
      translate("en", "agents.cite.left.other", { count: 5, total: MAX_CITES + 5 }),
    );
    const rest = await cite(quotes.slice(MAX_CITES, MAX_CITES + 5));
    expect(rest.cited.citations.map((each) => each.check)).toEqual([
      "found",
      "found",
      "found",
      "found",
      "found",
    ]);
    const one = await cite(quotes.slice(0, MAX_CITES + 1));
    expect(one.cited.left).toBe(
      translate("en", "agents.cite.left.one", { count: 1, total: MAX_CITES + 1 }),
    );
  });

  // protects=one call's answers stay within a part's size whatever the quotes, the rest counted and named for another call; fails_when=quotes whose answers are long make a result past what a client keeps whole, or leave quotes out without saying so
  it("checks the quotes in order while their answers fit, and says how many are left to send again", async () => {
    const { cite, quotes } = await readInterview();
    // Words no Passage holds: each answer gives back its Passage's text to copy from.
    const unfound = quotes
      .slice(0, MAX_CITES)
      .map(({ passageId, quote }) => ({ passageId, quote: `${quote} And then the wind dropped.` }));
    const first = await cite(unfound);
    expect(first.result.isError ?? false).toBe(false);
    expect(estimateTokens(first.text)).toBeLessThanOrEqual(READ_PART_TOKENS);
    const checked = first.cited.citations.length;
    expect(checked).toBeGreaterThan(0);
    expect(checked).toBeLessThan(MAX_CITES);
    expect(first.cited.citations.every((each) => each.check === "not-found" && each.text)).toBe(
      true,
    );
    const left = MAX_CITES - checked;
    expect(first.cited.left).toBe(
      translate("en", "agents.cite.left.other", { count: left, total: MAX_CITES }),
    );

    const again = await cite(unfound.slice(checked));
    expect(again.cited.citations).toHaveLength(left);
    expect(again.cited.left).toBeUndefined();
    expect(estimateTokens(again.text)).toBeLessThanOrEqual(READ_PART_TOKENS);
  });

  // protects=a quote sent without its passageId is refused with words that say what each quote needs; fails_when=the refusal names only a field that must be text
  it("says what each quote needs when one comes without its passageId", async () => {
    const { cite, quotes } = await readInterview();
    const missing = await cite([quotes[0], { quote: quotes[1]?.quote }]);
    expect(missing.result.isError).toBe(true);
    expect(missing.text).toBe(translate("en", "agents.problem.citeWithoutPassage"));
  });

  // protects=one unknown passageId in a cite call never refuses the good quotes around it, and a call of only unknown passageIds cites nothing and says which ones weren't found (#3597); fails_when=one bad passageId fails the whole cite call or cites anything for an unknown id
  it("answers each quote on its own when a call includes or consists only of unknown passageIds (#3597)", async () => {
    const { cite, quotes } = await readInterview();
    const badOne = "0001da17-5c2f-463f-a18d-5ee8be66219e";
    const badTwo = "placeholder-passage-id";

    const mixed = await cite([
      quotes[0],
      { passageId: badOne, quote: quotes[1]?.quote },
      quotes[2],
    ]);
    expect(mixed.result.isError ?? false).toBe(false);
    expect(mixed.cited.citations).toHaveLength(3);
    expect(mixed.cited.citations[0]).toMatchObject({
      passageId: quotes[0]?.passageId,
      check: "found",
      text: null,
    });
    expect(mixed.cited.citations[0]?.cite).toMatch(/^\[cite:[a-z0-9]{8}\]$/);
    expect(mixed.cited.citations[1]).toEqual({
      passageId: badOne,
      quote: quotes[1]?.quote,
      check: "not-found",
      cite: null,
      document: null,
      location: null,
      text: translate("en", "agents.problem.citeNotFound", { passageId: badOne }),
    });
    expect(mixed.cited.citations[2]).toMatchObject({
      passageId: quotes[2]?.passageId,
      check: "found",
      text: null,
    });
    expect(mixed.cited.citations[2]?.cite).toMatch(/^\[cite:[a-z0-9]{8}\]$/);

    const allBad = await cite([
      { passageId: badOne, quote: quotes[0]?.quote },
      { passageId: badTwo, quote: quotes[1]?.quote },
    ]);
    expect(allBad.result.isError ?? false).toBe(false);
    expect(allBad.cited.citations).toEqual([
      {
        passageId: badOne,
        quote: quotes[0]?.quote,
        check: "not-found",
        cite: null,
        document: null,
        location: null,
        text: translate("en", "agents.problem.citeNotFound", { passageId: badOne }),
      },
      {
        passageId: badTwo,
        quote: quotes[1]?.quote,
        check: "not-found",
        cite: null,
        document: null,
        location: null,
        text: translate("en", "agents.problem.citeNotFound", { passageId: badTwo }),
      },
    ]);
  });
});
