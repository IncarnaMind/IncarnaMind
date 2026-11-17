/**
 * What a real model (Claude Haiku 5.5) replied when a sentence about a Document's name was checked
 * against the Library (#2525), replayed through the reading of those replies: each check's replies,
 * kept by tests/live/libraryRepliesCapture.live.test.ts, are played back in order to a Library built
 * as the capture built it, and the sentence must end as it ended then. A change to how a reply is
 * read is tried on these replies for nothing before any model is asked again.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { readMind, writeMind } from "../helpers/minds";
import { scriptedModel, scriptedModels } from "../helpers/models";

interface Recorded {
  via: "stream" | "generate";
  question: string | null;
  text: string;
  tools: { name: string; input: string }[];
  finish: string;
}

interface Captured {
  language: "en" | "zh-CN";
  name: string;
  copies: 1 | 2;
  says: "once" | "twice";
  sentence: string;
  state: string;
  reason: string | null;
  calls: Recorded[];
}

/** The replies kept before and after the model was told which line each Library-line word names. */
const FIXTURES = ["libraryReplies.jsonl", "libraryRepliesAfter.jsonl"] as const;

const kept = (file: (typeof FIXTURES)[number]): Captured[] =>
  readFileSync(join(import.meta.dirname, "../fixtures", file), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Captured);

const FILLER = [
  { name: "Harbour survey.txt", contents: "Harbour survey: the north wall needs repointing." },
  { name: "Crew roster.txt", contents: "Crew roster: Ines, Tomas and Wren on the early shift." },
  { name: "Tide log.csv", contents: "Date,High water\n2026-10-01,04:12\n2026-10-02,04:55\n" },
];

/**
 * The model that said what was kept. A request that names a judge's question gets the kept reply
 * to that question, and any other the next of the Run's, whichever way the request is made.
 */
function replaying(calls: readonly Recorded[]) {
  const left = [...calls];
  let started = false;
  const take = (question: string | null | undefined): Recorded => {
    const at = left.findIndex((each) =>
      question ? each.question === question : each.question === null && each.via === "stream",
    );
    const [next] = at < 0 ? [] : left.splice(at, 1);
    if (!next) throw new Error(`No reply was kept for ${question ?? "the Run"}.`);
    return next;
  };
  const model = scriptedModel(
    (call) => {
      if (!started) return { text: "" };
      const next = take(call.question);
      return {
        text: next.text,
        ...(next.tools.length > 0 && {
          calls: next.tools.map((tool) => ({ tool: tool.name, input: JSON.parse(tool.input) })),
        }),
      };
    },
    {
      generate: (call) => (started ? { text: take(call.question).text } : { text: "" }),
    },
  );
  return {
    model,
    /** From here the replies are the kept ones: before it, the Library's own setup. */
    start: () => {
      started = true;
    },
  };
}

async function replay(each: Captured) {
  const dataDir = await createTempDataFolder();
  const replayed = replaying(each.calls);
  const core = startCore(dataDir, {
    createChatModel: scriptedModels(replayed.model).createChatModel,
  });
  core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
  await core.saveChatProvider({
    kind: "anthropic",
    apiKey: "replayed",
    modelId: "claude-haiku-5-5",
  });
  await core.updateSettings({ user: { language: each.language } });
  const sources = await createTempDataFolder();
  const copies = Array.from({ length: each.copies }, (_, at) => ({
    name: `${each.name}${at === 0 ? "" : " (2)"}.txt`,
    contents: `${each.name}: the figures for the quarter.`,
  }));
  const files = [...FILLER.filter((file) => !file.name.startsWith(each.name)), ...copies];
  await addAndProcess(
    core,
    await Promise.all(files.map((file) => writeSourceFile(sources, file.name, file.contents))),
  );
  const note = await core.createMind({ title: "Library overview", folderId: null });
  const mind = await connectToMind(core, note.id);
  writeMind(mind, [
    {
      type: "paragraph",
      attrs: { id: "one" },
      content: [{ type: "text", text: each.sentence }],
    },
  ]);
  await mind.settled();
  replayed.start();
  await core.checkMind({ requestId: `check-${randomUUID()}`, mindId: note.id, mode: "all" });
  await mind.settled();
  const check = claimSpans(readMind(mind))[0]?.check;
  core.close();
  return {
    state: check?.state ?? "no mark",
    reason: check?.state === "not-checked" ? (check.reason ?? null) : null,
  };
}

describe.each(FIXTURES)(
  "replies a real model gave to a sentence about a name, replayed (%s)",
  (file) => {
    // protects=the replies kept from a real model, played back through the reading of them, end each sentence as they ended then, so a change to the reading is tried on them for nothing (#2525); fails_when=a replay ends a sentence another way than it ended when asked
    test.each(kept(file).map((each) => [each.sentence, each] as const))(
      "%s ends as it ended",
      async (_sentence, each) => {
        expect(await replay(each)).toEqual({ state: each.state, reason: each.reason });
      },
      60_000,
    );
  },
);
