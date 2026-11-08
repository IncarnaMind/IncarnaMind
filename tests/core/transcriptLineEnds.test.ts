/**
 * Where a cloud route ends a Transcript's lines: at the speaker's change, the service's pause and
 * each sentence's end, never by a clock; a sentence that runs on ends at a clause mark after 30
 * seconds and at a word after 45, never inside one. Through each route's adapter, fed the messages
 * its service sends, as a Meeting's stream is.
 */
import { describe, expect, test } from "vitest";
import type { SpeechSegment } from "../../src/core";
import { createDeepgramStream } from "../../src/core/transcription/cloud/deepgram";
import { endsAfter, endsBefore, startsWord } from "../../src/core/transcription/cloud/lineEnds";
import type { CloudConnect, CloudSocketEvents } from "../../src/core/transcription/cloud/socket";
import { createSonioxStream } from "../../src/core/transcription/cloud/soniox";
import { createSpeechmaticsStream } from "../../src/core/transcription/cloud/speechmatics";
import { createXaiStream } from "../../src/core/transcription/cloud/xai";
import { turnsOf } from "../../src/shared/transcriptTurns";

/** A word of the monologue: its text as written (with any mark after it), when, and who says it. */
interface Said {
  text: string;
  start: number;
  end: number;
  speaker: number;
}

const ENGLISH = [
  "We looked at the launch plan again this morning.",
  "The budget holds at one point two million for the year.",
  "Partner preview stays on the twenty-eighth of October.",
  "Press waits for the new date before anything goes out.",
  "Mats checks the briefing date with the agency this week.",
];
const CHINESE = [
  "我们今天上午又看了一遍发布计划。",
  "全年的预算维持在一百二十万。",
  "合作伙伴预览仍在十月二十八日。",
  "媒体要等新的日期再发布消息。",
  "马茨本周和代理商确认简报日期。",
];

/**
 * Ninety seconds of one speaker, a word every 300 ms with no pause long enough for the service
 * to end the utterance, and "Right." from someone else at 40 seconds.
 */
function monologue(language: "en" | "zh"): Said[] {
  const said: Said[] = [];
  let at = 0;
  let sentence = 0;
  let interjected = false;
  while (at < 90_000) {
    const text = (language === "en" ? ENGLISH : CHINESE)[sentence % 5] as string;
    const words = language === "en" ? text.split(" ") : [...text];
    for (const word of words) {
      said.push({ text: word, start: at, end: at + 280, speaker: 0 });
      at += 300;
    }
    sentence++;
    if (!interjected && at >= 40_000) {
      interjected = true;
      said.push({
        text: language === "en" ? "Right." : "好的。",
        start: at,
        end: at + 600,
        speaker: 1,
      });
      at += 700;
    }
  }
  return said;
}

/** What a route reported: its final lines, in order. */
function heard() {
  const segments: SpeechSegment[] = [];
  return {
    finals: () => segments.filter((each) => each.final),
    report: {
      segment: (each: SpeechSegment) => segments.push(each),
      progress: () => undefined,
      lost: () => undefined,
      opened: () => undefined,
    },
  };
}

function service() {
  let events: CloudSocketEvents | null = null;
  const connect: CloudConnect = (_url, _key, given) => {
    events = given;
    return { send: () => undefined, close: () => undefined };
  };
  return {
    connect,
    open: () => events?.open(),
    say: (message: object) => events?.message(JSON.stringify(message)),
  };
}

