import { describe, expect, test, vi } from "vitest";
import type { MeetingFill, SystemNotifications } from "../../src/core";
import { CITATION_NODE } from "../../src/core/api";
import type { Language } from "../../src/core/language";
import { createFakeCapture } from "../../src/core/meetings/fakeCapture";
import { translate } from "../../src/shared/i18n";
import { shownPassages } from "../helpers/citations";
import { createTempDataFolder, manualClock, startCore } from "../helpers/core";
import { connectToMind } from "../helpers/mindClient";
import { exactly, heading, note, readMind, writeMind } from "../helpers/minds";
import { scriptedModel, scriptedModels } from "../helpers/models";
import { inProcessTranscriber, NO_TRANSCRIPTION_FILES, until } from "../helpers/transcription";

type Result = "complete" | "omitted" | "unknown-frame" | "unplaced-heading";

async function recordedFill(language: Language, result: Result) {
  const words =
    language === "en"
      ? {
          name: "Project review",
          heading: "Review",
          line: "review date and assignments",
          purpose: "We are settling the review date and sharing the work",
          decision: "The review is on Tuesday",
          action: "Dana will send the draft on Monday",
        }
      : {
          name: "项目评审",
          heading: "评审",
          line: "评审日期与分工",
          purpose: "今天定评审日期，再分一下工",
          decision: "评审定在周二",
          action: "王芳周一发草稿",
        };
  const fact = (id: string, text: string, marker: number, section: string, invalid = false) =>
    [
      `### FACT ${id}`,
      "```json",
      JSON.stringify({
        topic: invalid ? 17 : section,
        citations: [marker],
        lines: ["L1"],
        sections: [section],
        claim: false,
      }),
      "```",
      `${text} [^${marker}].`,
      `### END ${id}`,
    ].join("\n");
  const reply = [
    // The note has no H2: the sections go under their own titles instead.
    result === "unplaced-heading" ? "HEADINGS: H2=ACTIONS" : "HEADINGS: H1=NONE",
    ...(result === "unknown-frame" ? ["### FACT 1invalid\nUnknown frame identity."] : []),
    fact("F1", words.decision, 1, "decisions"),
    fact("F2", words.action, 2, "actions", result === "omitted"),
    "### OVERVIEW",
    "```json",
    JSON.stringify({ citations: [3] }),
    "```",
    `${words.purpose} [^3].`,
    "### END OVERVIEW",
  ].join("\n\n");
  const quotes = [words.decision, words.action, words.purpose];
  const model = scriptedModel((call) => {
    const shown = shownPassages(call.prompt);
    if (shown.length === 0) return { text: "OK" };
    if (call.results.some((each) => each.tool === "cite")) return { text: reply };
    const citations = quotes.map((quote, index) => {
      const passage = shown.find((each) => each.text.includes(quote));
      const cue = passage?.text.split("\n").find((line) => line.includes(quote));
      const location = /^\[([^\]]+)\]/.exec(cue ?? "")?.[1];
      if (!passage || !location) throw new Error("The Transcript quote has no timed cue");
      return { marker: index + 1, passage: passage.id, quote, location };
    });
    return { calls: [{ tool: "cite", input: { citations } }] };
  });
  const clock = manualClock();
  const capture = createFakeCapture({ now: () => clock.now().getTime() });
  const { transcriber } = inProcessTranscriber({
    lines: [words.purpose, words.decision, words.action],
  });
  const show = vi.fn<SystemNotifications["show"]>();
  const core = startCore(await createTempDataFolder(), {
    audioCapture: capture,
    transcriber,
    transcriptionModelSource: NO_TRANSCRIPTION_FILES,
    createChatModel: scriptedModels(model).createChatModel,
    now: clock.now,
    notifications: { show },
  });
  await core.saveLibrarySettings({ ...(await core.getLibrary()).settings, automatic: false });
  await core.updateSettings({
    user: { language },
    device: { meetingNoticeAccepted: true },
  });
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  const mind = await core.createMind({ title: words.name });
  const meeting = await core.createMeeting({ mindId: mind.id });
  const client = await connectToMind(core, mind.id);
  writeMind(client, [heading(1, words.heading), note(words.line)]);
  await client.settled();
  const before = exactly(client);
  await core.startMeeting({ meetingId: meeting.id, systemAudio: false });
  for (let at = 0; at < 8_000; at += 500) {
    clock.advance(500);
    capture.push("microphone", 500);
  }
  await until(core, meeting.id, (transcript) => transcript.lines >= 3);
  await core.stopMeeting(meeting.id);
  const fill = await vi.waitFor(
    async (): Promise<MeetingFill> => {
      const current = (await core.listMeetings()).find((each) => each.id === meeting.id)?.fill;
      if (!current || current.state === "waiting" || current.state === "filling") {
        throw new Error(
          `The meeting fill has not settled: ${JSON.stringify({
            fill: current ?? null,
            modelCalls: model.doStreamCalls,
          })}`,
        );
      }
      return current;
    },
    { timeout: 20_000 },
  );
  return { core, meeting, client, before, fill, show, words, model };
}

describe.each(["en", "zh-CN"] as const)("meeting-fill notifications in %s", (language) => {
  // protects=the notification says a note is partly filled in only when something the reply held isn't in it: an item left out, a malformed part among them; a heading the note can't take, with every fact written, is a whole note (#3099); fails_when=a whole note is called partly filled in, or a dropped part goes uncounted; no_claim=the line beside the note, which tests/renderer/meetingFillLine.test.ts covers.
  test.each(["complete", "omitted", "unknown-frame", "unplaced-heading"] as const)(
    "%s chooses the actual Core notification title and keeps exact one-step Undo",
    async (result) => {
      const { core, meeting, client, before, fill, show, words, model } = await recordedFill(
        language,
        result,
      );
      try {
        const partial = result === "omitted" || result === "unknown-frame";
        expect(fill).toMatchObject({
          state: "filled",
          omitted: partial ? 1 : 0,
          unfinishedParts: 0,
        });
        expect(fill.problem).toEqual(
          result === "unknown-frame" ? { kind: "model", message: expect.any(String) } : null,
        );
        const title = translate(
          language,
          partial ? "meetings.fill.notify.partial" : "meetings.fill.notify",
          {
            meeting: words.name,
          },
        );
        await vi.waitFor(() => {
          expect(show.mock.calls.map(([notification]) => notification)).toEqual([
            { title, body: "" },
          ]);
        });
        expect(show.mock.calls[0]?.[0].title).toContain(words.name);
        if (partial) {
          expect(show.mock.calls[0]?.[0].title).not.toBe(
            translate(language, "meetings.fill.notify", { meeting: words.name }),
          );
        }
        const written = readMind(client);
        expect(written.textContent).toContain(words.purpose);
        expect(written.textContent).toContain(words.decision);
        if (result === "omitted") expect(written.textContent).not.toContain(words.action);
        else expect(written.textContent.split(words.action)).toHaveLength(2);
        expect(written.textContent.split(words.decision)).toHaveLength(2);
        expect(written.textContent).not.toContain("Unknown frame identity.");
        let citations = 0;
        written.descendants((node) => {
          if (node.type.name !== CITATION_NODE) return;
          citations++;
          expect(node.attrs.check).toBe("found");
        });
        expect(citations).toBeGreaterThanOrEqual(2);
        expect(model.doStreamCalls).toHaveLength(2);
        await core.undoMeetingFill(meeting.id);
        await vi.waitFor(() => expect(exactly(client)).toEqual(before));
      } finally {
        core.close();
      }
    },
  );
});
