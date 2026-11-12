/**
 * An earlier call's Transcript, sent with call help and with a Question typed during a call
 * (#3005), through the core's public interface: two calls with one buyer, in Notes of one Folder,
 * both named for the day. The model is sent this call's Passages marked as this call's and the
 * earlier call's as an earlier call, with its Note's name, each with when its call started, and is
 * told what the marks mean. With the evaluation's switch on, the request is as it was before.
 */
import { describe, expect, test } from "vitest";
import type { Core } from "../../src/core";
import type { Language } from "../../src/core/language";
import { formatFullDateTime } from "../../src/shared/dates";
import { mindName } from "../../src/shared/naming";
import { answerEnded } from "../helpers/citations";
import { createTempDataFolder } from "../helpers/core";
import { type ModelCall, scriptedModel } from "../helpers/models";
import { stoppedMeeting, transcribingCore, transcriptRead, until } from "../helpers/transcription";

const SECOND = 1000;
const HOUR = 3_600_000;

/** Every line is said once, in one call or the other, and names the data: what the search finds. */
const LINES: Record<Language, { mine: string[]; theirs: string[]; query: string }> = {
  en: {
    mine: [
      "Let's go over where the data is hosted for the pilot.",
      "Our data has to stay in Europe.",
      "Frankfurt is the data region we use today.",
      "Backups of the data run every night at two.",
      "The pilot data import starts in January.",
      "We send the data terms next week.",
      "Let's go over the data hosting again.",
      "Our data has to stay in the country now.",
      "The regulator changed the data rule in October.",
      "Backups of the data must stay local too.",
      "Does the data rule change the price?",
      "We will confirm the data plan on Friday.",
    ],
    theirs: [
      "Where does your data have to stay?",
      "Understood, your data stays in Europe then.",
      "We can host the data in Frankfurt.",
      "Who reviews the data security report?",
      "Our data team can start in January.",
      "Send the data terms to our lawyer.",
      "Where does your data have to stay now?",
      "So your data stays in the country, not all of Europe?",
      "We can host the data in a local region.",
      "Local data backups cost a little more.",
      "The data price depends on the region.",
      "Friday works for the data plan.",
    ],
    query: "data",
  },
  "zh-CN": {
    mine: [
      "我们先说说试点的数据放在哪里。",
      "我们的数据必须留在欧洲。",
      "我们现在用法兰克福的数据中心。",
      "数据每天夜里两点备份。",
      "试点的数据导入一月份开始。",
      "数据条款下周发给你们。",
      "我们再说说数据托管。",
      "我们的数据现在必须留在国内。",
      "监管部门十月份改了数据规定。",
      "数据备份也必须留在本地。",
      "新的数据规定会影响价格吗？",
      "我们周五确认数据方案。",
    ],
    theirs: [
      "你们的数据必须放在哪里？",
      "明白，数据就留在欧洲。",
      "我们可以把数据放在法兰克福。",
      "谁来审数据安全报告？",
      "我们的数据团队一月份可以开始。",
      "数据条款请发给我们的律师。",
      "你们的数据现在必须放在哪里？",
      "所以数据留在国内，不是整个欧洲？",
      "我们可以把数据放在本地的区域。",
      "本地数据备份会贵一点。",
      "数据价格要看区域。",
      "周五确认数据方案可以。",
    ],
    query: "数据",
  },
};

const INSTRUCTION =
  '\n- A Transcript Passage marked call="this" is this call\'s. One marked call="earlier" is another call, named by its note and started: it was not said in this call. Say they or you said something only from call="this" lines; give an earlier call\'s line as said in that call, saying when, and cite it.';
const HELP_LINE = {
  marked: 'A Document fact, or an earlier call\'s line (call="earlier"), was not said in this call',
  unmarked: "A Document fact was not said in this call",
};

/** What one request sent: its system prompt, its messages and its Tool results. */
const sentBy = (call: ModelCall) =>
  [call.system, call.prompt, ...call.results.map((result) => result.text)].join("\n\n");

/** The request with the marks of #3005 taken out: what it was before them. */
const withoutMarks = (sent: string) =>
  sent
    .replace(/ call="this" started="[^"]*"/g, "")
    .replace(/ call="earlier" note="[^"]*" started="[^"]*"/g, "")
    .replaceAll(INSTRUCTION, "")
    .replaceAll(HELP_LINE.marked, HELP_LINE.unmarked);

