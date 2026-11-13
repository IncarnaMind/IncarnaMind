/**
 * Earlier calls and call help (#3005), through the core's public interface: two calls with one
 * buyer, in Notes of one Folder that also holds an ordinary Document, both named for the day. A
 * help button's press is given this call and the Documents, never another call's Transcript. A
 * Question typed during the call is given the earlier call too: each Transcript Passage marked as
 * this call's or an earlier call's, with its Note's name and when its call started, and the model
 * is told what the marks mean. With the evaluation's switch on, both are as main's: the earlier
 * call sent unmarked, to a press too.
 */
import { describe, expect, test } from "vitest";
import type { Core } from "../../src/core";
import type { Language } from "../../src/core/language";
import { formatFullDateTime } from "../../src/shared/dates";
import {
  GENERAL_HELP,
  type MeetingHelpKind,
  type MeetingHelpTemplate,
  TEMPLATE_HELP,
} from "../../src/shared/meetingHelp";
import { mindName } from "../../src/shared/naming";
import { answerEnded } from "../helpers/citations";
import { createTempDataFolder } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { writeMind } from "../helpers/minds";
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

/** The Folder's ordinary Document, and a sentence of it to find in a request. */
const TERMS: Record<Language, { name: string; text: string; sentence: string }> = {
  en: {
    name: "Hosting terms.md",
    text: "# Hosting terms\n\nThe pilot's data is kept in our Frankfurt data centre for twelve months.\n",
    sentence: "The pilot's data is kept in our Frankfurt data centre for twelve months.",
  },
  "zh-CN": {
    name: "托管条款.md",
    text: "# 托管条款\n\n试点的数据在我们法兰克福的数据中心保存十二个月。\n",
    sentence: "试点的数据在我们法兰克福的数据中心保存十二个月。",
  },
};

/** What the User keeps in the live call's Note about last time, in their own words. */
const BRIEF: Record<Language, string> = {
  en: "Last time with these people: their data had to stay in Europe.",
  "zh-CN": "上次与这些人开会：对方的数据必须留在欧洲。",
};

/** The buttons that read this call alone, never the Documents. */
const CALL_ONLY: readonly MeetingHelpKind[] = [
  "want",
  "sum",
  "followUp",
  "leading",
  "decisions",
  "disagree",
];

/** Every button, each with the template that shows it. */
const BUTTONS: readonly { kind: MeetingHelpKind; template: MeetingHelpTemplate | null }[] = [
  ...GENERAL_HELP.map((kind) => ({ kind, template: null })),
  ...(Object.keys(TEMPLATE_HELP) as MeetingHelpTemplate[]).flatMap((template) =>
    TEMPLATE_HELP[template].map((kind) => ({ kind, template })),
  ),
];

/** What an earlier call's line may be given as: one sentence, in the Answer's rule and the button's. */
const EARLIER_RULE =
  'A Transcript Passage marked call="earlier" is another call, named by its note and started: nothing in it was said in this call. Give its line only as said in that call, saying in the sentence itself who said it and when (the day that call started, or its time when it started the same day as this one), as in "When we spoke on Monday, you said …", and cite it; a sentence that can\'t say so leaves the line out.';
