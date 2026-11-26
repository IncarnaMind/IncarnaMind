/**
 * A change that cites in the one call that writes it (#3753): the agent writes each quote where its
 * Citation goes, "[cite:<passageId>|<its exact words>]", and IncarnaMind cites it there as `cite`
 * cites it, with no `cite` call before. Each case is written both ways in the same Note, through the
 * shim the app ships with the MCP SDK's own client: with the token `cite` gave, and inline.
 */
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { beforeAll, describe, expect, it } from "vitest";
import { CITATION_NODE } from "../../src/core/api";
import { buildAgentShim, connectLegacyAgent, startAgentsCore } from "../helpers/agents";
import { addAndProcess, createSourceFolder, writeSourceFile } from "../helpers/documents";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { readMind } from "../helpers/minds";
import { replyingModel } from "../helpers/models";

const RIDERSHIP =
  "The Kestrel Bay ferry carried 212,000 passengers in 2025, up from 198,000 in 2024.";
const LATE = "The 07:40 crossing left late on 61 of 250 weekdays.";
const FEES = "Mooring fees [as revised in March] are £2,400 | £2,600 for a large boat.";
const RAMP = "The second ramp opens on 1 March 2027.\nWorks close the south quay for 6 weeks.";
const COSTS = [
  "| Item | Cost |",
  "| --- | --- |",
  "| Second ramp | £3.8 million |",
  "| Staff | £520,000 |",
].join("\n");
const BUDGET = "港口预计 2026 年收入 142 万英镑，其中泊位费 61 万英镑。";
const FARES = "Fares for a return crossing rose to £7.50 in April.";

type Agent = Awaited<ReturnType<typeof connectLegacyAgent>>;

interface Checked {
  cite: string;
  check: string;
  document: string | null;
  quote: string | null;
  text?: string;
}

interface Written {
  citations: Checked[];
  uncited: string[];
}

interface Cited {
  cite: string | null;
  check: string;
  text: string | null;
}

function structured<T>(result: unknown): T {
  const { isError, structuredContent, content } = result as {
    isError?: boolean;
    structuredContent?: unknown;
    content?: { text?: string }[];
  };
  expect(isError ?? false, content?.[0]?.text).toBe(false);
  return structuredContent as T;
}

function refusal(result: unknown): string {
  const { isError, content } = result as { isError?: boolean; content?: { text?: string }[] };
  expect(isError).toBe(true);
  return content?.[0]?.text ?? "";
}

/** A Block as the User reads it: its words, each Citation as ‹C›, and what each Citation holds. */
function asRead(block: ProseMirrorNode | null) {
  let text = "";
  const citations: Record<string, unknown>[] = [];
  block?.descendants((node) => {
    if (node.isText) text += node.text ?? "";
    else if (node.type.name === CITATION_NODE) {
      text += "‹C›";
      const { documentName, quote, check, pageFrom, pageTo, location } = node.attrs;
      citations.push({ documentName, quote, check, pageFrom, pageTo, location });
    } else if (["tableCell", "tableHeader"].includes(node.type.name)) text += "|";
    return true;
  });
  return { text, citations };
}

/** The Note's last `count` Blocks as the User reads them. */
function lastRead(client: MindClient, count: number) {
  const doc = readMind(client);
  return Array.from({ length: count }, (_, at) =>
    asRead(doc.maybeChild(doc.childCount - count + at)),
  );
}

