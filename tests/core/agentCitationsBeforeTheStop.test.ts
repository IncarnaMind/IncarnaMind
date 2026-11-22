/**
 * A Citation an outside agent writes after a sentence's stop ("…in the quarter. [cite:x]") stands
 * before it in the Note, after the Citations already there, as every other Citation does, in
 * English and in Chinese; a Passage the sentence already cites isn't cited a second time; and a
 * Citation inside the next sentence, or one the Note already had after its stop, stays where it is.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { CITATION_NODE } from "../../src/core/api";
import { buildAgentShim, connectLegacyAgent, startAgentsCore } from "../helpers/agents";
import { checkingModel } from "../helpers/checks";
import { addAndProcess, createSourceFolder, writeSourceFile } from "../helpers/documents";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { editMind, readMind } from "../helpers/minds";

const ENGLISH = [
  "Recyclers collect scrap metal and plastic from the harbour towns every week.",
  "Most of the plastic they collect was never used for food.",
  "At the time, the recyclers did not use any artificial intelligence.",
].join("\n\n");
const CHINESE = [
  "回收商每周从港口城镇收集废金属和塑料。",
  "他们收集的塑料大部分从未用于食品。",
  "当时回收商没有使用任何人工智能。",
].join("\n\n");

const QUOTES = {
  en: [
    "Recyclers collect scrap metal and plastic from the harbour towns every week",
    "Most of the plastic they collect was never used for food",
    "At the time, the recyclers did not use any artificial intelligence",
  ],
  "zh-CN": [
    "回收商每周从港口城镇收集废金属和塑料",
    "他们收集的塑料大部分从未用于食品",
    "当时回收商没有使用任何人工智能",
  ],
} as const;
const QUERIES = { en: "recyclers plastic", "zh-CN": "回收商 塑料" } as const;
const WORDS = {
  en: { first: "Recyclers collect scrap metal and plastic every week", stop: ".", space: " " },
  "zh-CN": { first: "回收商每周收集废金属和塑料", stop: "。", space: "" },
} as const;

type Agent = Awaited<ReturnType<typeof connectLegacyAgent>>;
type Language = keyof typeof QUOTES;

function structured<T>(result: unknown): T {
  const { isError, structuredContent, content } = result as {
    isError?: boolean;
    structuredContent?: unknown;
    content?: { text?: string }[];
  };
  expect(isError ?? false, content?.[0]?.text).toBe(false);
  return structuredContent as T;
}

/** An agent paired with a Folder that holds an English and a Chinese Document of the same lines. */
async function paired() {
  const started = await startAgentsCore(checkingModel({}, []));
  const { core } = started;
  const sources = await createSourceFolder();
  const documents = await addAndProcess(core, [
    await writeSourceFile(sources, "Recycling.md", ENGLISH),
    await writeSourceFile(sources, "回收.md", CHINESE),
  ]);
  const folder = await core.createLibraryGroup({ name: "Coast", description: "The sea." });
  for (const document of documents) await core.assignDocumentGroup(document.id, folder.id);
  await core.setAgentsEnabled(true);
  const { launch } = await core.connectAgent({
    name: "Claude Code",
    folderIds: [folder.id],
    propose: true,
  });
  const agent = await connectLegacyAgent(launch);
  const cite = async (language: Language, at: number): Promise<string> => {
    const quote = QUOTES[language][at] ?? "";
    const { passages } = structured<{ passages: { passageId: string }[] }>(
      await agent.callTool({ name: "search", arguments: { query: QUERIES[language] } }),
    );
    const { citations } = structured<{ citations: { cite: string | null }[] }>(
      await agent.callTool({
        name: "cite",
        arguments: { citations: passages.map(({ passageId }) => ({ passageId, quote })) },
      }),
    );
    const found = citations.find((each) => each.cite !== null)?.cite;
    if (!found) throw new Error(`No Passage holds “${quote}”.`);
    return found;
  };
  return { core, agent, cite };
}

async function createNote(
  core: Awaited<ReturnType<typeof paired>>["core"],
  agent: Agent,
  markdown: string,
) {
  const { mindId } = structured<{ mindId: string }>(
    await agent.callTool({ name: "create_mind", arguments: { title: "Recyclers", markdown } }),
  );
  const client = await connectToMind(core, mindId);
  await client.settled();
  return { mindId, client };
}

/** The Note's paragraphs, each Citation as [n] for the n-th quote of its language. */
async function paragraphs(client: MindClient, language: Language): Promise<string[]> {
  await client.settled();
  const lines: string[] = [];
  readMind(client).forEach((block, _offset, index) => {
    if (index === 0) return;
    let line = "";
    block.forEach((node) => {
      const quote = QUOTES[language].findIndex((each) => each === node.attrs.quote);
      line += node.type.name === CITATION_NODE ? `[${quote + 1}]` : (node.text ?? "");
    });
    lines.push(line);
  });
  return lines;
}

