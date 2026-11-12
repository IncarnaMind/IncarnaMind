/**
 * When a Transcript's words were said (#138): kept in its file as WebVTT cue timestamps, for
 * playing its audio from a word, and read by nothing else. A Transcript with them reads, searches,
 * cites, checks and exports exactly as one without them, in English and Chinese.
 */
import { readFileSync } from "node:fs";
import type { JSONContent } from "@tiptap/core";
import { describe, expect, test } from "vitest";
import type { Core } from "../../src/core";
import { readVtt, timestamp, writeVtt } from "../../src/core/documents/formats/vtt";
import type { PrintDocument } from "../../src/shared/printDocument";
import { timeAt } from "../../src/shared/wordTimes";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, createSourceFolder, writeSourceFile } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { writeMind } from "../helpers/minds";
import { fakePrinter } from "../helpers/printer";
import { transcribingCore, until } from "../helpers/transcription";

const SONIOX_KEY = "soniox-test-key-0123456789";

/** The same call, in English or Chinese, with or without its words' times. */
function callFile(language: "en" | "zh", timed: boolean): string {
  const lines =
    language === "en"
      ? [
          [
            "00:00:01.000",
            "00:00:04.000",
            "Dana",
            ["The ", "budget ", "holds ", "at ", "one ", "point ", "two."],
          ],
          [
            "00:00:05.000",
            "00:00:08.500",
            "Sam",
            ["Partner ", "preview ", "stays ", "on ", "the ", "twenty-eighth."],
          ],
        ]
      : [
          ["00:00:01.000", "00:00:04.000", "王丽", ["预算", "维持在", "一百二十万。"]],
          ["00:00:05.000", "00:00:08.500", "李明", ["合作伙伴", "预览", "仍在", "二十八日。"]],
        ];
  const cues = lines.map(([from, to, speaker, words]) => {
    const start = Number((from as string).slice(6, 8)) * 1000;
    const text = (words as string[])
      .map((word, index) => (timed ? `<${timestamp(start + index * 400)}>${word}` : word))
      .join("");
    return `${from} --> ${to}\n<v ${speaker}>${text}</v>`;
  });
  return `WEBVTT\n\n${cues.join("\n\n")}\n`;
}

const textOf = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const noTags = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
const TIMESTAMP = /\d{2}:\d{2}\.\d{3}|&lt;\d|<\d/;

