/**
 * What an agent writes into a Note that holds only empty lines, as a new Note does, takes their
 * place, so the Note starts with it at its first line (#3759); a Note with words in it is written
 * as before, at the top, at the end, inside the words selected or after the paragraph the cursor
 * is in. From the box at a Note's foot, where it applies at once, and from an outside agent, where
 * it waits and Reject leaves the empty lines as they were.
 */
import type { JSONContent } from "@tiptap/core";
import { beforeAll, describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { OwnAiRunner } from "../../src/core/adapters";
import type { NoteChangeApplied, NoteRequestInput, NoteSelectionBlock } from "../../src/core/api";
import { decideProposals, waitingChanges } from "../../src/shared/proposals";
import { buildAgentShim, connectLegacyAgent, startAgentsCore } from "../helpers/agents";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { exactly, heading, note, readMind, writeMind } from "../helpers/minds";
import { replyingModel } from "../helpers/models";

const P1 = "The early ferry runs late most weekdays.";
const P2 = "Commuters miss the 08:15 train when it does.";
const SUMMARY = "## Ferry interviews\n\nThe vans load first.\n\nThe café queue starts at seven.";

/** The Note's top-level Blocks: a heading by its level and words, a paragraph by its words. */
const shape = (json: JSONContent): string[] =>
  (json.content ?? []).map((node) => {
    const text = (node.content ?? []).map((each) => each.text ?? "").join("");
    return node.type === "heading" ? `h${node.attrs?.level}(${text})` : `p(${text})`;
  });

const SUMMARISED = [
  "h2(Ferry interviews)",
  "p(The vans load first.)",
  "p(The café queue starts at seven.)",
];

type Agent = Awaited<ReturnType<typeof connectLegacyAgent>>;

async function propose(
  agent: Agent,
  mindId: string,
  changes: { paragraph: string; text: string }[],
): Promise<{
  isError?: boolean;
  content?: { text?: string }[];
  structuredContent?: { status?: string };
}> {
  const read = (await agent.callTool({
    name: "read_mind",
    arguments: { mindId, named: true },
  })) as {
    structuredContent?: { version?: string };
  };
  return (await agent.callTool({
    name: "propose_changes",
    arguments: { mindId, version: read.structuredContent?.version, changes },
  })) as {
    isError?: boolean;
    content?: { text?: string }[];
    structuredContent?: { status?: string };
  };
}

const blockIdAt = (client: MindClient, index: number): string => {
  const block = client.blocks.get(index);
  return block instanceof Y.XmlElement ? String(block.getAttribute("id")) : "";
};

interface Case {
  name: string;
  note: () => JSONContent[];
  changes: { paragraph: string; text: string }[];
  /** What the request says of the words selected or of where the cursor is. */
  asked?: (client: MindClient) => Partial<NoteRequestInput>;
  after: string[];
  counted: Pick<NoteChangeApplied, "added" | "changed">;
}

const CASES: Case[] = [
  {
    name: "an empty heading only",
    note: () => [heading(1, "")],
    changes: [{ paragraph: "¶0+", text: SUMMARY }],
    after: SUMMARISED,
    counted: { added: 2, changed: 0 },
  },
  {
    name: "an empty heading and empty paragraphs",
    note: () => [heading(1, ""), note(""), note("")],
    changes: [{ paragraph: "¶0+", text: SUMMARY }],
    after: SUMMARISED,
    counted: { added: 2, changed: 0 },
  },
  {
    name: "one word, written at its end",
    note: () => [note("Ferry")],
    changes: [{ paragraph: "¶1+", text: SUMMARY }],
    after: ["p(Ferry)", ...SUMMARISED],
    counted: { added: 2, changed: 0 },
  },
  {
    name: "one word under an empty heading, written at the top",
    note: () => [heading(1, ""), note("Ferry")],
    changes: [{ paragraph: "¶0+", text: SUMMARY }],
    after: ["h1()", ...SUMMARISED, "p(Ferry)"],
    counted: { added: 2, changed: 0 },
  },
  {
    name: "words selected",
    note: () => [note(P1), note(P2)],
    changes: [{ paragraph: "¶1", text: P1.replace("late", "LATE") }],
    asked: (client): Partial<NoteRequestInput> => {
      const selection: NoteSelectionBlock[] = [
        {
          blockId: blockIdAt(client, 0),
          before: "The early ferry runs ",
          after: " most weekdays.",
        },
      ];
      return { quote: "late", selection };
    },
    after: [`p(${P1.replace("late", "LATE")})`, `p(${P2})`],
    counted: { added: 0, changed: 1 },
  },
  {
    name: "the cursor in the first paragraph",
    note: () => [note(P1), note(P2)],
    changes: [{ paragraph: "¶1+", text: "The vans load first." }],
    asked: () => ({ caret: P1 }),
    after: [`p(${P1})`, "p(The vans load first.)", `p(${P2})`],
    counted: { added: 1, changed: 0 },
  },
];

describe("writing into a Note of empty lines (#3759)", () => {
  beforeAll(async () => {
    await buildAgentShim();
  }, 60_000);

  // protects=a summary asked for in a new Note starts at its first line, the empty lines gone, while a Note with words is written where it was before; fails_when=the empty first line stays above what was written, or a Note with words loses or moves any of them
  it("from the box at a Note's foot, applies at once in their place", async () => {
    for (const each of CASES) {
      let said = "";
      const ownAi: OwnAiRunner = {
        installed: async () => true,
        status: async () => ({ kind: "ready" }),
        purge: async () => true,
        async run(request) {
          request.started?.();
          const agent = await connectLegacyAgent(request.server);
          const mindId = request.prompt.match(/mindId: ([^)]+)\)/)?.[1] ?? "";
          const result = await propose(agent, mindId, each.changes);
          said = result.structuredContent?.status ?? result.content?.[0]?.text ?? "";
          return { kind: "finished", reply: "Done." };
        },
      };
      const { core } = await startAgentsCore(replyingModel(), { ownAi }, { modelSetUp: false });
      await core.setAgentsEnabled(true);
      await core.connectAgent({
        name: "Claude Code",
        client: "claude-code",
        folderIds: ["all"],
        propose: true,
      });
      const mind = await core.createMind({});
      const client = await connectToMind(core, mind.id);
      writeMind(client, each.note());
      await client.settled();
      const ended = new Promise<{ turnId: string; applied: NoteChangeApplied[] }>((resolve) =>
        core.on("agents.noteTurn", (turn) => {
          if (turn.state !== "working") resolve(turn);
        }),
      );
      await core.askInNote({
        mindId: mind.id,
        words: "Summarise the ferry interviews",
        ...each.asked?.(client),
      });
      const end = await ended;
      expect(said, each.name).toBe("applied");
      expect(
        end.applied.map(({ added, changed }) => ({ added, changed })),
        each.name,
      ).toEqual([each.counted]);
      await core.applyAskedChanges({
        answerId: end.turnId,
        mindId: mind.id,
        requests: end.applied.map((change) => change.request),
      });
      await client.settled();
      expect(shape(readMind(client).toJSON()), each.name).toEqual(each.after);
    }
  }, 180_000);

  // protects=from an outside agent the empty lines' removal is part of the first Block's change, so the Note counts only what is written as waiting and Reject leaves it exactly as it was; fails_when=the empty lines count as changes, or Reject leaves the Note without its first line
  it("from an outside agent, waits as the Blocks written and Reject leaves the empty lines", async () => {
    const { core } = await startAgentsCore(replyingModel());
    await core.setAgentsEnabled(true);
    const { launch } = await core.connectAgent({
      name: "Claude Code",
      folderIds: ["all"],
      propose: true,
    });
    const agent = await connectLegacyAgent(launch);
    for (const outcome of ["accept", "reject"] as const) {
      const mind = await core.createMind({});
      const client = await connectToMind(core, mind.id);
      writeMind(client, [heading(1, ""), note("")]);
      await client.settled();
      const before = exactly(client);
      const result = await propose(agent, mind.id, [{ paragraph: "¶0+", text: SUMMARY }]);
      expect(result.isError ?? false, result.content?.[0]?.text).toBe(false);
      expect(result.structuredContent?.status).toBe("waiting");
      await client.settled();
      expect(waitingChanges(client.blocks)).toBe(3);
      client.doc.transact(() => decideProposals(client.blocks, () => true, outcome), "user");
      await client.settled();
      if (outcome === "accept") expect(shape(readMind(client).toJSON())).toEqual(SUMMARISED);
      else expect(exactly(client)).toEqual(before);
    }
  }, 120_000);
});