async function rewrite(agent: Agent, mindId: string, text: string): Promise<string> {
  const { version } = structured<{ version: string }>(
    await agent.callTool({ name: "read_mind", arguments: { mindId, named: true } }),
  );
  const { status } = structured<{ status: string }>(
    await agent.callTool({
      name: "propose_changes",
      arguments: { mindId, version, changes: [{ paragraph: "¶1", text }] },
    }),
  );
  return status;
}

describe("a Citation an agent writes after the stop", () => {
  beforeAll(async () => {
    await buildAgentShim();
  }, 60_000);

  // protects=create_mind puts a Citation the agent wrote after a sentence's stop before it, in English and Chinese, with or without a space, one in the next sentence stays, and one before the stop stays; fails_when=a Citation stays after the stop, one inside the next sentence is pulled into the one before, or one before the stop moves.
  it.each(["en", "zh-CN"] as const)(
    "create_mind, in %s",
    async (language) => {
      const { core, agent, cite } = await paired();
      const [one, two, three] = [
        await cite(language, 0),
        await cite(language, 1),
        await cite(language, 2),
      ];
      const { first, stop, space } = WORDS[language];
      const made = async (markdown: string) => {
        const { client } = await createNote(core, agent, markdown);
        return paragraphs(client, language);
      };

      expect(await made(`${first}${stop}${space}${one}${two}`)).toEqual([`${first}[1][2]${stop}`]);
      expect(await made(`${first}${stop}${one}${two}`)).toEqual([`${first}[1][2]${stop}`]);
      expect(await made(`${first}${space}${one}${two}${stop}`)).toEqual([
        `${first}${space}[1][2]${stop}`,
      ]);
      expect(
        await made(
          `${first}${stop}${space}${one}${space}${second(language)}${stop}${space}${three}`,
        ),
      ).toEqual([`${first}[1]${stop}${space}${second(language)}[3]${stop}`]);
      // A Citation inside the next sentence is that sentence's own.
      const inside =
        language === "en" ? `Then ${two} they sorted by hand` : `然后${two}他们手工分拣`;
      expect(await made(`${first}${stop}${space}${inside}${stop}`)).toEqual([
        language === "en"
          ? `${first}${stop} Then [2] they sorted by hand${stop}`
          : `${first}${stop}然后[2]他们手工分拣${stop}`,
      ]);
    },
    120_000,
  );

  // protects=propose_changes puts a Citation the agent adds after a paragraph's stop before it, after the Citations the paragraph has, and doesn't cite a Passage the sentence already cites again; fails_when=the new Citation stands after the stop, or the same Passage is cited twice in the sentence; no_claim=a repeat in another sentence, which is a second use.
  it.each(["en", "zh-CN"] as const)(
    "propose_changes, in %s",
    async (language) => {
      const { core, agent, cite } = await paired();
      const [one, two, three] = [
        await cite(language, 0),
        await cite(language, 1),
        await cite(language, 2),
      ];
      const { first, stop, space } = WORDS[language];
      const start = `${first}${space}${one}${two}${stop}`;

      const added = await createNote(core, agent, start);
      expect(await rewrite(agent, added.mindId, `${start}${space}${three}`)).toBe("applied");
      expect(await paragraphs(added.client, language)).toEqual([
        `${first}${space}[1][2][3]${stop}`,
      ]);

      const repeated = await createNote(core, agent, start);
      expect(await rewrite(agent, repeated.mindId, `${start}${space}${one}${two}`)).toBe("applied");
      expect(await paragraphs(repeated.client, language)).toEqual([
        `${first}${space}[1][2]${stop}`,
      ]);

      // A Citation made before a file was cited by paragraph keeps its Location: the agent's token for
      // the same quote has another, and it is still the Passage the sentence already cites.
      const older = await createNote(core, agent, start);
      editMind(older.client, (blocks) =>
        blocks.map((block) => ({
          ...block,
          content: block.content?.map((node) =>
            node.type === CITATION_NODE
              ? { ...node, attrs: { ...node.attrs, location: { kind: "section", heading: null } } }
              : node,
          ),
        })),
      );
      await older.client.settled();
      expect(await rewrite(agent, older.mindId, `${start}${space}${one}${two}`)).toBe("applied");
      expect(await paragraphs(older.client, language)).toEqual([`${first}${space}[1][2]${stop}`]);

      // The Note's own Citation after a stop is the Note's: only the new one goes before it.
      const held = await createNote(core, agent, start);
      editMind(held.client, (blocks) =>
        blocks.map((block, index) =>
          index === 0
            ? block
            : {
                ...block,
                content: [
                  { type: "text", text: first },
                  ...(block.content ?? [])
                    .filter((node) => node.type === CITATION_NODE)
                    .slice(0, 1),
                  { type: "text", text: stop },
                  ...(block.content ?? []).filter((node) => node.type === CITATION_NODE).slice(1),
                ],
              },
        ),
      );
      await held.client.settled();
      expect(await paragraphs(held.client, language)).toEqual([`${first}[1]${stop}[2]`]);
      const read = structured<{ markdown: string }>(
        await agent.callTool({
          name: "read_mind",
          arguments: { mindId: held.mindId, named: true },
        }),
      );
      const [, paragraph] = read.markdown.split("\n\n");
      expect(
        await rewrite(
          agent,
          held.mindId,
          `${paragraph?.replace(/^¶1 (?:\(the User wrote this\) )?/, "")}${space}${three}`,
        ),
      ).toBe("applied");
      expect(await paragraphs(held.client, language)).toEqual([`${first}[1][3]${stop}[2]`]);
    },
    120_000,
  );
});

