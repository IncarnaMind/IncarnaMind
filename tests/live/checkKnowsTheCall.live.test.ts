/**
 * The sentence check is told whose call a quote is from (#3005 part 3), on a real model: an earlier
 * call, then a live one on the same day, in one Folder; a Question typed in the live call whose
 * Answer is scripted to a sentence and the line it cites, so only the batch that judges the
 * sentence goes to the model. A sentence about this call (no word of when) cited to a line only
 * the earlier call said must not end with a green check; a sentence that says when, cited to that
 * line, and a sentence about this call cited to this call's line, must keep it. Both arms in one
 * build: `callsUnmarked` is main's, with no mark and the old instructions.
 *
 * INCARNAMIND_LIVE_ANTHROPIC_KEY runs it, on INCARNAMIND_LIVE_ANTHROPIC_MODEL (Claude Haiku 5.5 by
 * default); INCARNAMIND_LIVE_RUNS sets how many times each sentence is asked (2), and
 * INCARNAMIND_LIVE_REPORT keeps the numbers and each miss.
 */
import { appendFile } from "node:fs/promises";
import type { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test, vi } from "vitest";
import type { Core } from "../../src/core";
import { isSentenceBatch } from "../../src/core/answers/checks/sentenceBatch";
import type { Language } from "../../src/core/language";
import type { ChatModelFactory } from "../../src/core/providers/models";
import { checkGenerate, checkReply, isCheckRun } from "../helpers/checks";
import { shownPassages } from "../helpers/citations";
import { createTempDataFolder } from "../helpers/core";
import { heldClock } from "../helpers/heldClock";
import { billedModels } from "../helpers/liveBilling";
import { scriptedModel, unscripted } from "../helpers/models";
import { liveTranscriptRead, transcribingCore, until } from "../helpers/transcription";

const KEY = process.env.INCARNAMIND_LIVE_ANTHROPIC_KEY;
const MODEL = process.env.INCARNAMIND_LIVE_ANTHROPIC_MODEL ?? "claude-haiku-5-5";
const RUNS = Number(process.env.INCARNAMIND_LIVE_RUNS ?? 2);
const REPORT = process.env.INCARNAMIND_LIVE_REPORT;
const { createChatModel, spent } = billedModels(MODEL);
const SECOND = 1000;
const HOUR = 3_600_000;

/** The engine says four lines a side in each call, in turn: the earlier call's are the first four. */
const LINES: Record<Language, { mine: string[]; theirs: string[] }> = {
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
    ],
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
    ],
  },
};

interface Case {
  language: Language;
  /** "negative": about this call, cited to the earlier call's line; "positive": one that must keep its check. */
  kind: "negative" | "positive";
  sentence: string;
  line: string;
}

const CASES: readonly Case[] = [
  {
    language: "en",
    kind: "negative",
    sentence: "They said the data stays in Europe.",
    line: "Understood, your data stays in Europe then.",
  },
  {
    language: "en",
    kind: "negative",
    sentence: "They said they can host the data in Frankfurt.",
    line: "We can host the data in Frankfurt.",
  },
  {
    language: "en",
    kind: "positive",
    sentence: "Last time they said the data stays in Europe.",
    line: "Understood, your data stays in Europe then.",
  },
  {
    language: "en",
    kind: "positive",
    sentence: "In the earlier call they said they can host the data in Frankfurt.",
    line: "We can host the data in Frankfurt.",
  },
  {
    language: "en",
    kind: "positive",
    sentence: "They asked whether the data stays in the country, not all of Europe.",
    line: "So your data stays in the country, not all of Europe?",
  },
  {
    language: "en",
    kind: "positive",
    sentence: "They asked where the data has to stay now.",
    line: "Where does your data have to stay now?",
  },
  {
    language: "zh-CN",
    kind: "negative",
    sentence: "对方说数据就留在欧洲。",
    line: "明白，数据就留在欧洲。",
  },
  {
    language: "zh-CN",
    kind: "negative",
    sentence: "对方说可以把数据放在法兰克福。",
    line: "我们可以把数据放在法兰克福。",
  },
  {
    language: "zh-CN",
    kind: "positive",
    sentence: "上次对方说数据就留在欧洲。",
    line: "明白，数据就留在欧洲。",
  },
  {
    language: "zh-CN",
    kind: "positive",
    sentence: "在上一场会议里对方说可以把数据放在法兰克福。",
    line: "我们可以把数据放在法兰克福。",
  },
  {
    language: "zh-CN",
    kind: "positive",
    sentence: "对方问数据是不是留在国内，而不是整个欧洲。",
    line: "所以数据留在国内，不是整个欧洲？",
  },
  {
    language: "zh-CN",
    kind: "positive",
    sentence: "对方问数据现在必须放在哪里。",
    line: "你们的数据现在必须放在哪里？",
  },
];

