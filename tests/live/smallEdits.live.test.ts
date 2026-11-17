/**
 * Small fixes to a long Note, against real models, in English and in Chinese (#3284): a figure, a
 * name or a sentence changed in a Note the User typed, of about 1,500 words (Chinese: 1,700
 * characters) in 24 (17) paragraphs, asked as a person asks it, with controls that need a rewrite.
 * Every case names the paragraph it means; the text before and after is read from the Note once the
 * changes are accepted. Counted per language, in the report (INCARNAMIND_LIVE_REPORT) with the runs
 * (`.runs`): where the change landed (the paragraphs that differ), whether it is the exact swap the
 * case names, the seconds and tokens the request took, and each model request's step from the core's
 * own timing records. Runs only with INCARNAMIND_LIVE_DEEPSEEK_KEY (DeepSeek V4.1 Flash) or
 * INCARNAMIND_LIVE_ANTHROPIC_KEY (Claude Haiku 5.5); INCARNAMIND_LIVE_LANGUAGE, _KINDS (fix,
 * control), _ONLY (case numbers) and _LIMIT narrow it.
 *
 * Baseline on `main` (2026-11-17, DeepSeek V4.1 Flash; Claude Haiku 5.5 meant; 26 requests twice):
 * the exact swap and nothing else changed in 17 of 20 and 17 of 20 fixes, the right place where the
 * words are in the Note more than once in 6 of 9 and 7 of 9, every fix landed in 19 of 20 and 19 of
 * 20; the median small fix took 8.6 s and 898 output tokens, the rewrite itself about 14% of the time
 * and 10% to 14% of the output tokens; 11 of the first run's 26 requests were refused first for naming
 * a paragraph, and the second run's 19 refused calls were a label of one or two words (10), words
 * that don't start the paragraph or are not the Note's (6) and the model's own reasoning (3). Bars for the branch, written 2026-11-17 before its paired run against
 * `main`, the arms alternated in one session, two rounds:
 * - exactness decides: on the 20 small fixes the asked words change and nothing else in the Note,
 *   counted by code, 20 of 20; every fix lands, 20 of 20; at the right place on the 9 where the
 *   words are there more than once, 9 of 9, read by hand;
 * - the model chooses from the descriptions: old_text and new_text on at least 18 of the 20 fixes,
 *   and instruction on all 6 controls (a rewrite still reads as a rewrite);
 * - a refusal (not found, more than once) is recovered within two tries in at least 80% of the
 *   requests that met one, and its cause is counted: if curly against straight quotes, kinds of
 *   space or full-width against half-width punctuation account for a third of them, they are
 *   matched across in code and nothing looser;
 * - no reply claims a change that didn't land: 0;
 * - speed is reported and aimed at, not a gate: median seconds at least 15% under `main`'s, median
 *   output tokens at least 10% under, tokens in and out together at least 20% under; no slower than
 *   `main` at the median;
 * - the controls meet fewer "no such heading" refusals than `main`'s, counted beside it;
 * - #3283's third-round rows that were met stay met against `main`.
 */
import { appendFile } from "node:fs/promises";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { describe, expect, test } from "vitest";
import type { ChatProviderKind, Core } from "../../src/core";
import { catalogProvider } from "../../src/core/providers/catalog/providers";
import { createAiSdkChatModel } from "../../src/core/providers/models";
import { createTempDataFolder, queryDatabase, startCore } from "../helpers/core";
import { createSourceFolder, waitForProcessing, writeSourceFile } from "../helpers/documents";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { note, readMind, resolveChanges, writeMind } from "../helpers/minds";
import { LONG_CHINESE, LONG_ENGLISH } from "./longNotes";

const LIVE: { name: string; kind: ChatProviderKind; apiKey: string | undefined; model: string }[] =
  [
    {
      name: "Anthropic",
      kind: "anthropic",
      apiKey: process.env.INCARNAMIND_LIVE_ANTHROPIC_KEY,
      model:
        process.env.INCARNAMIND_LIVE_ANTHROPIC_MODEL ??
        (catalogProvider("anthropic")?.roles.quickTasks as string),
    },
    {
      name: "DeepSeek",
      kind: "deepseek",
      apiKey: process.env.INCARNAMIND_LIVE_DEEPSEEK_KEY,
      model:
        process.env.INCARNAMIND_LIVE_DEEPSEEK_MODEL ??
        (catalogProvider("deepseek")?.roles.quickTasks as string),
    },
  ];