/** A Folder that holds a file, its byte-for-byte copy ("(1)") and a copy with one character changed ("(2)"). */
async function pairedCopies(language: Language) {
  const started = await startAgentsCore(checkingModel({}, []));
  const { core } = started;
  const sources = await createSourceFolder();
  const text = language === "en" ? ENGLISH : CHINESE;
  const changed =
    language === "en"
      ? text.replace("intelligence", "intelligent")
      : text.replace("人工智能", "人工智慧");
  const name = language === "en" ? "Interview" : "访谈";
  const documents = await addAndProcess(core, [
    await writeSourceFile(sources, `${name}.md`, text),
    await writeSourceFile(sources, `${name} (1).md`, text),
    await writeSourceFile(sources, `${name} (2).md`, changed),
  ]);
  const [original, copy, other] = documents;
  if (!original || !copy || !other) throw new Error("The Documents weren't added.");
  expect([
    copy.contentHash === original.contentHash,
    other.contentHash === original.contentHash,
  ]).toEqual([true, false]);
  const folder = await core.createLibraryGroup({ name: "Coast", description: "The sea." });
  for (const document of documents) await core.assignDocumentGroup(document.id, folder.id);
  await core.setAgentsEnabled(true);
  const { launch } = await core.connectAgent({
    name: "Claude Code",
    folderIds: [folder.id],
    propose: true,
  });
  const agent = await connectLegacyAgent(launch);
  /** A Citation of the first quote, from the Passage of one Document that holds it. */
  const citeIn = async (documentId: string): Promise<string> => {
    const { passages } = structured<{ passages: { passageId: string }[] }>(
      await agent.callTool({ name: "read_passages", arguments: { documentId } }),
    );
    const { citations } = structured<{ citations: { cite: string | null }[] }>(
      await agent.callTool({
        name: "cite",
        arguments: {
          citations: passages.map(({ passageId }) => ({ passageId, quote: QUOTES[language][0] })),
        },
      }),
    );
    const found = citations.find((each) => each.cite !== null)?.cite;
    if (!found) throw new Error("No Passage holds the quote.");
    return found;
  };
  const letters = new Map([
    [original.id, "A"],
    [copy.id, "B"],
    [other.id, "C"],
  ]);
  const reads = async (client: MindClient) => {
    await client.settled();
    const lines: string[] = [];
    readMind(client).forEach((block, _offset, index) => {
      if (index === 0) return;
      let line = "";
      block.forEach((node) => {
        line +=
          node.type.name === CITATION_NODE
            ? `[${letters.get(String(node.attrs.documentId))}]`
            : (node.text ?? "");
      });
      lines.push(line);
    });
    return lines;
  };
  return {
    core,
    agent,
    reads,
    cites: { a: await citeIn(original.id), b: await citeIn(copy.id), c: await citeIn(other.id) },
  };
}

describe("a Passage the sentence cites from a Document is cited again from its copy", () => {
  beforeAll(async () => {
    await buildAgentShim();
  }, 60_000);

  // protects=a Citation an agent adds from a byte-for-byte copy of a Document the sentence already cites, after the stop or next to the original before it, is not added, while one from a copy with a character changed is another Document and stays, in English and Chinese; fails_when=a file's copy is cited a second time, or a changed copy is taken for the same one.
  it.each(["en", "zh-CN"] as const)(
    "in %s",
    async (language) => {
      const { core, agent, reads, cites } = await pairedCopies(language);
      const { first, stop, space } = WORDS[language];
      const start = `${first}${space}${cites.a}${stop}`;
      const made = await createNote(core, agent, start);
      expect(await reads(made.client)).toEqual([`${first}${space}[A]${stop}`]);

      expect(await rewrite(agent, made.mindId, `${start}${space}${cites.b}`)).toBe("applied");
      expect(await reads(made.client)).toEqual([`${first}${space}[A]${stop}`]);

      const before = await createNote(core, agent, start);
      expect(
        await rewrite(agent, before.mindId, `${first}${space}${cites.a}${cites.b}${stop}`),
      ).toBe("applied");
      expect(await reads(before.client)).toEqual([`${first}${space}[A]${stop}`]);

      const changed = await createNote(core, agent, start);
      expect(await rewrite(agent, changed.mindId, `${start}${space}${cites.c}`)).toBe("applied");
      expect(await reads(changed.client)).toEqual([`${first}${space}[A][C]${stop}`]);
    },
    120_000,
  );
});

/** A second sentence of the Note, in the language. */
const second = (language: Language) =>
  language === "en" ? "They did not use AI" : "他们没有使用人工智能";
