import { describe, expect, test, vi } from "vitest";
import * as Y from "yjs";
import {
  type Core,
  MIND_CONTENT_FIELD,
  PROPOSAL_ATTRIBUTE,
  PROPOSAL_INSERT_MARK,
} from "../../src/core";
import { translate } from "../../src/shared/i18n";
import { markValueOf } from "../../src/shared/markKeys";
import { readProposalAttribute, readProposalRef } from "../../src/shared/proposals";
import { askAssistant, changesIn, mindCalls } from "../helpers/assistant";
import { checkGenerate, checkReply, isCheckRun } from "../helpers/checks";
import { shownPassages } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import {
  type ModelCall,
  type ScriptedReply,
  scriptedModel,
  scriptedModels,
} from "../helpers/models";

const MOON = "Spring tides come at new and full moon.";
const NEAP = "Neap tides come between them.";
const CONTENT = `## Tide summary\n\n${MOON.slice(0, -1)} [^1].\n\n${NEAP.slice(0, -1)} [^1].\n\nThe harbour is quiet in winter.`;
const INPUT = { mind: "Untitled", content: CONTENT };

/**
 * A summary written into the empty Note in front, named "Untitled" as the model reads it, its
 * input streamed in, heading first; after a refusal for the Note's name, written again under the
 * name its first line gave the Note, as Claude Haiku 5.5 did in the everyday evaluation (#2830).
 */
function writesToUntitled(
  calls: ModelCall[],
  pause?: { until: Promise<void>; reached: () => void },
) {
  return scriptedModel(
    (call): ScriptedReply => {
      calls.push(call);
      if (isCheckRun(call)) return checkReply(call, { [MOON]: { verdict: "supported" } });
      const { results } = call;
      const search = results.find((result) => result.tool === "search_documents");
      if (!search) return { calls: [{ tool: "search_documents", input: { query: "tides" } }] };
      if (!results.some((result) => result.tool === "cite")) {
        const [passage] = shownPassages(search.text);
        return {
          calls: [
            {
              tool: "cite",
              input: { citations: [{ marker: 1, passage: passage?.id, quote: MOON }] },
            },
          ],
        };
      }
      const adds = results.filter((result) => result.tool === "add_to_mind");
      if (adds.length === 0)
        return {
          calls: [{ tool: "add_to_mind", input: INPUT, streamInput: true }],
          // Stopped once the heading and the first paragraph are whole, the next one begun.
          ...(pause && { pause: { after: JSON.stringify(INPUT).indexOf("Neap"), ...pause } }),
        };
      if (adds.length === 1 && /no note called/i.test(adds[0]?.text ?? ""))
        return {
          calls: [{ tool: "add_to_mind", input: { mind: "Tide summary", content: CONTENT } }],
        };
      return { text: "Done." };
    },
    { generate: checkGenerate({ [MOON]: { verdict: "supported" } }) },
  );
}

/** The Note's top-level Blocks: their text, and the request whose Proposal each holds. */
function blocksOf(doc: Y.Doc) {
  return doc
    .getXmlFragment(MIND_CONTENT_FIELD)
    .toArray()
    .flatMap((block) => {
      if (!(block instanceof Y.XmlElement)) return [];
      let request = readProposalAttribute(block.getAttribute(PROPOSAL_ATTRIBUTE))?.request ?? null;
      let text = "";
      for (const child of block.toArray()) {
        if (!(child instanceof Y.XmlText)) continue;
        for (const run of child.toDelta() as {
          insert: unknown;
          attributes?: Record<string, unknown>;
        }[]) {
          if (typeof run.insert === "string") text += run.insert;
          request ??=
            readProposalRef(markValueOf(PROPOSAL_INSERT_MARK, run.attributes))?.request ?? null;
        }
      }
      return [{ text: text.trim(), request }];
    });
}

/** A core with the tides line in a Folder, and an empty Note with no title there. */
async function emptyNote(model: ReturnType<typeof writesToUntitled>) {
  const core: Core = startCore(await createTempDataFolder(), {
    createChatModel: scriptedModels(model).createChatModel,
  });
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  const sources = await createTempDataFolder();
  const documents = await addAndProcess(core, [
    await writeSourceFile(sources, "Tides.md", `# Tides\n\n${MOON} ${NEAP}\n`),
  ]);
  const folder = await core.createLibraryGroup({ name: "Coast", description: "" });
  await core.moveToFolder({ documentIds: documents.map((each) => each.id), folderId: folder.id });
  const mind = await core.createMind({ title: "", folderId: folder.id });
  const ask = { text: "Summarise these Documents into this Note", mindId: mind.id };
  return {
    core,
    mind,
    folder,
    ask: { ...ask, scope: { folderIds: [folder.id], tagIds: [], documentIds: [] } },
  };
}

const MADE = { title: "Tide summary", content: CONTENT };

