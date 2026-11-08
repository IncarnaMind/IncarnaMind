/**
 * `npm run eval:speed` with INCARNAMIND_EVAL_SPEED_VANISH (gates/call-help-vanish.md, #2767): the
 * call-help set's "What do they want?" and "What to ask next" cases, each pressed that many times
 * on each model, every write of each reply kept, and the panel read at each write as
 * `shownItems` lays it out. With INCARNAMIND_EVAL_SPEED_VANISH_REPLAY naming a kept replies.json,
 * this checkout's panel reads those replies again and no model is asked. Writes
 * eval/results/speed-vanish-<time>/.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "vitest";
import type { ConversationAnswer, Core, MeetingHelpKind } from "../../src/core";
import {
  type ReplyItem,
  type ReplyPiece,
  readHelpReply,
  shownItems,
} from "../../src/renderer/src/helpReply";
import { HELP_SHAPE } from "../../src/shared/meetingHelp";
import { answerEnded } from "../../tests/helpers/citations";
import { commitOf } from "../lib/commit";
import { readConfig } from "../lib/config";
import { createWorkerEmbedder } from "../lib/embedder";
import { createLog } from "../lib/log";
import { createWorkerCrossEncoder } from "../lib/rerank";
import { openCall } from "./callHelp";
import { CALL_HELP_CASES } from "./callHelpCases";
import { env, list, modelsAsked, spentUsd } from "./settings";

const ROOT = resolve(__dirname, "../..");
const ANSWER_TIMEOUT_MS = 3 * 60_000;
const KINDS: readonly MeetingHelpKind[] = ["want", "ask"];

interface Write {
  ms: number;
  status: ConversationAnswer["status"];
  text: string;
  textBehind: boolean;
}

interface Press {
  model: string;
  case: string;
  kind: MeetingHelpKind;
  language: string;
  writes: Write[];
  error: string | null;
}

const pieceText = (pieces: readonly ReplyPiece[]) =>
  pieces.map((piece) => (piece.kind === "text" ? piece.text : "")).join("");

/** Letters and digits only, a marker still being written taken off: a streamed lead is a prefix of its whole. */
const comparable = (text: string) =>
  text.replace(/\[(?:\^|=)?\d*$/, "").replace(/[^\p{L}\p{N}]+/gu, "");

const words = (item: ReplyItem) =>
  comparable([item.lead, ...item.notes, item.effect ?? []].map(pieceText).join(""));

function panel(write: Write, kind: MeetingHelpKind): ReplyItem[] {
  return shownItems(readHelpReply(write.text), {
    shape: HELP_SHAPE[kind],
    leadIn: kind === "leading" || write.textBehind,
    streaming: write.status === "streaming",
  }).filter((item) => words(item) !== "");
}

/** How the panel showed one press, from its first write to its end. */
function readPress(press: Press) {
  const last = press.writes.at(-1);
  const done = last?.status === "done";
  const streamed = press.writes.filter((write) => write.status === "streaming");
  const shownWhileWritten = streamed.map((write) => panel(write, press.kind));
  const showedWords = shownWhileWritten.some((items) => items.length > 0);
  const atEnd = last && done ? panel(last, press.kind) : [];
  const endLeads = atEnd.map((item) => comparable(pieceText(item.lead)));
  const replyLeads = last
    ? readHelpReply(last.text).map((item) => comparable(pieceText(item.lead)))
    : [];
  let lostByPanel = false;
  let takenBackByCore = false;
  let emptiedWhileWritten = false;
  let shownBefore = false;
  for (const items of shownWhileWritten) {
    if (shownBefore && items.length === 0) emptiedWhileWritten = true;
    if (items.length > 0) shownBefore = true;
    if (!done) continue;
    for (const item of items) {
      const lead = comparable(pieceText(item.lead));
      if (lead === "" || endLeads.some((end) => end.startsWith(lead))) continue;
      if (replyLeads.some((end) => end.startsWith(lead))) lostByPanel = true;
      else takenBackByCore = true;
    }
  }
  return {
    done,
    failed: last?.status === "failed" || press.error !== null,
    showedWords,
    emptyAtEnd: done && atEnd.length === 0,
    vanished: done && showedWords && atEnd.length === 0,
    lostByPanel,
    takenBackByCore,
    emptiedWhileWritten,
  };
}

type Read = ReturnType<typeof readPress>;
const COUNTED = [
  ["done", "done"],
  ["failed", "failed"],
  ["showedWords", "words while written"],
  ["vanished", "words, then none at the end"],
  ["emptyAtEnd", "no item at the end"],
  ["lostByPanel", "an item shown, then hidden though the reply has it"],
  ["takenBackByCore", "an item shown, then taken back by the core"],
  ["emptiedWhileWritten", "emptied while written"],
] as const satisfies readonly (readonly [keyof Read, string])[];

function report(presses: readonly Press[], heading: string): string {
  const read = presses.map((press) => ({ press, read: readPress(press) }));
  const cells = [
    ...new Set(presses.map((press) => `${press.model} · ${press.language} · ${press.kind}`)),
  ];
  const rows = cells.map((cell) => {
    const ofCell = read.filter(
      ({ press }) => `${press.model} · ${press.language} · ${press.kind}` === cell,
    );
    return `| ${cell} | ${ofCell.length} | ${COUNTED.map(([key]) => ofCell.filter((each) => each.read[key]).length).join(" | ")} |`;
  });
  const flagged = read.filter(
    ({ read: each }) => each.vanished || each.emptyAtEnd || each.lostByPanel || each.failed,
  );
  return [
    heading,
    "",
    `| Model · language · button | presses | ${COUNTED.map(([, label]) => label).join(" | ")} |`,
    `|---|---|${COUNTED.map(() => "---").join("|")}|`,
    ...rows,
    "",
    "## Replies the panel ended with nothing, or with less, or that failed",
    "",
    ...flagged.flatMap(({ press, read: each }) => [
      `### ${press.model} · ${press.case} (${COUNTED.filter(([key]) => each[key] && key !== "done")
        .map(([, label]) => label)
        .join("; ")})`,
      "",
      "```text",
      press.error ?? press.writes.at(-1)?.text ?? "",
      "```",
      "",
    ]),
  ].join("\n");
}

/** Presses one button and keeps every write of its reply, from the press to its end. */
async function press(
  core: Core,
  meetingId: string,
  kind: MeetingHelpKind,
): Promise<Omit<Press, "model" | "case" | "language">> {
  const writes = new Map<string, Write[]>();
  const start = performance.now();
  const keep = (message: ConversationAnswer) => {
    const ofAnswer = writes.get(message.id) ?? [];
    const write = {
      ms: Math.round(performance.now() - start),
      status: message.status,
      text: message.text,
      textBehind: message.steps?.textBehind === true,
    };
    const before = ofAnswer.at(-1);
    if (
      before?.status !== write.status ||
      before.text !== write.text ||
      before.textBehind !== write.textBehind
    )
      ofAnswer.push(write);
    writes.set(message.id, ofAnswer);
  };
  const stop = core.on("conversation.message", (message) => {
    if (message.kind === "answer") keep(message);
  });
  try {
    const asked = await core.askMeetingHelp({ meetingId, kind });
    if (!asked.asked) return { kind, writes: [], error: `Not asked: ${JSON.stringify(asked)}` };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<"late">((resolve) => {
      timer = setTimeout(() => resolve("late"), ANSWER_TIMEOUT_MS);
    });
    const end = await Promise.race([answerEnded(core, asked.answerId), late]).finally(() =>
      clearTimeout(timer),
    );
    if (end === "late") {
      await core.stopConversationAnswer({
        conversationId: asked.conversation.id,
        answerId: asked.answerId,
      });
      return { kind, writes: writes.get(asked.answerId) ?? [], error: "The reply took too long." };
    }
    const { messages } = await core.getConversation(asked.conversation.id);
    const answer = messages.find((message) => message.id === asked.answerId);
    if (answer?.kind !== "answer") return { kind, writes: [], error: "No reply." };
    keep(answer);
    return {
      kind,
      writes: writes.get(asked.answerId) ?? [],
      error:
        answer.status === "failed"
          ? `${answer.errorKind ?? "failed"}: ${answer.errorMessage ?? ""}`
          : null,
    };
  } finally {
    stop();
  }
}

test.skipIf(env("VANISH") === null && env("VANISH_REPLAY") === null)(
  "call help: no reply that showed while written ends with less (#2767)",
  async () => {
    const log = createLog();
    const config = readConfig(ROOT);
    const out = join(
      config.resultsDir,
      `speed-vanish-${new Date().toISOString().replace(/[:.]/g, "-")}`,
    );
    await mkdir(out, { recursive: true });
    const replay = env("VANISH_REPLAY");
    if (replay) {
      const presses: Press[] = JSON.parse(await readFile(replay, "utf8"));
      const text = report(
        presses,
        `# The kept replies of ${replay}, read by commit ${commitOf(ROOT)}'s panel`,
      );
      console.log(text);
      await writeFile(join(out, "report.md"), text);
      log(`Report in ${out}`);
      return;
    }
    const times = Number(env("VANISH"));
    if (!Number.isInteger(times) || times < 1)
      throw new Error("INCARNAMIND_EVAL_SPEED_VANISH: presses per case.");
    const models = modelsAsked();
    if (models.length === 0) throw new Error("Set INCARNAMIND_EVAL_SPEED_MODELS.");
    const languages = list("LANGUAGES");
    const stopUsd = Number(env("STOP_USD") ?? "4");
    const cases = CALL_HELP_CASES.filter(
      (each) => KINDS.includes(each.kind) && (!languages || languages.includes(each.language)),
    );
    const presses: Press[] = [];
    let spent = 0;
    let stopped: string | null = null;
    const save = () => writeFile(join(out, "replies.json"), JSON.stringify(presses, null, 2));
    run: for (const each of cases) {
      log(`Opening ${each.id}`);
      const opened = await openCall(
        {
          embedder: createWorkerEmbedder(),
          modelCache: join(config.cacheDir, "models"),
          reranker: createWorkerCrossEncoder(config.rerankOnCpu),
          keep: config.keepData,
          log,
          embeddings: false,
        },
        each,
        `vanish-${each.id}`,
      );
      const { core } = opened.library;
      // Setting the variables is the consent to send the case and its Passages to each model.
      core.on("consent.requested", (request) => {
        void core.respondToConsent(
          request.requestId,
          request.flow.id === "chat" || request.flow.id === "checks",
        );
      });
      try {
        if (!opened.meeting) throw new Error("The call-help set needs its Meeting.");
        for (const model of models) {
          const name = `${model.kind}/${model.modelId}`;
          const providerId = (await core.saveChatProvider(model)).id;
          await core.updateSettings({
            user: { chatModel: { providerId, modelId: model.modelId } },
          });
          for (let time = 1; time <= times; time++) {
            const now = spent + (await spentUsd(core));
            if (now >= stopUsd) {
              stopped = `Stopped at $${now.toFixed(2)} before ${name} · ${each.id} press ${time}.`;
              break run;
            }
            const pressed = await press(core, opened.meeting.id, each.kind);
            presses.push({ model: name, case: each.id, language: each.language, ...pressed });
            const read = readPress(presses.at(-1) as Press);
            log(
              `${name} · ${each.id} ${time}/${times}: ${
                COUNTED.filter(([key]) => read[key])
                  .map(([, label]) => label)
                  .join("; ") || "nothing"
              }`,
            );
            if (/^(?:out-of-credit:|auth:|Not asked)/.test(pressed.error ?? "")) {
              stopped = `Stopped at ${name} · ${each.id}: ${pressed.error}`;
              break run;
            }
          }
          await save();
        }
      } finally {
        spent += await spentUsd(core);
        await opened.close();
      }
    }
    await save();
    const text = report(
      presses,
      [
        `# Call help pressed again and again, read by commit ${commitOf(ROOT)}'s panel`,
        "",
        `${new Date().toISOString()}. Spent: $${spent.toFixed(2)} (cap $${stopUsd}).${stopped ? ` ${stopped}` : ""}`,
      ].join("\n"),
    );
    console.log(text);
    await writeFile(join(out, "report.md"), text);
    log(`Replies and report in ${out}`);
  },
);
