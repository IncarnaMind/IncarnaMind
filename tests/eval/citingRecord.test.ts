/**
 * The citing record (#3059) through the core, as the everyday evaluation's harness asks: the
 * scripted model writes an Answer four ways, and the record keeps the five things a replay of its
 * citing step needs; the count reads them back from a run file, held-out folders unread. A press
 * for call help, watched the same way, gives a whole record too.
 */
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { ask, judgedAnswer } from "../../eval/everyday/asking";
import { citedAnswers, countCiting, runFiles } from "../../eval/lib/citingCount";
import { type CitingRecord, citingRecord, watchCiting } from "../../eval/lib/citingRecord";
import type { Core } from "../../src/core";
import type { Language } from "../../src/core/language";
import { answerEnded, setUpWithDocuments, shownPassages } from "../helpers/citations";
import { createTempDataFolder } from "../helpers/core";
import {
  type ModelCall,
  type ScriptedReply,
  scriptedModel,
  scriptedModels,
} from "../helpers/models";
import { transcribingCore, until } from "../helpers/transcription";

const SECOND = 1000;

const TERMS: Record<Language, { name: string; first: string; second: string; loose: string }> = {
  en: {
    name: "Hosting terms.md",
    first: "The pilot's data is kept in our Frankfurt data centre for twelve months.",
    second: "Backups of the pilot's data run every night in the same building.",
    loose: "Hosting stays inside the European Union for the whole pilot",
  },
  "zh-CN": {
    name: "托管条款.md",
    first: "试点的数据在我们法兰克福的数据中心保存十二个月。",
    second: "试点数据的备份每晚在同一栋楼里进行。",
    loose: "整个试点期间托管都留在欧盟境内",
  },
};

const withoutStop = (line: string) => line.replace(/[.。]$/, "");
const stop = (language: Language) => (language === "en" ? "." : "。");

type Way = "app" | "asked-given" | "asked-none" | "model";

/**
 * A model that searches once, then answers one way:
 * - "app": its Document's first line with a marker it gives no record for, then the second line
 *   with none, both of which the app matches by itself;
 * - "asked-given", "asked-none": a sentence the app can't match, with a marker and no record, so
 *   the one request for Citations goes out: it gives the first line, or nothing;
 * - "model": the first line, with its own record for its marker.
 */
function answering(way: Way, language: Language) {
  const terms = TERMS[language];
  const end = stop(language);
  const passageOf = (call: ModelCall) =>
    shownPassages(call.results.map((result) => result.text).join("\n"))[0]?.id ?? "P1";
  return scriptedModel(
    (call: ModelCall): ScriptedReply => {
      if (call.question === "unmarked-quotes") {
        const [id] = [...call.prompt.matchAll(/<passage id="([^"]+)"/g)].map((match) => match[1]);
        const given =
          way === "asked-given"
            ? [{ sentence: `${terms.loose}${end}`, passage: id ?? "P1", quote: terms.first }]
            : [];
        return { text: JSON.stringify({ citations: given }) };
      }
      const searched = call.results.some((result) => result.tool === "search_documents");
      if (!searched) {
        return {
          calls: [{ tool: "search_documents", input: { query: "where the data is kept" } }],
        };
      }
      const cited = call.results.some((result) => result.tool === "cite");
      if (way === "model" && !cited) {
        return {
          calls: [
            {
              tool: "cite",
              input: { citations: [{ marker: 1, passage: passageOf(call), quote: terms.first }] },
            },
          ],
        };
      }
      if (way === "app") {
        return {
          text: `${withoutStop(terms.first)} [^1]${end} ${terms.second}`,
        };
      }
      if (way === "model") return { text: `${withoutStop(terms.first)} [^1]${end}` };
      return { text: `${terms.loose} [^1]${end}` };
    },
    { judgesItsAnswers: true },
  );
}

async function recorded(way: Way, language: Language): Promise<CitingRecord> {
  const terms = TERMS[language];
  const watch = watchCiting();
  const model = answering(way, language);
  const { core } = await setUpWithDocuments(
    model,
    [
      {
        name: terms.name,
        contents: `# ${withoutStop(terms.name)}\n\n${terms.first}\n\n${terms.second}\n`,
      },
    ],
    { createChatModel: watch.chatModels(scriptedModels(model).createChatModel) },
  );
  watch.begin();
  const answer = await ask(core, {
    text: language === "en" ? "Where is the pilot's data kept?" : "试点的数据保存在哪里？",
    mindId: null,
    conversationId: null,
    focus: null,
  });
  return citingRecord(watch.end(), await judgedAnswer(core, answer));
}

