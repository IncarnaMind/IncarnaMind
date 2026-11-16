/**
 * The meeting-notes set's saved notes judged again (README.md › The meeting-notes set, #3156): the
 * notes of each arm of a paired run's `report.json`, as they were saved, sent to the judge alone.
 * No model under test is asked. With READINGS=2 each note is judged twice, and the summary says how
 * many sentences both readings mark: the judge's own noise, which a bar on its count must clear.
 * Every judge request is counted, a refused or failed attempt included; each reading is written as
 * it ends, and the spend goes on the gate's one ledger.
 *
 * INCARNAMIND_EVAL_SPEED_REJUDGE_NOTES=<report.json> INCARNAMIND_EVAL_SPEED_JUDGE=anthropic/claude-sonnet-5-5
 * INCARNAMIND_EVAL_SPEED_READINGS=2 INCARNAMIND_EVAL_SPEED_LEDGER=<ledger> INCARNAMIND_EVAL_SPEED_STOP_USD=1.00
 * npm run eval:speed -- eval/speed/meetingNotesRejudge.speed.ts
 */
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "vitest";
import { readConfig } from "../lib/config";
import { callOf } from "./callHelpCases";
import { MEETING_NOTES_CASES, type MeetingNotesCase } from "./meetingNotesCases";
import { citedSentences, judgeNotes, savedNotes } from "./meetingNotesJudge";
import type { PairedRow } from "./pairedReport";
import { openRejudge } from "./rejudge";
import { env } from "./settings";

const ROOT = resolve(__dirname, "../..");

interface Control {
  language: MeetingNotesCase["language"];
  /** Each sentence with the words of the call it cites, and whether the judge must mark it. */
  sentences: readonly { text: string; quote: string; marked: boolean }[];
}

/**
 * Notes written by hand over lines every long call says, so a judge that marks nothing, or
 * everything, shows: a sentence its whole line says under a short quote must stay unmarked, and one
 * that gives the line to the wrong side, or says of two people what the line says of one, must be
 * marked. Judged with the saved notes; never a prompt.
 */
const CONTROLS: readonly Control[] = [
  {
    language: "en",
    sentences: [
      {
        text: "The other side will check with IT whether it can publish a feed; IT is slow to answer during a server move.",
        quote: "I'll have to check with IT",
        marked: false,
      },
      {
        text: "I will check with IT whether it can publish a feed.",
        quote: "I'll have to check with IT",
        marked: true,
      },
      {
        text: "The other side can think of two people who would be good at it, one of them very sceptical.",
        quote: "I can think of two people who'd be good at it",
        marked: false,
      },
      {
        text: "Both of the two people the other side has in mind are very sceptical.",
        quote: "One of them is very sceptical",
        marked: true,
      },
    ],
  },
  {
    language: "zh-CN",
    sentences: [
      {
        text: "对方要找 IT 确认能否发布订阅源，IT 正在搬服务器，回复较慢。",
        quote: "我得找 IT 确认",
        marked: false,
      },
      { text: "我方要找 IT 确认能否发布订阅源。", quote: "我得找 IT 确认", marked: true },
    ],
  },
];

function controlOf(control: Control) {
  const each = MEETING_NOTES_CASES.find((known) => known.language === control.language);
  if (!each) throw new Error(`No ${control.language} case.`);
  const turns = callOf(each.call);
  for (const { quote } of control.sentences) {
    if (!turns.some((turn) => turn.text.includes(quote))) {
      throw new Error(`${each.id} says nothing with “${quote}”: the control can't be judged.`);
    }
  }
  return {
    language: control.language,
    wanted: control.sentences.flatMap(({ marked }, index) => (marked ? [index + 1] : [])),
    input: {
      expected: each.facts,
      turns,
      notes: control.sentences.map(({ text }, index) => `${text}[${index + 1}]`).join("\n"),
      citations: control.sentences.map(({ quote }) => ({
        documentName: "Transcript",
        quote,
        check: "found",
      })),
    },
  };
}

const same = (one: readonly number[], other: readonly number[]) =>
  one.length === other.length && one.every((n) => other.includes(n));