interface Fix {
  kind: "fix";
  /** Whether the figure or name appears more than once in the Note, so the request has to be read for its place. */
  twice: boolean;
  request: string;
  /** The paragraph the request means, from 0. */
  at: number;
  /** The words as the Note holds them, and what they should become. */
  old: string;
  now: string;
}
interface Control {
  kind: "control";
  request: string;
  at: number;
}
type Case = Fix | Control;

const ENGLISH: Case[] = [
  {
    kind: "fix",
    twice: false,
    request: "In the Note, the Reporting team has twelve people now, not eleven.",
    at: 2,
    old: "Eleven people work in the team",
    now: "Twelve people work in the team",
  },
  {
    kind: "fix",
    twice: false,
    request: "The shuttle bus now leaves at eight fifty, not eight forty.",
    at: 16,
    old: "leaves the main building at eight forty",
    now: "leaves the main building at eight fifty",
  },
  {
    kind: "fix",
    twice: false,
    request: "Change the board pack so it is sent on the ninth day instead of the eighth.",
    at: 8,
    old: "sent on the eighth",
    now: "sent on the ninth",
  },
  {
    kind: "fix",
    twice: true,
    request: "Dana's desk is on the second floor, not the third.",
    at: 0,
    old: "on the third floor beside the window",
    now: "on the second floor beside the window",
  },
  {
    kind: "fix",
    twice: true,
    request: "Make Dana's buddy period the first four months instead of the first three.",
    at: 15,
    old: "first three months",
    now: "first four months",
  },
  {
    kind: "fix",
    twice: true,
    request: "The first review should be after eight weeks, not six.",
    at: 18,
    old: "After six weeks",
    now: "After eight weeks",
  },
  {
    kind: "fix",
    twice: true,
    request: "The IT desk now aims to answer within two working days, not one.",
    at: 21,
    old: "within one working day",
    now: "within two working days",
  },
  {
    kind: "fix",
    twice: true,
    request: "In the Reporting team paragraph, call the Head of Reporting the Reporting Lead.",
    at: 2,
    old: "The Head of Reporting holds",
    now: "The Reporting Lead holds",
  },
  {
    kind: "fix",
    twice: false,
    request:
      'Replace the sentence "A colleague reviews the change before it goes live." with "Two colleagues review the change before it goes live."',
    at: 4,
    old: "A colleague reviews the change before it goes live.",
    now: "Two colleagues review the change before it goes live.",
  },
  {
    kind: "fix",
    twice: false,
    request:
      'Delete the sentence "Pie charts are avoided, and any chart with more than seven series is split into two." from the style guide paragraph.',
    at: 6,
    old: " Pie charts are avoided, and any chart with more than seven series is split into two.",
    now: "",
  },
  { kind: "control", request: "Make the Tools paragraph read more formally.", at: 5 },
  { kind: "control", request: "Shorten the Meetings paragraph to a single sentence.", at: 11 },
  {
    kind: "control",
    request: "Rewrite the Reporting team paragraph so a customer could read it.",
    at: 2,
  },
];

