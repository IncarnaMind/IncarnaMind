/**
 * A meeting the User shared, as an outside agent reaches it (#3384): through the shim the app
 * ships, with the MCP SDK's own client. A Meeting is one item, its Note with its Transcript: the
 * agent finds it on its Note's row, and searches, reads and cites its Transcript as any Document.
 * A meeting whose Note the agent may not read is never listed, searched, cited or counted, and
 * nothing of it comes back in a refusal. Meetings are recorded with the fake capture and engine.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { Core } from "../../src/core";
import { createFakeAnalysisRuntime } from "../../src/core/analysis/fake";
import { NOT_IN_A_FOLDER_ID } from "../../src/core/api";
import { createFakeCapture, type FakeCapture } from "../../src/core/meetings/fakeCapture";
import type { AnalysisJob } from "../../src/shared/analysis";
import { formatFullDateTime } from "../../src/shared/dates";
import { agentsAdapter, buildAgentShim, connectLegacyAgent, resultText } from "../helpers/agents";
import { createTempDataFolder, manualClock, startCore } from "../helpers/core";
import {
  addAndProcess,
  createSourceFolder,
  waitForProcessing,
  writeSourceFile,
} from "../helpers/documents";
import {
  inProcessTranscriber,
  NO_TRANSCRIPTION_FILES,
  stoppedMeeting,
  until,
} from "../helpers/transcription";

type Agent = Awaited<ReturnType<typeof connectLegacyAgent>>;

/** Each meeting says one line on each side: the User's, then the other side's. */
const MEETINGS = {
  harbour: [
    "We'll move the first North crossing to ten past seven.",
    "The harbour can open the slipway earlier.",
  ],
  sale: [
    "The board agreed to sell the Tern for a million pounds.",
    "Penhallow Shipping signs on the thirtieth of April.",
  ],
  party: ["Book the Ship Inn for the staff party.", "The Ship Inn can take forty people."],
  refit: [
    "The Puffin's refit moves to Falmouth Yard.",
    "Falmouth Yard confirmed the slot for January.",
  ],
  claim: [
    "The claim against Gwavas Marine settles out of court.",
    "The settlement papers arrive next week.",
  ],
} as const;
type Key = keyof typeof MEETINGS;

const ORDER: readonly Key[] = ["harbour", "sale", "party", "refit", "claim"];

interface Listed {
  folders: {
    id: string;
    documents: number;
    documentList: { id: string; name: string }[];
    minds: {
      id: string;
      title: string;
      meeting?: { started: string | null; transcript: string };
    }[];
  }[];
}