const LANGUAGES: Language[] = ["en", "zh-CN"];

describe.each(LANGUAGES)("%s: the citing record of an Answer", (language) => {
  const terms = TERMS[language];

  // protects=an Answer whose marker has no record and whose sentences match their lines keeps them as the app's own, by kind, with no request; fails_when=the record loses the model's text, the Passages, which marker had no record, or calls them the model's or the request's; no_claim=how well the app matches beyond these lines.
  test("matched by the app: the marked sentence and the unmarked one, no request", {
    timeout: 60_000,
  }, async () => {
    const record = await recorded("app", language);
    expect(record.written).toEqual([
      `${withoutStop(terms.first)} [^1]${stop(language)} ${terms.second}`,
    ]);
    expect(record.passages.map((passage) => passage.text).join("\n")).toContain(terms.first);
    expect(record.records).toEqual([]);
    expect(record.unrecorded).toEqual([1]);
    expect(record.asked).toBeNull();
    expect(
      record.citations.map(({ from, quote, check, judged }) => ({ from, quote, check, judged })),
    ).toEqual([
      { from: "app-marked", quote: terms.first, check: "found", judged: true },
      { from: "app-unmarked", quote: terms.second, check: "found", judged: true },
    ]);
  });

  test("asked once more, and a Citation came of it", { timeout: 60_000 }, async () => {
    const record = await recorded("asked-given", language);
    expect(record.unrecorded).toEqual([1]);
    expect(record.asked?.given).toEqual([expect.objectContaining({ quote: terms.first })]);
    expect(record.citations.map(({ marker, from, quote }) => ({ marker, from, quote }))).toEqual([
      { marker: 1, from: "request", quote: terms.first },
    ]);
  });

  test("asked once more, and nothing came of it", { timeout: 60_000 }, async () => {
    const record = await recorded("asked-none", language);
    expect(record.written).toEqual([`${terms.loose} [^1]${stop(language)}`]);
    expect(record.unrecorded).toEqual([1]);
    expect(record.asked).toEqual({ given: [] });
    expect(record.citations).toEqual([]);
  });

  test("the model's own record", { timeout: 60_000 }, async () => {
    const record = await recorded("model", language);
    expect(record.records).toEqual([
      { marker: 1, passage: expect.any(String), quote: terms.first },
    ]);
    expect(record.passages.map((passage) => passage.id)).toContain(record.records[0]?.passage);
    expect(record.unrecorded).toEqual([]);
    expect(record.asked).toBeNull();
    expect(record.citations.map(({ marker, from, check }) => ({ marker, from, check }))).toEqual([
      { marker: 1, from: "model", check: "found" },
    ]);
  });
});

describe("The count over run files", () => {
  // protects=the count reads citing records wherever a run file keeps them, by model and language, and never a held-out set's or a gate's folder; fails_when=one of those is counted, or an Answer lands in the wrong row; no_claim=real models' numbers.
  test("four Answers a language, counted by how their Citations came; held-out and gate folders unread", {
    timeout: 240_000,
  }, async () => {
    const results: { model: string; language: Language; citing: CitingRecord }[] = [];
    for (const language of LANGUAGES) {
      for (const way of ["app", "asked-given", "asked-none", "model"] as const) {
        results.push({
          model: "ollama/local-model",
          language,
          citing: await recorded(way, language),
        });
      }
    }
    const runs = await createTempDataFolder();
    mkdirSync(join(runs, "2026-11-13-everyday"));
    writeFileSync(
      join(runs, "2026-11-13-everyday", "report.json"),
      JSON.stringify({ rows: [], results }),
    );
    for (const closed of ["a-held-out-set", "a-gate-run"]) {
      cpSync(join(runs, "2026-11-13-everyday"), join(runs, closed), { recursive: true });
    }

    const files = runFiles([runs]);
    expect(files).toEqual([join(runs, "2026-11-13-everyday", "report.json")]);
    const counts = countCiting(
      files.flatMap((file) => citedAnswers(JSON.parse(readFileSync(file, "utf8")))),
    );
    const each = {
      answers: 4,
      unrecorded: 3,
      matchedByApp: 1,
      asked: 2,
      askedGiven: 1,
      askedNone: 1,
      askedWithoutMarker: 0,
      origins: {
        model: { citations: 1, judged: 1, passed: 1 },
        request: { citations: 1, judged: 1, passed: 1 },
        "app-marked": { citations: 1, judged: 1, passed: 1 },
        "app-unmarked": { citations: 1, judged: 1, passed: 1 },
        figure: { citations: 0, judged: 0, passed: 0 },
      },
    };
    expect(counts).toEqual([
      { model: "ollama/local-model", language: "en", ...each },
      { model: "ollama/local-model", language: "zh-CN", ...each },
    ]);
  });
});