/** Each route, fed the monologue as its service sends final words, then the end of the audio. */
const ROUTES: Record<string, (said: readonly Said[]) => SpeechSegment[]> = {
  Soniox(said) {
    const heardBy = heard();
    const socket = service();
    createSonioxStream({
      stream: "m:system",
      model: "stt-rt-v5",
      apiKey: "key",
      connect: socket.connect,
      report: heardBy.report,
    });
    socket.open();
    for (const word of said) {
      // Subword pieces, as Soniox sends: a space before each English word.
      const pieces = /^[\p{Script=Han}\p{P}]/u.test(word.text) ? [word.text] : [` ${word.text}`];
      socket.say({
        tokens: pieces.map((text) => ({
          text,
          start_ms: word.start,
          end_ms: word.end,
          is_final: true,
          speaker: String(word.speaker + 1),
        })),
      });
    }
    socket.say({ tokens: [{ text: "<end>", is_final: true }], finished: true });
    return heardBy.finals();
  },
  Deepgram(said) {
    const heardBy = heard();
    const socket = service();
    createDeepgramStream({
      stream: "m:system",
      model: "nova-3",
      apiKey: "key",
      url: "wss://api.deepgram.com/v1/listen",
      connect: socket.connect,
      report: heardBy.report,
    });
    socket.open();
    for (const word of said) {
      socket.say({
        type: "Results",
        start: word.start / 1000,
        duration: (word.end - word.start) / 1000,
        is_final: true,
        speech_final: false,
        channel: {
          alternatives: [
            {
              transcript: word.text,
              words: [
                {
                  word: word.text,
                  punctuated_word: word.text,
                  start: word.start / 1000,
                  end: word.end / 1000,
                  speaker: word.speaker,
                  confidence: 0.9,
                },
              ],
            },
          ],
        },
      });
    }
    const last = said.at(-1) as Said;
    socket.say({
      type: "Results",
      start: last.end / 1000,
      duration: 0.5,
      is_final: true,
      speech_final: true,
      channel: { alternatives: [{ transcript: "", words: [] }] },
    });
    return heardBy.finals();
  },
  Speechmatics(said) {
    const heardBy = heard();
    const socket = service();
    createSpeechmaticsStream({
      stream: "m:system",
      model: "enhanced",
      apiKey: "key",
      connect: socket.connect,
      report: heardBy.report,
    });
    socket.open();
    socket.say({ message: "RecognitionStarted", id: "s1" });
    for (const word of said) {
      const mark = /[.。]$/u.exec(word.text)?.[0];
      const content = mark ? word.text.slice(0, -1) : word.text;
      const speaker = `S${word.speaker + 1}`;
      socket.say({
        message: "AddTranscript",
        metadata: { start_time: word.start / 1000, end_time: word.end / 1000, transcript: "" },
        results: [
          {
            type: "word",
            start_time: word.start / 1000,
            end_time: word.end / 1000,
            alternatives: [{ content, confidence: 0.9, speaker }],
          },
          ...(mark
            ? [
                {
                  type: "punctuation",
                  start_time: word.end / 1000,
                  end_time: word.end / 1000,
                  attaches_to: "previous",
                  is_eos: true,
                  alternatives: [{ content: mark, confidence: 1, speaker }],
                },
              ]
            : []),
        ],
      });
    }
    socket.say({ message: "EndOfUtterance", metadata: { start_time: 91, end_time: 91 } });
    return heardBy.finals();
  },
  xAI(said) {
    const heardBy = heard();
    const socket = service();
    createXaiStream({
      stream: "m:system",
      model: "grok-voice-transcribe-2.0",
      apiKey: "key",
      connect: socket.connect,
      report: heardBy.report,
    });
    socket.open();
    socket.say({ type: "transcript.created" });
    for (const word of said) {
      socket.say({
        type: "transcript.partial",
        text: word.text,
        words: [
          {
            text: word.text,
            start: word.start / 1000,
            end: word.end / 1000,
            confidence: 0.9,
            speaker: word.speaker,
          },
        ],
        start: word.start / 1000,
        duration: (word.end - word.start) / 1000,
        is_final: true,
        speech_final: false,
      });
    }
    const last = said.at(-1) as Said;
    socket.say({
      type: "transcript.partial",
      text: "",
      words: [],
      start: last.end / 1000,
      duration: 0.5,
      is_final: true,
      speech_final: true,
    });
    return heardBy.finals();
  },
};