const CHINESE: Case[] = [
  {
    kind: "fix",
    twice: false,
    request: "报告团队有十二个人，不是十一个。",
    at: 2,
    old: "团队共有十一人",
    now: "团队共有十二人",
  },
  {
    kind: "fix",
    twice: false,
    request: "班车改成八点五十分出发，不是八点四十分。",
    at: 16,
    old: "每天八点四十分从主楼出发",
    now: "每天八点五十分从主楼出发",
  },
  {
    kind: "fix",
    twice: false,
    request: "月度材料改成第九天发出，不是第八天。",
    at: 8,
    old: "第八天发出",
    now: "第九天发出",
  },
  {
    kind: "fix",
    twice: true,
    request: "账号与权限里，报告数据库的权限改到第三周开通，不是第二周。",
    at: 1,
    old: "要到第二周、数据保护课程完成之后才会开通",
    now: "要到第三周、数据保护课程完成之后才会开通",
  },
  {
    kind: "fix",
    twice: true,
    request: "看板组的例会改到周三上午十点，不是周二。",
    at: 2,
    old: "每周二上午十点开会半小时",
    now: "每周三上午十点开会半小时",
  },
  {
    kind: "fix",
    twice: true,
    request: "带教同事这一段里，“报告负责人”改成“报告主管”。",
    at: 15,
    old: "向报告负责人做简短汇报",
    now: "向报告主管做简短汇报",
  },
  {
    kind: "fix",
    twice: true,
    request: "学习预算这一段里，需提前与报告负责人商定，改成与带教同事商定。",
    at: 14,
    old: "需提前与报告负责人商定",
    now: "需提前与带教同事商定",
  },
  {
    kind: "fix",
    twice: false,
    request: "带教安排改成头四个月，不是头三个月。",
    at: 15,
    old: "头三个月的带教人",
    now: "头四个月的带教人",
  },
  {
    kind: "fix",
    twice: false,
    request: "把“小的需求两个工作日内答复”改成“小的需求当天答复”。",
    at: 9,
    old: "小的需求两个工作日内答复",
    now: "小的需求当天答复",
  },
  {
    kind: "fix",
    twice: false,
    request:
      "把指标名称这一段里“如果两位同事用同一个词表示不同的意思，鼓励达娜在词汇表频道里提出来”这半句删掉。",
    at: 7,
    old: "，如果两位同事用同一个词表示不同的意思，鼓励达娜在词汇表频道里提出来",
    now: "",
  },
  { kind: "control", request: "把工具这一段改得更正式一些。", at: 5 },
  { kind: "control", request: "把会议这一段缩成一句话。", at: 11 },
  { kind: "control", request: "把报告团队这一段改写得客户也能读懂。", at: 2 },
];

const LANGUAGES = [
  {
    language: "English",
    file: "Onboarding.md",
    contents: "# Onboarding\n\nA short onboarding note.\n",
    note: LONG_ENGLISH,
    cases: ENGLISH,
  },
  {
    language: "Chinese",
    file: "入职安排.md",
    contents: "# 入职安排\n\n一份简短的入职说明。\n",
    note: LONG_CHINESE.slice(0, 17),
    cases: CHINESE,
  },
];

const ASK_LIMIT_MS = 240_000;

async function ask(core: Core, text: string, mindId: string, folderId: string) {
  const result = await core.askInConversation({
    text,
    mindId,
    scope: { folderIds: [folderId], tagIds: [], documentIds: [] },
  });
  if (!result.asked) throw new Error(`Not asked: ${JSON.stringify(result)}`);
  await new Promise<void>((resolve) => {
    const limit = setTimeout(done, ASK_LIMIT_MS);
    const stops = [
      core.on("answer.finished", ({ answerId }) => answerId === result.answerId && done()),
      core.on("answer.failed", ({ answerId }) => answerId === result.answerId && done()),
    ];
    function done() {
      clearTimeout(limit);
      for (const stop of stops) stop();
      resolve();
    }
  });
  const { messages } = await core.getConversation(result.conversation.id);
  const answer = messages.find((message) => message.id === result.answerId);
  if (answer?.kind !== "answer") throw new Error("No Answer.");
  return answer;
}

/** The Note's paragraphs, in order, as the User reads them. */
function paragraphsOf(doc: ProseMirrorNode): string[] {
  const lines: string[] = [];
  doc.forEach((node) => {
    if (node.isTextblock) lines.push(node.textContent);
  });
  return lines;
}

async function noteNow(client: MindClient) {
  await client.settled();
  await resolveChanges(client, "accept");
  return paragraphsOf(readMind(client));
}

/** What changed between two texts, as their shared start and end leave it. */
function changeBetween(before: string, after: string) {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = 0;
  while (
    end < before.length - start &&
    end < after.length - start &&
    before[before.length - 1 - end] === after[after.length - 1 - end]
  ) {
    end++;
  }
  return {
    took: before.slice(start, before.length - end),
    put: after.slice(start, after.length - end),
  };
}

/** Characters that differ only by their look: curly and straight quotes, kinds of space, full-width and half-width. */
const lookalike = (text: string) =>
  [...text]
    .map((char) => {
      const code = char.codePointAt(0) ?? 0;
      if (code >= 0xff01 && code <= 0xff5e) return String.fromCodePoint(code - 0xfee0);
      if (/[\u00a0\u2000-\u200a\u202f\u3000]/u.test(char)) return " ";
      if (/[\u2018\u2019]/u.test(char)) return "'";
      if (/[\u201c\u201d]/u.test(char)) return '"';
      return char === "\u3002" ? "." : char;
    })
    .join("");

