/**
 * An agent cites a whole Note's quotes in one call (#3585): through the same interface Claude Code
 * or Codex use, `cite` takes up to `MAX_CITES` quotes, checks them in order while their answers
 * fit in `READ_PART_TOKENS`, and says how many it left for another call.
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

  // protects=a Note's quotes are cited in one call up to the most a call takes, and more than that is refused with words to split them; fails_when=21 to 40 quotes are refused for their count
  it(`cites up to ${MAX_CITES} quotes in one call, and refuses more with words to split them`, async () => {
    const { cite, quotes } = await readInterview();
    expect(MAX_CITES).toBe(40);
    const all = await cite(quotes.slice(0, MAX_CITES));
    expect(all.result.isError ?? false).toBe(false);
    expect(all.cited.citations.map((each) => each.check)).toEqual(
      quotes.slice(0, MAX_CITES).map(() => "found"),
    );
    expect(all.cited.left).toBeUndefined();
    expect(estimateTokens(all.text)).toBeLessThanOrEqual(READ_PART_TOKENS);

    const more = await cite(quotes.slice(0, MAX_CITES + 1));
    expect(more.result.isError).toBe(true);
    expect(more.text).toContain(
      `At most ${MAX_CITES} quotes a call: cite the first ${MAX_CITES}, then the rest in another call.`,
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
      translate("en", "agents.cite.left", { count: left, total: MAX_CITES }),
    );

    const again = await cite(unfound.slice(checked));
    expect(again.cited.citations).toHaveLength(left);
    expect(again.cited.left).toBeUndefined();
    expect(estimateTokens(again.text)).toBeLessThanOrEqual(READ_PART_TOKENS);
  });
});