describe("A press for call help, watched as the everyday harness watches an Answer", () => {
  // protects=what call help's harness holds for a press, with the watcher on its chat models and around the press, gives a whole citing record; fails_when=a press's requests aren't heard, or its Citation loses where it came from or its check; no_claim=the call-help harness's own wiring, which another change adds.
  test("its record holds the reply as written, the call's Passages, the record and the Citation's verdict", {
    timeout: 120_000,
  }, async () => {
    const line = "Your data stays in our Frankfurt data centre.";
    const watch = watchCiting();
    const model = scriptedModel(
      (call: ModelCall): ScriptedReply => {
        if (call.results.some((result) => result.tool === "cite")) {
          return { text: `★ ${withoutStop(line)} [^1]\n→ keeps it moving` };
        }
        const shown = shownPassages(call.prompt);
        const passage = shown.find((each) => each.text.includes("Frankfurt"));
        return passage
          ? {
              calls: [
                {
                  tool: "cite",
                  input: { citations: [{ marker: 1, passage: passage.id, quote: line }] },
                },
              ],
            }
          : { text: `★ ${withoutStop(line)}\n→ keeps it moving` };
      },
      { judgesItsAnswers: true },
    );
    const dataDir = await createTempDataFolder();
    const { core, record } = await transcribingCore(dataDir, {
      createChatModel: watch.chatModels(scriptedModels(model).createChatModel),
      // Each line said once, so the quote is in one place only.
      engine: {
        lines: Array.from({ length: 8 }, (_, at) => `Question ${at + 1} from our side.`),
        theirLines: [
          line,
          ...Array.from({ length: 7 }, (_, at) => `Answer ${at + 2} from theirs.`),
        ],
      },
    });
    await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
    const meeting = await core.createMeeting({ folderId: null });
    await core.startMeeting({ meetingId: meeting.id, systemAudio: true });
    await until(core, meeting.id, (transcript) => transcript.state === "live");
    record(9 * SECOND);
    await until(core, meeting.id, (transcript) => transcript.lines >= 4);

    watch.begin();
    const pressed = await core.askMeetingHelp({
      meetingId: meeting.id,
      kind: "say",
      conversationId: null,
    });
    if (!pressed.asked) throw new Error("Not pressed.");
    const answer = await answerOfPress(core, pressed.conversation.id, pressed.answerId);
    const citing = citingRecord(watch.end(), await judgedAnswer(core, answer));

    expect(citing.written.join("")).toContain("[^1]");
    expect(citing.passages.some((passage) => passage.text.includes("Frankfurt"))).toBe(true);
    expect(citing.records).toEqual([{ marker: 1, passage: expect.any(String), quote: line }]);
    expect(citing.unrecorded).toEqual([]);
    expect(citing.asked).toBeNull();
    expect(citing.citations).toEqual([
      expect.objectContaining({ marker: 1, from: "model", check: expect.any(String) }),
    ]);
    expect(citing.citations[0]?.check).not.toBe("checking");
  });
});

/** The press's Answer once it has ended, as call help's harness reads it. */
async function answerOfPress(core: Core, conversationId: string, answerId: string) {
  await answerEnded(core, answerId);
  const { messages } = await core.getConversation(conversationId);
  const answer = messages.find((message) => message.id === answerId);
  if (answer?.kind !== "answer") throw new Error("No reply.");
  return answer;
}
