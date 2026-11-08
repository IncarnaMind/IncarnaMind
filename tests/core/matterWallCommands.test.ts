import { describe, expect, test } from "vitest";
import type {
  ConversationAnswer,
  Core,
  CoreAdapters,
  OfferedCommand,
  WindowCommandRequest,
} from "../../src/core";
import { askAssistant } from "../helpers/assistant";
import { setUpWithDocuments } from "../helpers/citations";
import { manualClock } from "../helpers/core";
import { planReply } from "../helpers/library";
import {
  type GenerateCall,
  type GeneratedReply,
  type ModelCall,
  type ScriptedReply,
  scriptedModel,
} from "../helpers/models";

/**
 * The assistant's commands are held to a Folder wall by what they declare they touch, and a
 * Folder's wall is the User's alone (#1934): from outside a wall nothing names, offers, changes or
 * brings back what is behind it, and from inside nothing turns the wall off.
 */

const FILES = [
  { name: "Client A lease.txt", contents: "Client A settlement offer: 2.5 million zeta.\n" },
  { name: "General memo.txt", contents: "The general memo has no offer in it.\n" },
  { name: "Late filing.txt", contents: "A filing Organize sorts while the assistant runs.\n" },
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

async function setUp(
  overrides: Partial<CoreAdapters> = {},
  classify?: (call: GenerateCall) => GeneratedReply,
) {
  let steps: Call[] = [];
  const calls: ModelCall[] = [];
  const model = scriptedModel(
    (call): ScriptedReply => {
      calls.push(call);
      const made = call.results.filter((each) => /^(?:list_commands|run_command)$/.test(each.tool));
      const step = steps[made.length];
      return step ? { calls: [step] } : { text: "Done." };
    },
    classify ? { generate: classify } : {},
  );
  const setup = await setUpWithDocuments(model, FILES, overrides);
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
  let lastAnswer: ConversationAnswer | null = null;
  const ask = async (mindId: string, plan: Call[]) => {
    steps = plan;
    const from = calls.length;
    lastAnswer = await askAssistant(core, {
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
  /** The Answer the last `ask` wrote, for its Run's Undo and Redo. */
  const askAnswer = async (mindId: string, plan: Call[]) => {
    await ask(mindId, plan);
    if (!lastAnswer) throw new Error("No Answer was asked.");
    return lastAnswer;
  };
  const named = (start: string) => {
    const found = setup.documents.find((each) => each.name.startsWith(start));
    if (!found) throw new Error(`${start} wasn't added.`);
    return found;
  };
  return {
    core,
    folderA,
    noteA,
    memo,
    lease,
    general: named("General"),
    outside: setup.mind,
    windowAsked,
    ask,
    askAnswer,
  };
}

const walled = async (core: Core, folderId: string) =>
  (await core.getLibrary()).groups.find((group) => group.id === folderId)?.keepInside;

/** The Run an Answer's commands were part of: what one Undo takes back, and a Redo puts back. */
const runOf = (answer: ConversationAnswer): string => {
  const run = answer.toolCalls.find((call) => call.command)?.command?.run;
  if (!run) throw new Error("No command ran.");
  return run;
};

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

  test("a Document from a deleted walled Folder says nothing about where it was, outside the wall", async () => {
    const clock = manualClock();
    const s = await setUp({ now: clock.now });
    await s.core.deleteDocuments([s.lease.id]);
    clock.advance(1000);
    await s.core.deleteLibraryGroup(s.folderA.id);
    const namesake = await s.core.createMind({ title: "Client A lease" });
    await s.core.deleteMind(namesake.id);

    const asked: { label: string; description: string }[][] = [];
    s.core.on("question.asked", (request) => {
      asked.push(request.question.options);
      const note = request.question.options.find((option) => option.label.startsWith("Note"));
      void s.core.answerUserQuestion(request.requestId, {
        skipped: false,
        chosen: note ? [note.label] : [],
        wrote: null,
      });
    });
    await s.ask(s.outside.id, [
      {
        tool: "run_command",
        input: { command: "deleted.restore", ids: [s.lease.id, namesake.id] },
      },
    ]);

    const options = asked[0] ?? [];
    expect(options.find((each) => each.label.startsWith("Document"))?.description).toBe("");
    expect(options.every((each) => !each.description.includes("Client A"))).toBe(true);
    expect(options.find((each) => each.label.startsWith("Note"))?.description).toBe(
      "It was in no Folder.",
    );
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

  test("from outside a wall it is never offered a walled Folder as a destination", async () => {
    const offered: string[][] = [];
    const s = await setUp({}, ({ prompt }) => {
      const data = JSON.parse(prompt) as { groups?: { id: string; name: string }[] };
      if (!data.groups) return { text: JSON.stringify({ tags: [] }) };
      offered.push(data.groups.map((each) => each.name));
      const into =
        data.groups.find((each) => each.name === "Client A") ??
        data.groups.find((each) => each.name === "Office");
      return { text: JSON.stringify({ groupId: into?.id ?? null, tags: [] }) };
    });
    const provider = (await s.core.listChatProviders())[0];
    if (!provider) throw new Error("No provider.");
    const settings = (await s.core.getLibrary()).settings;
    await s.core.saveLibrarySettings({
      classifier: { kind: "chat", choice: { providerId: provider.id, modelId: "local-model" } },
      automatic: settings.automatic,
    });
    const office = await s.core.createLibraryGroup({ name: "Office", description: "" });

    await s.ask(s.outside.id, [
      {
        tool: "run_command",
        input: { command: "documents.organize", folder: "Office", about: "General papers" },
      },
    ]);

    expect(offered.length).toBeGreaterThan(0);
    for (const names of offered) expect(names).not.toContain("Client A");
    expect(await heldIn(s.core, office.id)).toEqual([
      "General memo: waiting",
      "Late filing: waiting",
    ]);
    expect(await heldIn(s.core, s.folderA.id)).toEqual(["Client A lease: filed"]);
  });

  test("from outside a wall its plan is never offered a walled Folder", async () => {
    const offered: string[][] = [];
    const s = await setUp({}, ({ prompt }) => {
      const data = JSON.parse(prompt) as { folders?: unknown[]; documents?: unknown[] };
      if (data.folders && data.documents)
        offered.push(
          data.folders.flatMap((each) =>
            typeof each === "object" && each !== null && "name" in each ? [String(each.name)] : [],
          ),
        );
      const planned = planReply(prompt, { name: "Office", description: "" });
      return { text: planned?.text ?? JSON.stringify({ tags: [] }) };
    });
    const provider = (await s.core.listChatProviders())[0];
    if (!provider) throw new Error("No provider.");
    const settings = (await s.core.getLibrary()).settings;
    await s.core.saveLibrarySettings({
      classifier: { kind: "chat", choice: { providerId: provider.id, modelId: "local-model" } },
      automatic: settings.automatic,
    });
    const office = await s.core.createLibraryGroup({ name: "Office", description: "" });

    await s.ask(s.outside.id, [{ tool: "run_command", input: { command: "documents.organize" } }]);

    expect(offered.length).toBeGreaterThan(0);
    for (const names of offered) {
      expect(names).toContain("Office");
      expect(names).not.toContain("Client A");
    }
    expect(await heldIn(s.core, office.id)).toEqual([
      "General memo: waiting",
      "Late filing: waiting",
    ]);
    expect(await heldIn(s.core, s.folderA.id)).toEqual(["Client A lease: filed"]);
  });

  test("from inside a wall only that Folder and its sub-Folders are offered as destinations", async () => {
    const offered: string[][] = [];
    const s = await setUp({}, ({ prompt }) => {
      const data = JSON.parse(prompt) as { groups?: { id: string; name: string }[] };
      if (!data.groups) return { text: JSON.stringify({ tags: [] }) };
      offered.push(data.groups.map((each) => each.name));
      const into = data.groups.find((each) => each.name === "Client A");
      return { text: JSON.stringify({ groupId: into?.id ?? null, tags: [] }) };
    });
    const provider = (await s.core.listChatProviders())[0];
    if (!provider) throw new Error("No provider.");
    const settings = (await s.core.getLibrary()).settings;
    await s.core.saveLibrarySettings({
      classifier: { kind: "chat", choice: { providerId: provider.id, modelId: "local-model" } },
      automatic: settings.automatic,
    });
    const office = await s.core.createLibraryGroup({ name: "Office", description: "" });
    await s.core.createLibraryGroup({
      name: "Client A sub-Folder",
      description: "",
      parentId: s.folderA.id,
    });

    await s.ask(s.noteA.id, [
      { tool: "run_command", input: { command: "documents.organize", ids: [s.lease.id] } },
    ]);

    expect(offered.length).toBeGreaterThan(0);
    for (const names of offered)
      expect([...names].sort()).toEqual(["Client A", "Client A sub-Folder"]);
    expect(await heldIn(s.core, office.id)).toEqual([]);
    expect(await heldIn(s.core, s.folderA.id)).toEqual(["Client A lease: filed"]);
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

/** What a Folder holds, and what waits in Suggestions to go into it (#1569). */
async function heldIn(core: Core, folderId: string) {
  const names = new Map((await core.listDocuments()).map((each) => [each.id, each.name]));
  const proposed = (await core.getOrganizeReview()).items.filter(
    ({ placement }) => placement.kind === "folder" && placement.folderId === folderId,
  );
  return [
    ...(await core.getLibrary()).assignments
      .filter((each) => each.groupId === folderId)
      .map((each) => `${names.get(each.documentId)}: filed`),
    ...proposed.map((item) => `${names.get(item.documentId)}: waiting`),
  ].sort();
}

describe("the assistant's move judges the walls again when it moves", () => {
  test("a Folder that gains a wall after the check takes no Document the assistant moves", async () => {
    const s = await setUp();
    const outbox = await s.core.createLibraryGroup({ name: "Outbox", description: "" });
    // Checked while Outbox was outside every wall; it gained a wall before the move.
    await s.core.updateLibraryGroup(outbox.id, {
      name: "Outbox",
      description: "",
      keepInside: true,
    });

    await expect(
      s.core.moveToFolder({ documentIds: [s.general.id], folderId: outbox.id, wall: null }),
    ).rejects.toMatchObject({ wording: { key: "error.folder.wallMove" } });
    const { assignments } = await s.core.getLibrary();
    expect(assignments.find((each) => each.documentId === s.general.id)?.groupId).not.toBe(
      outbox.id,
    );
  });

  test("a turn whose wall was switched off files by the outside rule, so it can't file into another wall", async () => {
    const s = await setUp();
    const vault = await s.core.createLibraryGroup({ name: "Vault", description: "" });
    await s.core.updateLibraryGroup(vault.id, {
      name: "Vault",
      description: "",
      keepInside: true,
    });
    const sub = await s.core.createLibraryGroup({
      name: "Vault sub",
      description: "",
      parentId: vault.id,
    });
    const off = await s.core.createLibraryGroup({ name: "Off", description: "" });

    await expect(
      s.core.moveToFolder({ documentIds: [s.general.id], folderId: sub.id, wall: off.id }),
    ).rejects.toMatchObject({ wording: { key: "error.folder.wallMove" } });
    const { assignments } = await s.core.getLibrary();
    expect(assignments.find((each) => each.documentId === s.general.id)?.groupId).not.toBe(sub.id);
  });

  test("control: the same move with no wall switched moves the Document", async () => {
    const s = await setUp();
    const outbox = await s.core.createLibraryGroup({ name: "Outbox", description: "" });

    await s.core.moveToFolder({ documentIds: [s.general.id], folderId: outbox.id, wall: null });

    const { assignments } = await s.core.getLibrary();
    expect(assignments.find((each) => each.documentId === s.general.id)?.groupId).toBe(outbox.id);
  });

  test("a Note whose Folder is behind a wall is not moved out by a turn from outside it", async () => {
    const s = await setUp();
    const outbox = await s.core.createLibraryGroup({ name: "Outbox", description: "" });

    await expect(
      s.core.moveToFolder({ mindIds: [s.noteA.id], folderId: outbox.id, wall: null }),
    ).rejects.toMatchObject({ wording: { key: "error.folder.wallMove" } });
    expect((await s.core.listMinds()).find((mind) => mind.id === s.noteA.id)?.folderId).toBe(
      s.folderA.id,
    );
  });

  test("a Note moved inside its wall goes where it asks", async () => {
    const s = await setUp();

    await s.core.moveToFolder({
      mindIds: [s.noteA.id],
      folderId: s.folderA.id,
      wall: s.folderA.id,
    });

    expect((await s.core.listMinds()).find((mind) => mind.id === s.noteA.id)?.folderId).toBe(
      s.folderA.id,
    );
  });

  test("a redo of the assistant's move judges the wall again, and moves nothing across it", async () => {
    const s = await setUp();
    const answer = await s.askAnswer(s.outside.id, [
      {
        tool: "run_command",
        input: { command: "document.moveTo", ids: [s.general.id], folder: "Outbox" },
      },
    ]);
    const outbox = (await s.core.getLibrary()).groups.find((group) => group.name === "Outbox");
    if (!outbox) throw new Error("Outbox wasn't made.");
    const filed = async () =>
      (await s.core.getLibrary()).assignments.find((each) => each.documentId === s.general.id)
        ?.groupId ?? null;
    expect(await filed()).toBe(outbox.id);

    await s.core.updateLibraryGroup(outbox.id, {
      name: "Outbox",
      description: "",
      keepInside: true,
    });
    await s.core.undoCommands(runOf(answer));
    await expect(s.core.redoCommands(runOf(answer))).rejects.toMatchObject({
      wording: { key: "error.commands.redoPartly" },
    });
    expect(await filed()).toBeNull();
  });
});
