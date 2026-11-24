/**
 * The input at a Note's foot, the window's side (#3627): a request goes to the core, the label
 * follows what the core says of it, the changes it made in the Note asked from are applied once,
 * in the window that asked, through the assistant's own path (`applyTurn`), and a connection that
 * may only read is let to propose changes in place, the request then sent again.
 */
import { getSchema } from "@tiptap/core";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { DOMParser } from "linkedom";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type {
  AgentPairing,
  NoteRequestInput,
  NoteRequestStart,
  NoteTurnEvent,
} from "../../src/core/api";
import { NODE_CHARACTER } from "../../src/shared/proposals";

const page = new DOMParser().parseFromString("<html><body></body></html>", "text/html");
const view = page.defaultView;
const claude = { id: "p1", name: "Claude Code", client: "claude-code" } as AgentPairing;
const bridge = {
  turns: [] as ((event: NoteTurnEvent) => void)[],
  on: (event: string, listener: (event: NoteTurnEvent) => void) => {
    if (event === "agents.noteTurn") bridge.turns.push(listener);
    return () => undefined;
  },
  start: { kind: "started", pairing: claude, turnId: "t1" } as NoteRequestStart,
  asked: [] as NoteRequestInput[],
  askInNote: async (input: NoteRequestInput) => {
    bridge.asked.push(input);
    return bridge.start;
  },
  updated: [] as unknown[],
  updateAgent: async (pairingId: string, input: unknown) => {
    bridge.updated.push([pairingId, input]);
    return claude;
  },
  listAgentsToAsk: async () => [claude],
};
const methods = new Proxy(bridge, {
  get: (each, name) =>
    name in each ? each[name as keyof typeof each] : () => Promise.resolve(undefined),
});
Object.assign(view, { incarnamind: methods, incarnamindFiles: methods });
vi.stubGlobal("window", view);
vi.stubGlobal("document", page);
vi.stubGlobal("navigator", { userAgent: "node" });

const applyTurn = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../../src/renderer/src/askedChanges", async (original) => ({
  ...(await original<typeof import("../../src/renderer/src/askedChanges")>()),
  applyTurn,
}));

const {
  allowAndAskAgain,
  askFromSelection,
  askInNote,
  firstWordsOf,
  selectedForRequest,
  useNoteAsks,
} = await import("../../src/renderer/src/ownAiInNote");
const { useNotices } = await import("../../src/renderer/src/notices");
const { noteExtensions } = await import("../../src/renderer/src/editor/noteSchema");

const event = (rest: Partial<NoteTurnEvent>): NoteTurnEvent => ({
  mindId: "m1",
  turnId: "t1",
  pairingId: "p1",
  state: "working",
  doing: null,
  startedAt: "2026-11-22T10:00:00.000Z",
  problem: null,
  reply: "",
  applied: [],
  waiting: [],
  made: [],
  fresh: false,
  quiet: false,
  model: null,
  steps: [],
  documentsFound: 0,
  questions: [],
  mode: null,
  ...rest,
});
const tell = (each: NoteTurnEvent) => {
  for (const listener of bridge.turns) listener(each);
};
const ask = () => useNoteAsks.getState().byMind.m1;

beforeEach(() => {
  applyTurn.mockClear();
  bridge.asked = [];
  bridge.updated = [];
  bridge.start = { kind: "started", pairing: claude, turnId: "t1" };
  useNoteAsks.setState({ byMind: {} });
});