const LOOK_ASKS = new Set(["find-claims", "nearest", "evidence", "covered-evidence", "restate"]);
const tagOf = (index: number) => `(case ${index + 1})`;

/** The Answer, scripted to its case's sentence and the line it cites; every other request is a check that finds nothing. */
function answering(language: Language) {
  const mine = CASES.map((each, index) => ({ each, index })).filter(
    ({ each }) => each.language === language,
  );
  return scriptedModel(
    (call) => {
      if (isCheckRun(call)) return checkReply(call, {});
      const picked = mine.find(({ index }) => call.prompt.includes(tagOf(index)));
      if (!picked) return { text: "★ Nothing.\n→ keeps it moving" };
      if (call.results.some((result) => result.tool === "cite")) {
        return { text: `★ ${picked.each.sentence} [^1]\n→ keeps it moving` };
      }
      const shown = [call.prompt, ...call.results.map((result) => result.text)].join("\n\n");
      const passage = shownPassages(shown).find((each) => each.text.includes(picked.each.line));
      if (passage) {
        return {
          calls: [
            {
              tool: "cite",
              input: { citations: [{ marker: 1, passage: passage.id, quote: picked.each.line }] },
            },
          ],
        };
      }
      if (
        call.tools.includes("search_documents") &&
        !call.results.some((result) => result.tool === "search_documents")
      ) {
        return { calls: [{ tool: "search_documents", input: { query: picked.each.line } }] };
      }
      return { text: `★ ${picked.each.sentence}\n→ keeps it moving` };
    },
    {
      generate: (call) => {
        if (call.question === undefined) return { error: { status: 500, message: "Not here." } };
        if (call.question === "claimed-changes") return { text: '{"claims":[]}' };
        if (call.question === "request-done") {
          return { text: '{"asks_change":"no","request":"none"}' };
        }
        if (LOOK_ASKS.has(call.question)) return checkGenerate({})(call);
        return unscripted(call.question, call.system);
      },
    },
  );
}

/** Whether an Answer ended or failed: its sentences' judgement is waited for apart (`judgedAnswer`). */
const answerFinished = (core: Core, answerId: string) =>
  new Promise<"finished" | "failed">((resolve) => {
    const stops = [
      core.on("answer.finished", (payload) => {
        if (payload.answerId !== answerId) return;
        for (const stop of stops) stop();
        resolve("finished");
      }),
      core.on("answer.failed", (payload) => {
        if (payload.answerId !== answerId) return;
        for (const stop of stops) stop();
        resolve("failed");
      }),
    ];
  });

/** The Answer once none of its Citations waits as checking: the look in its scope runs on the real model, a minute or more. */
const judgedAnswer = (core: Core, conversationId: string, answerId: string) =>
  vi.waitFor(
    async () => {
      const { messages } = await core.getConversation(conversationId);
      const answer = messages.find((message) => message.id === answerId);
      if (answer?.kind !== "answer") throw new Error("No Answer.");
      if (answer.citations.some((citation) => citation.check === "checking")) {
        throw new Error("Its sentences are still being judged.");
      }
      return answer;
    },
    { timeout: 240_000, interval: 500 },
  );

const systemOf = (options: unknown): string => {
  const prompt = (options as { prompt?: { role?: string; content?: unknown }[] }).prompt ?? [];
  const system = prompt.find((message) => message.role === "system")?.content;
  return typeof system === "string" ? system : "";
};

/** A request the real model gets: the batch that judges the Answer's sentences, and the look in its scope that checks one the batch read Unsupported. */
const realRequest = (system: string) =>
  isSentenceBatch(system) ||
  system.startsWith("You check one sentence") ||
  system.startsWith("Compare a sentence the User wrote");

/** `scripted` for everything but those, which `real` gets; each batch's reply lands in `heard`. */
function judgedByReal(
  scripted: MockLanguageModelV4,
  real: ChatModelFactory,
  heard: string[],
): ChatModelFactory {
  return (spec) => {
    const judge = real(spec);
    return new Proxy(scripted, {
      get(target, property, receiver) {
        if (property === "doGenerate" || property === "doStream")
          return (options: unknown) => {
            const model = realRequest(systemOf(options)) ? judge : target;
            const method = Reflect.get(model, property) as (options: unknown) => Promise<unknown>;
            if (model !== judge) return method.call(model, options);
            return method.call(model, options).then((result) => {
              const content = (result as { content?: { type: string; text?: string }[] }).content;
              heard.push(content?.map((part) => part.text ?? "").join("") ?? "");
              return result;
            });
          };
        return Reflect.get(target, property, receiver);
      },
    });
  };
}

