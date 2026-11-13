/**
 * A paired call-help record made free (#2847): the presses of INCARNAMIND_EVAL_SPEED_ITEMS in
 * INCARNAMIND_EVAL_SPEED_SETS through the paired runner's own record (each arm's library and switch,
 * `runOnArm`, the rows and report.json as `npm run eval:speed` writes them), on scripted replies in
 * each arm's form and a scripted judge, so the tools that read a run are proven on its record before
 * money is spent. Nothing is sent anywhere: the models INCARNAMIND_EVAL_SPEED_MODELS names are the
 * rows' labels only. INCARNAMIND_EVAL_SPEED_FREE_RECORD names the folder it writes to.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vitest";
import type { CoreAdapters } from "../../src/core";
import { createFakeEmbedder } from "../../src/core/embedding/fake";
import { shownPassages } from "../../tests/helpers/citations";
import { type ModelCall, scriptedModel } from "../../tests/helpers/models";
import { requestSizes } from "../lib/requestSizes";
import { armNamed, armSwitch, type SentRequest } from "./arms";
import { type CallHelpSet, callHelpSet, isLoadedCallHelpSet, loadedCallHelpSet } from "./callHelp";
import { type ArmRun, droppedOf, openForArms, runOnArm } from "./paired";
import { armTurns, cellOf, type PairedRow, sentPair } from "./pairedReport";
import { env, list } from "./settings";

const block = (text: string, tag: string) =>
  new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`).exec(text)?.[1] ?? "";

const WORDS = {
  en: {
    say: "We can book a survey of each roof this week",
    effect: "moves to a survey",
    second: "Let me check with the team and come back to you",
    after: "buys time",
    own: "The Documents don't say whether the price includes customs duty",
    wrong: "Wrong.",
    said: "They said it is otherwise",
    remark: "Nothing was decided on the price",
  },
  zh: {
    say: "我们这周可以安排每个屋顶的勘察",
    effect: "推进到勘察",
    second: "我跟团队确认后再回复你",
    after: "争取时间",
    own: "文档没有提到价格是否含关税",
    wrong: "不对。",
    said: "对方说的不一样",
    remark: "价格还没定",
  },
};

/**
 * A reply in the shape and form the press's instructions ask for, citing `quote` as markers 1 and 2.
 * In the form, some buttons write a fact line out of place, a marker on the line to say, a fact in
 * quotation marks or a third fact line, so a reading's counts of each have something to count.
 */
function replyOf(help: string, quote: string, newest: string): string {
  const w = help.includes("The call is in Chinese") ? WORDS.zh : WORDS.en;
  const form = help.includes('starting with "> "');
  const words = quote.replace(/[.。!?！？]\s*$/u, "");
  const fact = `${words} [^1]`;
  // The call's newest line on a line to say, its marker recorded on the call: the form's reader takes
  // the marker off, so the record keeps it as a dropped Citation.
  if (form && help.includes("newest objection")) {
    const said = newest.replace(/[.。!?！？]\s*$/u, "");
    return [`★ ${said} [^2]`, `> ${fact}`, `→ ${w.effect}`, "", w.second, `→ ${w.after}`].join(
      "\n",
    );
  }
  if (help.includes("Check the newest claim")) {
    return form
      ? [`= ${w.wrong}`, `> ${w.said} [^1]`, `> ${fact}`].join("\n")
      : `- ${w.said}; ${fact}`;
  }
  if (help.includes("At most three short lines")) {
    return form
      ? [`> ${fact}`, `= ${w.remark}`].join("\n")
      : [`- ${fact}`, `- ${w.remark}`].join("\n");
  }
  if (!form) return [`★ ${w.say} [^1]`, `→ ${w.effect}`, "", w.second, `→ ${w.after}`].join("\n");
  if (help.includes("What could the User say next")) {
    return [`> ${fact}`, `★ ${w.say}`, `→ ${w.effect}`, "", w.second, `→ ${w.after}`].join("\n");
  }
  if (help.includes("What should the User ask next")) {
    return [`★ ${w.say}`, `→ ${w.effect}`, `> ${fact}`, "", w.second, `→ ${w.after}`].join("\n");
  }
  if (help.includes("Decline what was just asked")) {
    return [`★ ${w.say}`, `→ ${w.effect}`, "", `> ${fact}`, w.second, `→ ${w.after}`].join("\n");
  }
  return [
    `★ ${w.say} [^2]`,
    `> ${fact}`,
    `> “${words}” [^1]`,
    `> ${fact}`,
    `→ ${w.effect}`,
    "",
    w.second,
    `= ${w.own}`,
    `→ ${w.after}`,
  ].join("\n");
}