/** All a User or a model gets of a Transcript: its text, Units, search hits, a check and exports. */
async function whatIsShown(
  core: Core,
  printed: readonly PrintDocument[],
  language: "en" | "zh",
  timed: boolean,
) {
  const sources = await createSourceFolder();
  const name = language === "en" ? "Steering call.vtt" : "指导委员会.vtt";
  const [document] = await addAndProcess(core, [
    await writeSourceFile(sources, name, callFile(language, timed)),
  ]);
  if (!document) throw new Error("The Transcript wasn't added.");
  const query = language === "en" ? "preview stays" : "合作伙伴预览";
  const quote =
    language === "en" ? "preview stays on the twenty-eighth" : "合作伙伴预览仍在二十八日";
  const { pages } = await core.readDocumentText(document.id);
  const passages = await core.searchPassages(query, {
    mode: "keyword",
    documentIds: [document.id],
  });
  const matches = (await core.searchDocumentText(query)).filter(
    (match) => match.documentId === document.id,
  );
  const mind = await core.createMind({ title: language === "en" ? "Launch" : "发布" });
  const checked = await core.recheckCitation({
    mindId: mind.id,
    documentId: document.id,
    pageFrom: pages[0]?.page ?? null,
    pageTo: pages[0]?.page ?? null,
    quote,
    location: { kind: "time", from: 5000, to: 8500, speaker: language === "en" ? "Sam" : "李明" },
  });
  if ("keptInside" in checked) throw new Error("The check was kept inside a wall.");
  const citation: JSONContent = {
    type: "citation",
    attrs: {
      passageId: checked.passageId,
      documentId: document.id,
      documentName: document.name,
      contentHash: checked.contentHash,
      pageFrom: checked.pageFrom,
      pageTo: checked.pageTo,
      location: checked.location,
      quote,
      check: checked.check,
    },
  };
  const client = await connectToMind(core, mind.id);
  writeMind(client, [
    { type: "paragraph", content: [{ type: "text", text: "Preview " }, citation] },
  ]);
  await client.settled();
  await core.closeMind(mind.id);
  const markdown = textOf((await core.exportMind(mind.id, { format: "markdown" })).data);
  const html = noTags(textOf((await core.exportMind(mind.id, { format: "html" })).data));
  // A Word file, read back as the Library reads it, and the page a PDF is printed from.
  const exported = await createSourceFolder();
  const [wordFile] = await addAndProcess(core, [
    await writeSourceFile(
      exported,
      `${timed ? "timed" : "plain"}.docx`,
      (await core.exportMind(mind.id, { format: "docx" })).data,
    ),
  ]);
  const word = (await core.readDocumentText(wordFile?.id ?? "")).pages
    .map((page) => page.text)
    .join("\n");
  await core.exportMind(mind.id, { format: "pdf" });
  const page = printed.at(-1);
  const pdf = page ? noTags([page.body, ...page.notes].join(" ")) : "";
  return {
    pages: pages.map(({ page, text, label }) => ({ page, text, label })),
    passages: passages.map(({ text, pageFrom, pageTo, position }) => ({
      text,
      pageFrom,
      pageTo,
      position,
    })),
    matches: matches.map(({ excerpt, highlights, atMs }) => ({ excerpt, highlights, atMs })),
    check: {
      check: checked.check,
      location: checked.location,
      pageFrom: checked.pageFrom,
      pageTo: checked.pageTo,
    },
    markdown,
    html: html.slice(html.indexOf("Preview")),
    word,
    pdf,
  };
}

