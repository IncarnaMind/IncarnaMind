/**
 * One path for a model's change to a Note (#2796). Every feature that writes one (Edit with AI,
 * Regenerate a change, the assistant's edit_mind and add_to_mind, an outside agent, Compare
 * Documents and Regenerate an edited Answer) writes the same change the same way: each of its
 * Proposals records the text it changes, so the User's edit puts it out of date; one record says
 * where it came from, on the core's clock; a Checkpoint is saved only when it applies at once; and
 * a part refused refuses the whole change, with its reason.
 */
import { getSchema } from "@tiptap/core";
import { prosemirrorToYXmlFragment } from "@tiptap/y-tiptap";
import type { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import {
  type Core,
  GENERATED_MARK,
  MIND_CONTENT_FIELD,
  PROPOSAL_INSERT_MARK,
} from "../../src/core";
import {
  ChangeRefused,
  type NamedChange,
  namedNote,
  type ProposeOptions,
  proposeNamed,
} from "../../src/core/agents/proposals";
import { createElement } from "../../src/core/answers/blocks";
import { docOf, forkChanges, usersBlocks } from "../../src/core/proposals/merge";
import { proposeRewrite, readSelection } from "../../src/core/proposals/write";
import { noteExtensions } from "../../src/renderer/src/editor/noteSchema";
import { translate } from "../../src/shared/i18n";
import {
  outOfDateProposals,
  pendingProposals,
  proposalRequestOf,
  recordProposalRequest,
} from "../../src/shared/proposals";
import { askAssistant, changesIn, mindCalls } from "../helpers/assistant";
import { answerEnded, setUpWithDocuments } from "../helpers/citations";
import { fillEnded } from "../helpers/comparisons";
import { wholeParagraph } from "../helpers/editing";
import type { MindClient } from "../helpers/mindClient";
import { heading, note, question, readMind, writeMind } from "../helpers/minds";
import { type ModelCall, type ScriptedReply, scriptedModel } from "../helpers/models";

const CLOCK = "2026-11-08T09:00:00.000Z";
const AGENT_CLOCK = "2026-11-08T10:30:00.000Z";

const TIDES = {
  name: "Tides.md",
  contents: "# Tides\n\nSpring tides happen at new moon and at full moon.",
};

const WORDS = {
  en: {
    before: "The quarter was very good, and sales were really strong.",
    after: "The quarter was good, and sales were strong.",
    gone: "very",
    added: "The supplier is two weeks late.",
    typed: "Write <removed>draft</removed> in the subject line until the memo is final.",
    dropsTag: "Write draft in the subject line until the memo is final.",
    keepsTag: "Write \\<removed>draft\\</removed> in the subject line until it is final.",
    most: "Sales were strong.",
    phrase: "very good",
    better: "excellent",
    noTable: "| Tide | When |\n| Spring | At new moon |",
  },
  "zh-CN": {
    before: "本季度业绩非常好，销售也真的很强。",
    after: "本季度业绩好，销售也很强。",
    gone: "非常",
    added: "供应商晚了两周。",
    typed: "备忘录定稿前，主题行里写<removed>草稿</removed>。",
    dropsTag: "备忘录定稿前，主题行里写草稿。",
    keepsTag: "备忘录定稿前，主题行里写\\<removed>草稿\\</removed>两字。",
    most: "好。",
    phrase: "非常好",
    better: "出色",
    noTable: "| 潮汐 | 时间 |\n| 大潮 | 新月 |",
  },
} as const;
type Language = keyof typeof WORDS;
const LANGUAGES: Language[] = ["en", "zh-CN"];

/** The passage an Edit with AI request asks to rewrite; null for any other request. */
const passageOf = (call: ModelCall) =>
  /<passage>\n([\s\S]*?)\n<\/passage>/.exec(call.prompt)?.[1] ?? null;

/**
 * A model that rewrites each passage with `rewrite`, answers a Question with `answer`, and in the
 * assistant makes `tool`'s call once before it replies.
 */
function modelOf({
  rewrite = () => "",
  answer = () => "Done.",
  tool = null,
}: {
  rewrite?: (passage: string) => string;
  answer?: () => string;
  tool?: { tool: string; input: Record<string, unknown> } | null;
}): MockLanguageModelV4 {
  return scriptedModel((call: ModelCall): ScriptedReply => {
    const passage = passageOf(call);
    if (passage !== null) return { text: rewrite(passage) };
    if (tool && call.tools.includes(tool.tool) && call.results.length === 0) {
      return { calls: [tool] };
    }
    return { text: answer() };
  });
}

/** A Note "Tides" on the core's standing clock, with a heading and `paragraphs`. */
async function noteOf(
  model: MockLanguageModelV4,
  paragraphs: readonly string[],
  files: readonly (typeof TIDES)[] = [],
) {
  const set = await setUpWithDocuments(model, files, { now: () => new Date(CLOCK) });
  writeMind(set.client, [heading(2, "Summary"), ...paragraphs.map((text) => note(text))]);
  await set.client.settled();
  return set;
}

const idOf = (client: MindClient, index: number) => String(readMind(client).child(index).attrs.id);

const checkpointsOf = async (core: Core, mindId: string) =>
  (await core.listCheckpoints(mindId)).checkpoints.length;

const mine = (client: MindClient, request: string) =>
  pendingProposals(client.blocks).filter((each) => each.request === request);

/** Types a letter into `word`, wherever the Note has it: an edit of the User's to the text there. */
function typeInside(client: MindClient, word: string): void {
  const into = (parent: Y.XmlFragment | Y.XmlElement): boolean =>
    parent.toArray().some((child) => {
      if (child instanceof Y.XmlElement) return into(child);
      if (!(child instanceof Y.XmlText)) return false;
      const plain = (child.toDelta() as { insert: unknown }[])
        .map((run) => (typeof run.insert === "string" ? run.insert : "\uFFFC"))
        .join("");
      const at = plain.indexOf(word);
      if (at < 0) return false;
      child.insert(at + 1, "x");
      return true;
    });
  if (!into(client.blocks)) throw new Error(`No “${word}” in the Note.`);
}

/** What the agent writes with, as the MCP Tool gives it (../../src/core/agents/access.ts). */
const agentOptions = (request: string): ProposeOptions => {
  let ids = 0;
  return {
    request,
    made: {
      source: "outside-agent",
      agent: "Codex",
      pairingId: "pairing-1",
      createdAt: AGENT_CLOCK,
    },
    cited: () => null,
    notFound: "[quote not found]",
    newId: () => `${request}-${++ids}`,
  };
};

/** The outside agent's change to the Note's first paragraph, through its writer, in the window's copy. */
function agentChange(client: MindClient, changes: readonly NamedChange[], request: string) {
  const named = namedNote(client.blocks, { citation: () => null, waiting: "", busy: "" });
  return client.doc.transact(() =>
    proposeNamed(client.blocks, named, changes, agentOptions(request)),
  );
}

interface Written {
  core: Core;
  mindId: string;
  client: MindClient;
  request: string;
  /** Checkpoints of the Note just before the writer wrote. */
  checkpoints: number;
}

interface Writer {
  name: string;
  origin: Record<string, unknown>;
  /** It applies at once, with Undo; otherwise it waits for the User. */
  applies: boolean;
  /** It takes out words of the User's, which are its target. */
  removes: boolean;
  write(language: Language): Promise<Written>;
}

/** Edit with AI over the Note's paragraph: the change the User asked for in the editor. */
async function editWithAi(language: Language): Promise<Written & { proposalId: string }> {
  const words = WORDS[language];
  const set = await noteOf(modelOf({ rewrite: () => words.after }), [words.before]);
  const checkpoints = await checkpointsOf(set.core, set.mind.id);
  const result = await set.core.editWithAi(
    wholeParagraph(set.client, set.mind.id, idOf(set.client, 1), "instruction", "Shorten it"),
  );
  if (result.kind !== "proposed") throw new Error(`Not proposed: ${JSON.stringify(result)}`);
  await set.client.settled();
  return {
    core: set.core,
    mindId: set.mind.id,
    client: set.client,
    request: result.request,
    checkpoints,
    proposalId: mine(set.client, result.request)[0]?.id ?? "",
  };
}

const WRITERS: Writer[] = [
  {
    name: "Edit with AI",
    origin: { source: "edit-with-ai", action: "instruction", instruction: "Shorten it" },
    applies: true,
    removes: true,
    write: editWithAi,
  },
  {
    name: "Edit with AI that takes out most of the User's text, held back",
    origin: { source: "edit-with-ai", action: "instruction", instruction: "Shorten it" },
    // It waits for the User: Apply saves its Checkpoint then, and writing it saves none.
    applies: false,
    removes: true,
    async write(language) {
      const words = WORDS[language];
      const set = await noteOf(modelOf({ rewrite: () => words.most }), [words.before]);
      const checkpoints = await checkpointsOf(set.core, set.mind.id);
      const result = await set.core.editWithAi(
        wholeParagraph(set.client, set.mind.id, idOf(set.client, 1), "instruction", "Shorten it"),
      );
      if (result.kind !== "proposed") throw new Error(`Not proposed: ${JSON.stringify(result)}`);
      await set.client.settled();
      return {
        core: set.core,
        mindId: set.mind.id,
        client: set.client,
        request: result.request,
        checkpoints,
      };
    },
  },
  {
    name: "Regenerate a change",
    origin: { source: "edit-with-ai", action: "instruction", instruction: "Shorten it" },
    applies: false,
    removes: true,
    async write(language) {
      const edited = await editWithAi(language);
      const checkpoints = await checkpointsOf(edited.core, edited.mindId);
      const result = await edited.core.regenerateProposal({
        requestId: "regenerate-1",
        mindId: edited.mindId,
        proposalId: edited.proposalId,
      });
      if (result.kind !== "proposed") throw new Error(`Not proposed: ${JSON.stringify(result)}`);
      await edited.client.settled();
      return { ...edited, request: result.request, checkpoints };
    },
  },
  {
    name: "edit_mind by instruction",
    origin: { source: "edit-with-ai", action: "instruction", instruction: "Shorten it" },
    applies: true,
    removes: true,
    async write(language) {
      const words = WORDS[language];
      const model = modelOf({
        rewrite: () => words.after,
        tool: { tool: "edit_mind", input: { instruction: "Shorten it" } },
      });
      const set = await noteOf(model, [words.before]);
      const checkpoints = await checkpointsOf(set.core, set.mind.id);
      const answer = await askAssistant(set.core, { text: "Shorten it", mindId: set.mind.id });
      await set.client.settled();
      const request = changesIn(answer)[0]?.request ?? "";
      return { core: set.core, mindId: set.mind.id, client: set.client, request, checkpoints };
    },
  },
  {
    name: "edit_mind that takes out most of the User's text, held back",
    origin: { source: "edit-with-ai", action: "instruction", instruction: "Shorten it" },
    // It waits for the User: Apply saves its Checkpoint then, and writing it saves none.
    applies: false,
    removes: true,
    async write(language) {
      const words = WORDS[language];
      const model = modelOf({
        rewrite: (passage) => passage.replace(words.before, words.most),
        tool: { tool: "edit_mind", input: { instruction: "Shorten it" } },
      });
      const set = await noteOf(model, [words.before]);
      const checkpoints = await checkpointsOf(set.core, set.mind.id);
      const answer = await askAssistant(set.core, { text: "Shorten it", mindId: set.mind.id });
      await set.client.settled();
      const request = changesIn(answer)[0]?.request ?? "";
      return { core: set.core, mindId: set.mind.id, client: set.client, request, checkpoints };
    },
  },
  {
    name: "add_to_mind",
    origin: { source: "answer-added", requested: "write" },
    applies: true,
    removes: false,
    async write(language) {
      const words = WORDS[language];
      const model = modelOf({ tool: { tool: "add_to_mind", input: { content: words.added } } });
      const set = await noteOf(model, [words.before]);
      const checkpoints = await checkpointsOf(set.core, set.mind.id);
      const answer = await askAssistant(set.core, { text: "Add a line", mindId: set.mind.id });
      await set.client.settled();
      const request = changesIn(answer)[0]?.request ?? "";
      return { core: set.core, mindId: set.mind.id, client: set.client, request, checkpoints };
    },
  },
  {
    name: "edit_mind with content",
    origin: { source: "answer-added", requested: "edit" },
    applies: true,
    removes: false,
    async write(language) {
      const words = WORDS[language];
      // The assistant adds its own text, then the User asks for it in other words.
      const model = scriptedModel((call: ModelCall): ScriptedReply => {
        if (call.results.length > 0) return { text: "Done." };
        const again = call.prompt.includes("Say it again");
        return again
          ? {
              calls: [
                {
                  tool: "edit_mind",
                  input: { part: "Risks", content: `## Risks\n\n${words.after}` },
                },
              ],
            }
          : {
              calls: [{ tool: "add_to_mind", input: { content: `## Risks\n\n${words.added}` } }],
            };
      });
      const set = await noteOf(model, [words.before]);
      const first = await askAssistant(set.core, { text: "Add the risks", mindId: set.mind.id });
      await set.client.settled();
      const checkpoints = await checkpointsOf(set.core, set.mind.id);
      const answer = await askAssistant(set.core, {
        text: "Say it again",
        mindId: set.mind.id,
        conversationId: first.conversationId,
      });
      await set.client.settled();
      const request = changesIn(answer)[0]?.request ?? "";
      return { core: set.core, mindId: set.mind.id, client: set.client, request, checkpoints };
    },
  },
  {
    name: "an outside agent",
    origin: {
      source: "outside-agent",
      agent: "Codex",
      pairingId: "pairing-1",
      createdAt: AGENT_CLOCK,
    },
    applies: false,
    removes: true,
    async write(language) {
      const words = WORDS[language];
      const set = await noteOf(modelOf({}), [words.before]);
      const checkpoints = await checkpointsOf(set.core, set.mind.id);
      // ¶1 is the heading, ¶2 the paragraph.
      agentChange(set.client, [{ kind: "rewrite", at: 1, text: words.after }], "agent-request");
      await set.client.settled();
      return {
        core: set.core,
        mindId: set.mind.id,
        client: set.client,
        request: "agent-request",
        checkpoints,
      };
    },
  },
  {
    name: "Compare Documents",
    origin: { source: "comparison-table", modelId: "local-model" },
    applies: false,
    removes: false,
    async write(language) {
      const set = await noteOf(
        modelOf({ answer: () => "NOT_FOUND" }),
        [WORDS[language].before],
        [TIDES],
      );
      const checkpoints = await checkpointsOf(set.core, set.mind.id);
      const result = await set.core.compareDocuments({
        mindId: set.mind.id,
        documentIds: set.documents.map((document) => document.id),
        questions: [{ text: "When are spring tides?" }],
      });
      if (!result.started) throw new Error(`Not started: ${JSON.stringify(result)}`);
      await fillEnded(set.core, result.tableId);
      await set.client.settled();
      const request = pendingProposals(set.client.blocks)[0]?.request ?? "";
      return { core: set.core, mindId: set.mind.id, client: set.client, request, checkpoints };
    },
  },
  {
    name: "Regenerate an edited Answer",
    origin: { source: "answer", modelId: "local-model" },
    applies: false,
    removes: true,
    async write(language) {
      const words = WORDS[language];
      const answers = [words.before, words.after];
      const set = await noteOf(modelOf({ answer: () => answers.shift() ?? "" }), []);
      const asked = question("How was the quarter?");
      writeMind(set.client, [asked]);
      await set.client.settled();
      const first = await set.core.askQuestion({ mindId: set.mind.id, questionId: asked.attrs.id });
      if (!first.asked) throw new Error("The Question wasn't asked.");
      await answerEnded(set.core, first.answerId);
      await set.client.settled();
      // The User's own words in the Answer: written again, it comes as changes over them.
      const answer = set.client.blocks.get(1) as Y.XmlElement;
      ((answer.get(0) as Y.XmlElement).get(0) as Y.XmlText).insert(words.before.length, "!");
      await set.client.settled();
      const checkpoints = await checkpointsOf(set.core, set.mind.id);
      await set.core.regenerateAnswer({ mindId: set.mind.id, answerId: first.answerId });
      await answerEnded(set.core, first.answerId);
      await set.client.settled();
      const request = pendingProposals(set.client.blocks)[0]?.request ?? "";
      return { core: set.core, mindId: set.mind.id, client: set.client, request, checkpoints };
    },
  },
];

describe("Every writer proposes a change the same way", { timeout: 60_000 }, () => {
  for (const language of LANGUAGES) {
    test.each(WRITERS)(`$name, ${language}`, async (writer) => {
      const { core, mindId, client, request, checkpoints } = await writer.write(language);

      // Proposed, each Proposal with the text it changes, so it can go out of date.
      const proposals = mine(client, request);
      expect(proposals.length).toBeGreaterThan(0);
      expect(proposals.filter((each) => each.target === undefined)).toEqual([]);

      // One record of where it came from, made on the core's clock (the agent's on the call's).
      expect(proposalRequestOf(client.doc, request)).toMatchObject({
        createdAt: CLOCK,
        ...writer.origin,
      });
      if (writer.origin.source === "outside-agent") {
        expect(proposalRequestOf(client.doc, request)).not.toHaveProperty("modelId");
      }

      // A Checkpoint only for a change that applies at once; one that waits saves none.
      expect(await checkpointsOf(core, mindId)).toBe(checkpoints + (writer.applies ? 1 : 0));

      // The User edits the words it takes out: it is out of date, whichever writer made it.
      if (writer.removes) {
        const stale = () =>
          proposals.filter((each) => outOfDateProposals(client.blocks).has(each.id));
        expect(stale()).toEqual([]);
        typeInside(client, WORDS[language].gone);
        expect(stale().length).toBeGreaterThan(0);
      }
    });
  }
});

type Refusal = "typed-tag" | "misnamed" | "no-table";

/** The Note's one paragraph, and the model's reply to it, for each refusal. */
const REFUSED: Record<Refusal, (language: Language) => { text: string; reply: string }> = {
  "typed-tag": (language) => ({ text: WORDS[language].typed, reply: WORDS[language].dropsTag }),
  misnamed: (language) => ({ text: WORDS[language].before, reply: `¶9 ${WORDS[language].after}` }),
  "no-table": (language) => ({ text: WORDS[language].before, reply: WORDS[language].noTable }),
};

/** A writer's refusal as it says it, and the Note's text and changes once it has. */
interface Refused {
  kind: string | undefined;
  client: MindClient;
  /** The Note just before the refused change, and the changes waiting there then. */
  before: unknown;
  waiting: string[];
  checkpoints: number;
  core: Core;
  mindId: string;
}

const waitingIds = (client: MindClient) => pendingProposals(client.blocks).map((each) => each.id);

interface Rewriter {
  name: string;
  refusals: readonly Refusal[];
  /** How the writer names a refusal of `kind`. */
  says(kind: Refusal): string;
  refuse(text: string, reply: string, language: Language): Promise<Refused>;
}

const REWRITERS: Rewriter[] = [
  {
    name: "Edit with AI",
    refusals: ["typed-tag", "misnamed", "no-table"],
    says: (kind) => kind,
    async refuse(text, reply) {
      const set = await noteOf(modelOf({ rewrite: () => reply }), [text]);
      const before = readMind(set.client).toJSON();
      const checkpoints = await checkpointsOf(set.core, set.mind.id);
      const result = await set.core.editWithAi(
        wholeParagraph(set.client, set.mind.id, idOf(set.client, 1), "instruction", "Rewrite it"),
      );
      await set.client.settled();
      return {
        kind: result.kind,
        client: set.client,
        before,
        waiting: [],
        checkpoints,
        core: set.core,
        mindId: set.mind.id,
      };
    },
  },
  {
    name: "Regenerate a change",
    // Made again from the words its Proposal changed, which never span a tag the User typed: a
    // change that kept the tag left the words around it as they were.
    refusals: ["misnamed", "no-table"],
    says: (kind) => kind,
    async refuse(text, reply) {
      // The first change only swaps a word; made again, the model's reply is refused.
      const replies = [
        (passage: string) => passage.replace(/memo|备忘录|quarter|本季度/, "x"),
        () => reply,
      ];
      const set = await noteOf(
        modelOf({ rewrite: (passage) => (replies.shift() ?? (() => reply))(passage) }),
        [text],
      );
      const first = await set.core.editWithAi(
        wholeParagraph(set.client, set.mind.id, idOf(set.client, 1), "instruction", "Rewrite it"),
      );
      if (first.kind !== "proposed") throw new Error(`Not proposed: ${JSON.stringify(first)}`);
      await set.client.settled();
      const before = readMind(set.client).toJSON();
      const waiting = waitingIds(set.client);
      const checkpoints = await checkpointsOf(set.core, set.mind.id);
      const result = await set.core.regenerateProposal({
        requestId: "regenerate-refused",
        mindId: set.mind.id,
        proposalId: waiting[0] ?? "",
      });
      await set.client.settled();
      return {
        kind: result.kind,
        client: set.client,
        before,
        waiting,
        checkpoints,
        core: set.core,
        mindId: set.mind.id,
      };
    },
  },
  {
    name: "edit_mind by instruction",
    refusals: ["typed-tag", "misnamed", "no-table"],
    says: (kind) => kind,
    async refuse(text, reply) {
      const model = modelOf({
        rewrite: () => reply,
        tool: { tool: "edit_mind", input: { instruction: "Rewrite it" } },
      });
      const set = await noteOf(model, [text]);
      const before = readMind(set.client).toJSON();
      const checkpoints = await checkpointsOf(set.core, set.mind.id);
      const answer = await askAssistant(set.core, { text: "Rewrite it", mindId: set.mind.id });
      await set.client.settled();
      const kind = mindCalls(answer)[0]?.mindProblem?.kind;
      return {
        kind,
        client: set.client,
        before,
        waiting: [],
        checkpoints,
        core: set.core,
        mindId: set.mind.id,
      };
    },
  },
  {
    name: "an outside agent",
    refusals: ["typed-tag", "no-table"],
    says: (kind) => (kind === "typed-tag" ? "agents.propose.typedTag" : "agents.propose.table"),
    async refuse(text, reply, language) {
      const set = await noteOf(modelOf({}), [text]);
      const before = readMind(set.client).toJSON();
      const checkpoints = await checkpointsOf(set.core, set.mind.id);
      // With a paragraph added after it too: a part refused refuses all of it.
      const changes: NamedChange[] = [
        { kind: "rewrite", at: 1, text: reply },
        { kind: "add", after: 1, text: WORDS[language].added },
      ];
      let kind: string | undefined;
      try {
        agentChange(set.client, changes, "agent-refused");
      } catch (error) {
        if (!(error instanceof ChangeRefused)) throw error;
        kind = error.key;
      }
      await set.client.settled();
      return {
        kind,
        client: set.client,
        before,
        waiting: [],
        checkpoints,
        core: set.core,
        mindId: set.mind.id,
      };
    },
  },
];

describe("A refused part refuses the whole change, with its reason, for every writer", {
  timeout: 60_000,
}, () => {
  const cases = REWRITERS.flatMap((writer) =>
    writer.refusals.flatMap((refusal) =>
      LANGUAGES.map((language) => ({ name: writer.name, writer, refusal, language })),
    ),
  );
  test.each(cases)("$name: $refusal, $language", async ({ writer, refusal, language }) => {
    const { text, reply } = REFUSED[refusal](language);
    const refused = await writer.refuse(text, reply, language);

    expect(refused.kind).toBe(writer.says(refusal));
    // Nothing of it is in the Note, and no Checkpoint was saved for it.
    expect(waitingIds(refused.client)).toEqual(refused.waiting);
    expect(readMind(refused.client).toJSON()).toEqual(refused.before);
    expect(await checkpointsOf(refused.core, refused.mindId)).toBe(refused.checkpoints);
  });
});

/** A standalone Note with one paragraph of the User's, as the outside agent's writer gets it. */
function standalone(text: string) {
  const doc = new Y.Doc();
  const blocks = doc.getXmlFragment(MIND_CONTENT_FIELD);
  const schema = getSchema(noteExtensions());
  prosemirrorToYXmlFragment(
    schema.nodeFromJSON({
      type: "doc",
      content: [{ type: "paragraph", attrs: { id: "p1" }, content: [{ type: "text", text }] }],
    }),
    blocks,
  );
  return { doc, blocks };
}

describe("An outside agent is told why its whole change was refused", () => {
  const SAID = {
    en: "The text for ¶1 leaves out a <removed> tag the User typed there, which would take their words out, so nothing was written. Keep each tag as the paragraph has it.",
    "zh-CN":
      "¶1 的文字漏掉了用户在这一段输入的 <removed> 标记，会删掉用户的文字，因此没有写入任何修改。请按原样保留每个标记。",
  };

  test.each(LANGUAGES)(
    "dropping the User's typed tag proposes nothing, and says so (%s)",
    (language) => {
      const words = WORDS[language];
      const propose = (rewrite: string) => {
        const note = standalone(words.typed);
        const named = namedNote(note.blocks, { citation: () => null, waiting: "", busy: "" });
        const changes: NamedChange[] = [
          { kind: "rewrite", at: 0, text: rewrite },
          { kind: "add", after: 0, text: words.added },
        ];
        return {
          note,
          run: () =>
            note.doc.transact(() => proposeNamed(note.blocks, named, changes, agentOptions("tag"))),
        };
      };

      const kept = propose(words.keepsTag);
      expect(kept.run()).toMatchObject({ waiting: 2 });

      const dropped = propose(words.dropsTag);
      let refused: unknown = null;
      try {
        dropped.run();
      } catch (error) {
        refused = error;
      }
      expect(refused).toBeInstanceOf(ChangeRefused);
      const { key, paragraph } = refused as ChangeRefused;
      expect(translate(language, key, { name: paragraph })).toBe(SAID[language]);
      expect(pendingProposals(dropped.note.blocks)).toEqual([]);
      expect(proposalRequestOf(dropped.note.doc, "tag")).toBeNull();
    },
  );
});

describe("Merged, a change may add Proposals and nothing else", () => {
  /** A Note of the User's paragraph, an empty line and a heading the assistant wrote, and a copy's change to it. */
  function merged(language: Language, change: (blocks: Y.XmlFragment) => void, typed?: string) {
    const words = WORDS[language];
    const doc = new Y.Doc();
    const blocks = doc.getXmlFragment(MIND_CONTENT_FIELD);
    blocks.insert(0, [
      new Y.XmlElement("paragraph"),
      new Y.XmlElement("paragraph"),
      new Y.XmlElement("heading"),
    ]);
    const paragraph = blocks.get(0) as Y.XmlElement;
    paragraph.insert(0, [new Y.XmlText()]);
    (paragraph.get(0) as Y.XmlText).insert(0, words.before);
    const title = blocks.get(2) as Y.XmlElement;
    title.insert(0, [new Y.XmlText()]);
    (title.get(0) as Y.XmlText).insert(0, "Summary", { [GENERATED_MARK]: {} });
    const base = Y.encodeStateAsUpdate(doc);

    const fork = new Y.Doc();
    Y.applyUpdate(fork, base);
    change(fork.getXmlFragment(MIND_CONTENT_FIELD));
    // Meanwhile the User may type in the empty line.
    if (typed) {
      const line = blocks.get(1) as Y.XmlElement;
      line.insert(0, [new Y.XmlText()]);
      (line.get(0) as Y.XmlText).insert(0, typed);
    }
    return forkChanges(base, fork, Y.encodeStateAsUpdate(doc));
  }

  const textOf = (blocks: Y.XmlFragment) => (blocks.get(0) as Y.XmlElement).get(0) as Y.XmlText;

  test.each(LANGUAGES)(
    "Proposals merge; taking the User's words outright doesn't (%s)",
    (language) => {
      const { before, gone } = WORDS[language];
      const at = before.indexOf(gone);
      const ref = { id: "p-1", request: "r-1", target: "t" };
      expect(
        merged(language, (blocks) =>
          textOf(blocks).insert(at, "x", { [PROPOSAL_INSERT_MARK]: ref }),
        ),
      ).not.toBeNull();
      expect(merged(language, (blocks) => textOf(blocks).delete(at, gone.length))).toBeNull();
    },
  );

  test.each(LANGUAGES)(
    "an empty line holds none of the User's words; text the AI wrote, accepted, is theirs (%s)",
    (language) => {
      expect(merged(language, (blocks) => blocks.delete(1, 1))).not.toBeNull();
      expect(merged(language, (blocks) => blocks.delete(2, 1))).toBeNull();
      // Typed in since, the line is theirs.
      expect(merged(language, (blocks) => blocks.delete(1, 1), WORDS[language].added)).toBeNull();
    },
  );

  const ACCEPTED = {
    en: {
      own: "Sales rose.",
      ai: " The board approved the budget in March.",
      cut: " in March",
      reply: "Sales rose\nsharply.",
    },
    "zh-CN": {
      own: "销售上升。",
      ai: "董事会在三月批准了预算。",
      cut: "在三月",
      reply: "销售上升\n很快。",
    },
  } as const;

  /**
   * Edit with AI over the User's sentence, before an AI sentence they accepted, whose reply breaks
   * the line; meanwhile, perhaps, the User cuts words from the AI sentence.
   */
  function rewriteBeside(language: Language, cuts: boolean) {
    const { own, ai, cut, reply } = ACCEPTED[language];
    const doc = new Y.Doc();
    const blocks = doc.getXmlFragment(MIND_CONTENT_FIELD);
    blocks.insert(0, [new Y.XmlElement("paragraph")]);
    const paragraph = blocks.get(0) as Y.XmlElement;
    paragraph.setAttribute("id", "p1");
    paragraph.insert(0, [new Y.XmlText()]);
    const text = paragraph.get(0) as Y.XmlText;
    text.insert(0, own);
    text.insert(own.length, ai, { [GENERATED_MARK]: {} });
    const base = Y.encodeStateAsUpdate(doc);

    const fork = new Y.Doc();
    Y.applyUpdate(fork, base);
    const copy = fork.getXmlFragment(MIND_CONTENT_FIELD);
    const read = readSelection(
      copy,
      { blockId: "p1", offset: 0 },
      { blockId: "p1", offset: own.length },
    );
    if (!read.ok) throw new Error(`The sentence can't be read: ${read.reason}`);
    let ids = 0;
    fork.transact(() => proposeRewrite(read.selection, reply, "r-1", () => `p-${++ids}`));
    if (cuts) text.delete((own + ai).indexOf(cut), cut.length);
    return forkChanges(base, fork, Y.encodeStateAsUpdate(doc));
  }

  test.each(LANGUAGES)(
    "a rewrite beside AI text the User accepted merges, but not over words they cut from it since (%s)",
    (language) => {
      expect(rewriteBeside(language, false)).not.toBeNull();
      expect(rewriteBeside(language, true)).toBeNull();
    },
  );
});

describe("What a write may take out with no Proposal", { timeout: 60_000 }, () => {
  test.each(LANGUAGES)(
    "add_to_mind at the Note's end takes the empty last line, and its Blocks wait (%s)",
    async (language) => {
      const words = WORDS[language];
      const model = modelOf({ tool: { tool: "add_to_mind", input: { content: words.added } } });
      const set = await noteOf(model, [words.before, ""]);
      expect(set.client.blocks.length).toBe(3);

      const answer = await askAssistant(set.core, { text: "Add a line", mindId: set.mind.id });
      await set.client.settled();

      const request = changesIn(answer)[0]?.request ?? "";
      expect(mine(set.client, request).length).toBeGreaterThan(0);
      expect(readMind(set.client).child(1).textContent).toBe(words.before);
      expect(readMind(set.client).child(2).textContent).toBe(words.added);
      expect(readMind(set.client).childCount).toBe(3);
    },
  );
});

describe("Regenerate makes a change again as it was asked", { timeout: 60_000 }, () => {
  test.each(LANGUAGES)(
    "what was asked, and what its text may leave out, carry over (%s)",
    async (language) => {
      const { before, phrase, better } = WORDS[language];
      const set = await noteOf(modelOf({ rewrite: (passage) => passage.replace(phrase, better) }), [
        before,
      ]);
      const edited = await set.core.editWithAi(
        wholeParagraph(
          set.client,
          set.mind.id,
          idOf(set.client, 1),
          "instruction",
          "Say it better",
        ),
      );
      if (edited.kind !== "proposed") throw new Error(`Not proposed: ${JSON.stringify(edited)}`);
      await set.client.settled();
      // As the assistant records a change the User asked for that only takes text out.
      const made = proposalRequestOf(set.client.doc, edited.request);
      if (made?.source !== "edit-with-ai") throw new Error("The edit has no record.");
      recordProposalRequest(set.client.doc, edited.request, {
        ...made,
        requested: "edit",
        removesOnly: true,
      });
      await set.client.settled();

      const again = await set.core.regenerateProposal({
        requestId: "regenerate-asked",
        mindId: set.mind.id,
        proposalId: pendingProposals(set.client.blocks)[0]?.id ?? "",
      });

      if (again.kind !== "proposed") throw new Error(`Not proposed: ${JSON.stringify(again)}`);
      await set.client.settled();
      expect(again.request).not.toBe(edited.request);
      expect(proposalRequestOf(set.client.doc, again.request)).toMatchObject({
        source: "edit-with-ai",
        action: "instruction",
        instruction: "Say it better",
        requested: "edit",
        removesOnly: true,
        keepsLeftOut: true,
        createdAt: CLOCK,
      });
    },
  );
});

describe("What a merge may take out (#2814)", () => {
  // protects=every Block counts as the User's, even one with no text, a picture: a merge that takes it out with no Proposal is refused as "changed"; fails_when=the merge is let through because the Block counts no text; no_claim=writers today, which take out no picture.
  test("a picture Block counts, and a merge that takes it out is refused", () => {
    const doc = new Y.Doc();
    const blocks = doc.getXmlFragment(MIND_CONTENT_FIELD);
    blocks.insert(0, [
      createElement({
        type: "paragraph",
        attrs: { id: "one" },
        content: [{ type: "text", text: "Words." }],
      }),
      createElement({
        type: "picture",
        attrs: {
          id: "chart",
          src: "data:image/png;base64,AA==",
          alt: "A chart",
          width: 10,
          height: 10,
        },
      }),
    ]);
    const base = Y.encodeStateAsUpdate(doc);
    expect(usersBlocks(blocks).map((row) => row.id)).toEqual(["one", "chart"]);

    const fork = docOf(base);
    fork.getXmlFragment(MIND_CONTENT_FIELD).delete(1, 1);

    expect(forkChanges(base, fork, base)).toBeNull();
  });
});
