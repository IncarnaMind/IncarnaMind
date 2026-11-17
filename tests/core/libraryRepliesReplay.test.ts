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

/**
 * The runs kept. The first two were made when the number in a name was sent to the model as a
 * figure, and with a second copy of a name named "<name> (2)", a name of its own: the name still
 * appears once, so only a sentence that says twice is wrong. The third has twins of one name (a
 * .txt and a .md file) and no number in a name sent as a figure.
 */
const FIXTURES = [
  { file: "libraryReplies.jsonl", twins: "renamed", numberAsFigure: true },
  { file: "libraryRepliesAfter.jsonl", twins: "renamed", numberAsFigure: true },
  { file: "libraryRepliesBranch.jsonl", twins: "same-name", numberAsFigure: false },
] as const;

type Fixture = (typeof FIXTURES)[number];

/**
 * The checks the reading ends another way than the kept run did, by their place in the file: that
 * run was made before the Library line's gloss ("name (Documents named …)") was read as no fact
 * beyond the one it glosses (#3246), so a true sentence whose reply held on `name` alone is
 * Supported where it was Not checked.
 */
const READ_NOW: Partial<Record<string, Record<number, { state: string; reason: string | null }>>> =
  {
    "libraryRepliesBranch.jsonl": { 31: { state: "supported", reason: null } },
  };

const kept = ({ file, numberAsFigure }: Fixture): Captured[] =>
  readFileSync(join(import.meta.dirname, "../fixtures", file), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Captured)
    // A name's number is no figure the model is asked about now, so replies kept for a request
    // that asked about it have no request here to answer.
    .filter((each) => !numberAsFigure || !/\d/.test(each.name));

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

async function replay(each: Captured, twins: Fixture["twins"]) {
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
    name:
      twins === "renamed"
        ? `${each.name}${at === 0 ? "" : " (2)"}.txt`
        : `${each.name}.${at === 0 ? "txt" : "md"}`,
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
  "replies a real model gave to a sentence about a name, replayed ($file)",
  (fixture) => {
    // protects=the replies kept from a real model, played back through the reading of them, end each sentence as they ended then, so a change to the reading is tried on them for nothing, and whatever else the reading learns, a wrong sentence is never Supported nor a true one Contradicted (#2525); fails_when=a replay ends a sentence another way than it ended when asked, or a wrong one Supported
    test.each(kept(fixture).map((each, at) => [each.sentence, each, at] as const))(
      "%s ends as it ended",
      async (_sentence, each, at) => {
        const ended = await replay(each, fixture.twins);
        expect(ended).toEqual(
          READ_NOW[fixture.file]?.[at] ?? { state: each.state, reason: each.reason },
        );
        const holds =
          fixture.twins === "renamed"
            ? each.says === "once"
            : (each.copies === 1) === (each.says === "once");
        expect(ended.state).not.toBe(holds ? "contradicted" : "supported");
      },
      60_000,
    );
  },
);