describe("Word times in a Transcript (#138)", { timeout: 120_000 }, () => {
  // protects=a cloud service's word times reach the saved Transcript's file as cue timestamps, each word playing from its own time, and the local engine's lines, with none, fall back to an estimate within their line; fails_when=the saved file loses the times, a word's time is off by a second or more, or a line without times plays from outside itself; no_claim=how close the estimate is on real speech, which the pull request measures.
  test("a cloud Transcript keeps each word's time, and a local one plays its words by estimate", async () => {
    const { core, record } = await transcribingCore(await createTempDataFolder());
    await core.setTranscriptionKey({ route: "soniox", apiKey: SONIOX_KEY });
    await core.updateSettings({ device: { transcriptionRoute: "soniox" } });
    const meeting = await core.createMeeting();
    await core.startMeeting({ meetingId: meeting.id });
    await until(core, meeting.id, (transcript) => transcript.cloud === "soniox");
    record(9000);
    await until(core, meeting.id, (transcript) => transcript.lines >= 4);
    await core.stopMeeting(meeting.id);
    const saved = await until(core, meeting.id, (transcript) => transcript.state === "saved");
    const file = readFileSync(saved.savedPath as string, "utf8");
    expect(file).toMatch(/<00:00:\d{2}\.\d{3}>/);
    const { cues } = readVtt(file);
    expect(cues.length).toBeGreaterThanOrEqual(4);
    for (const cue of cues) {
      const words = cue.text.split(" ");
      expect(cue.words).toHaveLength(words.length);
      let at = 0;
      words.forEach((word, index) => {
        const said = cue.startMs + ((cue.endMs - cue.startMs) * index) / words.length;
        expect(Math.abs(timeAt(cue, at) - said)).toBeLessThan(1000);
        at += word.length + 1;
      });
    }
    core.close();

    const local = await transcribingCore(await createTempDataFolder());
    const call = await local.core.createMeeting();
    await local.core.startMeeting({ meetingId: call.id });
    local.record(9000);
    await until(local.core, call.id, (transcript) => transcript.lines >= 4);
    await local.core.stopMeeting(call.id);
    const kept = await until(local.core, call.id, (transcript) => transcript.state === "saved");
    const localCues = readVtt(readFileSync(kept.savedPath as string, "utf8")).cues;
    expect(localCues.length).toBeGreaterThan(0);
    for (const cue of localCues) {
      expect(cue.words).toBeUndefined();
      const middle = timeAt(cue, Math.floor(cue.text.length / 2));
      expect(middle).toBeGreaterThan(cue.startMs);
      expect(middle).toBeLessThan(cue.endMs);
    }
    local.core.close();
  });

  // protects=a Transcript with word times reads back the same, its times where they were, and one written without them has none; fails_when=the times move, are lost or are written as text; no_claim=the files a service writes, which the test above covers.
  test("word times read back where they were, and a line without them is written without", () => {
    for (const language of ["en", "zh"] as const) {
      const timed = readVtt(callFile(language, true));
      expect(readVtt(writeVtt(timed))).toEqual(timed);
      expect(timed.cues.every((cue) => (cue.words?.length ?? 0) > 1)).toBe(true);
      const plain = readVtt(callFile(language, false));
      expect(writeVtt(plain)).not.toMatch(/<\d/);
      expect(plain.cues.map((cue) => cue.text)).toEqual(timed.cues.map((cue) => cue.text));
    }
  });

  // protects=word times are never text: a Transcript with them shows, searches, cites, checks and exports (Markdown, HTML, Word, PDF) exactly as one without them, in English and Chinese; fails_when=a timestamp reaches the text, a Unit, a search hit, a check or an export, or anything differs between the two; no_claim=the window's copy, which the window spec covers.
  test.each(["en", "zh"] as const)(
    "a Transcript with word times reads exactly as one without them (%s)",
    async (language) => {
      const timedPrinter = fakePrinter();
      const plainPrinter = fakePrinter();
      const timedCore = startCore(await createTempDataFolder(), {
        printer: timedPrinter.printer,
      });
      const plainCore = startCore(await createTempDataFolder(), {
        printer: plainPrinter.printer,
      });
      const timed = await whatIsShown(timedCore, timedPrinter.printed, language, true);
      const plain = await whatIsShown(plainCore, plainPrinter.printed, language, false);
      expect(timed.pages.length).toBeGreaterThan(0);
      expect(timed.passages.length).toBeGreaterThan(0);
      expect(timed.matches.length).toBeGreaterThan(0);
      expect(timed.check.check).toBe("found");
      const cited = language === "en" ? "Sam · 0:05" : "李明 · 0:05";
      expect(timed.word).toContain(cited);
      expect(timed.pdf).toContain(cited);
      expect(timed.markdown).toContain(cited);
      for (const shown of Object.values(timed))
        expect(JSON.stringify(shown)).not.toMatch(TIMESTAMP);
      expect(timed).toEqual(plain);
      timedCore.close();
      plainCore.close();
    },
  );
});

/**
 * The saved cues of a call on Soniox whose pretend service hears `line` each time, a token a word
 * timed evenly over the line, with `told` in Words to know. Each cue is given as its text and its
 * placed words: where each is in the text, and which of the line's tokens its time is, from 0.
 */
async function placedIn(line: string, told: string[]) {
  const { core, record } = await transcribingCore(await createTempDataFolder(), {
    engine: { cloud: { lines: [line] } },
  });
  await core.updateSettings({ user: { meetingWords: told } });
  await core.setTranscriptionKey({ route: "soniox", apiKey: SONIOX_KEY });
  await core.updateSettings({ device: { transcriptionRoute: "soniox" } });
  const meeting = await core.createMeeting();
  await core.startMeeting({ meetingId: meeting.id, systemAudio: false });
  await until(core, meeting.id, (transcript) => transcript.cloud === "soniox");
  record(5000, ["microphone"]);
  await until(core, meeting.id, (transcript) => transcript.lines >= 2);
  await core.stopMeeting(meeting.id);
  const saved = await until(core, meeting.id, (transcript) => transcript.state === "saved");
  const { cues } = readVtt(readFileSync(saved.savedPath as string, "utf8"));
  core.close();
  const tokens = line.split(" ").length;
  return cues.map((cue) => ({
    text: cue.text,
    words: (cue.words ?? []).map(({ at, ms }) => [
      at,
      Math.round(((ms - cue.startMs) / (cue.endMs - cue.startMs)) * tokens),
    ]),
  }));
}

