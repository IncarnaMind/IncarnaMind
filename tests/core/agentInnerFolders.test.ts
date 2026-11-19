/**
 * A Folder shared with an outside agent shares everything inside it (#3394): the Folders inside
 * it, their Documents, notes and meetings, up to the next wall. A Folder behind a wall is shared
 * only by its own grant, alone. Through the shim the app ships, with the MCP SDK's own client.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { Core } from "../../src/core";
import { createFakeAnalysisRuntime } from "../../src/core/analysis/fake";
import type { AnalysisJob } from "../../src/shared/analysis";
import {
  buildAgentShim,
  connectLegacyAgent,
  resultText,
  startMeetingAgentsCore,
} from "../helpers/agents";
import { addAndProcess, createSourceFolder, writeSourceFile } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { editMind, note } from "../helpers/minds";

type Agent = Awaited<ReturnType<typeof connectLegacyAgent>>;

interface Listed {
  folders: {
    id: string;
    name: string;
    path?: string;
    documents: number;
    documentList: { id: string; name: string }[];
    minds: { id: string; title: string; meeting?: { transcript: string } }[];
  }[];
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

const listsGiven = (job: AnalysisJob | undefined) =>
  (job?.inputs ?? []).map((input) =>
    input.kind === "table" ? input.rows.map((row) => row.join(" | ")) : [],
  );

async function noteIn(core: Core, folderId: string, title: string, text: string) {
  const mind = await core.createMind({ title, folderId });
  const client = await connectToMind(core, mind.id);
  editMind(client, (blocks) => [...blocks, note(text)]);
  await client.settled();
  return mind;
}

/** Words of what an agent given Coast may not reach: Legal (walled, inside Coast) and Private. */
const BEYOND = /Legal|Drafts|Claim|Gwavas|settle|Private|Archive|Penhallow|tonnage/;

/**
 * Coast, shared: a timetable; Engineering inside it (the gearbox report, the note "Refit plan" and
 * the meeting "Refit call") and Yard inside that (the slipway survey). Legal, inside Coast behind
 * its own wall (the claim, the note "Claim notes", the meeting "Claim call") and Drafts inside
 * Legal (a draft reply). Private, never shared, and Archive inside it.
 */