/** A new Note of the summary, its input streamed in, stopped once its first paragraph is whole. */
function makesNote(pause: { until: Promise<void>; reached: () => void }) {
  return scriptedModel((call): ScriptedReply => {
    const { results } = call;
    const search = results.find((result) => result.tool === "search_documents");
    if (!search) return { calls: [{ tool: "search_documents", input: { query: "tides" } }] };
    if (!results.some((result) => result.tool === "cite")) {
      const [passage] = shownPassages(search.text);
      return {
        calls: [
          {
            tool: "cite",
            input: { citations: [{ marker: 1, passage: passage?.id, quote: MOON }] },
          },
        ],
      };
    }
    if (!results.some((result) => result.tool === "create_mind"))
      return {
        calls: [{ tool: "create_mind", input: MADE, streamInput: true }],
        pause: { after: JSON.stringify(MADE).indexOf("Neap"), ...pause },
      };
    return { text: "Done." };
  });
}

const addResults = (calls: readonly ModelCall[]) => [
  ...new Set(
    calls
      .flatMap((call) => call.results)
      .filter((result) => result.tool === "add_to_mind")
      .map((result) => result.text),
  ),
];

describe("A write into the empty Note in front, named as the model reads it while its own heading renames it (#2830)", {
  timeout: 30_000,
}, () => {
  // protects=a write that names the empty Note in front "Untitled" lands there in one call, though its own first line renames the Note while it streams in: the name meant the Note it began to write into; fails_when=the call is refused for the name it began with, and the model's next call writes the whole text again under the first copy; no_claim=which name a real model gives.
  test("it lands there in one call, its text once", async () => {
    const calls: ModelCall[] = [];
    const { core, mind, ask } = await emptyNote(writesToUntitled(calls));
    const client = await connectToMind(core, mind.id);
    const answer = await askAssistant(core, ask);
    await client.settled();

    const results = addResults(calls);
    expect(results).toHaveLength(1);
    expect(results[0]).toContain(
      "in the Note the User is in, which held nothing before and which its first line now names “Tide summary”",
    );
    const [change] = changesIn(answer);
    expect(mindCalls(answer).map((call) => call.status)).toEqual(["done"]);
    expect(blocksOf(client.doc)).toEqual(
      [
        "Tide summary",
        "Spring tides come at new and full moon .",
        "Neap tides come between them .",
        "The harbour is quiet in winter.",
      ].map((text) => ({ text, request: change?.request })),
    );
  });

  // protects=a write refused after its text began to stream into a Note leaves nothing of it there, so the Note holds what the call's card says: here the User deleted the Note it was writing into, and it comes back as it was; fails_when=the Blocks that streamed in stay in the Note while the card says nothing changed; no_claim=how often a real call is refused mid-stream.
  test("refused once its text began to stream in, it leaves nothing of it in the Note", async () => {
    const calls: ModelCall[] = [];
    let release = () => {};
    const until = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached = () => {};
    const paused = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const { core, mind, ask } = await emptyNote(writesToUntitled(calls, { until, reached }));
    const client = await connectToMind(core, mind.id);
    const answering = askAssistant(core, ask);
    await paused;
    await vi.waitFor(() => expect(blocksOf(client.doc).length).toBeGreaterThan(1), {
      timeout: 20_000,
      interval: 10,
    });
    await core.deleteMind(mind.id);
    release();
    const answer = await answering;

    expect(addResults(calls)[0]).toContain("no note called");
    const cards = mindCalls(answer).map((call) => [call.status, call.mindChange ?? null]);
    expect(cards.length).toBeGreaterThan(0);
    expect(cards.every(([status, change]) => status === "failed" && change === null)).toBe(true);
    await core.restore([{ kind: "mind", id: mind.id }]);
    const back = await connectToMind(core, mind.id);
    await back.settled();
    expect(blocksOf(back.doc)).toEqual([]);
  });

  // protects=a new Note whose text began to stream in, refused when its call ends because its Folder can't be found now, is taken back, and its call's card holds no change, as when nothing streamed: only the Answer's line says why; fails_when=the card still shows a Note made that is gone, or the Note stays; no_claim=how often a Folder goes while a Note is written.
  test("a new Note whose Folder is gone before its call ends leaves no Note, and its card no change", async () => {
    let release = () => {};
    const until = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached = () => {};
    const paused = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const { core, folder, ask } = await emptyNote(makesNote({ until, reached }));
    const answering = askAssistant(core, ask);
    await paused;
    await vi.waitFor(
      async () => expect((await core.listMinds()).map((each) => each.title)).toContain(MADE.title),
      { timeout: 20_000, interval: 10 },
    );
    await core.deleteLibraryGroup(folder.id);
    release();
    const answer = await answering;

    expect(mindCalls(answer).map((call) => [call.tool, call.mindChange ?? null])).toEqual([
      ["create_mind", null],
    ]);
    expect(answer.text).toContain(translate("en", "folder.wall.notFiled"));
    expect((await core.listMinds()).map((each) => each.title)).not.toContain(MADE.title);
  });
});
