/**
 * An outside agent keeps working on a Note it wrote (#3371), through the shim the app ships: its
 * changes there land at once, each a step the User's Undo takes back after a Checkpoint, while a
 * Note the User wrote, or a copy of the agent's, still has them wait. `list_minds` says which
 * Notes are the agent's, `read_mind` which of their paragraphs hold the User's words and which line
 * is the title, and a change built on an older version is refused for its true cause.
 */
import { beforeAll, describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  type AgentNoteChange,
  CONTENT_SCHEMA_VERSION,
  CONTENT_SCHEMA_VERSION_KEY,
  GENERATED_MARK,
  MIND_SETTINGS_FIELD,
} from "../../src/core/api";
import { MindReadOnlyError } from "../../src/core/errors";
import { activityWords } from "../../src/renderer/src/components/agents/agentWords";
import { translate } from "../../src/shared/i18n";
import { mindName } from "../../src/shared/naming";
import { pendingProposals } from "../../src/shared/proposals";
import { buildAgentShim, connectLegacyAgent, startAgentsCore } from "../helpers/agents";
import { addAndProcess, createSourceFolder, writeSourceFile } from "../helpers/documents";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { editMind, note, readMind } from "../helpers/minds";
import { replyingModel } from "../helpers/models";

const TIDES = "# Tides\n\nSpring tides happen twice a month, at new moon and full moon.\n";
const OPENING = "Tides rise and fall twice a day along the coast.";
const RANGE = "The range between high and low water changes through the month.";
const TYPED = "Call the harbour master before the survey.";

type Agent = Awaited<ReturnType<typeof connectLegacyAgent>>;

interface Named {
  mindId: string;
  title: string;
  markdown: string;
  version: string;
}

interface Proposed {
  status: "applied" | "waiting";
  waiting: number;
  waitingInNote: number;
  markdown: string;
  version: string;
  next: string | null;
}