describe("A cloud route's lines end at sentences, never by a clock", () => {
  for (const [route, run] of Object.entries(ROUTES)) {
    for (const language of ["en", "zh"] as const) {
      // protects=on each word-by-word route, ninety seconds of one speaker come back as one line a sentence, each with its own start, none cut by a clock or inside a word, "Right." from the other side a line of its own, and nothing lost; as turns, the speaker's lines before and after the interjection are two turns around it; in English and Chinese; fails_when=a line is cut at 20 seconds or inside a word, a sentence is split, a word is lost or doubled, or the interjection joins the speaker's line; no_claim=the speaker pass and the view, which their own tests cover.
      test(`${route}: a 90-second monologue is a line a sentence, with an interjection its own (${language})`, () => {
        const said = monologue(language);
        const finals = run(said);
        const sentences = language === "en" ? ENGLISH : CHINESE;
        const interjection = language === "en" ? "Right." : "好的。";
        expect(finals.length).toBeGreaterThan(15);
        for (const line of finals) {
          expect(line.text === interjection || sentences.includes(line.text), line.text).toBe(true);
          expect(line.endMs - line.startMs).toBeLessThan(20_000);
        }
        const joined = finals.map((line) => line.text).join(language === "en" ? " " : "");
        const expected = said.map((word) => word.text).join(language === "en" ? " " : "");
        expect(joined).toBe(expected);
        const speakers = finals.map((line) => line.speaker);
        const turns = turnsOf(
          finals.map((line, index) => ({
            startMs: line.startMs,
            endMs: line.endMs,
            text: line.text,
            speaker: speakers[index] ?? null,
          })),
        );
        expect(turns).toHaveLength(3);
        expect(turns[1]?.paragraphs.flat().map((line) => line.text)).toEqual([interjection]);
      });
    }
  }
});

describe("A sentence that runs on", () => {
  // protects=a sentence with no end after 30 seconds ends at its next clause mark, and after 45 at its next word, never inside a Latin word or between a word and the piece that finishes it; a full stop ends a sentence only once the next piece starts a word, not in "3.5" or after "Dr."; fails_when=a long sentence never ends, one ends by a clock inside a word, or a decimal or a title ends a line; no_claim=routes that end lines themselves, Gladia's 15 seconds among them.
  test("ends at a clause mark after 30 seconds, at a word after 45, and a full stop ends it only whole", () => {
    expect(endsAfter("We talked about the plan,", 29_000, true)).toBe(false);
    expect(endsAfter("We talked about the plan,", 31_000, true)).toBe(true);
    expect(endsAfter("我们讨论了计划，", 31_000, false)).toBe(true);
    expect(endsAfter("这是第一句。", 2000, false)).toBe(true);
    expect(endsAfter("Is it ready?", 2000, false)).toBe(true);
    expect(endsAfter("Version 3.", 2000, false)).toBe(false);
    expect(endsAfter("Version 3.", 2000, true)).toBe(true);
    expect(endsAfter("Ask Dr.", 2000, true)).toBe(false);
    expect(endsAfter('He said "go."', 2000, true)).toBe(true);
    expect(endsBefore(44_000, true)).toBe(false);
    expect(endsBefore(46_000, false)).toBe(false);
    expect(endsBefore(46_000, true)).toBe(true);
    expect(startsWord("We talk", " about")).toBe(true);
    expect(startsWord("We talk", "ed")).toBe(false);
    expect(startsWord("我们讨", "论")).toBe(true);
  });

  // protects=Soniox's subword pieces: "3" "." "5" stay one line, and a full stop followed by a new word ends one; fails_when=a decimal splits a line; no_claim=the other routes, which give whole words.
  test("Soniox keeps a decimal in one line, and ends one at a full stop before a new word", () => {
    const heardBy = heard();
    const socket = service();
    createSonioxStream({
      stream: "m:system",
      model: "stt-rt-v5",
      apiKey: "key",
      connect: socket.connect,
      report: heardBy.report,
    });
    socket.open();
    const pieces = [" It", " grew", " 3", ".", "5", "%.", " Next", " year", " too", "."];
    socket.say({
      tokens: pieces.map((text, index) => ({
        text,
        start_ms: index * 300,
        end_ms: index * 300 + 280,
        is_final: true,
        speaker: "1",
      })),
    });
    socket.say({ tokens: [{ text: "<end>", is_final: true }], finished: true });
    expect(heardBy.finals().map((line) => line.text)).toEqual(["It grew 3.5%.", "Next year too."]);
  });
});