describe(`${MODEL}, live: the sentence check knows whose call a quote is from`, () => {
  test.skipIf(KEY === undefined)(
    "a sentence about this call gets no green check from the earlier call's line, and one that says when does",
    { timeout: 3_000_000 },
    async () => {
      const report: string[] = [`## ${MODEL} (#3005 part 3)`];
      const misses: string[] = [];
      const total = { negatives: 0, negativeChecks: 0, positives: 0, positiveChecks: 0 };
      for (const arm of ["main", "marked"] as const) {
        const counts = { negatives: 0, negativeChecks: 0, positives: 0, positiveChecks: 0 };
        for (const language of ["en", "zh-CN"] as const) {
          const heard: string[] = [];
          const dataDir = await createTempDataFolder();
          const pace = heldClock();
          const { core, record, clock } = await transcribingCore(dataDir, {
            createChatModel: judgedByReal(answering(language), createChatModel, heard),
            engine: { lines: LINES[language].mine, theirLines: LINES[language].theirs },
            callsUnmarked: () => arm === "main",
            paceTimers: pace.timers,
          });
          core.on(
            "consent.requested",
            (asked) => void core.respondToConsent(asked.requestId, true),
          );
          await core.saveChatProvider({ kind: "anthropic", apiKey: KEY ?? "", modelId: MODEL });
          await core.updateSettings({ user: { language } });
          const folder = await core.createLibraryGroup({
            name: "Tallowmere Freight",
            description: "",
          });
          const callIn = async () => {
            const meeting = await core.createMeeting({ folderId: folder.id });
            await core.startMeeting({ meetingId: meeting.id, systemAudio: true });
            await until(core, meeting.id, (transcript) => transcript.state === "live");
            record(9 * SECOND);
            const heard = await until(core, meeting.id, (transcript) => transcript.lines >= 8);
            return { meeting, heard };
          };
          const earlier = await callIn();
          await core.stopMeeting(earlier.meeting.id);
          await until(core, earlier.meeting.id, (transcript) => transcript.state === "saved");
          clock.advance(3 * HOUR);
          const { meeting: live, heard: hearing } = await callIn();
          await liveTranscriptRead(core, dataDir, live.id, hearing.documentId ?? "", pace);
          for (const [index, each] of CASES.entries()) {
            if (each.language !== language) continue;
            for (let run = 1; run <= RUNS; run++) {
              if (spent() > 0.6) throw new Error(`Spent $${spent().toFixed(2)}, past the cap.`);
              const asked = await core.askInConversation({
                mindId: live.mindId,
                text: `${language === "en" ? "What did they say?" : "他们说了什么？"} ${tagOf(index)}`,
              });
              if (!asked.asked) throw new Error("Not asked.");
              if ((await answerFinished(core, asked.answerId)) !== "finished") {
                throw new Error("The Answer failed.");
              }
              const answer = await judgedAnswer(core, asked.conversation.id, asked.answerId);
              const citation = answer.citations.find((each) => each.marker === 1);
              const checked = citation?.check === "found";
              if (each.kind === "negative") {
                counts.negatives++;
                if (checked) {
                  counts.negativeChecks++;
                  misses.push(
                    `- ${arm} green check on a sentence about this call: ${each.sentence} ← ${each.line}`,
                  );
                }
              } else {
                counts.positives++;
                if (checked) counts.positiveChecks++;
                else
                  misses.push(
                    `- ${arm} lost a check: ${each.sentence} ← ${each.line} (${citation?.check ?? "no citation"})`,
                  );
              }
            }
          }
          core.close();
        }
        report.push(
          `  ${arm}: sentences about this call cited to the earlier call's line: green check ${counts.negativeChecks}/${counts.negatives}; sentences that must keep it: ${counts.positiveChecks}/${counts.positives}`,
        );
        for (const key of Object.keys(total) as (keyof typeof total)[]) total[key] += counts[key];
      }
      report.push(`  spent US$${spent().toFixed(4)}`, ...misses);
      if (REPORT) await appendFile(REPORT, `${report.join("\n")}\n\n`);
      expect(report.length).toBeGreaterThan(1);
    },
  );
});