const INSTRUCTION = `\n- A Transcript Passage marked call="this" is this call's: say they or you said something only from call="this" lines. ${EARLIER_RULE}`;
const HELP_LINE = {
  marked: `A Document fact was not said in this call: distinguish it from the transcript, cite it, and never invent one. ${EARLIER_RULE} When giving`,
  unmarked:
    "A Document fact was not said in this call: distinguish it from the transcript, cite it, and never invent one. When giving",
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
/** A Passage marked as an earlier call's: the rules name the mark too, so only a tag counts. */
const EARLIER_PASSAGE = /<passage [^>]*call="earlier"/;

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

/**
 * A core with one Folder holding the ordinary Document, and a way to record a call in it. `only`:
 * the engine says the first so many lines of each side and no more, so a call's text stops there.
 */
async function folderCore(language: Language, only?: number) {
  const lines = LINES[language];
  const calls: ModelCall[] = [];
  let unmarked = false;
  const dataDir = await createTempDataFolder();
  const { core, record, clock } = await transcribingCore(dataDir, {
    model: searchingModel(calls, lines.query),
    engine: { lines: lines.mine.slice(0, only), theirLines: lines.theirs.slice(0, only) },
    callsUnmarked: () => unmarked,
  });
  await core.updateSettings({ user: { language } });
  const folder = await core.createLibraryGroup({ name: "Tallowmere Freight", description: "" });
  const terms = TERMS[language];
  const [document] = await addAndProcess(core, [
    await writeSourceFile(await createTempDataFolder(), terms.name, terms.text),
  ]);
  if (!document) throw new Error(`${terms.name} wasn't added.`);
  await core.moveToFolder({ documentIds: [document.id], folderId: folder.id });
  /** Records a call in the Folder until eight of its lines are heard. */
  const call = async () => {
    const meeting = await core.createMeeting({ folderId: folder.id });
    await core.startMeeting({ meetingId: meeting.id, systemAudio: true });
    await until(core, meeting.id, (transcript) => transcript.state === "live");
    record(9 * SECOND);
    const heard = await until(core, meeting.id, (transcript) => transcript.lines >= 8);
    return { meeting, heard };
  };
  return {
    core,
    calls,
    clock,
    dataDir,
    call,
    unmark: (on: boolean) => {
      unmarked = on;
    },
  };
}

const textOf = async (core: Core, documentId: string) =>
  (await core.readDocumentText(documentId)).pages.map((page) => page.text).join("\n");

/** The live call, after an earlier one stopped three hours before it on the same day. */
async function setUp(language: Language) {
  const setup = await folderCore(language);
  const { core, dataDir, clock } = setup;
  const earlier = await setup.call();
  const stopped = await stoppedMeeting(core, dataDir, earlier.meeting.id);
  // The same day, three hours later: both Notes, and so both Transcripts, are named for the day.
  clock.advance(3 * HOUR);
  await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  const { meeting: live, heard } = await setup.call();
  // Every line heard is in the Document before the first press, so each request reads the same.
  await transcriptRead(core, dataDir, live.id, heard.documentId ?? "");
  const meetings = await core.listMeetings();
  const startOf = (meetingId: string) =>
    formatFullDateTime(meetings.find((each) => each.id === meetingId)?.startedAt ?? "", "en");
  const note = (await core.listMinds()).find((mind) => mind.id === earlier.meeting.mindId);
  const liveName = (await core.listDocuments()).find((each) => each.id === heard.documentId)?.name;
  return {
    ...setup,
    live,
    earlierName: stopped.document.name,
    liveName,
    earlierNote: note ? mindName(note) : "",
    earlierStart: startOf(earlier.meeting.id),
    liveStart: startOf(live.id),
    earlierText: await textOf(core, stopped.document.id),
    liveText: await textOf(core, heard.documentId ?? ""),
  };
}

/** The requests of one press of a help button, in a new conversation. */
async function press(core: Core, calls: ModelCall[], meetingId: string, kind: MeetingHelpKind) {
  const from = calls.length;
  const result = await core.askMeetingHelp({ meetingId, kind, conversationId: null });
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

/** Presses every button once, each in its template, and gives each one's requests. */
async function pressEvery(core: Core, calls: ModelCall[], meetingId: string) {
  const pressed: { kind: MeetingHelpKind; sent: string[] }[] = [];
  for (const { kind, template } of BUTTONS) {
    await core.setMeetingTemplate({ meetingId, template });
    pressed.push({ kind, sent: await press(core, calls, meetingId, kind) });
  }
  return pressed;
}

for (const language of ["en", "zh-CN"] as const) {
  describe(`${language}: an earlier call's Transcript`, { timeout: 180_000 }, () => {
    test("a typed Question is given it, marked as an earlier call with its Note and start, this call's lines as this call's, and the model is told what that means; a press is never given it; switched off, both are as main's", async () => {
      const setup = await setUp(language);
      const { core, calls, live } = setup;
      expect(setup.liveName).toBe(setup.earlierName);
      expect(setup.earlierStart).not.toBe(setup.liveStart);
      const isEarlier = (passage: { lines: string[] }) =>
        passage.lines.some((line) => setup.earlierText.includes(line));

      const question = language === "en" ? "What did they say last time?" : "上次他们说了什么？";
      const markedPress = await press(core, calls, live.id, "say");
      const markedTyped = await typed(core, calls, live.mindId, question);
      setup.unmark(true);
      const unmarkedPress = await press(core, calls, live.id, "say");
      const unmarkedTyped = await typed(core, calls, live.mindId, question);

      const earlierMarks = ` call="earlier" note="${setup.earlierNote}" started="${setup.earlierStart}"`;
      const thisMarks = ` call="this" started="${setup.liveStart}"`;
      const [typedFirst] = markedTyped;
      if (typedFirst === undefined) throw new Error("The typed Question sent nothing.");
      expect(typedFirst).toContain(INSTRUCTION);
      for (const sent of markedTyped) {
        for (const passage of transcriptPassages(sent, setup.earlierName)) {
          expect(passage.attributes).toContain(isEarlier(passage) ? earlierMarks : thisMarks);
        }
      }
      expect(
        markedTyped.some((sent) =>
          transcriptPassages(sent, setup.earlierName).some(
            (passage) => isEarlier(passage) && passage.attributes.includes(earlierMarks),
          ),
        ),
      ).toBe(true);

      const [pressed] = markedPress;
      if (pressed === undefined) throw new Error("The press sent nothing.");
      expect(pressed).toContain(INSTRUCTION);
      expect(pressed).toContain(HELP_LINE.marked);
      const heard = /<live-transcript>\n([\s\S]*?)\n<\/live-transcript>/.exec(pressed)?.[1] ?? "";
      const thisCall = transcriptPassages(heard, setup.earlierName);
      expect(thisCall.length).toBeGreaterThan(0);
      for (const passage of thisCall) expect(passage.attributes).toContain(thisMarks);
      for (const sent of markedPress) {
        expect(transcriptPassages(sent, setup.earlierName).filter(isEarlier)).toEqual([]);
        expect(sent).not.toMatch(EARLIER_PASSAGE);
      }

      expect(unmarkedTyped).toHaveLength(markedTyped.length);
      for (const sent of [...unmarkedPress, ...unmarkedTyped]) {
        expect(sent).not.toMatch(/ call="(?:this|earlier)"/);
        expect(sent).not.toContain(INSTRUCTION);
        expect(sent).not.toContain(HELP_LINE.marked);
      }
      expect(unmarkedTyped).toEqual(markedTyped.map(withoutMarks));
      // Main's path still gives a press the earlier call, as main does.
      expect(
        unmarkedPress.some((sent) => transcriptPassages(sent, setup.earlierName).some(isEarlier)),
      ).toBe(true);
    });

    test("no button's press is given it: each is given this call, and each button that reads the Documents the Folder's ordinary Document too", async () => {
      const setup = await setUp(language);
      const { core, calls, live } = setup;
      const isEarlier = (passage: { lines: string[] }) =>
        passage.lines.some((line) => setup.earlierText.includes(line));
      const pressed = await pressEvery(core, calls, live.id);

      expect(pressed.map(({ kind }) => kind)).toHaveLength(15);
      for (const { kind, sent } of pressed) {
        const [first] = sent;
        if (first === undefined) throw new Error(`${kind} sent nothing.`);
        const heard = /<live-transcript>\n([\s\S]*?)\n<\/live-transcript>/.exec(first)?.[1] ?? "";
        const thisCall = transcriptPassages(heard, setup.earlierName);
        expect(thisCall.length, kind).toBeGreaterThan(0);
        for (const passage of thisCall) {
          expect(
            passage.lines.every((line) => setup.liveText.includes(line)),
            kind,
          ).toBe(true);
        }
        for (const each of sent) {
          expect(transcriptPassages(each, setup.earlierName).filter(isEarlier), kind).toEqual([]);
          expect(each, kind).not.toMatch(EARLIER_PASSAGE);
        }
        expect(
          sent.some((each) => each.includes(TERMS[language].sentence)),
          kind,
        ).toBe(!CALL_ONLY.includes(kind));
      }
    });

    test("a Note that holds what the User kept from last time: a press is given the Note's words, and still no Passage of the earlier call", async () => {
      const setup = await setUp(language);
      const { core, calls, live } = setup;
      const client = await connectToMind(core, live.mindId);
      writeMind(client, [
        {
          type: "paragraph",
          attrs: { id: "brief" },
          content: [{ type: "text", text: BRIEF[language] }],
        },
      ]);
      await client.settled();
      const isEarlier = (passage: { lines: string[] }) =>
        passage.lines.some((line) => setup.earlierText.includes(line));

      const sent = await press(core, calls, live.id, "say");

      expect(sent.some((each) => each.includes(BRIEF[language]))).toBe(true);
      for (const each of sent) {
        expect(transcriptPassages(each, setup.earlierName).filter(isEarlier)).toEqual([]);
      }
    });
  });

  describe(`${language}: a Folder with no other call`, { timeout: 180_000 }, () => {
    test("each button's press is main's request to the byte but for the marks: the system's line on calls, the buttons' line on an earlier call's line, and this call's Passages' call and start", async () => {
      const setup = await folderCore(language, 4);
      const { core, calls } = setup;
      await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
      // The engine says eight lines and no more, so the call's text holds still for both arms.
      const { meeting } = await setup.call();

      const branch = await pressEvery(core, calls, meeting.id);
      setup.unmark(true);
      const main = await pressEvery(core, calls, meeting.id);

      for (const [index, { kind, sent }] of branch.entries()) {
        const mains = main[index]?.sent ?? [];
        expect(sent.map(withoutMarks), kind).toEqual(mains);
        const [first] = sent;
        expect(first, kind).toContain(INSTRUCTION);
        expect(first, kind).toMatch(/ call="this" started="[^"]+"/);
        if (CALL_ONLY.includes(kind)) expect(first, kind).not.toContain(HELP_LINE.marked);
        else expect(first, kind).toContain(HELP_LINE.marked);
        for (const each of mains) {
          expect(each, kind).not.toMatch(/ call="(?:this|earlier)"/);
          expect(each, kind).not.toContain(INSTRUCTION);
        }
      }
    });
  });
}
