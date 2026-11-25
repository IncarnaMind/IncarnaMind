/**
 * Write notes after Stop with no model set up, on the User's own AI (#3762), then the Note's own
 * Check of what it wrote, as the window runs the two in one press: the notes land in the empty
 * Note, the Check plans their sentences, runs on the same AI in the background, and a sentence
 * naming an owner nobody said is marked as its check judged it. The runner stands in for the
 * command line, calling the Tools through the shim as `claude` would; what it judges is scripted.
 */
import { beforeAll, describe, expect, test, vi } from "vitest";
import type { CoreAdapters, OwnAiRunner } from "../../src/core/adapters";
import type { NoteTurnEvent, OwnAiCheckEnd } from "../../src/core/api";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { claimCheckShown } from "../../src/shared/claimChecks";
import { translate } from "../../src/shared/i18n";
import { buildAgentShim, connectLegacyAgent } from "../helpers/agents";
import { startLiveAgentMeeting } from "../helpers/liveAgentMeeting";
import { connectToMind } from "../helpers/mindClient";
import { readMind } from "../helpers/minds";
import { until } from "../helpers/transcription";

type Summarize = NonNullable<CoreAdapters["summarizeWithMeetingAgent"]>;
type RunRequest = Parameters<OwnAiRunner["run"]>[0];
type Agent = Awaited<ReturnType<typeof connectLegacyAgent>>;

const SAID = ["我周五前把投票链接发到群里。", "下次读书会在三楼活动室。"];
/** What the AI wrote: the first line names an owner nobody named, the second says what was said. */
const OWNER = "小周周五前把投票链接发到群里。";
const ROOM = "下次读书会在三楼活动室。";

const structured = <T>(result: unknown): T => {
  const { isError, structuredContent, content } = result as {
    isError?: boolean;
    structuredContent?: unknown;
    content?: { text?: string }[];
  };
  expect(isError ?? false, content?.[0]?.text).toBe(false);
  return structuredContent as T;
};

/** Write notes: the Note named, then its notes written into it, empty as it is, with ¶0+. */
async function writesNotes(agent: Agent, mindId: string) {
  const { version } = structured<{ version: string }>(
    await agent.callTool({ name: "read_mind", arguments: { mindId, named: true } }),
  );
  structured(
    await agent.callTool({
      name: "propose_changes",
      arguments: {
        mindId,
        version,
        changes: [{ paragraph: "¶0+", text: `## 待办\n\n${OWNER}\n\n${ROOM}` }],
      },
    }),
  );
}

/** The Check: the sentences it is given, judged as scripted, handed back. */
async function checks(agent: Agent, mindId: string) {
  const given = structured<{ task: string; sentences: { n: number; text: string }[] }>(
    await agent.callTool({ name: "check_mind_yourself", arguments: { mindId } }),
  );
  const n = (text: string) => given.sentences.find((each) => each.text === text)?.n;
  structured(
    await agent.callTool({
      name: "report_check",
      arguments: {
        mindId,
        task: given.task,
        results: [
          { n: n(OWNER), verdict: "not found" },
          { n: n(ROOM), verdict: "nothing to check" },
        ],
      },
    }),
  );
  return given.sentences.map((each) => each.text);
}

describe("Write notes, then its Check, on the User's own AI (#3762)", { timeout: 90_000 }, () => {
  beforeAll(async () => {
    await buildAgentShim();
  }, 60_000);

  // protects=after Stop with no model set up, what Write notes writes into the empty Note is there for the Check the same press runs next: planned as ready, run on the User's own AI in the background, given the sentences written, and a sentence naming an owner nobody said marked Not found, in the Note, while the other is left unmarked; fails_when=the Check plans nothing, isn't given the written sentences, or its result marks nothing; no_claim=how a real model judges it, which a real-model run shows.
  test("the notes written land, and the Check of them marks the owner nobody said", async () => {
    let given: string[] = [];
    const prompts: string[] = [];
    const ownAi: OwnAiRunner = {
      installed: async () => true,
      status: async () => ({ kind: "ready" }),
      purge: async () => true,
      async run(request: RunRequest) {
        prompts.push(request.prompt);
        request.started?.();
        const agent = await connectLegacyAgent(request.server);
        const mindId = request.prompt.match(/mindId: ([^)]+)\)/)?.[1] ?? "";
        if (request.tools?.includes("report_check")) given = await checks(agent, mindId);
        else await writesNotes(agent, mindId);
        return { kind: "finished", reply: "" };
      },
    };
    const started = await startLiveAgentMeeting(vi.fn<Summarize>(), false, SAID, "claude-code", {
      ownAi,
    });
    const { core, meeting, pairing } = started;
    try {
      await core.updateAgent(pairing.id, { propose: true });
      await core.updateSettings({ user: { language: "zh-CN" } });
      started.push(5000);
      await until(core, meeting.id, (state) => state.lines >= 2);
      await core.stopMeeting(meeting.id);
      await vi.waitFor(async () => {
        const now = (await core.listMeetings()).find((each) => each.id === meeting.id);
        expect(now?.fill?.state).toBe("own-ai");
      });

      // The press: the request the button sends, its changes applied as the window applies them.
      const turns: NoteTurnEvent[] = [];
      core.on("agents.noteTurn", (turn) => turns.push(turn));
      await core.askInNote({
        mindId: meeting.mindId,
        words: translate("zh-CN", "meetings.foot.writeNotesRequest"),
      });
      const end = await vi.waitFor(() => {
        const ended = turns.find((turn) => turn.state !== "working");
        if (!ended) throw new Error("Still writing.");
        return ended;
      });
      expect(end.state).toBe("landed");
      // Until the window applies them the notes wait, and a Check would find nothing to check:
      // the window's press waits for its apply (turnApplied) before it checks.
      expect(await core.planMindCheck(meeting.mindId, "changed", false)).toEqual({
        kind: "nothing",
      });
      await core.applyAskedChanges({
        answerId: end.turnId,
        mindId: meeting.mindId,
        requests: end.applied.map((change) => change.request),
      });
      const client = await connectToMind(core, meeting.mindId);
      await client.settled();

      // Then the Check, as the window starts it with no model set up: planned, then on its own AI.
      expect(await core.planMindCheck(meeting.mindId, "changed", false)).toMatchObject({
        kind: "ready",
        sentences: 2,
      });
      const ends: OwnAiCheckEnd[] = [];
      core.on("agents.ownCheck", (each) => ends.push(each));
      expect(await core.checkWithOwnAi(meeting.mindId)).toMatchObject({ kind: "started" });
      await vi.waitFor(() => expect(ends).toHaveLength(1));
      expect(ends[0]).toMatchObject({ outcome: "landed", problem: null });
      expect(given).toEqual(expect.arrayContaining([OWNER, ROOM]));

      await client.settled();
      const versions = new Map(
        (await core.listDocuments()).map((each) => [each.id, each.contentHash]),
      );
      const marks = claimSpans(readMind(client)).map((span) => [
        span.sentence.text,
        claimCheckShown(span.check, {
          footing: "not-yet-known",
          text: span.sentence.text,
          versions,
          folderId: pairing.folderIds[0] ?? null,
          scope: null,
        }).state,
      ]);
      // "not found" shows as Not supported; a sentence with nothing to check carries no mark.
      expect(marks).toEqual([[OWNER, "unsupported"]]);
      expect(prompts).toHaveLength(2);
    } finally {
      core.close();
    }
  });
});