async function library() {
  const runtime = createFakeAnalysisRuntime();
  const { core, recordMeeting } = await startMeetingAgentsCore(
    {
      mine: [
        "The Puffin's gearbox goes to Falmouth Yard in March.",
        "The Gwavas claim will settle.",
      ],
      theirs: ["Falmouth Yard confirmed the March slot.", "The papers arrive next week."],
    },
    { analysisRuntime: runtime },
  );
  const sources = await createSourceFolder();
  const added = await addAndProcess(core, [
    await writeSourceFile(
      sources,
      "Timetable.md",
      "# Timetable\n\nThe first ferry leaves at seven.\n",
    ),
    await writeSourceFile(
      sources,
      "Gearbox.md",
      "# Gearbox\n\nThe gearbox overhaul costs nine thousand pounds.\n",
    ),
    await writeSourceFile(
      sources,
      "Slipway.md",
      "# Slipway\n\nThe slipway survey found the rails sound.\n",
    ),
    await writeSourceFile(
      sources,
      "Claim.md",
      "# Claim\n\nGwavas Marine claims forty thousand pounds.\n",
    ),
    await writeSourceFile(
      sources,
      "Draft.md",
      "# Draft\n\nThe draft reply offers to settle the claim.\n",
    ),
    await writeSourceFile(
      sources,
      "Archive.md",
      "# Archive\n\nThe archived tonnage records end in 2019.\n",
    ),
  ]);
  const [timetable, gearbox, slipway, claim, draft, archive] = added;
  if (!timetable || !gearbox || !slipway || !claim || !draft || !archive) {
    throw new Error("The Documents weren't added.");
  }
  const folder = (name: string, parentId: string | null = null, keepInside = false) =>
    core.createLibraryGroup({ name, description: "", parentId, keepInside });
  const coast = await folder("Coast");
  const engineering = await folder("Engineering", coast.id);
  const yard = await folder("Yard", engineering.id);
  const legal = await folder("Legal", coast.id, true);
  const drafts = await folder("Drafts", legal.id);
  const hidden = await folder("Private");
  const archived = await folder("Archive", hidden.id);
  const filings: [string, string][] = [
    [timetable.id, coast.id],
    [gearbox.id, engineering.id],
    [slipway.id, yard.id],
    [claim.id, legal.id],
    [draft.id, drafts.id],
    [archive.id, archived.id],
  ];
  for (const [documentId, folderId] of filings)
    await core.assignDocumentGroup(documentId, folderId);
  const refitPlan = await noteIn(
    core,
    engineering.id,
    "Refit plan",
    "The gearbox overhaul is booked for the second week of March.",
  );
  const claimNotes = await noteIn(core, legal.id, "Claim notes", "Gwavas Marine wants to settle.");
  const draftNote = await noteIn(core, drafts.id, "Draft reply", "Offer to settle by Friday.");
  const archiveNote = await noteIn(
    core,
    archived.id,
    "Archive list",
    "The tonnage books are boxed.",
  );
  const refitCall = await recordMeeting(engineering.id, "Refit call");
  const claimCall = await recordMeeting(legal.id, "Claim call");
  await core.setAgentsEnabled(true);
  const connect = async (name: string, folderIds: string[]) => {
    const { pairing, launch } = await core.connectAgent({ name, folderIds, propose: true });
    return { pairing, agent: await connectLegacyAgent(launch) };
  };
  return {
    core,
    runtime,
    connect,
    folders: { coast, engineering, yard, legal, drafts, hidden, archived },
    documents: { timetable, gearbox, slipway, claim, draft, archive },
    notes: { refitPlan, claimNotes, draftNote, archiveNote },
    meetings: { refitCall, claimCall },
  };
}

const search = async (agent: Agent, query: string, folderIds?: string[]) =>
  structured<{ passages: { passageId: string; documentId: string; cite: string | null }[] }>(
    await agent.callTool({ name: "search", arguments: { query, folderIds } }),
  ).passages;