/** A model that cites the first Passage found ahead, or else the call's newest line, then replies. */
function replying(calls: ModelCall[]) {
  return scriptedModel(
    (call) => {
      calls.push(call);
      const [found] = shownPassages(block(call.prompt, "found-in-documents"));
      const heard = shownPassages(block(call.prompt, "live-transcript")).at(-1);
      const passage = found ?? heard;
      const quote = found
        ? (found.text.split("\n").find((line) => line.startsWith("- ")) ?? found.text)
            .replace(/^- /, "")
            .trim()
        : (heard?.text.split("\n").at(-1) ?? "").replace(/^\[[^\]]*\]\s*/, "").trim();
      if (passage && !call.results.some((result) => result.tool === "cite")) {
        return {
          calls: [
            {
              tool: "cite",
              input: {
                citations: [
                  { marker: 1, passage: passage.id, quote },
                  { marker: 2, passage: passage.id, quote },
                ],
              },
            },
          ],
        };
      }
      const newest = (heard?.text.split("\n").at(-1) ?? "").replace(/^\[[^\]]*\]\s*/, "").trim();
      return { text: replyOf(block(call.prompt, "help"), quote, newest) };
    },
    { judgesItsAnswers: true },
  );
}

/** A judge that grades every reply right, and, asked place by place, lists the first place. */
const judging = () =>
  scriptedModel(() => ({ text: "" }), {
    generate: (call) => {
      const first = /^\[(p\d+)\]/m.exec(call.prompt)?.[1];
      return call.prompt.includes("<places>")
        ? { text: JSON.stringify({ unbacked: first ? [first] : [] }) }
        : { text: JSON.stringify({ grade: "right", unstated: [] }) };
    },
  });

// The press answers on an Ollama choice; the model is scripted, so the server is always here.
const ollamaModels: CoreAdapters["ollamaModels"] = {
  describe: async () => null,
  loaded: async () => null,
  running: async () => true,
};

test.skipIf(env("FREE_RECORD") === null)("a free paired call-help record", async () => {
  const out = env("FREE_RECORD") ?? "";
  const named = list("PAIRED") ?? [];
  if (named.length !== 2) throw new Error("INCARNAMIND_EVAL_SPEED_PAIRED names two arms.");
  const arms = [armNamed(named[0] as string), armNamed(named[1] as string)] as const;
  const sets = (list("SETS") ?? []) as CallHelpSet[];
  const ids = list("ITEMS");
  const models = list("MODELS") ?? [];
  const switches = [armSwitch(), armSwitch()] as const;
  switches[0].use(arms[0]);
  switches[1].use(arms[1]);
  const turn = armTurns();
  const rows: PairedRow[] = [];
  const calls: ModelCall[] = [];
  const sizes = requestSizes();
  const model = sizes.wrap(replying(calls), "app");
  const groups = await Promise.all(
    sets.map((set) => (isLoadedCallHelpSet(set) ? loadedCallHelpSet(set) : callHelpSet(set))),
  );
  for (const group of groups.flat()) {
    const items = group.items.filter((item) => !ids || ids.includes(item.id));
    if (items.length === 0) continue;
    const opened = await openForArms(group, (which) => ({
      embedder: createFakeEmbedder(),
      ollamaModels,
      keep: false,
      log: () => undefined,
      embeddings: false,
      recordTimings: true,
      chatModels: () => switches[which].chatModels(() => model),
      callHelpForm: switches[which].callHelpForm,
    }));
    try {
      const choices = await Promise.all(
        opened.map(async ({ library }) => ({
          providerId: (await library.core.saveChatProvider({ kind: "ollama", modelId: "local" }))
            .id,
          modelId: "local",
        })),
      );
      for (const name of models) {
        for (const item of items) {
          const order = turn(cellOf({ model: name, set: item.set, language: item.language }));
          const done: ArmRun[] = [];
          const firstSent: (SentRequest | null)[] = [null, null];
          for (const which of order) {
            const { library, meeting, citing } = opened[which];
            const recorder = library.timings;
            if (!recorder || !meeting) throw new Error(`${item.id} opened without its Meeting.`);
            switches[which].takeSent();
            switches[which].takeChecks();
            switches[which].takeCites();
            sizes.take();
            done[which] = await runOnArm(item, {
              library,
              meeting,
              ...(citing && { citing }),
              recorder,
              choice: choices[which] ?? { providerId: "", modelId: "local" },
              model: name,
              arm: arms[which].id,
              grade: async () => "unread",
              claimsJudge: sizes.wrap(judging(), "judge"),
            });
            firstSent[which] = switches[which].takeSent()[0] ?? null;
            const written = switches[which].takeCites();
            done[which] = {
              ...done[which],
              checkReplies: switches[which].takeChecks(),
              writtenCitations: written,
              droppedCitations: droppedOf(written, done[which]?.help?.citations),
              requestSizes: sizes.take(),
            };
          }
          rows.push({
            set: item.set,
            id: item.id,
            kind: item.kind,
            language: item.language,
            model: name,
            run: 1,
            first: order[0],
            ...sentPair(firstSent[0] ?? null, firstSent[1] ?? null),
            baseline: done[0] as ArmRun,
            candidate: done[1] as ArmRun,
          });
        }
      }
    } finally {
      await Promise.all(opened.map((each) => each.close()));
    }
  }
  for (const name of models) {
    const folder = join(out, name.split("/").at(-1) ?? name, "speed-paired-free");
    await mkdir(folder, { recursive: true });
    const mine = rows.filter((row) => row.model === name);
    await writeFile(
      join(folder, "report.json"),
      JSON.stringify({ arms: arms.map((arm) => arm.id), rows: mine }, null, 2),
    );
  }
});