const PASSAGE = /<passage id="[^"]+" document="([^"]*)"([^>]*)>\n([\s\S]*?)\n<\/passage>/g;

/** The Transcript Passages sent, each with its attributes after its Document's name, and its lines. */
const transcriptPassages = (sent: string, transcriptName: string) =>
  [...sent.matchAll(PASSAGE)]
    .filter((match) => match[1] === transcriptName)
    .map((match) => ({
      attributes: match[2] as string,
      lines: (match[3] as string)
        .split("\n")
        .map((line) => line.replace(/^\[[^\]]*\] /, ""))
        .filter(Boolean),
    }));

/** A model that searches the Documents once, then gives one option; every request is kept. */
function searchingModel(calls: ModelCall[], query: string) {
  return scriptedModel((call) => {
    calls.push(call);
    if (
      call.tools.includes("search_documents") &&
      !call.results.some((result) => result.tool === "search_documents")
    ) {
      return { calls: [{ tool: "search_documents", input: { query } }] };
    }
    return { text: "★ Let me check the hosting options\n→ keeps it moving" };
  });
}

async function setUp(language: Language) {
  const lines = LINES[language];
  const calls: ModelCall[] = [];
  let unmarked = false;
  const dataDir = await createTempDataFolder();
  const { core, record, clock } = await transcribingCore(dataDir, {
    model: searchingModel(calls, lines.query),
    engine: { lines: lines.mine, theirLines: lines.theirs },
    callsUnmarked: () => unmarked,
  });
  await core.updateSettings({ user: { language } });
  const folder = await core.createLibraryGroup({ name: "Tallowmere Freight", description: "" });

  const earlier = await core.createMeeting({ folderId: folder.id });
  await core.startMeeting({ meetingId: earlier.id, systemAudio: true });
  await until(core, earlier.id, (transcript) => transcript.state === "live");
  record(9 * SECOND);
  await until(core, earlier.id, (transcript) => transcript.lines >= 8);
  const stopped = await stoppedMeeting(core, dataDir, earlier.id);

  // The same day, three hours later: both Notes, and so both Transcripts, are named for the day.
  clock.advance(3 * HOUR);
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  const live = await core.createMeeting({ folderId: folder.id });
  await core.startMeeting({ meetingId: live.id, systemAudio: true });
  await until(core, live.id, (transcript) => transcript.state === "live");
  record(9 * SECOND);
  const heard = await until(core, live.id, (transcript) => transcript.lines >= 8);
  // Every line heard is in the Document before the first press, so each request reads the same.
  await transcriptRead(core, dataDir, live.id, heard.documentId ?? "");
  const meetings = await core.listMeetings();
  const startOf = (meetingId: string) =>
    formatFullDateTime(meetings.find((each) => each.id === meetingId)?.startedAt ?? "", "en");
  const note = (await core.listMinds()).find((mind) => mind.id === earlier.mindId);
  const liveName = (await core.listDocuments()).find((each) => each.id === heard.documentId)?.name;
  const earlierText = (await core.readDocumentText(stopped.document.id)).pages
    .map((page) => page.text)
    .join("\n");
  return {
    core,
    calls,
    live,
    earlierName: stopped.document.name,
    liveName,
    earlierNote: note ? mindName(note) : "",
    earlierStart: startOf(earlier.id),
    liveStart: startOf(live.id),
    earlierText,
    unmark: (on: boolean) => {
      unmarked = on;
    },
  };
}

/** The requests of one press of "What should I say?", in a new conversation. */
async function press(core: Core, calls: ModelCall[], meetingId: string) {
  const from = calls.length;
  const result = await core.askMeetingHelp({ meetingId, kind: "say", conversationId: null });
  if (!result.asked) throw new Error(`Not asked: ${JSON.stringify(result)}`);
  await answerEnded(core, result.answerId);
  return calls.slice(from).map(sentBy);
}

/** The requests of a Question typed in the call's Note, in a new conversation. */
async function typed(core: Core, calls: ModelCall[], mindId: string, text: string) {
  const from = calls.length;
  const result = await core.askInConversation({ mindId, text });
  if (!result.asked) throw new Error(`Not asked: ${JSON.stringify(result)}`);
  await answerEnded(core, result.answerId);
  return calls.slice(from).map(sentBy);
}

for (const language of ["en", "zh-CN"] as const) {
  describe(`${language}: an earlier call's Transcript`, { timeout: 90_000 }, () => {
    test("is marked as an earlier call with its Note and start, this call's lines as this call's, and the model is told what that means; switched off, the request is as before", async () => {
      const setup = await setUp(language);
      const { core, calls, live } = setup;
      expect(setup.liveName).toBe(setup.earlierName);
      expect(setup.earlierStart).not.toBe(setup.liveStart);

      const question = language === "en" ? "What did they say last time?" : "上次他们说了什么？";
      const marked = [
        ...(await press(core, calls, live.id)),
        ...(await typed(core, calls, live.mindId, question)),
      ];
      setup.unmark(true);
      const unmarked = [
        ...(await press(core, calls, live.id)),
        ...(await typed(core, calls, live.mindId, question)),
      ];

      const [pressed] = marked;
      if (pressed === undefined) throw new Error("The press sent nothing.");
      expect(pressed).toContain(INSTRUCTION);
      expect(pressed).toContain(HELP_LINE.marked);

      const heard = /<live-transcript>\n([\s\S]*?)\n<\/live-transcript>/.exec(pressed)?.[1] ?? "";
      const thisCall = transcriptPassages(heard, setup.earlierName);
      expect(thisCall.length).toBeGreaterThan(0);
      for (const passage of thisCall) {
        expect(passage.attributes).toContain(` call="this" started="${setup.liveStart}"`);
      }

      const earlierMarks = ` call="earlier" note="${setup.earlierNote}" started="${setup.earlierStart}"`;
      for (const sent of marked) {
        const passages = transcriptPassages(sent, setup.earlierName);
        for (const passage of passages) {
          const earlier = passage.lines.every((line) => setup.earlierText.includes(line));
          expect(passage.attributes).toContain(
            earlier ? earlierMarks : ` call="this" started="${setup.liveStart}"`,
          );
        }
      }
      for (const sent of [pressed, marked.at(-1) ?? ""]) {
        expect(
          transcriptPassages(sent, setup.earlierName).some((passage) =>
            passage.attributes.includes(earlierMarks),
          ),
        ).toBe(true);
      }

      expect(unmarked).toHaveLength(marked.length);
      for (const sent of unmarked) {
        expect(sent).not.toMatch(/ call="(?:this|earlier)"/);
        expect(sent).not.toContain(INSTRUCTION);
        expect(sent).not.toContain(HELP_LINE.marked);
      }
      expect(unmarked).toEqual(marked.map(withoutMarks));
    });
  });
}