test.skipIf(env("REJUDGE_NOTES") === null)(
  "the meeting-notes set's saved notes, judged again",
  async () => {
    const path = env("REJUDGE_NOTES") ?? "";
    const readings = Number(env("READINGS") ?? "1");
    if (readings !== 1 && readings !== 2) {
      throw new Error("INCARNAMIND_EVAL_SPEED_READINGS is 1 or 2: nothing was sent.");
    }
    const read: { rows: PairedRow[] } = JSON.parse(await readFile(path, "utf8"));
    const rows = read.rows.filter((row) => row.set === "meeting-notes");
    const controls = CONTROLS.map(controlOf);
    const rejudge = await openRejudge(`meeting notes judged again, ${path}`, 1);
    const out = join(
      readConfig(ROOT).resultsDir,
      `meeting-notes-rejudge-${rejudge.startedAt.replace(/[:.]/g, "-")}`,
    );
    await mkdir(out, { recursive: true });
    const keep = (record: unknown) =>
      appendFile(join(out, "rejudge.jsonl"), `${JSON.stringify(record)}\n`);
    const lines: string[] = [];
    const total = { sentences: 0, before: 0, marked: [0, 0], both: 0 };
    let unread = 0;
    let skipped = 0;
    let controlsFailed = 0;
    try {
      for (const row of rows) {
        const each = MEETING_NOTES_CASES.find((known) => known.id === row.id);
        if (!each) throw new Error(`No case ${row.id}.`);
        for (const [arm, run] of [
          ["first", row.baseline],
          ["second", row.candidate],
        ] as const) {
          if (run.status !== "done") {
            lines.push(`${row.id} ${arm}: no notes to judge (${run.status})`);
            continue;
          }
          const saved = savedNotes(run.text);
          const found = (n: number) => saved.citations[n - 1]?.check === "found";
          const sentences = citedSentences(saved.notes).filter(({ cites }) => cites.some(found));
          const before = sentences
            .filter(({ cites }) => cites.some((n) => found(n) && saved.unstated.includes(n)))
            .flatMap(({ cites }) => cites.find(found) ?? []);
          const marked: number[][] = [];
          for (let reading = 1; reading <= readings; reading++) {
            if (rejudge.atStop()) {
              skipped++;
              continue;
            }
            try {
              const judged = await judgeNotes(rejudge.model, {
                expected: each.facts,
                notes: saved.notes,
                citations: saved.citations,
                turns: callOf(each.call),
              });
              if (judged.grade === "unread") unread++;
              await keep({ id: row.id, arm, reading, before, ...judged });
              marked.push(judged.unstated.map(({ n }) => n));
            } catch (error) {
              unread++;
              await keep({ id: row.id, arm, reading, failed: String(error) });
            }
          }
          if (marked.length < readings) {
            lines.push(`${row.id} ${arm}: ${marked.length} of ${readings} readings made`);
            continue;
          }
          const [first = [], second = first] = marked;
          const both = first.filter((n) => second.includes(n)).length;
          total.sentences += sentences.length;
          total.before += before.length;
          total.marked[0] = (total.marked[0] ?? 0) + first.length;
          total.marked[1] = (total.marked[1] ?? 0) + second.length;
          total.both += both;
          lines.push(
            `${row.id} ${arm}: ${sentences.length} sentences with a found Citation; marked before ${before.length}; now ${marked.map((one) => one.length).join(" and ")}${readings > 1 ? `, ${both} in both` : ""}`,
          );
        }
      }
      for (const control of controls) {
        if (rejudge.atStop()) {
          skipped++;
          lines.push(`control ${control.language} not judged: the stop is reached`);
          continue;
        }
        try {
          const judged = await judgeNotes(rejudge.model, control.input);
          const marked = judged.unstated.map(({ n }) => n);
          const held = judged.grade !== "unread" && same(marked, control.wanted);
          if (!held) controlsFailed++;
          await keep({ control: control.language, wanted: control.wanted, ...judged });
          lines.push(
            `control ${control.language}: marked ${marked.join(", ") || "none"}, must mark ${control.wanted.join(", ")}${held ? "" : "  CONTROL FAILED"}`,
          );
        } catch (error) {
          unread++;
          await keep({ control: control.language, failed: String(error) });
          lines.push(`control ${control.language}: the judge failed`);
        }
      }
    } finally {
      await rejudge.record();
    }
    const counts =
      rejudge.refused.length === 0 && unread === 0 && skipped === 0 && controlsFailed === 0;
    const summary = [
      "# The meeting-notes set's notes judged again",
      "",
      `${rejudge.startedAt} · ${path} · judge ${rejudge.name}, ${readings} reading${readings === 1 ? "" : "s"} of each note. ${rejudge.attempts()} judge requests, ${rejudge.refused.length} refused or failed${rejudge.refused.length ? ` (${rejudge.refused.join("; ")})` : ""}; ${unread} readings unread or failed; ${skipped} not made at the stop of $${rejudge.stopUsd}; ${controlsFailed} controls failed; spent $${rejudge.spent().toFixed(4)}. ${counts ? "The run counts." : "THE RUN DOES NOT COUNT."}`,
      "",
      `${total.sentences} sentences with a found Citation; marked in the saved run ${total.before}; marked now ${total.marked.slice(0, readings).join(" and ")}${readings > 1 ? `, ${total.both} in both readings` : ""}.`,
      "",
      ...lines,
    ].join("\n");
    await writeFile(join(out, "rejudge.md"), `${summary}\n`);
    console.log(summary);
  },
);