interface Listed {
  folders: { minds: { id: string; title: string; yours?: true }[] }[];
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

/** A core with agents on, Tides in "Coast", an agent that may write there, and what it tells the windows. */
async function paired(language: "en" | "zh-CN" = "en") {
  const started = await startAgentsCore(replyingModel());
  const { core } = started;
  if (language !== "en") await core.updateSettings({ user: { language } });
  const sources = await createSourceFolder();
  const [tides] = await addAndProcess(core, [await writeSourceFile(sources, "Tides.md", TIDES)]);
  if (!tides) throw new Error("Tides wasn't added.");
  const coast = await core.createLibraryGroup({ name: "Coast", description: "The sea." });
  await core.assignDocumentGroup(tides.id, coast.id);
  await core.setAgentsEnabled(true);
  const told: AgentNoteChange[] = [];
  core.on("agents.noteChanged", (change) => told.push(change));
  const connect = async (name = "Claude Code") => {
    const { launch, pairing } = await core.connectAgent({
      name,
      folderIds: [coast.id],
      propose: true,
    });
    return { agent: await connectLegacyAgent(launch), pairing };
  };
  const { agent, pairing } = await connect();
  return { ...started, core, coast, agent, pairing, told, connect };
}

const write = async (agent: Agent, title = "Tide report") =>
  structured<{ mindId: string }>(
    await agent.callTool({
      name: "create_mind",
      arguments: { title, markdown: `${OPENING}\n\n${RANGE}` },
    }),
  ).mindId;

const readNamed = async (agent: Agent, mindId: string) =>
  structured<Named>(
    await agent.callTool({ name: "read_mind", arguments: { mindId, named: true } }),
  );

const change = (agent: Agent, mindId: string, version: string, changes: object[]) =>
  agent.callTool({ name: "propose_changes", arguments: { mindId, version, changes } });

/** The Note's paragraphs as the User's window shows them, the title included, empty lines left out. */
const linesOf = (client: MindClient) => {
  const lines: string[] = [];
  readMind(client).forEach((block) => {
    if (block.textContent !== "") lines.push(block.textContent);
  });
  return lines;
};

/** Types `text` into the paragraph that holds `words`, just before them, as the User's typing is: no AI text mark. */
function typeBefore(client: MindClient, words: string, text: string): void {
  for (const block of client.blocks.toArray()) {
    const content = block instanceof Y.XmlElement ? block.get(0) : null;
    if (!(content instanceof Y.XmlText)) continue;
    const plain = (content.toDelta() as { insert: unknown }[])
      .map((run) => (typeof run.insert === "string" ? run.insert : ""))
      .join("");
    const at = plain.indexOf(words);
    if (at < 0) continue;
    content.insert(at, text, { [GENERATED_MARK]: null });
    return;
  }
  throw new Error(`No paragraph holds “${words}”.`);
}

describe("an agent's changes to a Note it wrote (#3371)", () => {
  beforeAll(async () => {
    await buildAgentShim();
  }, 60_000);

  // protects=an agent can keep working on its own Note: each change is in it at once, and the User takes each back with Undo; fails_when=a change waits, is refused as stale, or Undo takes back the wrong one
  it("land at once, three in a row, and one Undo for each takes them back in order", async () => {
    const { core, agent, told, pairing } = await paired();
    const mindId = await write(agent);
    const client = await connectToMind(core, mindId);
    const before = linesOf(client);
    expect(before).toEqual(["Tide report", OPENING, RANGE]);

    let { version } = await readNamed(agent, mindId);
    const states = [before];
    for (const changes of [
      [{ paragraph: "¶1", text: "Tides rise and fall twice a day." }],
      [{ paragraph: "¶2+", text: "Neap tides come at the quarter moons." }],
      [{ paragraph: "¶1", text: "Tides turn twice a day." }],
    ]) {
      const done = structured<Proposed>(await change(agent, mindId, version, changes));
      expect(done).toMatchObject({ status: "applied", waiting: 0, waitingInNote: 0 });
      ({ version } = done);
      await expect.poll(() => linesOf(client)).not.toEqual(states.at(-1));
      expect(pendingProposals(client.blocks)).toEqual([]);
      states.push(linesOf(client));
    }
    expect(states.at(-1)).toEqual([
      "Tide report",
      "Tides turn twice a day.",
      RANGE,
      "Neap tides come at the quarter moons.",
    ]);
    // A Checkpoint of the Note as it was before each.
    const { checkpoints } = await core.listCheckpoints(mindId);
    expect(checkpoints.filter((each) => each.reason === "accept")).toHaveLength(3);

    const steps = told.flatMap((each) => (each.kind === "changed" && each.step ? [each.step] : []));
    expect(told.map((each) => [each.kind, each.agent, each.changed, each.added])).toEqual([
      ["wrote", "Claude Code", 0, 0],
      ["changed", "Claude Code", 1, 0],
      ["changed", "Claude Code", 0, 1],
      ["changed", "Claude Code", 1, 0],
    ]);
    expect(steps).toHaveLength(3);
    // Last first: an earlier one isn't taken back over a later one.
    expect(await core.undoAgentChange(steps[0] ?? "")).toBe("unavailable");
    for (const [index, step] of [...steps.entries()].reverse()) {
      expect(await core.undoAgentChange(step)).toBe("done");
      await expect.poll(() => linesOf(client)).toEqual(states[index]);
    }
    expect(await core.redoAgentChange(steps[0] ?? "")).toBe("done");
    await expect.poll(() => linesOf(client)).toEqual(states[1]);

    // Its activity list says each changed the Note, never that a change waits.
    const said = (await core.listAgentActivity(pairing.id))
      .filter((each) => each.tool === "propose_changes")
      .map((each) => activityWords(each, (key, params) => translate("en", key, params)));
    expect(said).toEqual(Array(3).fill("Changed the note “Tide report”"));
  });

  // protects=a Note the User wrote stays theirs: an agent's changes there wait, and it learns how many; fails_when=a change to the User's Note applies, or the count leaves out earlier ones
  it("wait in a Note the User wrote, as before, saying how many wait in all", async () => {
    const { core, agent, coast, told } = await paired();
    const mind = await core.createMind({ title: "", folderId: coast.id });
    const client = await connectToMind(core, mind.id);
    editMind(client, () => [note(OPENING), note(RANGE)]);
    await client.settled();

    let { version } = await readNamed(agent, mind.id);
    const counts: number[] = [];
    for (const changes of [
      [{ paragraph: "¶1", text: "Tides rise and fall twice a day." }],
      [{ paragraph: "¶2+", text: "Neap tides come at the quarter moons." }],
      [{ paragraph: "¶2", text: "The range changes through the month." }],
    ]) {
      const done = structured<Proposed>(await change(agent, mind.id, version, changes));
      expect(done).toMatchObject({ status: "waiting", waiting: 1, next: null });
      counts.push(done.waitingInNote);
      ({ version } = done);
    }
    expect(counts).toEqual([1, 2, 3]);
    await expect
      .poll(() => new Set(pendingProposals(client.blocks).map((each) => each.request)).size)
      .toBe(3);
    expect(told).toEqual([]);
  });

  // protects=the User's own words in the agent's Note stay theirs and are never overwritten unseen; fails_when=read_mind doesn't say whose they are, a change built before them lands, or the refusal blames the agent
  it("marks what the User typed as theirs, and refuses a change built before it, naming the User", async () => {
    const { core, agent } = await paired();
    const mindId = await write(agent);
    const before = await readNamed(agent, mindId);
    expect(before.markdown).toBe(`¶0 # Tide report\n\n¶1 ${OPENING}\n\n¶2 ${RANGE}`);

    const client = await connectToMind(core, mindId);
    editMind(client, (blocks) => [...blocks, note(TYPED)]);
    typeBefore(client, "twice a day", "usually ");
    await client.settled();

    const now = await readNamed(agent, mindId);
    expect(now.markdown).toBe(
      [
        "¶0 # Tide report",
        "¶1 (the User changed this) Tides rise and fall usually twice a day along the coast.",
        `¶2 ${RANGE}`,
        `¶3 (the User wrote this) ${TYPED}`,
      ].join("\n\n"),
    );
    expect(
      refusal(
        await change(agent, mindId, before.version, [{ paragraph: "¶2", text: "Ranges vary." }]),
      ),
    ).toBe(
      "The User changed this note after you read it. Read it again with named, then make your changes again.",
    );

    const done = structured<Proposed>(
      await change(agent, mindId, now.version, [{ paragraph: "¶2", text: "Ranges vary." }]),
    );
    expect(done.status).toBe("applied");
    await expect.poll(() => linesOf(client)).toContain("Ranges vary.");
    expect(linesOf(client)).toEqual([
      "Tide report",
      "Tides rise and fall usually twice a day along the coast.",
      "Ranges vary.",
      TYPED,
    ]);
    // Built on the version its own change replaced: it says so.
    expect(
      refusal(await change(agent, mindId, now.version, [{ paragraph: "¶3+", text: "More." }])),
    ).toBe(
      "Your own change gave this note a new version after you read it. Use the version propose_changes returned, or read the note again with named, then make this change again.",
    );
  });

  // protects=a copy of the agent's Note is the User's, so its changes never land there unasked; fails_when=the copied writer record makes the copy's changes apply at once
  it("waits in a copy the User made of its Note", async () => {
    const { core, agent, told } = await paired();
    const mindId = await write(agent);
    const copy = await core.duplicateMind(mindId);
    const { version, markdown } = await readNamed(agent, copy.id);
    expect(markdown).not.toContain("(the User");
    const done = structured<Proposed>(
      await change(agent, copy.id, version, [{ paragraph: "¶1", text: "Tides turn twice a day." }]),
    );
    expect(done).toMatchObject({ status: "waiting", waiting: 1, waitingInNote: 1 });
    expect(told.map((each) => each.kind)).toEqual(["wrote"]);
  });

  // protects=a new conversation finds the agent's own Notes, and never another agent's as its own; fails_when=list_minds marks none, or marks another agent's Note
  it("are listed as its own, and no other agent's are", async () => {
    const { core, agent, coast, connect } = await paired();
    const { agent: other } = await connect("Codex");
    const mine = await write(agent, "Tide report");
    const theirs = await write(other, "Codex's report");
    const users = await core.createMind({ title: "My plans", folderId: coast.id });
    const listed = (folders: Listed["folders"]) =>
      Object.fromEntries(
        folders.flatMap((each) => each.minds).map((each) => [each.id, each.yours]),
      );
    const forMe = structured<Listed>(await agent.callTool({ name: "list_minds", arguments: {} }));
    expect(listed(forMe.folders)).toEqual({
      [mine]: true,
      [theirs]: undefined,
      [users.id]: undefined,
    });
    const forThem = structured<Listed>(await other.callTool({ name: "list_minds", arguments: {} }));
    expect(listed(forThem.folders)).toEqual({
      [mine]: undefined,
      [theirs]: true,
      [users.id]: undefined,
    });

    // Another agent's changes to it wait, and are none of this one's steps.
    const { version } = await readNamed(other, mine);
    const done = structured<Proposed>(
      await change(other, mine, version, [{ paragraph: "¶1", text: "Tides turn." }]),
    );
    expect(done.status).toBe("waiting");
  });

  // protects=the sidebar names the Note as its page does after the agent rewrites the title, and a name the User chose stays; fails_when=the sidebar keeps the old title, or the User's own name is replaced
  it("renames the Note when it rewrites the title the Note was named by, and keeps a name the User gave it", async () => {
    const { core, agent } = await paired();
    const nameOf = async (mindId: string) => {
      const mind = (await core.listMinds()).find((each) => each.id === mindId);
      return mind && mindName(mind);
    };
    const titled = await write(agent, "Tide report");
    const renamed = await write(agent, "Tide notes");
    await core.renameMind(renamed, "My survey");

    for (const mindId of [titled, renamed]) {
      const { version } = await readNamed(agent, mindId);
      structured<Proposed>(
        await change(agent, mindId, version, [{ paragraph: "¶0", text: "# Spring tide survey" }]),
      );
      const client = await connectToMind(core, mindId);
      await expect.poll(() => linesOf(client)[0]).toBe("Spring tide survey");
    }
    expect(await nameOf(titled)).toBe("Spring tide survey");
    expect(await nameOf(renamed)).toBe("My survey");
  });

  // protects=the title is never a numbered paragraph, so "the second paragraph" means the second under it; fails_when=the title is ¶1 or read_mind gives it twice
  it("reads the title once, as ¶0, and a change can go right under it", async () => {
    const { core, agent } = await paired("zh-CN");
    const mindId = await write(agent);
    const plain = structured<{ title: string; markdown: string }>(
      await agent.callTool({ name: "read_mind", arguments: { mindId } }),
    );
    expect(plain.title).toBe("Tide report");
    expect(plain.markdown.match(/Tide report/g)).toHaveLength(1);
    const { version } = await readNamed(agent, mindId);
    const done = structured<Proposed>(
      await change(agent, mindId, version, [{ paragraph: "¶0+", text: "Dated 4 December 2025." }]),
    );
    expect(done.markdown).toBe(
      `¶0 # Tide report\n\n¶1 Dated 4 December 2025.\n\n¶2 ${OPENING}\n\n¶3 ${RANGE}`,
    );
    expect(
      refusal(await change(agent, mindId, done.version, [{ paragraph: "¶4", text: "x" }])),
    ).toBe("笔记中没有 ¶4：¶0 是标题，段落为 ¶1 到 ¶3。");
    const client = await connectToMind(core, mindId);
    expect(linesOf(client)).toEqual(["Tide report", "Dated 4 December 2025.", OPENING, RANGE]);
  });
});

/** The Note's paragraph that holds `words`, as the User's window holds it. */
function paragraphWith(client: MindClient, words: string): Y.XmlElement {
  for (const block of client.blocks.toArray()) {
    if (!(block instanceof Y.XmlElement)) continue;
    const content = block.get(0);
    if (!(content instanceof Y.XmlText)) continue;
    const plain = (content.toDelta() as { insert: unknown }[])
      .map((run) => (typeof run.insert === "string" ? run.insert : ""))
      .join("");
    if (plain.includes(words)) return block;
  }
  throw new Error(`No paragraph holds “${words}”.`);
}

/** The User deletes the whole paragraph that holds `words`. */
function deleteParagraph(client: MindClient, words: string): void {
  const paragraph = paragraphWith(client, words);
  client.blocks.delete(client.blocks.toArray().indexOf(paragraph), 1);
}

describe("Undo and Redo of an agent's change to a Note it wrote (#3371)", () => {
  beforeAll(async () => {
    await buildAgentShim();
  }, 60_000);

  /** A Note the agent wrote, then changed twice: ¶1 (`a`) and then ¶2 (`b`). */
  async function changedTwice(language: "en" | "zh-CN" = "en") {
    const started = await paired(language);
    const { core, agent, told } = started;
    const mindId = await write(agent);
    const client = await connectToMind(core, mindId);
    let { version } = await readNamed(agent, mindId);
    for (const changes of [
      [{ paragraph: "¶1", text: "Tides turn twice a day." }],
      [{ paragraph: "¶2", text: "Ranges vary through the month." }],
    ]) {
      ({ version } = structured<Proposed>(await change(agent, mindId, version, changes)));
    }
    await expect.poll(() => linesOf(client)).toContain("Ranges vary through the month.");
    const [a = "", b = ""] = told.flatMap((each) => (each.step ? [each.step] : []));
    return { ...started, mindId, client, a, b };
  }

  // protects=one press takes back the change it names and no other; fails_when=Undo of a change whose paragraph is gone takes back an earlier change instead, or the steps offered stop matching what Undo does
  it("take back only the change Undo names: one whose paragraph is gone takes back nothing, and says so", async () => {
    const { core, client, a, b } = await changedTwice();
    deleteParagraph(client, "Ranges vary");
    await client.settled();

    expect(await core.undoAgentChange(b)).toBe("nothing-left");
    expect(linesOf(client)).toEqual(["Tide report", "Tides turn twice a day."]);
    // It is gone from the steps: the next press is the change before it, which goes back.
    expect(await core.undoAgentChange(b)).toBe("unavailable");
    expect(await core.redoAgentChange(b)).toBe("unavailable");
    expect(await core.undoAgentChange(a)).toBe("done");
    await expect.poll(() => linesOf(client)).toEqual(["Tide report", OPENING]);
    expect(await core.redoAgentChange(a)).toBe("done");
    await expect.poll(() => linesOf(client)).toEqual(["Tide report", "Tides turn twice a day."]);
  });

  // protects=Redo does again the change it names and no other; fails_when=Redo of a change whose paragraph is gone does another change again
  it("do again only the change Redo names", async () => {
    const { core, client, a, b } = await changedTwice();
    expect(await core.undoAgentChange(b)).toBe("done");
    expect(await core.undoAgentChange(a)).toBe("done");
    await expect.poll(() => linesOf(client)).toEqual(["Tide report", OPENING, RANGE]);
    deleteParagraph(client, OPENING);
    await client.settled();

    expect(await core.redoAgentChange(a)).toBe("nothing-left");
    expect(linesOf(client)).toEqual(["Tide report", RANGE]);
    expect(await core.redoAgentChange(b)).toBe("done");
    await expect
      .poll(() => linesOf(client))
      .toEqual(["Tide report", "Ranges vary through the month."]);
  });

  // protects=what the User typed inside the agent's change stays when Undo takes the change back; fails_when=Undo takes the User's words too, or another change
  it("keep what the User typed inside the change it takes back", async () => {
    const { core, client, b } = await changedTwice();
    typeBefore(client, " through the month", " widely");
    await client.settled();

    expect(await core.undoAgentChange(b)).toBe("done");
    await expect.poll(() => linesOf(client)).not.toContain("Ranges vary widely through the month.");
    const [title, first, second] = linesOf(client);
    expect([title, first]).toEqual(["Tide report", "Tides turn twice a day."]);
    expect(second).toContain("widely");
    expect(second).not.toContain("Ranges vary");
    expect(second?.replace(" widely", "")).toBe(RANGE);
  });

  // protects=a Note a newer IncarnaMind wrote is never changed by this one; fails_when=Undo or Redo changes the Note and only then finds it may not
  it("leave a Note a newer IncarnaMind wrote exactly as it is, and say why", async () => {
    const { core, client, mindId, a, b } = await changedTwice();
    expect(await core.undoAgentChange(b)).toBe("done");
    await expect
      .poll(() => linesOf(client))
      .toEqual(["Tide report", "Tides turn twice a day.", RANGE]);
    client.doc
      .getMap(MIND_SETTINGS_FIELD)
      .set(CONTENT_SCHEMA_VERSION_KEY, CONTENT_SCHEMA_VERSION + 1);
    await client.settled();

    for (const step of [() => core.undoAgentChange(a), () => core.redoAgentChange(b)]) {
      const failure = await step().then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(MindReadOnlyError);
      expect((failure as MindReadOnlyError).wording).toEqual({
        key: "error.mind.newerVersionEdit",
      });
    }
    const now = await connectToMind(core, mindId);
    expect(linesOf(now)).toEqual(["Tide report", "Tides turn twice a day.", RANGE]);
    // Refused, each step leaves, as the window's Undo lets go of it.
    expect(await core.undoAgentChange(a)).toBe("unavailable");
    expect(await core.redoAgentChange(b)).toBe("unavailable");
  });

  // protects=restoring a version, or disconnecting the agent, leaves Undo safe; fails_when=either throws, or Undo then changes the restored Note
  it("after a version is restored take back nothing of it, and outlast the agent's disconnection", async () => {
    const { core, client, mindId, pairing, a, b } = await changedTwice();
    const { checkpoints } = await core.listCheckpoints(mindId);
    const first = checkpoints.filter((each) => each.reason === "accept").at(-1);
    if (!first) throw new Error("No Checkpoint before the first change.");
    await core.restoreCheckpoint(mindId, first.id);
    await expect.poll(() => linesOf(client)).toEqual(["Tide report", OPENING, RANGE]);
    expect(await core.undoAgentChange(b)).toBe("nothing-left");
    expect(await core.undoAgentChange(a)).toBe("nothing-left");
    expect(linesOf(client)).toEqual(["Tide report", OPENING, RANGE]);

    const again = await changedTwice();
    await again.core.disconnectAgent(again.pairing.id);
    expect(await again.core.undoAgentChange(again.b)).toBe("done");
    await expect
      .poll(() => linesOf(again.client))
      .toEqual(["Tide report", "Tides turn twice a day.", RANGE]);
    expect(pairing.id).not.toBe(again.pairing.id);
  });
});
