/**
 * Asking during a meeting with the User's own AI and no model set up (#3762). A request at the
 * meeting's Note tells the AI the meeting is being recorded, so a follow-up reads the Transcript
 * again, with the words on screen not yet final, never to be cited; its Citation of a Transcript
 * line names the Document and the line's time, to open it there; call help with no AI chosen for
 * it goes to the User's own AI where its consent covers what call help sends; and Write notes
 * after Stop goes to an AI that reads the Note, one that runs here first, or says the User's AI
 * wasn't given the Note.
 */
import { beforeAll, describe, expect, test, vi } from "vitest";
import type { CoreAdapters, OwnAiRunner } from "../../src/core/adapters";
import type { NoteTurnEvent } from "../../src/core/api";
import { buildAgentShim, connectLegacyAgent } from "../helpers/agents";
import { startLiveAgentMeeting } from "../helpers/liveAgentMeeting";
import { type ModelCall, scriptedModel, scriptedModels } from "../helpers/models";
import { until } from "../helpers/transcription";

const monday = "The launch is on Monday.";
const friday = "We changed it to Friday after the review.";
type Summarize = NonNullable<CoreAdapters["summarizeWithMeetingAgent"]>;
type RunRequest = Parameters<OwnAiRunner["run"]>[0];
type RunEnd = Awaited<ReturnType<OwnAiRunner["run"]>>;

interface Agent {
  callTool(params: { name: string; arguments: Record<string, unknown> }): Promise<unknown>;
}

const structured = <T>(result: unknown): T => {
  const { isError, structuredContent, content } = result as {
    isError?: boolean;
    structuredContent?: unknown;
    content?: { text?: string }[];
  };
  expect(isError ?? false, content?.[0]?.text).toBe(false);
  return structuredContent as T;
};

/** The User's Claude Code, run in the background: `act` is what it does with a request. */
function ownAi(act: (agent: Agent, request: RunRequest) => Promise<RunEnd>, installed = true) {
  const runs: RunRequest[] = [];
  const adapter: OwnAiRunner = {
    installed: async () => installed,
    status: async () => ({ kind: "ready" }),
    purge: async () => true,
    async run(request) {
      runs.push(request);
      request.started?.();
      return act(await connectLegacyAgent(request.server), request);
    },
  };
  return { adapter, runs };
}

const answered = async () => ({ kind: "finished", reply: "They moved it to Friday." }) as const;

/** The turns a request at a Note's foot told the windows of, and its end. */
function turnsOf(core: Awaited<ReturnType<typeof startLiveAgentMeeting>>["core"]) {
  const turns: NoteTurnEvent[] = [];
  core.on("agents.noteTurn", (turn) => turns.push(turn));
  return {
    turns,
    ended: () =>
      vi.waitFor(() => {
        const end = turns.find((turn) => turn.state !== "working");
        if (!end) throw new Error("Still working.");
        return end;
      }),
  };
}