/**
 * Lines whose told name the engine spells another way, each with where its words are placed and
 * the token each has the time of, with the name told and, its twin, with nothing told.
 */
const RESPELLED = [
  {
    form: "a later word holds the heard spelling (Market)",
    told: "Marc",
    heard: "We asked Mark about the Market.",
    written: "We asked Marc about the Market.",
    places: [
      [0, 0],
      [3, 1],
      [9, 2],
      [14, 3],
      [20, 4],
      [24, 5],
    ],
    untold: [
      [0, 0],
      [3, 1],
      [9, 2],
      [14, 3],
      [20, 4],
      [24, 5],
    ],
  },
  {
    form: "the heard spelling is a common word later in the line (mark)",
    told: "Marc",
    heard: "We asked Mark to mark the page.",
    written: "We asked Marc to mark the page.",
    places: [
      [0, 0],
      [3, 1],
      [9, 2],
      [14, 3],
      [17, 4],
      [22, 5],
      [26, 6],
    ],
    untold: [
      [0, 0],
      [3, 1],
      [9, 2],
      [14, 3],
      [17, 4],
      [22, 5],
      [26, 6],
    ],
  },
  {
    form: "the name is heard again after a colon, where it stays as heard",
    told: "Catherine",
    heard: "We asked Katherine about it: Katherine agreed.",
    written: "We asked Catherine about it: Katherine agreed.",
    places: [
      [0, 0],
      [3, 1],
      [9, 2],
      [19, 3],
      [25, 4],
      [29, 5],
      [39, 6],
    ],
    untold: [
      [0, 0],
      [3, 1],
      [9, 2],
      [19, 3],
      [25, 4],
      [29, 5],
      [39, 6],
    ],
  },
  {
    form: "the name is heard as two words and written as one: it takes the first one's time, and the second's is left out",
    told: "Lindqvist",
    heard: "We asked Lind Qvist about it.",
    written: "We asked Lindqvist about it.",
    places: [
      [0, 0],
      [3, 1],
      [9, 2],
      [19, 4],
      [25, 5],
    ],
    untold: [
      [0, 0],
      [3, 1],
      [9, 2],
      [14, 3],
      [20, 4],
      [26, 5],
    ],
  },
  {
    form: "the name is heard as one word and written as two: it takes that word's time",
    told: "De Shawn",
    heard: "We asked DeShawn about it.",
    written: "We asked De Shawn about it.",
    places: [
      [0, 0],
      [3, 1],
      [9, 2],
      [18, 3],
      [24, 4],
    ],
    untold: [
      [0, 0],
      [3, 1],
      [9, 2],
      [17, 3],
      [23, 4],
    ],
  },
];

describe("A name written the Meeting's way keeps each word's time (#1031)", {
  timeout: 60_000,
}, () => {
  // protects=where a line writes a told name for the words heard, every word plays from its own time: the name from the time of the first word heard for it, and each word after it from its own, also when the heard spelling stands again later in the line (inside a longer word, as a common word, or as the name once more) and when the name has more or fewer words than were heard; and with nothing told the same line keeps the engine's spelling and every word's time; fails_when=the heard word's time lands on a later word, the words between lose their times, or an unchanged line loses a time; no_claim=a service that times parts of words, or two sentences in one line, which a route that gives words never writes (a line ends at each sentence's end): tests/core/toldSpelling.test.ts holds both.
  test.each(RESPELLED)("$form", async ({ told, heard, written, places, untold }) => {
    const cues = await placedIn(heard, [told]);
    expect(cues.length).toBeGreaterThanOrEqual(2);
    for (const cue of cues) expect(cue).toEqual({ text: written, words: places });

    const asHeard = await placedIn(heard, []);
    expect(asHeard.length).toBeGreaterThanOrEqual(2);
    for (const cue of asHeard) expect(cue).toEqual({ text: heard, words: untold });
  });
});