interface Found {
  passages: {
    passageId: string;
    documentId: string;
    location: string | null;
    cite: string | null;
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

/** The rows the code was given of each list, as text: what it could count, and nothing else. */
const listsGiven = (job: AnalysisJob | undefined) =>
  (job?.inputs ?? []).map((input) =>
    input.kind === "table" ? input.rows.map((row) => row.join(" | ")) : [],
  );

/** Speech on one side for `ms`, the other quiet, the clock moving with it. */
function hear(
  capture: FakeCapture,
  clock: ReturnType<typeof manualClock>,
  ms: number,
  speaking: "microphone" | "system" | null,
) {
  for (let at = 0; at < ms; at += 500) {
    clock.advance(500);
    capture.push("microphone", 500, speaking !== "microphone");
    capture.push("system", 500, speaking !== "system");
  }
}

/**
 * Coast (a timetable Document, the harbour meeting, and a sub-Folder Engineering holding the
 * refit meeting), Private (the sale meeting), Legal behind a wall (the claim meeting), and the
 * party meeting in no Folder. Each meeting's Note is named for it.
 */
async function library() {
  const dataDir = await createTempDataFolder();
  const clock = manualClock();
  const capture = createFakeCapture({ now: () => clock.now().getTime() });
  const engine = inProcessTranscriber({
    lines: ORDER.map((key) => MEETINGS[key][0]),
    theirLines: ORDER.map((key) => MEETINGS[key][1]),
  });
  const runtime = createFakeAnalysisRuntime();
  const core = startCore(dataDir, {
    agents: await agentsAdapter(dataDir),
    audioCapture: capture,
    transcriber: engine.transcriber,
    transcriptionModelSource: NO_TRANSCRIPTION_FILES,
    transcriptionKeyFetch: async () => new Response(null, { status: 200 }),
    now: clock.now,
    analysisRuntime: runtime,
  });
  await core.updateSettings({ device: { meetingNoticeAccepted: true } });
  await core.setOutputLocation(join(dataDir, "Documents", "IncarnaMind"));
  const [timetable] = await addAndProcess(core, [
    await writeSourceFile(
      await createSourceFolder(),
      "Timetable.md",
      "# Timetable\n\nThe first North crossing leaves at half past seven.\n",
    ),
  ]);
  if (!timetable) throw new Error("The timetable wasn't added.");
  const coast = await core.createLibraryGroup({ name: "Coast", description: "" });
  const engineering = await core.createLibraryGroup({
    name: "Engineering",
    description: "",
    parentId: coast.id,
  });
  const hidden = await core.createLibraryGroup({ name: "Private", description: "" });
  const legal = await core.createLibraryGroup({ name: "Legal", description: "", keepInside: true });
  await core.assignDocumentGroup(timetable.id, coast.id);
  const folderOf: Record<Key, string | null> = {
    harbour: coast.id,
    sale: hidden.id,
    party: null,
    refit: engineering.id,
    claim: legal.id,
  };
  const recorded = {} as Record<Key, { mindId: string; transcriptId: string; startedAt: string }>;
  for (const key of ORDER) {
    const meeting = await core.createMeeting({ folderId: folderOf[key] });
    await core.startMeeting({ meetingId: meeting.id, systemAudio: true });
    hear(capture, clock, 2000, "microphone");
    hear(capture, clock, 1000, null);
    hear(capture, clock, 2000, "system");
    hear(capture, clock, 1000, null);
    await until(core, meeting.id, (transcript) => transcript.lines >= 2);
    const stopped = await stoppedMeeting(core, dataDir, meeting.id);
    await core.renameMind(meeting.mindId, `Meeting about the ${key}`);
    recorded[key] = {
      mindId: meeting.mindId,
      transcriptId: stopped.document.id,
      startedAt: stopped.meeting.startedAt ?? "",
    };
  }
  await core.setTranscriptSpeakers({
    documentId: recorded.harbour.transcriptId,
    speakers: { labels: { Them: "Morwenna Pascoe" }, lines: {} },
  });
  await core.setAgentsEnabled(true);
  const connect = async (name: string, folderIds: string[]) =>
    connectLegacyAgent((await core.connectAgent({ name, folderIds })).launch);
  return { core, runtime, recorded, coast, legal, timetable, connect };
}

/** A Passage of a meeting's Transcript, as the User's own search finds it. */
async function passageOf(core: Core, transcriptId: string, words: string) {
  const found = await core.searchPassages(words, { mode: "keyword" });
  const passage = found.find((each) => each.documentId === transcriptId);
  if (!passage) throw new Error(`The User's search found no Passage for “${words}”.`);
  return passage.passageId;
}

const listMinds = async (agent: Agent) =>
  structured<Listed>(await agent.callTool({ name: "list_minds", arguments: {} }));

const search = async (agent: Agent, query: string) =>
  structured<Found>(await agent.callTool({ name: "search", arguments: { query } })).passages;

const countLists = (agent: Agent) =>
  agent.callTool({
    name: "run_analysis",
    arguments: {
      title: "Count",
      inputs: [
        { name: "documents", library: "documents" },
        { name: "notes", library: "notes" },
      ],
      code: 'result("documents", len(inputs["documents"]))',
    },
  });

describe("an outside agent and the User's meetings", { timeout: 120_000 }, () => {
  beforeAll(async () => {
    await buildAgentShim();
  }, 60_000);

  // protects=an agent finds a shared meeting on its Note, with its date, and quotes and cites its Transcript, who said it included; fails_when=a meeting's Note looks like any Note, its Transcript is a second item of its own, or its Passages can't be searched, read or cited
  it("finds a shared meeting on its Note, with when it started, and searches, reads and cites its Transcript", async () => {
    const { runtime, recorded, coast, timetable, connect } = await library();
    const agent = await connect("Claude Code", [coast.id]);
    const { harbour } = recorded;

    const [listed] = (await listMinds(agent)).folders;
    expect(listed?.id).toBe(coast.id);
    // One item: the Transcript is no Document of its own, in the list or its count.
    expect(listed?.documentList.map((each) => each.id)).toEqual([timetable.id]);
    expect(listed?.documents).toBe(1);
    expect(listed?.minds).toEqual([
      expect.objectContaining({
        id: harbour.mindId,
        meeting: {
          started: formatFullDateTime(harbour.startedAt, "en"),
          transcript: harbour.transcriptId,
        },
      }),
    ]);

    const [said] = (await search(agent, "first North crossing ten past seven")).filter(
      (each) => each.documentId === harbour.transcriptId,
    );
    expect(said?.location).toMatch(/^Me · 0:0\d$/);
    expect(said?.cite).toMatch(/^\[cite:/);

    const cited = structured<{
      citations: { check: string; cite: string | null; location: string | null }[];
    }>(
      await agent.callTool({
        name: "cite",
        arguments: {
          citations: [
            {
              passageId: said?.passageId,
              quote: "The harbour can open the slipway earlier.",
            },
          ],
        },
      }),
    ).citations;
    expect(cited).toEqual([
      expect.objectContaining({
        check: "found",
        location: expect.stringMatching(/^Morwenna Pascoe · 0:0\d$/),
      }),
    ]);
    const checked = structured<{ citations: { check: string }[] }>(
      await agent.callTool({
        name: "check_citations",
        arguments: { text: `The slipway can open earlier ${cited[0]?.cite}.` },
      }),
    ).citations;
    expect(checked.map((each) => each.check)).toEqual(["found"]);

    const read = structured<{ passages: { text: string; location: string | null }[] }>(
      await agent.callTool({
        name: "read_passages",
        arguments: { documentId: harbour.transcriptId },
      }),
    );
    expect(read.passages.map((each) => each.text).join("\n")).toContain(MEETINGS.harbour[0]);
    // Placed as a Citation of its first line: who said it, then when.
    const [first] = structured<{ citations: { location: string | null }[] }>(
      await agent.callTool({
        name: "cite",
        arguments: { citations: [{ passageId: said?.passageId, quote: MEETINGS.harbour[0] }] },
      }),
    ).citations;
    expect(first?.location).toMatch(/^Me · 0:00$/);
    expect(read.passages.map((each) => each.location)).toEqual([first?.location]);

    // The Library's lists count the meeting once, as its Note.
    structured(await countLists(agent));
    const [documents, notes] = listsGiven(runtime.jobs[0]);
    expect(documents).toEqual([expect.stringMatching(/^Timetable \| markdown \| Coast/)]);
    expect(notes).toEqual([expect.stringMatching(/^Meeting about the harbour \| Coast/)]);
  });

  // protects=only a Transcript's Passage is placed as a Citation of it is; any other Document's keeps the place it had before (#3384); fails_when=read_passages narrows a web page's or a text file's Location to what its whole text covers
  it("places any other Document's Passage where it was placed before", async () => {
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir, { agents: await agentsAdapter(dataDir) });
    const page = await core.saveWebPage({
      address: "https://reader.example/tea",
      html: readFileSync(new URL("../fixtures/web/article.html", import.meta.url), "utf8"),
    });
    if (page.outcome !== "saved") throw new Error("The web page wasn't saved.");
    await waitForProcessing(core, [page.document.id]);
    const [log] = await addAndProcess(core, [
      await writeSourceFile(
        await createSourceFolder(),
        "Log.txt",
        Array.from(
          { length: 400 },
          (_, at) => `Line ${at + 1}: the ferry crossed in calm water.`,
        ).join("\n"),
      ),
    ]);
    if (!log) throw new Error("The log wasn't added.");
    const coast = await core.createLibraryGroup({ name: "Coast", description: "" });
    for (const id of [page.document.id, log.id]) await core.assignDocumentGroup(id, coast.id);
    await core.setAgentsEnabled(true);
    const agent = await connectLegacyAgent(
      (await core.connectAgent({ name: "Claude Code", folderIds: [coast.id] })).launch,
    );
    const placed = async (documentId: string) =>
      structured<{ passages: { location: string | null }[] }>(
        await agent.callTool({ name: "read_passages", arguments: { documentId, after: 1 } }),
      ).passages.map((each) => each.location);
    // As before: a web page's section, and the lines of each Passage's Units.
    expect(await placed(page.document.id)).toEqual(["§ Start"]);
    expect(await placed(log.id)).toEqual(["lines 1–50", "lines 1–100"]);
  });

  // protects=a meeting goes where its Note goes: one whose Note the agent can't read, in a Folder not shared, in a sub-Folder, in no Folder or behind a wall, is never listed, searched, cited or counted, and the refusal says nothing of it; fails_when=Not in a Folder or a shared Folder's tree hands the agent a Transcript whose Note it may not read, or a refusal tells such a meeting apart from an id that never was
  it("never lists, searches, cites or counts a meeting whose Note it may not read", async () => {
    const { core, runtime, recorded, coast, connect } = await library();
    const agent = await connect("Claude Code", [coast.id, NOT_IN_A_FOLDER_ID]);
    const outOfReach: Key[] = ["sale", "party", "refit", "claim"];
    const forbidden = new RegExp(
      outOfReach
        .flatMap((key) => [
          recorded[key].mindId,
          recorded[key].transcriptId,
          `the ${key}`,
          ...MEETINGS[key].map((line) => line.split(" ").slice(-3).join(" ").replace(/\.$/, "")),
        ])
        .join("|"),
    );
    const nowhere = resultText(
      await agent.callTool({ name: "read_passages", arguments: { documentId: "no-such-id" } }),
    );
    const said: string[] = [JSON.stringify(await listMinds(agent))];
    for (const key of outOfReach) {
      const words = MEETINGS[key].join(" ");
      const found = await search(agent, words);
      expect(found.map((each) => each.documentId)).not.toContain(recorded[key].transcriptId);
      said.push(JSON.stringify(found));
      const refusals = [
        await agent.callTool({
          name: "read_passages",
          arguments: { documentId: recorded[key].transcriptId },
        }),
        await agent.callTool({ name: "read_mind", arguments: { mindId: recorded[key].mindId } }),
        await agent.callTool({
          name: "cite",
          arguments: {
            citations: [
              {
                passageId: await passageOf(core, recorded[key].transcriptId, MEETINGS[key][0]),
                quote: MEETINGS[key][0],
              },
            ],
          },
        }),
      ];
      for (const refusal of refusals) {
        expect(refusal.isError).toBe(true);
        expect(resultText(refusal)).toBe(nowhere);
      }
    }
    said.push(resultText(await countLists(agent)));
    for (const text of said) expect(text).not.toMatch(forbidden);
    const [documents, notes] = listsGiven(runtime.jobs[0]);
    expect([documents?.length, notes?.length]).toEqual([1, 1]);
    expect([...(documents ?? []), ...(notes ?? [])].join("\n")).not.toMatch(forbidden);
    const listed = await listMinds(agent);
    expect(listed.folders.map((folder) => [folder.id, folder.documents])).toEqual([
      [coast.id, 1],
      [NOT_IN_A_FOLDER_ID, 0],
    ]);
  });

  // protects=a meeting behind a wall is read by an agent given that Folder alone, and its Note brings it into and out of an agent's reach as it moves; fails_when=the wall keeps its own agent from the meeting, or a Transcript stays where its Note was
  it("follows its Note: behind a wall, and into and out of a shared Folder", async () => {
    const { core, recorded, coast, legal, connect } = await library();
    const walled = await connect("Codex", [legal.id]);
    expect((await listMinds(walled)).folders[0]?.minds).toEqual([
      expect.objectContaining({
        id: recorded.claim.mindId,
        meeting: expect.objectContaining({ transcript: recorded.claim.transcriptId }),
      }),
    ]);
    expect((await search(walled, "Gwavas Marine settles")).map((each) => each.documentId)).toEqual([
      recorded.claim.transcriptId,
    ]);

    const agent = await connect("Claude Code", [coast.id]);
    const partyFound = async () =>
      (await search(agent, "Ship Inn staff party")).map((each) => each.documentId);
    expect(await partyFound()).toEqual([]);
    await core.moveToFolder({ mindIds: [recorded.party.mindId], folderId: coast.id });
    expect(await partyFound()).toEqual([recorded.party.transcriptId]);
    expect(
      (await listMinds(agent)).folders[0]?.minds.map((each) => each.meeting?.transcript),
    ).toContain(recorded.party.transcriptId);
    await core.moveToFolder({ mindIds: [recorded.party.mindId], folderId: null });
    expect(await partyFound()).toEqual([]);
  });
});
