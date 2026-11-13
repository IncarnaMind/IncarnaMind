/**
 * Earlier calls and call help (#3005), through the core's public interface: two calls with one
 * buyer, in Notes of one Folder that also holds an ordinary Document, both named for the day. A
 * help button's press is given this call and the Documents, never another call's Transcript. A
 * Question typed during the call is given the earlier call too: each Transcript Passage marked as
 * this call's or an earlier call's, with its Note's name and when its call started, and the model
 * is told what the marks mean. With the evaluation's switch on, both are as main's: the earlier
 * call sent unmarked, to a press too.
 */
import { describe, expect, test, vi } from "vitest";
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
import { answerEnded, shownPassages } from "../helpers/citations";
import { createTempDataFolder } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { pressedBeforeFirstLine, turnOf } from "../helpers/earlierCallPress";
import { connectToMind } from "../helpers/mindClient";
import { writeMind } from "../helpers/minds";
import { type GenerateCall, type ModelCall, scriptedModel, unscripted } from "../helpers/models";
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

/** The line on calls a typed Question during a call is sent, with the rule on an earlier call's line. */
const INSTRUCTION =
  '\n- A Transcript Passage marked call="this" is this call\'s: say they or you said something only from call="this" lines. A Transcript Passage marked call="earlier" is another call, named by its note and started: nothing in it was said in this call. Give its line only as said in that call, saying in the sentence itself who said it and when (the day that call started, or its time when it started the same day as this one), as in "When we spoke on Monday, you said …", and cite it; a sentence that can\'t say so leaves the line out.';
/** Any word of the earlier-call rule or of a call's marks. */
const CALL_MARKS = /call="(?:this|earlier)"/;

/** What one request sent: its system prompt, its messages and its Tool results. */
const sentBy = (call: ModelCall) =>
  [call.system, call.prompt, ...call.results.map((result) => result.text)].join("\n\n");

/** A typed Question's request with the marks of #3005 taken out: what it was before them. */
const withoutMarks = (sent: string) =>
  sent
    .replace(/ call="this" started="[^"]*"/g, "")
    .replace(/ call="earlier" note="[^"]*" started="[^"]*"/g, "")
    .replaceAll(INSTRUCTION, "");

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

/** What the earlier call's other side said, and a sentence of a reply that says it again. */
const EARLIER_SAID: Record<Language, { line: string; sentence: string }> = {
  en: {
    line: "Understood, your data stays in Europe then.",
    sentence: "Your data stays in Europe",
  },
  "zh-CN": { line: "明白，数据就留在欧洲。", sentence: "数据就留在欧洲" },
};

/**
 * A model that answers a press, or a typed Question, with one option whose sentence says the
 * earlier call's line again, cited to that line wherever it can see it: a Passage it was given or
 * found by searching once, else a Citation of the Note it reads, by its id ("C1"). While
 * `judging.now` is false the sentences' judgement fails, so its Citation waits as not checked;
 * then each batch is kept and judged unsupported.
 */
function citingModel(
  calls: ModelCall[],
  batches: GenerateCall[],
  { sentence, line, query }: { sentence: string; line: string; query: string },
  judging: { now: boolean },
) {
  return scriptedModel(
    (call) => {
      calls.push(call);
      if (call.results.some((result) => result.tool === "cite")) {
        return { text: `★ ${sentence} [^1]\n→ keeps it moving` };
      }
      const shown = [call.prompt, ...call.results.map((result) => result.text)].join("\n\n");
      const passage = shownPassages(shown).find((each) => each.text.includes(line));
      const cite = (id: string) => ({
        calls: [{ tool: "cite", input: { citations: [{ marker: 1, passage: id, quote: line }] } }],
      });
      if (passage) return cite(passage.id);
      if (/· C1\]/.test(call.prompt)) return cite("C1");
      if (
        call.tools.includes("search_documents") &&
        !call.results.some((result) => result.tool === "search_documents")
      ) {
        return { calls: [{ tool: "search_documents", input: { query } }] };
      }
      return { text: `★ ${sentence}\n→ keeps it moving` };
    },
    {
      generate: (call) => {
        // Stop starts the Transcript's own work (its tags, the notes filled in), none of it this test's.
        if (call.question === undefined) return { error: { status: 500, message: "Not here." } };
        if (call.question === "claimed-changes") return { text: '{"claims":[]}' };
        if (call.question === "request-done") {
          return { text: '{"asks_change":"no","request":"none"}' };
        }
        if (call.question !== "sentence-batch") return unscripted(call.question, call.system);
        if (!judging.now) return { error: { status: 500, message: "Not judged now." } };
        batches.push(call);
        const sentences = [
          ...call.prompt.matchAll(/<sentence number="(\d+)">\n[\s\S]*?\n<\/sentence>/g),
        ];
        return {
          text: JSON.stringify({
            sentences: sentences.map(([, number]) => ({
              number: Number(number),
              kind: "fact",
              verdict: "unsupported",
              roles: "same",
              time: "same",
              quoted: "states",
              says: "The quote says something else.",
            })),
          }),
        };
      },
    },
  );
}