describe("an agent given a Folder", { timeout: 120_000 }, () => {
  beforeAll(async () => {
    await buildAgentShim();
  }, 60_000);

  // protects=a shared Folder shares the Folders inside it, each listed by its own name and path with what is filed in it, so the counts add up, and their Documents, notes and meetings are searched, read and cited; fails_when=a note or meeting in an inner Folder is out of reach, an inner Folder's Documents are counted twice, or a walled Folder inside the shared one is listed or counted
  it("lists, searches, reads and cites what the Folders inside it hold, each Folder under its own name", async () => {
    const { connect, folders, documents, notes, meetings, runtime } = await library();
    const { agent } = await connect("Claude Code", [folders.coast.id]);

    const listed = structured<Listed>(await agent.callTool({ name: "list_minds", arguments: {} }));
    expect(
      listed.folders.map((each) => [
        each.name,
        each.path ?? null,
        each.documents,
        each.minds.map((mind) => mind.title).sort(),
      ]),
    ).toEqual([
      ["Coast", null, 1, []],
      ["Engineering", "Coast / Engineering", 1, ["Refit call", "Refit plan"]],
      ["Yard", "Coast / Engineering / Yard", 1, []],
    ]);
    const call = listed.folders[1]?.minds.find((mind) => mind.title === "Refit call");
    expect(call?.meeting?.transcript).toBe(meetings.refitCall.transcriptId);
    expect(JSON.stringify(listed)).not.toMatch(BEYOND);

    const read = structured<{ markdown: string }>(
      await agent.callTool({ name: "read_mind", arguments: { mindId: notes.refitPlan.id } }),
    );
    expect(read.markdown).toContain("second week of March");
    const found = new Set(
      (await search(agent, "gearbox slipway ferry Falmouth")).map((each) => each.documentId),
    );
    expect(found).toEqual(
      new Set([
        documents.timetable.id,
        documents.gearbox.id,
        documents.slipway.id,
        meetings.refitCall.transcriptId,
      ]),
    );
    const [passage] = (await search(agent, "gearbox overhaul")).filter(
      (each) => each.documentId === documents.gearbox.id,
    );
    const cited = structured<{ citations: { check: string }[] }>(
      await agent.callTool({
        name: "cite",
        arguments: {
          citations: [
            {
              passageId: passage?.passageId,
              quote: "The gearbox overhaul costs nine thousand pounds.",
            },
          ],
        },
      }),
    ).citations;
    expect(cited.map((each) => each.check)).toEqual(["found"]);

    // Naming an inner Folder searches it and the Folders inside it, and nothing beside it.
    expect(
      new Set(
        (await search(agent, "gearbox slipway ferry", [folders.engineering.id])).map(
          (each) => each.documentId,
        ),
      ),
    ).toEqual(
      new Set([documents.gearbox.id, documents.slipway.id, meetings.refitCall.transcriptId]),
    );

    // The Library's lists as a run counts them: each inner Folder with its own path.
    structured(
      await agent.callTool({
        name: "run_analysis",
        arguments: {
          title: "Count",
          inputs: [
            { name: "documents", library: "documents" },
            { name: "folders", library: "folders" },
            { name: "notes", library: "notes" },
          ],
          code: 'result("n", len(inputs["documents"]))',
        },
      }),
    );
    const [documentRows, folderRows, noteRows] = listsGiven(runtime.jobs[0]);
    expect([...(documentRows ?? [])].sort()).toEqual([
      "Gearbox | markdown | Engineering | Coast / Engineering | ",
      "Slipway | markdown | Yard | Coast / Engineering / Yard | ",
      "Timetable | markdown | Coast | Coast | ",
    ]);
    expect(
      [...(folderRows ?? [])].map((row) => row.split(" | ").slice(0, 3).join(" | ")).sort(),
    ).toEqual([
      "Coast |  | Coast",
      "Engineering | Coast | Coast / Engineering",
      "Yard | Engineering | Coast / Engineering / Yard",
    ]);
    expect([...(noteRows ?? [])].sort()).toEqual([
      "Refit call | Engineering | Coast / Engineering",
      "Refit plan | Engineering | Coast / Engineering",
    ]);
    expect(listsGiven(runtime.jobs[0]).flat().join("\n")).not.toMatch(BEYOND);
  });

  // protects=an agent writes, changes and checks notes in a Folder inside its own, never behind a wall inside it, and every refusal reads as for an id that never was; fails_when=create_mind refuses an inner Folder or takes a walled one, propose_changes or read_mind reach a walled note, or a refusal names what is outside
  it("writes and changes notes in the Folders inside it, never behind a wall there, and tells nothing of what is outside", async () => {
    const { core, connect, folders, documents, notes, meetings } = await library();
    const { agent } = await connect("Claude Code", [folders.coast.id]);
    const refusal = async (name: string, args: Record<string, unknown>) => {
      const result = await agent.callTool({ name, arguments: args });
      expect(result.isError, name).toBe(true);
      return resultText(result);
    };
    const nowhere = await refusal("read_mind", { mindId: "no-such-note" });
    const notShared = await refusal("search", { query: "claim", folderIds: ["no-such-folder"] });

    const made = structured<{ mindId: string; folder: string }>(
      await agent.callTool({
        name: "create_mind",
        arguments: {
          title: "Yard visit",
          markdown: "The yard visit is on Tuesday.",
          folderId: folders.yard.id,
        },
      }),
    );
    expect(made.folder).toBe("Yard");
    const plain = structured<{ folder: string }>(
      await agent.callTool({
        name: "create_mind",
        arguments: {
          title: "Timetable change",
          markdown: "The first ferry moves to ten past seven.",
        },
      }),
    );
    expect(plain.folder).toBe("Coast");
    const task = structured<{ sentences: unknown[] }>(
      await agent.callTool({ name: "check_mind_yourself", arguments: { mindId: made.mindId } }),
    );
    expect(task.sentences.length).toBeGreaterThan(0);

    const named = structured<{ version: string }>(
      await agent.callTool({
        name: "read_mind",
        arguments: { mindId: notes.refitPlan.id, named: true },
      }),
    );
    const proposed = structured<{ status: string }>(
      await agent.callTool({
        name: "propose_changes",
        arguments: {
          mindId: notes.refitPlan.id,
          version: named.version,
          changes: [{ paragraph: "¶1+", text: "The yard confirmed the slot." }],
        },
      }),
    );
    expect(proposed.status).toBe("waiting");

    for (const mindId of [
      notes.claimNotes.id,
      notes.draftNote.id,
      notes.archiveNote.id,
      meetings.claimCall.mindId,
    ]) {
      expect(await refusal("read_mind", { mindId })).toBe(nowhere);
      expect(
        await refusal("propose_changes", {
          mindId,
          version: "v",
          changes: [{ paragraph: "¶1+", text: "More." }],
        }),
      ).toBe(nowhere);
    }
    for (const documentId of [
      documents.claim.id,
      documents.draft.id,
      documents.archive.id,
      meetings.claimCall.transcriptId,
    ]) {
      expect(await refusal("read_passages", { documentId })).toBe(nowhere);
    }
    for (const folderId of [
      folders.legal.id,
      folders.drafts.id,
      folders.hidden.id,
      folders.archived.id,
    ]) {
      expect(await refusal("search", { query: "claim", folderIds: [folderId] })).toBe(notShared);
      expect(
        await refusal("create_mind", { title: "Note", markdown: "A line of text here.", folderId }),
      ).toBe(notShared);
    }
    expect(JSON.stringify(await search(agent, "claim settle Gwavas tonnage draft"))).not.toMatch(
      BEYOND,
    );

    // The Ask offer goes by the same reach: an inner Folder's note, never a walled one's (#3373).
    const asked = async (mindId: string) =>
      (await core.listAgentsToAsk(mindId)).map((pairing) => pairing.name);
    expect(await asked(notes.refitPlan.id)).toEqual(["Claude Code"]);
    expect(await asked(notes.claimNotes.id)).toEqual([]);
    expect(await asked(notes.archiveNote.id)).toEqual([]);
  });

  // protects=a wall is still a wall: a walled Folder inside a shared one is shared only by its own grant, alone, and then with the Folders inside it, never what is outside it; fails_when=a grant of the walled Folder reaches its parent, it can be shared beside another Folder, or its inner Folders are left out
  it("shares a walled Folder inside it only by its own grant, alone, with the Folders inside the wall", async () => {
    const { core, connect, folders, documents, notes, meetings } = await library();
    await expect(
      core.connectAgent({ name: "Codex", folderIds: [folders.coast.id, folders.legal.id] }),
    ).rejects.toThrow(/keeps its work inside it/);
    const { agent } = await connect("Codex", [folders.legal.id]);
    const listed = structured<Listed>(await agent.callTool({ name: "list_minds", arguments: {} }));
    expect(
      listed.folders.map((each) => [
        each.name,
        each.path ?? null,
        each.minds.map((mind) => mind.title).sort(),
      ]),
    ).toEqual([
      ["Legal", null, ["Claim call", "Claim notes"]],
      ["Drafts", "Legal / Drafts", ["Draft reply"]],
    ]);
    expect(JSON.stringify(listed)).not.toMatch(/Coast|Engineering|Yard|Refit|Timetable|Gearbox/);
    const read = structured<{ markdown: string }>(
      await agent.callTool({ name: "read_mind", arguments: { mindId: notes.draftNote.id } }),
    );
    expect(read.markdown).toContain("Offer to settle by Friday.");
    expect(
      new Set(
        (await search(agent, "claim settle Gwavas gearbox ferry")).map((each) => each.documentId),
      ),
    ).toEqual(new Set([documents.claim.id, documents.draft.id, meetings.claimCall.transcriptId]));
  });
});