interface TimingRow {
  flow: string | null;
  step: string | null;
  end_ms: number;
  input_tokens: number | null;
  output_tokens: number | null;
}

describe.each(LIVE)("Small fixes in a long Note, live: $name", (live) => {
  test.skipIf(live.apiKey === undefined)(
    `${live.name}: a figure, a name or a sentence changed in a long Note lands where it was meant, and what it costs`,
    { timeout: 3_600_000 },
    async () => {
      const limit = Number(process.env.INCARNAMIND_LIVE_LIMIT ?? 99);
      const onlyLanguage = process.env.INCARNAMIND_LIVE_LANGUAGE;
      const onlyKinds = process.env.INCARNAMIND_LIVE_KINDS?.split(",");
      const onlyCases = process.env.INCARNAMIND_LIVE_ONLY?.split(",").map(Number);
      const report = process.env.INCARNAMIND_LIVE_REPORT;
      const runs: string[] = [];
      const lines: string[] = [];
      for (const each of LANGUAGES.filter(
        (one) => !onlyLanguage || one.language === onlyLanguage,
      )) {
        const cases = each.cases
          .map((one, index) => ({ one, index: index + 1 }))
          .filter(
            ({ one, index }) =>
              (!onlyKinds || onlyKinds.includes(one.kind)) &&
              (!onlyCases || onlyCases.includes(index)),
          )
          .slice(0, limit);
        const tally = {
          fix: {
            ran: 0,
            landed: 0,
            exact: 0,
            elsewhere: 0,
            replaced: 0,
            seconds: 0,
            out: 0,
            input: 0,
          },
          control: {
            ran: 0,
            landed: 0,
            exact: 0,
            elsewhere: 0,
            replaced: 0,
            seconds: 0,
            out: 0,
            input: 0,
          },
        };
        const refused = { noWords: 0, look: 0, gone: 0, other: 0, several: 0, heading: 0 };
        let twiceRan = 0;
        let twiceExact = 0;
        for (const { one, index } of cases) {
          const dir = await createTempDataFolder();
          const core = startCore(dir, { createChatModel: createAiSdkChatModel });
          try {
            core.on(
              "consent.requested",
              (asked) => void core.respondToConsent(asked.requestId, true),
            );
            core.on(
              "question.asked",
              (asked) => void core.answerUserQuestion(asked.requestId, { skipped: true }),
            );
            await core.saveChatProvider({
              kind: live.kind,
              ...(live.apiKey && { apiKey: live.apiKey }),
              modelId: live.model,
            });
            const sources = await createSourceFolder();
            const folder = await core.createLibraryGroup({ name: each.language, description: "" });
            const added = await core.addDocuments(
              [await writeSourceFile(sources, each.file, each.contents)],
              { groupId: folder.id },
            );
            await waitForProcessing(
              core,
              added.documents.map((document) => document.id),
            );
            const mind = await core.createMind({ title: each.language, folderId: folder.id });
            const client = await connectToMind(core, mind.id);
            await client.settled();
            writeMind(
              client,
              each.note.map((line) => note(line)),
            );
            const before = await noteNow(client);
            const startedAt = new Date();
            const answer = await ask(core, one.request, mind.id, folder.id);
            const seconds = (Date.now() - startedAt.getTime()) / 1000;
            const after = await noteNow(client);
            const rows = queryDatabase<TimingRow>(
              dir,
              "SELECT flow, step, end_ms, input_tokens, output_tokens FROM ai_timings WHERE started_at >= ? ORDER BY started_at, rowid",
              [startedAt.toISOString()],
            );
            const out = rows.reduce((sum, row) => sum + (row.output_tokens ?? 0), 0);
            const input = rows.reduce((sum, row) => sum + (row.input_tokens ?? 0), 0);
            const changed = before
              .map((text, at) => ({ at, text, now: after[at] }))
              .filter((row) => row.now !== row.text);
            const elsewhere =
              changed.filter((row) => row.at !== one.at).length +
              Math.abs(after.length - before.length);
            const target = before[one.at] ?? "";
            const here = after[one.at] ?? "";
            const expected = one.kind === "fix" ? target.replace(one.old, one.now) : null;
            const landed =
              one.kind === "fix"
                ? here !== target &&
                  (one.now === "" ? !here.includes(one.old) : here.includes(one.now))
                : here !== target;
            const exact = expected !== null && here === expected;
            const edits = answer.toolCalls.filter(
              (call) => call.tool === "edit_mind" || call.tool === "add_to_mind",
            );
            const replaced = edits.some((call) => call.input.old_text !== undefined);
            for (const call of edits) {
              const problem = call.mindProblem?.kind;
              if (problem === "no-heading") refused.heading++;
              if (problem === "several-words") refused.several++;
              if (problem !== "no-words") continue;
              refused.noWords++;
              const old = String(call.input.old_text ?? "");
              if (before.some((paragraph) => paragraph.includes(old))) refused.gone++;
              else if (before.some((paragraph) => lookalike(paragraph).includes(lookalike(old))))
                refused.look++;
              else refused.other++;
            }
            const kept = tally[one.kind];
            kept.ran++;
            if (landed) kept.landed++;
            if (exact && elsewhere === 0) kept.exact++;
            if (elsewhere > 0) kept.elsewhere++;
            if (replaced) kept.replaced++;
            kept.seconds += seconds;
            kept.out += out;
            kept.input += input;
            if (one.kind === "fix" && one.twice) {
              twiceRan++;
              if (exact && elsewhere === 0) twiceExact++;
            }
            const diff = changeBetween(target, here);
            runs.push(
              `- ${each.language} · ${one.kind}${one.kind === "fix" && one.twice ? " (twice)" : ""} #${index} · “${one.request.slice(0, 90)}”: ${edits.map((call) => `${call.tool}[${Object.keys(call.input).join(" ")}]${call.mindProblem ? `!${call.mindProblem.kind}` : ""}${typeof call.input.part === "string" ? ` part=“${call.input.part.slice(0, 50)}”` : ""}${typeof call.input.old_text === "string" ? ` old=“${call.input.old_text.slice(0, 60)}”` : ""}`).join(", ") || "no edit"}; ${landed ? "landed" : "NOT LANDED"}${exact ? ", exact" : ""}${
                elsewhere > 0
                  ? `, ELSEWHERE ${elsewhere} (${changed
                      .filter((row) => row.at !== one.at)
                      .map((row) => row.at)
                      .join(",")})`
                  : ""
              }; ${seconds.toFixed(1)} s, ${input} in / ${out} out tokens\n  in paragraph ${one.at}: “${diff.took.slice(0, 120)}” → “${diff.put.slice(0, 120)}”\n  steps: ${rows.map((row) => `${row.flow}/${row.step} ${(row.end_ms / 1000).toFixed(1)}s ${row.output_tokens ?? 0}t`).join("; ")}\n  reply: ${answer.text.slice(0, 220).replace(/\s+/g, " ")}`,
            );
          } finally {
            core.close();
          }
        }
        lines.push(
          `  ${each.language} · refused calls: no such words ${refused.noWords} (only by look ${refused.look}, already made ${refused.gone}, not the Note's words ${refused.other}), words more than once ${refused.several}, no such heading ${refused.heading}`,
        );
        for (const kind of ["fix", "control"] as const) {
          const t = tally[kind];
          if (t.ran === 0) continue;
          lines.push(
            `  ${each.language} · ${kind}: landed ${t.landed}/${t.ran}, exactly the swap and nothing elsewhere ${t.exact}/${t.ran}, something else changed ${t.elsewhere}, by replacement ${t.replaced}/${t.ran}, ${(t.seconds / t.ran).toFixed(1)} s, ${(t.input / t.ran).toFixed(0)} in / ${(t.out / t.ran).toFixed(0)} out tokens each${kind === "fix" && twiceRan > 0 ? `; the ${twiceRan} where the figure or name is there twice: ${twiceExact} exact in the right place` : ""}`,
          );
        }
      }
      console.log(lines.join("\n"));
      if (report) {
        await appendFile(report, `${lines.join("\n")}\n`);
        await appendFile(`${report}.runs`, `${runs.join("\n")}\n`);
      }
      expect(lines.length).toBeGreaterThan(0);
    },
  );
});
