import { describe, expect, test } from "vitest";
import type { Core, OfferedCommand, WindowCommandRequest } from "../../src/core";
import { askAssistant } from "../helpers/assistant";
import { setUpWithDocuments } from "../helpers/citations";
import { type ModelCall, type ScriptedReply, scriptedModel } from "../helpers/models";

/**
 * The assistant's commands are held to a Folder wall by what they declare they touch, and a
 * Folder's wall is the User's alone (#1934): from outside a wall nothing names, offers, changes or
 * brings back what is behind it, and from inside nothing turns the wall off.
 */

const FILES = [
  { name: "Client A lease.txt", contents: "Client A settlement offer: 2.5 million zeta.\n" },
  { name: "General memo.txt", contents: "The general memo has no offer in it.\n" },
];

const entry = (id: OfferedCommand["id"], label: string, more: Partial<OfferedCommand> = {}) => ({
  id,
  label,
  purpose: null,
  on: null,
  deletes: false,
  final: false,
  recording: null,
  yours: null,
  ...more,
});

/** A window that offers the wall's switch as an ordinary command, as if it forgot it is the User's. */
const OFFERED: OfferedCommand[] = [
  entry("folder.keepInside", "Keep this Folder's work inside it", { on: ["folder"] }),
  entry("folder.organize", "Organize", { on: ["folder"] }),
  entry("folder.tagWithAi", "Tag with AI", { on: ["folder"] }),
];
const WINDOW = "test-window";

type Call = { tool: string; input: Record<string, unknown> };

async function setUp() {
  let steps: Call[] = [];
  const calls: ModelCall[] = [];
  const model = scriptedModel((call): ScriptedReply => {
    calls.push(call);
    const made = call.results.filter((each) => /^(?:list_commands|run_command)$/.test(each.tool));
    const step = steps[made.length];
    return step ? { calls: [step] } : { text: "Done." };
  });
  const setup = await setUpWithDocuments(model, FILES);
  const { core } = setup;
  const lease = setup.documents.find((each) => each.name.startsWith("Client A"));
  if (!lease) throw new Error("The lease wasn't added.");
  const folderA = await core.createLibraryGroup({ name: "Client A", description: "" });
  await core.assignDocumentGroup(lease.id, folderA.id);
  await core.updateLibraryGroup(folderA.id, {
    name: "Client A",
    description: "",
    keepInside: true,
  });
  const noteA = await core.createMind({ title: "Client A note", folderId: folderA.id });
  const memo = await core.createMind({ title: "Client A privileged memo", folderId: folderA.id });
  await core.deleteMind(memo.id);
  const windowAsked: WindowCommandRequest[] = [];
  core.on("command.windowRun", (request) => {
    windowAsked.push(request);
    void core.answerWindowCommand(request.requestId, { ran: true, changed: true });
  });
  const ask = async (mindId: string, plan: Call[]) => {
    steps = plan;
    const from = calls.length;
    await askAssistant(core, {
      text: "Do it",
      mindId,
      commands: OFFERED,
      clientId: WINDOW,
    });
    return calls
      .slice(from)
      .flatMap((call) => call.results.map((each) => each.text))
      .join("\n");
  };
  return { core, folderA, noteA, memo, lease, outside: setup.mind, windowAsked, ask };
}

const walled = async (core: Core, folderId: string) =>
  (await core.getLibrary()).groups.find((group) => group.id === folderId)?.keepInside;

describe("a Folder's wall is the User's alone", () => {
  test("the assistant can't turn a wall on or off from anywhere, and says which Folder's menu has it", async () => {
    const s = await setUp();
    const named = (folder: string) =>
      `Whether “${folder}” keeps its work inside it is the User's to change, never yours.`;
    const off = {
      tool: "run_command",
      input: { command: "folder.keepInside", ids: [s.folderA.id] },
    };
    // The Folder the request names, from outside the wall and from inside it.
    for (const from of [s.outside.id, s.noteA.id]) {
      expect(await s.ask(from, [off])).toContain(named("Client A"));
    }
    // Naming none: the Note's own Folder, else the only walled Folder.
    const unnamed = { tool: "run_command", input: { command: "folder.keepInside" } };
    expect(await s.ask(s.noteA.id, [unnamed])).toContain(named("Client A"));
    expect(await s.ask(s.outside.id, [unnamed])).toContain(named("Client A"));
    // An ordinary Folder isn't turned on either.
    const other = await s.core.createLibraryGroup({ name: "General", description: "" });
    const on = { tool: "run_command", input: { command: "folder.keepInside", ids: [other.id] } };
    expect(await s.ask(s.outside.id, [on])).toContain(named("General"));
    // With two walls and nothing to tell which, it names none.
    await s.core.updateLibraryGroup(other.id, {
      name: "General",
      description: "",
      keepInside: true,
    });
    expect(await s.ask(s.outside.id, [unnamed])).toContain(
      "Whether a Folder keeps its work inside it is the User's to change, never yours. It's in each Folder's ⋯ menu.",
    );
    expect(s.windowAsked).toEqual([]);
    expect(await walled(s.core, s.folderA.id)).toBe(true);
    expect(await walled(s.core, other.id)).toBe(true);

    // The menu still turns it off, by hand.
    await s.core.updateLibraryGroup(s.folderA.id, {
      name: "Client A",
      description: "",
      keepInside: false,
    });
    expect(await walled(s.core, s.folderA.id)).toBe(false);
  });
});

describe("the command gate denies by default what is behind another wall", () => {
  test("Recently deleted names a walled Note only inside its wall, and brings it back only there", async () => {
    const s = await setUp();
    const find = { tool: "list_commands", input: { kind: "deleted", name: "privileged memo" } };
    expect(await s.ask(s.outside.id, [find])).not.toContain("Client A privileged memo");
    expect(await s.ask(s.noteA.id, [find])).toContain("Client A privileged memo");

    const restore = {
      tool: "run_command",
      input: { command: "deleted.restore", ids: [s.memo.id] },
    };
    await s.ask(s.outside.id, [restore]);
    expect((await s.core.listMinds()).some((mind) => mind.id === s.memo.id)).toBe(false);
  });

  test("a walled Folder can't be renamed, deleted, organized or tagged from outside it", async () => {
    const s = await setUp();
    await s.ask(s.outside.id, [
      { tool: "run_command", input: { command: "folder.rename", ids: [s.folderA.id], name: "X" } },
      { tool: "run_command", input: { command: "folder.delete", ids: [s.folderA.id] } },
      { tool: "run_command", input: { command: "folder.organize", ids: [s.folderA.id] } },
      { tool: "run_command", input: { command: "folder.tagWithAi", ids: [s.folderA.id] } },
    ]);
    expect(s.windowAsked).toEqual([]);
    const folder = (await s.core.getLibrary()).groups.find((group) => group.id === s.folderA.id);
    expect(folder?.name).toBe("Client A");
    expect(folder?.keepInside).toBe(true);
  });

  test("Organize takes no Document behind a wall from outside, and nothing outside from inside", async () => {
    const s = await setUp();
    const said = await s.ask(s.outside.id, [
      {
        tool: "run_command",
        input: { command: "documents.organize", ids: [s.lease.id], folder: "Leases" },
      },
    ]);
    expect(said).toContain("This Folder keeps its work inside it.");
    const inside = await s.ask(s.noteA.id, [
      { tool: "run_command", input: { command: "documents.organize", folder: "Leases" } },
    ]);
    expect(inside).toContain("This Folder keeps its work inside it.");
    expect((await s.core.getLibrary()).groups.map((group) => group.name)).not.toContain("Leases");
  });
});