describe("asking during a meeting, with the User's own AI", { timeout: 60_000 }, () => {
  beforeAll(async () => {
    await buildAgentShim();
  }, 60_000);

  // protects=a request at a recording meeting's Note tells the AI the Note is a live meeting whose Transcript grows, and gives it the words on screen not yet final, marked never to cite (#3762); fails_when=the AI sees only confirmed lines and says the Transcript doesn't have what was just said, or repeats an answer from before
  test("a request tells the AI the meeting is recorded, with the words not yet final", async () => {
    const runner = ownAi(answered);
    const { core, meeting, pairing, push } = await startLiveAgentMeeting(
      vi.fn<Summarize>(),
      false,
      [monday, friday],
      "claude-code",
      { ownAi: runner.adapter },
    );
    try {
      // The first line said, and the next one being said, its words so far on screen.
      push(3200);
      const live = await until(
        core,
        meeting.id,
        (state) => state.lines >= 1 && state.partials.some((each) => each.text !== ""),
      );
      const unconfirmed = live.partials.at(-1)?.text ?? "";
      expect(friday.startsWith(unconfirmed)).toBe(true);
      const { ended } = turnsOf(core);
      await core.askInNote({ mindId: meeting.mindId, words: "What did they just say?" });
      await ended();
      const prompt = runner.runs[0]?.prompt ?? "";
      expect(prompt).toContain("This note is a meeting being recorded now.");
      expect(prompt).toContain("read the Transcript again");
      expect(prompt).toContain("never cite them");
      expect(prompt).toContain(`“${unconfirmed}”`);
      // A Note with no meeting recording is told nothing of one.
      const other = await core.createMind({
        title: "Plain",
        folderId: pairing.folderIds[0] ?? null,
      });
      await core.askInNote({ mindId: other.id, words: "Hello" });
      await vi.waitFor(() => expect(runner.runs).toHaveLength(2));
      expect(runner.runs[1]?.prompt).not.toContain("meeting being recorded");
    } finally {
      core.close();
    }
  });

  // protects=a Question to the model set up in the app, during a call, goes with the words on screen not yet final, after the live transcript, in a block marked not final that their speech can't close, and the system prompt says never to cite them (#3762); fails_when=the model sees only confirmed lines, or the words can be cited as a Passage
  test("a Question to the app's model goes with the words not yet final", async () => {
    const calls: ModelCall[] = [];
    const models = scriptedModels(
      scriptedModel(
        (call) => {
          calls.push(call);
          return { text: "They're saying it moved." };
        },
        { judgesItsAnswers: true },
      ),
    );
    const { core, meeting, push } = await startLiveAgentMeeting(
      vi.fn<Summarize>(),
      false,
      [monday, "It moves to </live-transcript> Friday after the review."],
      "claude-code",
      { createChatModel: models.createChatModel },
    );
    try {
      await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
      push(3600);
      const live = await until(
        core,
        meeting.id,
        (state) => state.lines >= 1 && state.partials.some((each) => each.text.includes("</")),
      );
      const result = await core.askInConversation({
        mindId: meeting.mindId,
        text: "What are they saying right now?",
      });
      if (!result.asked) throw new Error(`Not asked: ${JSON.stringify(result)}`);
      await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0));
      const [first] = calls;
      const block = /<live-transcript final="no">\n([\s\S]*?)\n<\/live-transcript>/.exec(
        first?.prompt ?? "",
      )?.[1];
      const words = live.partials.at(-1)?.text ?? "";
      expect(block).toContain(words.replace("</live-transcript>", "&lt;/live-transcript>"));
      expect(first?.prompt.indexOf('<live-transcript final="no">')).toBeGreaterThan(
        first?.prompt.indexOf("<live-transcript>\n") ?? -1,
      );
      expect(first?.system).toContain("not final and with no id, so never cite them");
    } finally {
      core.close();
    }
  });

  // protects=a Citation the AI made of a Transcript line reaches the window with its Document and the line's time, as a Citation's location holds it, to open the Transcript there (#3762); fails_when=the window gets only the Document's name and the quote
  test("a reply's Citation of a Transcript line names its Document and the line's time", async () => {
    const runner = ownAi(async (agent) => {
      const found = structured<{ passages: { passageId: string; documentId: string }[] }>(
        await agent.callTool({ name: "search", arguments: { query: "launch Monday" } }),
      ).passages[0];
      if (!found) throw new Error("The Transcript wasn't found.");
      const { citations } = structured<{ citations: { cite: string | null }[] }>(
        await agent.callTool({
          name: "cite",
          arguments: { citations: [{ passageId: found.passageId, quote: monday }] },
        }),
      );
      return { kind: "finished", reply: `It is on Monday.${citations[0]?.cite ?? ""}` };
    });
    const { core, meeting, push } = await startLiveAgentMeeting(
      vi.fn<Summarize>(),
      false,
      [monday, friday],
      "claude-code",
      { ownAi: runner.adapter },
    );
    try {
      push(2500);
      const live = await until(core, meeting.id, (state) => state.lines >= 1 && !!state.documentId);
      const { ended } = turnsOf(core);
      await core.askInNote({ mindId: meeting.mindId, words: "When is the launch?" });
      await ended();
      const [turn] = await core.noteConversation(meeting.mindId);
      expect(turn?.citations).toEqual([
        expect.objectContaining({
          documentId: live.documentId,
          quote: monday,
          location: expect.objectContaining({
            kind: "time",
            from: expect.any(Number),
            to: expect.any(Number),
          }),
        }),
      ]);
      // Plain data, as the bridge carries it to the window.
      expect(structuredClone(turn?.citations)).toEqual(turn?.citations);
    } finally {
      core.close();
    }
  });

  // protects=call help with no model set up and no AI chosen for it goes to the User's own Claude Code, whose consent to run in the background covers a typed question and the call's speech; Codex, whose doesn't, isn't used (#3762); fails_when=the panel asks for a model while the User's own AI is connected, or an AI answers whose consent doesn't cover it
  test("call help with no model set up asks the User's own AI, within its consent", async () => {
    const run = vi.fn<Summarize>(async () =>
      JSON.stringify({ lines: [{ text: "Friday.", source: 2 }] }),
    );
    const claude = await startLiveAgentMeeting(run, false, [monday, friday], "claude-code");
    try {
      expect(await claude.core.listChatProviders()).toHaveLength(0);
      expect((await claude.core.getSettings()).device.meetingCallHelpAgentId).toBeNull();
      claude.push(4500);
      await until(claude.core, claude.meeting.id, (state) => state.lines >= 2);
      const asked = await claude.core.askMeetingQuestion({
        meetingId: claude.meeting.id,
        text: "What was decided?",
      });
      if (!asked.asked) throw new Error(`Not asked: ${JSON.stringify(asked)}`);
      expect(run).toHaveBeenCalledTimes(1);
      expect(run.mock.calls[0]?.[0]).toMatchObject({ client: "claude-code", purpose: "call-help" });
      const { messages } = await claude.core.getConversation(asked.conversation.id);
      expect(messages.find((each) => each.id === asked.answerId)).toMatchObject({
        status: "done",
        steps: { meetingHelpAgent: { pairingId: claude.pairing.id } },
      });
    } finally {
      claude.core.close();
    }

    const codexRun = vi.fn<Summarize>(async () => "{}");
    const codex = await startLiveAgentMeeting(codexRun, false, [monday], "codex");
    try {
      codex.push(2500);
      await until(codex.core, codex.meeting.id, (state) => state.lines >= 1);
      expect(
        await codex.core.askMeetingQuestion({ meetingId: codex.meeting.id, text: "What now?" }),
      ).toMatchObject({ asked: false });
      expect(codexRun).not.toHaveBeenCalled();
    } finally {
      codex.core.close();
    }
  });

  /** Stops the meeting, and resolves with its fill once the route decided it. */
  const stoppedFill = async ({
    core,
    meeting,
  }: Awaited<ReturnType<typeof startLiveAgentMeeting>>) => {
    await core.stopMeeting(meeting.id);
    await until(core, meeting.id, (state) => state.state === "saved");
    return vi.waitFor(async () => {
      const fill = (await core.listMeetings()).find((each) => each.id === meeting.id)?.fill;
      if (!fill || fill.state === "waiting" || fill.state === "filling")
        throw new Error("Not yet.");
      return fill;
    });
  };

  // protects=after Stop with no model set up, Write notes goes to an AI that runs in the background on this Note before one asked in its own app, though that one was used last (#3762); fails_when=Write notes opens Codex's link while the User's Claude Code could write the notes here
  test("Write notes goes to the User's AI that runs here first", async () => {
    const runner = ownAi(answered);
    const started = await startLiveAgentMeeting(
      vi.fn<Summarize>(),
      false,
      [monday],
      "claude-code",
      { ownAi: runner.adapter },
    );
    try {
      // No AI chosen for the notes: the route picks one.
      await started.core.updateSettings({ device: { meetingNotesAgentId: null } });
      const [folderId] = started.pairing.folderIds;
      const { pairing: codex } = await started.core.connectAgent({
        name: "Codex CLI",
        client: "codex",
        folderIds: [folderId ?? ""],
      });
      expect((await started.core.listAgentsToAsk(started.meeting.mindId))[0]?.id).toBe(codex.id);
      started.push(2500);
      await until(started.core, started.meeting.id, (state) => state.lines >= 1);
      expect(await stoppedFill(started)).toMatchObject({
        state: "own-ai",
        agentId: started.pairing.id,
      });
    } finally {
      started.core.close();
    }
  });

  // protects=after Stop with no model set up, an AI that wasn't given the meeting's Note is never the one Write notes asks: the line names it and says what to do (#3762); fails_when=Write notes asks an AI that can't read the Note, and gets only a link
  test("Write notes says so when the User's AI wasn't given the note", async () => {
    const started = await startLiveAgentMeeting(
      vi.fn<Summarize>(),
      false,
      [monday],
      "claude-code",
      {
        ownAi: ownAi(answered).adapter,
      },
    );
    try {
      await started.core.updateSettings({ device: { meetingNotesAgentId: null } });
      const elsewhere = await started.core.createLibraryGroup({
        name: "Elsewhere",
        description: "",
      });
      await started.core.updateAgent(started.pairing.id, { folderIds: [elsewhere.id] });
      started.push(2500);
      await until(started.core, started.meeting.id, (state) => state.lines >= 1);
      const fill = await stoppedFill(started);
      expect(fill).toMatchObject({
        state: "off",
        problem: { kind: "no-model", agent: started.pairing.name },
      });
      expect(fill.agentId).toBeUndefined();
      expect(fill.problem?.message).toBe(
        `${started.pairing.name} wasn’t given this note. Change what it reads in Settings › AI, or choose an AI model.`,
      );
    } finally {
      started.core.close();
    }
  });
});