describe("the input at a Note's foot (#3627)", () => {
  // protects=the label follows the request: working, what the agent is doing, then what it did; the changes it made in the Note asked from are applied once, through the assistant's own path, with what the line counts; fails_when=the label doesn't follow, the changes aren't applied, or they are applied twice
  test("follows a request, and applies its changes once in the window that asked", async () => {
    expect(await askInNote("m1", { words: "shorter", quote: "", selection: null })).toBe("started");
    expect(bridge.asked).toEqual([{ mindId: "m1", words: "shorter" }]);
    expect(ask()).toMatchObject({ state: "working", agent: "Claude Code" });
    const reading = { kind: "call", tool: "read_mind", summary: "Ferry notes", count: 1 } as const;
    tell(event({ doing: reading }));
    expect(ask()?.doing).toEqual(reading);
    const applied = [{ mindId: "m1", request: "r1", changed: 1, added: 0, tables: 0 }];
    tell(event({ state: "landed", applied, reply: "Shorter." }));
    expect(ask()).toMatchObject({ state: "landed", changed: 1, reply: "Shorter." });
    await vi.waitFor(() => expect(applyTurn).toHaveBeenCalledOnce());
    expect(applyTurn).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({ mindId: "m1", requests: ["r1"], changed: 1, wrote: 0 }),
      expect.any(Function),
      { made: false, created: false, askedFrom: null },
    );
    tell(event({ state: "landed", applied }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(applyTurn).toHaveBeenCalledOnce();
  });

  // protects=a request that ended stays ended, whatever of it the window hears later, and says it is quiet only while it works; fails_when=a late word puts the line back on Working with nothing to stop, or a quiet sign outlives the run
  test("keeps an ended request ended, and its quiet sign to its run", async () => {
    await askInNote("m1", { words: "shorter", quote: "", selection: null });
    tell(event({ quiet: true }));
    expect(ask()?.quiet).toBe(true);
    tell(event({ quiet: false }));
    expect(ask()?.quiet).toBe(false);
    tell(event({ quiet: true }));
    tell(event({ state: "landed", reply: "Shorter.", quiet: true }));
    expect(ask()).toMatchObject({ state: "landed", quiet: false });
    tell(event({ state: "working", doing: { kind: "thinking" } }));
    expect(ask()).toMatchObject({ state: "landed", reply: "Shorter." });
  });

  // protects=a request that had to begin a new conversation, Claude Code having lost the Note's, says so once in the window that asked; fails_when=the User never learns the AI forgot what came before
  test("says when a request began a new conversation", async () => {
    await askInNote("m1", { words: "shorter", quote: "", selection: null });
    tell(event({ state: "landed", reply: "Shorter.", fresh: true }));
    expect(useNotices.getState().confirmation).toMatchObject({ message: "noteAsk.fresh" });
  });

  // protects=a request another window sent shows its line here but applies only there; fails_when=two windows apply one turn's changes
  test("doesn't apply a turn another window asked", async () => {
    tell(
      event({
        turnId: "t9",
        state: "landed",
        applied: [{ mindId: "m1", request: "r9", changed: 1, added: 0, tables: 0 }],
      }),
    );
    expect(ask()?.state).toBe("landed");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(applyTurn).not.toHaveBeenCalled();
  });

  // protects=a connection that may only read is let to propose changes from the Note, the switch Settings shows, and the same request goes again with its selection; fails_when=Allow sends the User to Settings, forgets the request, or loses its selection
  test("lets the agent propose changes, and sends the same request again", async () => {
    const selection = [{ blockId: "a", before: "The ", after: "." }];
    await askInNote("m1", { words: "bold", quote: "ferry", selection });
    tell(event({ state: "failed", problem: "read-only" }));
    expect(ask()?.problem).toBe("read-only");
    bridge.start = { kind: "started", pairing: claude, turnId: "t2" };
    await allowAndAskAgain("m1");
    expect(bridge.updated).toEqual([["p1", { propose: true }]]);
    expect(bridge.asked.at(-1)).toEqual({ mindId: "m1", words: "bold", quote: "ferry", selection });
    expect(ask()).toMatchObject({ state: "working", turnId: "t2" });
  });

  // protects=with no agent to run it in the background, the caller asks by the link and the label stays out; fails_when=a request that went nowhere shows as working
  test("leaves the link to the caller when no agent runs it", async () => {
    bridge.start = { kind: "link" };
    expect(await askInNote("m1", { words: "shorter", quote: "", selection: null })).toBe("link");
    expect(ask()).toBeUndefined();
  });

  // protects=a selection action while the Note's request runs sends nothing and says why, as Return at the input does; fails_when=it is dropped without a word, or shown as if it were the running one
  test("doesn't send a selection action while a request runs, and says so", async () => {
    await askInNote("m1", { words: "shorter", quote: "", selection: null });
    const schema = getSchema(noteExtensions());
    const doc = schema.nodeFromJSON({
      type: "doc",
      content: [
        { type: "paragraph", attrs: { id: "a" }, content: [{ type: "text", text: "Fares rose." }] },
      ],
    });
    const state = EditorState.create({ doc, selection: TextSelection.create(doc, 1, 6) });
    expect(await askFromSelection(state, "m1", "Explain this")).toBe("busy");
    expect(bridge.asked).toHaveLength(1);
    expect(useNotices.getState().confirmation).toMatchObject({
      message: "noteAsk.busy",
      params: { agent: "Claude Code" },
    });
  });

  // protects=the pill shows a reply's first words as the User reads them: no Markdown marks, no Citation tokens, the first line that has words; fails_when=the pill shows "**", "# " or "[cite:…]"
  test("shows a reply's first words, its marks and Citation tokens left out", () => {
    expect(
      firstWordsOf("## Summary\n\n**Ten interviews** [cite:ab12cd34] say the boat is fine."),
    ).toBe("Summary");
    expect(firstWordsOf("- **Kofi** says the ramp is hard [cite:x9y8z7w6].\n- Mei agrees.")).toBe(
      "Kofi says the ramp is hard.",
    );
  });

  // protects=the selection a request carries: its words, and for each top-level Block the text before and after them, which the core holds a change inside to; fails_when=the core gets offsets or text it can't compare with the Note's
  test("reads the selection as its words and the text kept around them", () => {
    const schema = getSchema(noteExtensions());
    const doc = schema.nodeFromJSON({
      type: "doc",
      content: [
        {
          type: "paragraph",
          attrs: { id: "a" },
          content: [{ type: "text", text: "The ferry carried 212,000 passengers in 2025." }],
        },
        { type: "paragraph", attrs: { id: "b" }, content: [{ type: "text", text: "Fares rose." }] },
      ],
    });
    const from = 1 + "The ferry carried ".length;
    const state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, from, from + "212,000 passengers".length),
    });
    expect(selectedForRequest(state)).toEqual({
      quote: "212,000 passengers",
      selection: [{ blockId: "a", before: "The ferry carried ", after: " in 2025." }],
    });
    const across = EditorState.create({
      doc,
      selection: TextSelection.create(doc, from, doc.content.size - 2),
    });
    expect(selectedForRequest(across)?.selection).toEqual([
      { blockId: "a", before: "The ferry carried ", after: "" },
      { blockId: "b", before: "", after: "." },
    ]);

    // A Citation after the words reads as one mark, as the core reads it, so dropping it is a change.
    const cited = schema.nodeFromJSON({
      type: "doc",
      content: [
        {
          type: "paragraph",
          attrs: { id: "c" },
          content: [
            { type: "text", text: "Fares rose." },
            { type: "citation", attrs: { passageId: "p1", quote: "Fares rose." } },
          ],
        },
      ],
    });
    const withCitation = EditorState.create({
      doc: cited,
      selection: TextSelection.create(cited, 1, 1 + "Fares".length),
    });
    expect(selectedForRequest(withCitation)?.selection).toEqual([
      { blockId: "c", before: "", after: ` rose.${NODE_CHARACTER}` },
    ]);
  });
});