/** Harbour's three files and Finance's one, an agent that may write in Harbour, and its Note. */
async function setUp() {
  const { core } = await startAgentsCore(replyingModel());
  const sources = await createSourceFolder();
  const [ridership, ramp, budget, fares] = await addAndProcess(core, [
    await writeSourceFile(
      sources,
      "Ferry ridership 2025.md",
      `# Ferry ridership 2025\n\n${RIDERSHIP}\n\n${LATE}\n\n${FEES}\n`,
    ),
    await writeSourceFile(
      sources,
      "Ramp works notice.md",
      `# Ramp works notice\n\n${RAMP}\n\n${COSTS}\n`,
    ),
    await writeSourceFile(sources, "港口 2026 年预算.md", `# 港口 2026 年预算\n\n${BUDGET}\n`),
    await writeSourceFile(sources, "Fares.md", `# Fares\n\n${FARES}\n`),
  ]);
  if (!ridership || !ramp || !budget || !fares) throw new Error("A file wasn't added.");
  const harbour = await core.createLibraryGroup({ name: "Harbour", description: "" });
  const finance = await core.createLibraryGroup({ name: "Finance", description: "" });
  for (const each of [ridership, ramp, budget]) await core.assignDocumentGroup(each.id, harbour.id);
  await core.assignDocumentGroup(fares.id, finance.id);
  await core.setAgentsEnabled(true);
  const writer = await core.connectAgent({
    name: "Claude Code",
    folderIds: [harbour.id],
    propose: true,
  });
  const agent = await connectLegacyAgent(writer.launch);
  const { mindId } = structured<{ mindId: string }>(
    await agent.callTool({
      name: "create_mind",
      arguments: {
        title: "Harbour facts",
        markdown: "Facts from the harbour's files.",
        folderId: harbour.id,
      },
    }),
  );
  const client = await connectToMind(core, mindId);
  const other = await core.connectAgent({
    name: "Codex",
    client: "codex",
    folderIds: [finance.id],
  });
  return {
    core,
    agent,
    mindId,
    client,
    budget,
    harbour,
    other,
    otherAgent: async () => connectLegacyAgent(other.launch),
  };
}

/** The Passage a search for `query` finds that holds `words`, as the agent reads it. */
async function passageOf(agent: Agent, query: string, words: string) {
  const { passages } = structured<{ passages: { passageId: string; text: string }[] }>(
    await agent.callTool({ name: "search", arguments: { query } }),
  );
  const passage = passages.find((each) => each.text.includes(words));
  if (!passage) throw new Error(`No Passage holds “${words}”.`);
  return passage;
}

/** `cite`'s answer for one quote of the Passage. */
async function citeFirst(agent: Agent, passageId: string, quote: string): Promise<Cited> {
  const { citations } = structured<{ citations: Cited[] }>(
    await agent.callTool({ name: "cite", arguments: { citations: [{ passageId, quote }] } }),
  );
  const answer = citations[0];
  if (!answer) throw new Error("cite gave no answer.");
  return answer;
}

/** Adds `texts` after the Note's last paragraph, in one change, as an agent names them. */
async function addAtTheEnd(agent: Agent, mindId: string, texts: string[]) {
  const { markdown, version } = structured<{ markdown: string; version: string }>(
    await agent.callTool({ name: "read_mind", arguments: { mindId, named: true } }),
  );
  const last = [...markdown.matchAll(/^¶(\d+)/gm)].at(-1)?.[1] ?? "0";
  return agent.callTool({
    name: "propose_changes",
    arguments: {
      mindId,
      version,
      changes: texts.map((text, at) => ({ paragraph: at === 0 ? `¶${last}+` : "¶+", text })),
    },
  });
}

const inline = (passageId: string, quote: string) => `[cite:${passageId}|${quote}]`;