/**
 * A core with one Folder holding the ordinary Document (none with `terms` false), and a way to
 * record a call in it or in another Folder. `only`: the engine says the first so many lines of
 * each side and no more, so a call's text stops there. `model`: the chat model, made with the
 * list every request goes in.
 */
async function folderCore(
  language: Language,
  {
    only,
    terms: withTerms = true,
    model,
  }: {
    only?: number;
    terms?: boolean;
    model?: (calls: ModelCall[]) => ReturnType<typeof scriptedModel>;
  } = {},
) {
  const lines = LINES[language];
  const calls: ModelCall[] = [];
  let unmarked = false;
  const dataDir = await createTempDataFolder();
  const { core, record, clock } = await transcribingCore(dataDir, {
    model: model ? model(calls) : searchingModel(calls, lines.query),
    engine: { lines: lines.mine.slice(0, only), theirLines: lines.theirs.slice(0, only) },
    callsUnmarked: () => unmarked,
  });
  await core.updateSettings({ user: { language } });
  const folder = await core.createLibraryGroup({ name: "Tallowmere Freight", description: "" });
  if (withTerms) {
    const terms = TERMS[language];
    const [document] = await addAndProcess(core, [
      await writeSourceFile(await createTempDataFolder(), terms.name, terms.text),
    ]);
    if (!document) throw new Error(`${terms.name} wasn't added.`);
    await core.moveToFolder({ documentIds: [document.id], folderId: folder.id });
  }
  /** Records a call in the Folder, or in `folderId` (null: none), until eight of its lines are heard. */
  const call = async (folderId: string | null = folder.id) => {
    const meeting = await core.createMeeting({ folderId });
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
    folder,
    call,
    record,
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

/** One press of a help button, in a new conversation: its requests and the Answer it gave. */
async function pressAnswered(
  core: Core,
  calls: ModelCall[],
  meetingId: string,
  kind: MeetingHelpKind,
) {
  const from = calls.length;
  const result = await core.askMeetingHelp({ meetingId, kind, conversationId: null });
  if (!result.asked) throw new Error(`Not asked: ${JSON.stringify(result)}`);
  await answerEnded(core, result.answerId);
  const { messages } = await core.getConversation(result.conversation.id);
  const answer = messages.find((message) => message.id === result.answerId);
  if (answer?.kind !== "answer") throw new Error(`${kind} gave no Answer.`);
  return { sent: calls.slice(from).map(sentBy), answer };
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
    test("a typed Question is given it, marked as an earlier call with its Note and start, this call's lines as this call's, and the model is told what that means; a press is never given it, nor any mark or rule for it; switched off, both are as main's", async () => {
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
      const heard = /<live-transcript>\n([\s\S]*?)\n<\/live-transcript>/.exec(pressed)?.[1] ?? "";
      expect(transcriptPassages(heard, setup.earlierName).length).toBeGreaterThan(0);
      for (const sent of markedPress) {
        expect(transcriptPassages(sent, setup.earlierName).filter(isEarlier)).toEqual([]);
        expect(sent).not.toMatch(CALL_MARKS);
      }

      expect(unmarkedTyped).toHaveLength(markedTyped.length);
      for (const sent of [...unmarkedPress, ...unmarkedTyped]) {
        expect(sent).not.toMatch(CALL_MARKS);
        expect(sent).not.toContain(INSTRUCTION);
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
          expect(each, kind).not.toMatch(CALL_MARKS);
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

    test("a typed Question with words selected in the earlier call's Transcript: those words and every Passage of it the search finds are marked as the earlier call's", async () => {
      const setup = await setUp(language);
      const { core, calls, live } = setup;
      const said = EARLIER_SAID[language];
      const earlierId = (await core.listMeetings()).find((each) => each.status === "stopped")
        ?.transcript?.documentId;
      const found = await core.findPassages({ text: said.line, mindId: null, scope: null });
      const passage = found.find((each) => each.documentId === earlierId);
      if (!passage) throw new Error("The earlier call's line isn't found.");
      const selected = await core.citePassage({ passageId: passage.passageId, text: said.line });
      if (!selected) throw new Error("The earlier call's line can't be selected.");
      const isEarlier = (shown: { lines: string[] }) =>
        shown.lines.some((line) => setup.earlierText.includes(line));
      const earlierMarks = ` call="earlier" note="${setup.earlierNote}" started="${setup.earlierStart}"`;
      const thisMarks = ` call="this" started="${setup.liveStart}"`;

      const from = calls.length;
      const asked = await core.askInConversation({
        mindId: live.mindId,
        text: language === "en" ? "What did they say about this?" : "他们对这个说了什么？",
        quotes: [
          {
            documentId: selected.documentId,
            documentName: selected.documentName,
            quote: selected.quote,
            pageFrom: selected.pageFrom,
            pageTo: selected.pageTo,
            location: selected.location,
            check: selected.check,
          },
        ],
      });
      if (!asked.asked) throw new Error("Not asked.");
      await answerEnded(core, asked.answerId);
      const sent = calls.slice(from).map(sentBy);

      const shown = sent.flatMap((each) => transcriptPassages(each, setup.earlierName));
      expect(shown.filter(isEarlier).length).toBeGreaterThan(1);
      for (const each of shown) {
        expect(each.attributes).toContain(isEarlier(each) ? earlierMarks : thisMarks);
      }
    });

    test("a typed Question asked before the call's first line, whose search finds this call's lines once they are heard: those are marked as this call's", async () => {
      let reached = () => {};
      const paused = new Promise<void>((resolve) => {
        reached = resolve;
      });
      let release = () => {};
      const heldUntil = new Promise<void>((resolve) => {
        release = resolve;
      });
      const setup = await folderCore(language, {
        model: (calls) =>
          scriptedModel((call) => {
            calls.push(call);
            if (
              call.tools.includes("search_documents") &&
              !call.results.some((result) => result.tool === "search_documents")
            ) {
              return {
                calls: [
                  {
                    tool: "search_documents",
                    input: { query: LINES[language].query },
                    streamInput: true,
                  },
                ],
                pause: { after: 1, until: heldUntil, reached },
              };
            }
            return { text: "They said so." };
          }),
      });
      const { core, calls, dataDir, clock } = setup;
      const earlier = await setup.call();
      await stoppedMeeting(core, dataDir, earlier.meeting.id);
      clock.advance(3 * HOUR);
      await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
      const live = await core.createMeeting({ folderId: setup.folder.id });
      await core.startMeeting({ meetingId: live.id, systemAudio: true });
      await until(core, live.id, (transcript) => transcript.state === "live");

      const asked = await core.askInConversation({
        mindId: live.mindId,
        text: language === "en" ? "What have they said so far?" : "他们目前说了什么？",
      });
      if (!asked.asked) throw new Error("Not asked.");
      // Listened before anyone spoke; the lines land while the model is still writing its search.
      await paused;
      setup.record(9 * SECOND);
      const heard = await until(core, live.id, (transcript) => transcript.lines >= 8);
      await transcriptRead(core, dataDir, live.id, heard.documentId ?? "");
      release();
      await answerEnded(core, asked.answerId);

      const meetings = await core.listMeetings();
      const startOf = (meetingId: string) =>
        formatFullDateTime(meetings.find((each) => each.id === meetingId)?.startedAt ?? "", "en");
      const liveName =
        (await core.listDocuments()).find((each) => each.id === heard.documentId)?.name ?? "";
      const liveText = await textOf(core, heard.documentId ?? "");
      const earlierText = await textOf(
        core,
        meetings.find((each) => each.id === earlier.meeting.id)?.transcript?.documentId ?? "",
      );
      const thisCallOnly = (shown: { lines: string[] }) =>
        shown.lines.every((line) => liveText.includes(line) && !earlierText.includes(line));
      const found = calls
        .flatMap((call) => call.results)
        .filter((result) => result.tool === "search_documents")
        .flatMap((result) => transcriptPassages(result.text, liveName))
        .filter(thisCallOnly);
      expect(found.length).toBeGreaterThan(0);
      for (const each of found) {
        expect(each.attributes).toContain(` call="this" started="${startOf(live.id)}"`);
      }
    });
  });

  describe(`${language}: a Folder with no other call`, { timeout: 180_000 }, () => {
    test("each button's press is main's request to the byte", async () => {
      const setup = await folderCore(language, { only: 4 });
      const { core, calls } = setup;
      await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
      // The engine says eight lines and no more, so the call's text holds still for both arms.
      const { meeting } = await setup.call();

      const branch = await pressEvery(core, calls, meeting.id);
      setup.unmark(true);
      const main = await pressEvery(core, calls, meeting.id);

      expect(branch.map(({ kind }) => kind)).toHaveLength(15);
      for (const [index, { kind, sent }] of branch.entries()) {
        expect(sent, kind).toEqual(main[index]?.sent);
        for (const each of sent) expect(each, kind).not.toMatch(CALL_MARKS);
      }
    });
  });

  describe(`${language}: a Folder that holds only calls`, { timeout: 180_000 }, () => {
    test("with the earlier call left out, a press reads this call alone and is answered: main's press in a Folder with this one call, to the byte", async () => {
      /**
       * The earlier call, stopped, then the live one three hours later, with no other Document.
       * `apart`: the earlier call is in another Folder, so the live call's Folder holds it alone.
       */
      const callsOnly = async (apart: boolean) => {
        const setup = await folderCore(language, { only: 8, terms: false });
        const { core, dataDir, clock } = setup;
        const elsewhere = apart
          ? (await core.createLibraryGroup({ name: "Archive", description: "" })).id
          : setup.folder.id;
        const earlier = await setup.call(elsewhere);
        const stopped = await stoppedMeeting(core, dataDir, earlier.meeting.id);
        clock.advance(3 * HOUR);
        await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
        const { meeting: live, heard } = await setup.call();
        await transcriptRead(core, dataDir, live.id, heard.documentId ?? "");
        return {
          ...setup,
          live,
          earlierName: stopped.document.name,
          earlierText: await textOf(core, stopped.document.id),
          liveText: await textOf(core, heard.documentId ?? ""),
        };
      };
      const branch = await callsOnly(false);
      const main = await callsOnly(true);
      main.unmark(true);

      for (const kind of ["say", "want"] as const) {
        const pressed = await pressAnswered(branch.core, branch.calls, branch.live.id, kind);
        const mains = await pressAnswered(main.core, main.calls, main.live.id, kind);

        for (const { answer } of [pressed, mains]) {
          expect(answer.status, kind).toBe("done");
          expect(answer.text, kind).toContain("Let me check the hosting options");
        }
        expect(pressed.sent.length, kind).toBeGreaterThan(0);
        // The engine's eight lines a side come round again in the live call, so a Passage is the
        // earlier call's when it holds a line only that call said.
        const earlierOnly = (line: string) =>
          branch.earlierText.includes(line) && !branch.liveText.includes(line);
        for (const each of pressed.sent) {
          expect(each, kind).not.toContain("holds no Documents, so there is nothing to search");
          expect(
            transcriptPassages(each, branch.earlierName).filter((passage) =>
              passage.lines.some(earlierOnly),
            ),
            kind,
          ).toEqual([]);
        }
        const heard =
          /<live-transcript>\n([\s\S]*?)\n<\/live-transcript>/.exec(pressed.sent[0] ?? "")?.[1] ??
          "";
        const thisCall = transcriptPassages(heard, branch.earlierName);
        expect(thisCall.length, kind).toBeGreaterThan(0);
        for (const passage of thisCall) {
          expect(
            passage.lines.every((line) => branch.liveText.includes(line)),
            kind,
          ).toBe(true);
        }
        expect(pressed.sent, kind).toEqual(mains.sent);
      }
    });
  });

  describe(`${language}: a press's reply checked again`, { timeout: 180_000 }, () => {
    /**
     * A press's reply and a typed Question's Answer in the live call's Note, each with one sentence
     * saying the earlier call's line again, cited to that line and not checked; then the call
     * stops. The press reaches the line by a Citation the User kept in the Note.
     */
    const pressedThenStopped = async () => {
      const said = EARLIER_SAID[language];
      const batches: GenerateCall[] = [];
      const judging = { now: false };
      const setup = await folderCore(language, {
        model: (calls) =>
          citingModel(
            calls,
            batches,
            { sentence: said.sentence, line: said.line, query: said.sentence },
            judging,
          ),
      });
      const { core, dataDir, clock } = setup;
      const earlier = await setup.call();
      const stopped = await stoppedMeeting(core, dataDir, earlier.meeting.id);
      clock.advance(3 * HOUR);
      // A model with a price, so the check has an estimate.
      const saved = await core.saveChatProvider({
        kind: "anthropic",
        apiKey: "sk-ant-test",
        modelId: "claude-haiku-5-5",
      });
      if (saved.service) {
        core.on("consent.requested", (request) => {
          void core.respondToConsent(request.requestId, true);
        });
        await core.allowDataFlow("chat", saved.service.id);
      }
      const { meeting: live, heard } = await setup.call();
      await transcriptRead(core, dataDir, live.id, heard.documentId ?? "");
      expect(await textOf(core, stopped.document.id)).toContain(said.line);

      const answerOf = async (ids: { conversationId: string; answerId: string }) => {
        const { messages } = await core.getConversation(ids.conversationId);
        const answer = messages.find((message) => message.id === ids.answerId);
        if (answer?.kind !== "answer") throw new Error("No Answer.");
        return answer;
      };

      // A typed Question cites the earlier call's line; the User keeps that Citation in the Note.
      const asked = await core.askInConversation({
        mindId: live.mindId,
        text: language === "en" ? "What did they say last time?" : "上次他们说了什么？",
      });
      if (!asked.asked) throw new Error("Not asked.");
      await answerEnded(core, asked.answerId);
      const typedIds = { conversationId: asked.conversation.id, answerId: asked.answerId };
      const [kept] = (await answerOf(typedIds)).citations;
      if (!kept) throw new Error("The typed Question cited nothing.");
      expect(kept.documentId).toBe(stopped.document.id);
      const client = await connectToMind(core, live.mindId);
      writeMind(client, [
        {
          type: "paragraph",
          attrs: { id: "kept" },
          content: [
            { type: "text", text: `${said.sentence} ` },
            {
              type: "citation",
              attrs: {
                passageId: kept.passageId,
                documentId: kept.documentId,
                documentName: kept.documentName,
                contentHash: kept.contentHash,
                pageFrom: kept.pageFrom,
                pageTo: kept.pageTo,
                location: kept.location,
                quote: kept.quote,
                check: "found",
                checkReason: null,
              },
            },
          ],
        },
      ]);
      await client.settled();

      // The press keeps the Note's Citation: the one way its reply can cite an earlier call.
      const pressed = await core.askMeetingHelp({
        meetingId: live.id,
        kind: "say",
        conversationId: null,
      });
      if (!pressed.asked) throw new Error("Not pressed.");
      await answerEnded(core, pressed.answerId);
      const pressIds = { conversationId: pressed.conversation.id, answerId: pressed.answerId };
      const reply = await answerOf(pressIds);
      expect(reply.citations.map((citation) => [citation.documentId, citation.check])).toEqual([
        [stopped.document.id, "not-checked"],
      ]);

      // Stop: the notes are tried with the model, which this test answers with an error.
      await core.stopMeeting(live.id);
      await until(core, live.id, (transcript) => transcript.state === "saved");
      await vi.waitFor(async () =>
        expect((await core.listMeetings()).find((each) => each.id === live.id)?.fill?.state).toBe(
          "failed",
        ),
      );
      return { core, said, batches, judging, live, pressIds, typedIds, answerOf };
    };

    /** Check again on the press's reply sends none of the earlier call's line and passes nothing. */
    const checkedWithoutIt = async (setup: Awaited<ReturnType<typeof pressedThenStopped>>) => {
      const { core, said, batches, judging, pressIds, answerOf } = setup;
      judging.now = true;
      await core.checkAnswerAgain(pressIds);
      expect(batches.filter((batch) => batch.prompt.includes(said.line))).toEqual([]);
      const rechecked = await answerOf(pressIds);
      expect(rechecked.citations.map((citation) => citation.check)).toEqual(["not-checked"]);
      expect(rechecked.citations.flatMap((citation) => citation.passedAt ?? [])).toEqual([]);
    };

    test("after the call stops, Check again and its estimate read the Folder without the earlier call's Transcript, though it holds the sentence's words; a typed Question's Answer still reads it", async () => {
      const setup = await pressedThenStopped();
      const { core, said, batches, pressIds, typedIds } = setup;

      // The estimate reads the scope Check again reads: for the press, the earlier call is out of
      // it, so there is nothing to judge; the typed Question's Answer still has it.
      expect(await core.estimateAnswerCheck(pressIds)).toBeNull();
      expect(await core.estimateAnswerCheck(typedIds)).not.toBeNull();

      await checkedWithoutIt(setup);
      await core.checkAnswerAgain(typedIds);
      expect(batches.some((batch) => batch.prompt.includes(said.line))).toBe(true);
    });

    test("with its Note deleted too, the press's reply is still checked again without the earlier call's Transcript, and its estimate counts the same scope", async () => {
      const setup = await pressedThenStopped();
      const { core, live, pressIds } = setup;
      await core.deleteMind(live.mindId);

      expect(await core.estimateAnswerCheck(pressIds)).toBeNull();
      await checkedWithoutIt(setup);
    });

    test("a press made before the call's first line is heard: Check again and its estimate read the Folder without the earlier call's Transcript, and its kept Citation of it stays not checked", async () => {
      const { core, line, batches, pressIds, earlier } = await pressedBeforeFirstLine(language);
      const holdsTheLine = () => batches.filter((batch) => batch.prompt.includes(line));
      const { answer } = await turnOf(core, pressIds);
      expect(answer.citations.map((citation) => [citation.documentId, citation.check])).toEqual([
        [earlier, "not-checked"],
      ]);
      expect(holdsTheLine()).toEqual([]);

      expect.soft(await core.estimateAnswerCheck(pressIds)).toBeNull();
      await core.checkAnswerAgain(pressIds);
      expect.soft(holdsTheLine()).toEqual([]);
      const rechecked = (await turnOf(core, pressIds)).answer;
      expect.soft(rechecked.citations.map((citation) => citation.check)).toEqual(["not-checked"]);
      expect.soft(rechecked.citations.flatMap((citation) => citation.passedAt ?? [])).toEqual([]);
    });
  });
}

describe("A Folder that keeps its work inside it", { timeout: 180_000 }, () => {
  const MATTER = {
    name: "Matter terms.md",
    text: "# Matter terms\n\nThe retainer for this matter is billed monthly at nine thousand.\n",
    sentence: "The retainer for this matter is billed monthly at nine thousand.",
  };

  /** A core whose Library also holds a walled Folder with one Document of its own. */
  const walledCore = async () => {
    const setup = await folderCore("en");
    const { core } = setup;
    const created = await core.createLibraryGroup({ name: "Matter A", description: "" });
    const walled = await core.updateLibraryGroup(created.id, {
      name: created.name,
      description: created.description,
      keepInside: true,
    });
    const [document] = await addAndProcess(core, [
      await writeSourceFile(await createTempDataFolder(), MATTER.name, MATTER.text),
    ]);
    if (!document) throw new Error(`${MATTER.name} wasn't added.`);
    await core.moveToFolder({ documentIds: [document.id], folderId: walled.id });
    return { ...setup, walled };
  };

  /** The earlier call in `earlierIn`, stopped, then the live call in `liveIn`: one press on each arm. */
  const pressedBothWays = async (
    earlierIn: (folders: { walled: string; open: string }) => string,
    liveIn: (folders: { walled: string; open: string }) => string | null,
  ) => {
    const setup = await walledCore();
    const { core, dataDir, clock, calls } = setup;
    const folders = { walled: setup.walled.id, open: setup.folder.id };
    const earlier = await setup.call(earlierIn(folders));
    const stopped = await stoppedMeeting(core, dataDir, earlier.meeting.id);
    clock.advance(3 * HOUR);
    await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
    const { meeting: live, heard } = await setup.call(liveIn(folders));
    await transcriptRead(core, dataDir, live.id, heard.documentId ?? "");
    const earlierText = await textOf(core, stopped.document.id);
    const branch = await press(core, calls, live.id, "say");
    setup.unmark(true);
    const main = await press(core, calls, live.id, "say");
    const holdsEarlier = (sent: readonly string[]) =>
      sent.some((each) =>
        transcriptPassages(each, stopped.document.name).some((passage) =>
          passage.lines.some((line) => earlierText.includes(line)),
        ),
      );
    const holds = (sent: readonly string[], words: string) =>
      sent.some((each) => each.includes(words));
    return { branch, main, holdsEarlier, holds };
  };

  test("a press from a Note outside it, with no Search scope, reads nothing inside it and not the other call: what main's press reads, but the other call", async () => {
    const { branch, main, holdsEarlier, holds } = await pressedBothWays(
      ({ open }) => open,
      () => null,
    );

    expect(holds(branch, MATTER.sentence)).toBe(false);
    expect(holds(main, MATTER.sentence)).toBe(false);
    expect(holds(branch, TERMS.en.sentence)).toBe(true);
    expect(holds(main, TERMS.en.sentence)).toBe(true);
    expect(holdsEarlier(main)).toBe(true);
    expect(holdsEarlier(branch)).toBe(false);
  });

  test("a press made inside it reads its Folder and not the other call kept inside it too", async () => {
    const { branch, main, holdsEarlier, holds } = await pressedBothWays(
      ({ walled }) => walled,
      ({ walled }) => walled,
    );

    expect(holds(branch, MATTER.sentence)).toBe(true);
    expect(holds(main, MATTER.sentence)).toBe(true);
    expect(holds(branch, TERMS.en.sentence)).toBe(false);
    expect(holdsEarlier(main)).toBe(true);
    expect(holdsEarlier(branch)).toBe(false);
  });
});

describe("Another call elsewhere in the Library", { timeout: 180_000 }, () => {
  /** The lines that say how many Documents there are and name them, through "Use the names…". */
  const documentsLines = (sent: string) => {
    const lines = sent.split("\n");
    const from = lines.findIndex((line) => line.startsWith("The User has added "));
    const to = lines.findIndex((line, at) => at > from && line.startsWith("Use the names to tell"));
    return from < 0 || to < 0 ? [] : lines.slice(from, to + 1);
  };

  test("a press with no Search scope is told main's line on the Documents but for the count, and their names but the other call's", async () => {
    const setup = await folderCore("en");
    const { core, dataDir, clock, calls } = setup;
    const earlier = await setup.call();
    const stopped = await stoppedMeeting(core, dataDir, earlier.meeting.id);
    // Days later, so each call's Transcript is named for a day of its own.
    clock.advance(6 * 24 * HOUR);
    await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
    const { meeting: live, heard } = await setup.call(null);
    await transcriptRead(core, dataDir, live.id, heard.documentId ?? "");
    const branch = await press(core, calls, live.id, "say");
    setup.unmark(true);
    const main = await press(core, calls, live.id, "say");

    expect(main.length).toBeGreaterThan(0);
    expect(branch).toHaveLength(main.length);
    const other = `- ${stopped.document.name}`;
    for (const [index, sent] of main.entries()) {
      const mains = documentsLines(sent);
      expect(mains[0]).toMatch(/^The User has added 3 Documents \(/);
      expect(mains).toContain(other);
      expect(documentsLines(branch[index] ?? "")).toEqual(
        mains
          .filter((line) => line !== other)
          .map((line) => line.replace("added 3 Documents", "added 2 Documents")),
      );
      for (const each of [sent, branch[index] ?? ""]) expect(each).not.toMatch(/^Search scope:/m);
    }
  });
});