describe("a change that cites in one call", () => {
  beforeAll(async () => {
    await buildAgentShim();
  }, 60_000);

  // protects=a quote written inline is cited as cite cites it: the same Citation in the Note as with cite's token, for words that hold "]" or "|", Chinese with full-width punctuation, a quote across a line break or a table's cells, two quotes of one Passage in one sentence, several after one sentence, the same quote twice, and one in a table cell of the change; nothing of it is left as words (#3753); fails_when=a Citation differs from cite's, one is lost, or "[cite:" or the quote's words are left in the Note
  it("cites each quote written inline as cite cites it, and leaves nothing of it in the Note", async () => {
    const { agent, mindId, client } = await setUp();
    const fees = await passageOf(agent, "mooring fees large boat", "Mooring fees");
    const riders = await passageOf(agent, "ferry passengers 2025", "212,000 passengers");
    const ramp = await passageOf(agent, "second ramp opens south quay", "second ramp opens");
    const costs = await passageOf(agent, "second ramp cost million", "3.8 million");
    const budget = await passageOf(agent, "泊位费 万英镑", "泊位费");
    const across = (text: string, from: string, to: string) =>
      text.slice(text.indexOf(from), text.indexOf(to) + to.length);
    const cases: { name: string; claim: string; passageId: string; quote: string }[] = [
      {
        name: "words that hold “]” and “|”",
        claim: "A small boat's mooring costs £2,400 a year",
        passageId: fees.passageId,
        quote: across(fees.text, "Mooring fees", "large boat."),
      },
      {
        name: "a Chinese quote with full-width punctuation",
        claim: "泊位费为 61 万英镑",
        passageId: budget.passageId,
        quote: "其中泊位费 61 万英镑。",
      },
      {
        name: "a quote across a line break",
        claim: "The south quay closes once the ramp is open",
        passageId: ramp.passageId,
        quote: across(ramp.text, "opens on 1 March 2027.", "the south quay"),
      },
      {
        name: "a quote across a table's cells",
        claim: "The second ramp costs £3.8 million",
        passageId: costs.passageId,
        quote: across(costs.text, "Second ramp", "3.8 million"),
      },
    ];
    expect(cases[0]?.quote).toMatch(/\].*\|/);
    expect(cases[2]?.quote).toContain("\n");
    expect(cases[3]?.quote).toContain("|");
    for (const { name, claim, passageId, quote } of cases) {
      const cited = await citeFirst(agent, passageId, quote);
      expect(cited.check, name).toBe("found");
      const written = structured<Written>(
        await addAtTheEnd(agent, mindId, [
          `${claim} ${cited.cite}.`,
          `${claim} ${inline(passageId, quote)}.`,
        ]),
      );
      expect(written.citations, name).toEqual([
        expect.objectContaining({ cite: cited.cite, check: "found" }),
      ]);
      await client.settled();
      const [asCited, asInline] = lastRead(client, 2);
      expect(asCited?.citations, name).toHaveLength(1);
      expect(asInline, name).toEqual(asCited);
    }

    // Two quotes of one Passage in one sentence, several after it, the same quote twice, and one in
    // a table's cell.
    const carried = "carried 212,000 passengers in 2025";
    const before = "up from 198,000 in 2024";
    const a = (await citeFirst(agent, riders.passageId, carried)).cite ?? "";
    const b = (await citeFirst(agent, riders.passageId, before)).cite ?? "";
    const pairs: [string, string, string][] = [
      [
        "two quotes of one Passage in one sentence",
        `The ferry carried 212,000 passengers ${a}, against 198,000 a year before ${b}.`,
        `The ferry carried 212,000 passengers ${inline(riders.passageId, carried)}, against 198,000 a year before ${inline(riders.passageId, before)}.`,
      ],
      [
        "several quotes after one sentence",
        `Ridership rose to 212,000 from 198,000 ${a}${b}.`,
        `Ridership rose to 212,000 from 198,000 ${inline(riders.passageId, carried)}${inline(riders.passageId, before)}.`,
      ],
      [
        "the same quote twice",
        `Ridership grew ${a}. It is the highest yet ${a}.`,
        `Ridership grew ${inline(riders.passageId, carried)}. It is the highest yet ${inline(riders.passageId, carried)}.`,
      ],
      [
        "a quote in a table cell of the change",
        `| Figure | Value |\n| --- | --- |\n| Passengers in 2025 | 212,000 ${a} |`,
        `| Figure | Value |\n| --- | --- |\n| Passengers in 2025 | 212,000 ${inline(riders.passageId, carried)} |`,
      ],
    ];
    for (const [name, withTokens, withQuotes] of pairs) {
      structured<Written>(await addAtTheEnd(agent, mindId, [withTokens, withQuotes]));
      await client.settled();
      const [asCited, asInline] = lastRead(client, 2);
      expect(asCited?.citations.length, name).toBeGreaterThan(0);
      expect(asInline, name).toEqual(asCited);
      expect(asInline?.text, name).not.toContain("[cite:");
    }
  });

  // protects=a quote written inline that isn't in its Passage, or names a Passage the agent can't reach, is taken out and its sentence written without a Citation, and the result tells it as cite does, with the same words, the sentence listed as uncited (#3753); fails_when=the quote or "[cite:" is left in the Note, a Citation is made, or the agent is told otherwise than cite tells it
  it("writes a sentence whose quote isn't found without it, and says so as cite does", async () => {
    const { agent, mindId, client, otherAgent } = await setUp();
    const riders = await passageOf(agent, "ferry passengers 2025", "212,000 passengers");
    const elsewhere = await passageOf(await otherAgent(), "return crossing fares", "Fares");
    for (const [name, passageId, quote, claim] of [
      [
        "a quote its Passage doesn't hold",
        riders.passageId,
        "carried 250,000 passengers in 2025",
        "The ferry carried 250,000 passengers last year",
      ],
      [
        "a Passage of a Folder not shared with the agent",
        elsewhere.passageId,
        "rose to £7.50 in April",
        "A return crossing costs £7.50 since April",
      ],
    ] as const) {
      const told = await citeFirst(agent, passageId, quote);
      expect(told, name).toMatchObject({ check: "not-found", cite: null });
      const written = structured<Written>(
        await addAtTheEnd(agent, mindId, [`${claim} ${inline(passageId, quote)}.`]),
      );
      expect(written.citations, name).toEqual([
        expect.objectContaining({ check: "not-found", quote, text: told.text }),
      ]);
      expect(written.uncited, name).toEqual([`${claim}.`]);
      await client.settled();
      expect(lastRead(client, 1), name).toEqual([{ text: `${claim}.`, citations: [] }]);
    }
  });

  // protects=an inline quote of the User's own working file is refused as cite refuses it, in the same words, and one in a formula as a token there is; neither writes anything (#3753); fails_when=the working file is cited, a refusal's words differ from cite's or the token's, or the Note changes
  it("refuses a quote of the User's own workings, and one in a formula, as their tokens are", async () => {
    const { core, agent, mindId, client, budget } = await setUp();
    const riders = await passageOf(agent, "ferry passengers 2025", "212,000 passengers");
    const carried = "carried 212,000 passengers in 2025";
    const token = (await citeFirst(agent, riders.passageId, carried)).cite ?? "";
    const withToken = refusal(
      await addAtTheEnd(agent, mindId, [`The rule $x = 2 ${token}$ holds.`]),
    );
    expect(
      refusal(
        await addAtTheEnd(agent, mindId, [
          `The rule $x = 2 ${inline(riders.passageId, carried)}$ holds.`,
        ]),
      ),
    ).toBe(withToken);

    const zh = await passageOf(agent, "泊位费 万英镑", "泊位费");
    await core.setNotCited(budget.id, true);
    const refused = refusal(
      await agent.callTool({
        name: "cite",
        arguments: { citations: [{ passageId: zh.passageId, quote: "其中泊位费 61 万英镑。" }] },
      }),
    );
    expect(refused).toMatch(/own working file/);
    expect(
      refusal(
        await addAtTheEnd(agent, mindId, [
          `泊位费为 61 万英镑${inline(zh.passageId, "其中泊位费 61 万英镑。")}。`,
        ]),
      ),
    ).toBe(refused);
    await client.settled();
    expect(lastRead(client, 1)).toEqual([
      { text: "Facts from the harbour's files.", citations: [] },
    ]);
  });

  // protects=a new Note written with its quotes inline is the Note written with cite's tokens, Citation for Citation, and the same is told of it; a quote in a code span reads as a token there does (#3753); fails_when=create_mind cites differently inline, or tells the agent differently
  it("writes a new Note with its quotes inline as with cite's tokens", async () => {
    const { core, agent, harbour } = await setUp();
    const riders = await passageOf(agent, "ferry passengers 2025", "212,000 passengers");
    const late = await passageOf(agent, "07:40 crossing late", "07:40 crossing");
    const carried = "carried 212,000 passengers in 2025";
    const tokens = {
      carried: (await citeFirst(agent, riders.passageId, carried)).cite ?? "",
      late: (await citeFirst(agent, late.passageId, LATE)).cite ?? "",
    };
    const markdown = (cite: (passageId: string, quote: string) => string) =>
      [
        "## The ferry in 2025",
        `The ferry carried 212,000 passengers ${cite(riders.passageId, carried)}.`,
        "",
        `- The early crossing ran late on 61 days ${cite(late.passageId, LATE)}.`,
        "",
        `Its tag reads \`${cite(riders.passageId, carried)}\` in the timetable's code.`,
      ].join("\n");
    const notes: { told: Written; read: ReturnType<typeof asRead>[] }[] = [];
    for (const [title, cite] of [
      [
        "With tokens",
        (passageId: string, quote: string) =>
          passageId === riders.passageId && quote === carried ? tokens.carried : tokens.late,
      ],
      ["With quotes", inline],
    ] as const) {
      const made = structured<Written & { mindId: string }>(
        await agent.callTool({
          name: "create_mind",
          arguments: { title, markdown: markdown(cite), folderId: harbour.id },
        }),
      );
      const client = await connectToMind(core, made.mindId);
      await client.settled();
      const doc = readMind(client);
      notes.push({
        told: { citations: made.citations, uncited: made.uncited },
        read: Array.from({ length: doc.childCount - 1 }, (_, at) => asRead(doc.child(at + 1))),
      });
    }
    expect(notes[0]?.told.citations).toHaveLength(2);
    expect(notes[1]).toEqual(notes[0]);
  });
});
