/**
 * The call-help set of eval:speed (eval/speed/README.md › The call-help set): each case is a call
 * of its own over its own Documents, its press read as the panel shows it, and what spend a piece
 * of work's runs have made in all. Scripted models only: nothing is sent anywhere.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, test } from "vitest";
import { newestStretch } from "../../eval/speed/arms";
import { callHelpSet } from "../../eval/speed/callHelp";
import { CALL_HELP_CASES, callOf, TRANSCRIPT } from "../../eval/speed/callHelpCases";
import { CALL_HELP_DOCUMENTS } from "../../eval/speed/callHelpDocuments";
import { CALL_HELP_FRESH } from "../../eval/speed/callHelpFresh";
import { CALL_HELP_HELD_OUT } from "../../eval/speed/callHelpHeldOut";
import { openLedger } from "../../eval/speed/ledger";
import { runOnArm } from "../../eval/speed/paired";
import type { CoreAdapters } from "../../src/core";
import { createFakeEmbedder } from "../../src/core/embedding/fake";
import { shownPassages } from "../helpers/citations";
import { type ModelCall, scriptedModel } from "../helpers/models";

const ENTERPRISE = "Enterprise plan: $45 per seat a month, single sign-on included.";
const TEAM = "Team plan: $25 per seat a month.";

const block = (text: string, tag: string) =>
  new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`).exec(text)?.[1] ?? "";

/** A model that cites `quote` from the first Passage found ahead, then answers in the options' shape. */
function helping(quote: string, calls: ModelCall[]) {
  return scriptedModel((call) => {
    calls.push(call);
    const [found] = shownPassages(block(call.prompt, "found-in-documents"));
    if (found && !call.results.some((result) => result.tool === "cite")) {
      return {
        calls: [{ tool: "cite", input: { citations: [{ marker: 1, passage: found.id, quote }] } }],
      };
    }
    return {
      text: "★ Yes, Enterprise is $45 a seat with single sign-on [^1]\n→ answers at once\n\nI'll send the price sheet\n→ buys time",
    };
  });
}

/**
 * A judge that grades every reply `grade` and lists `unstated` as the numbers it doesn't back;
 * `first`: its first reply is words with no JSON ("prose"), or no text ("empty"), as a judge's can
 * be. `roles` gets the roles of each request's messages.
 */
function judging(
  grade: string,
  unstated: number[],
  prompts: string[],
  first?: "prose" | "empty",
  roles: string[][] = [],
) {
  return new MockLanguageModelV4({
    doGenerate: async ({ prompt }) => {
      roles.push(prompt.map((message) => message.role));
      prompts.push(
        prompt
          .flatMap((message) =>
            typeof message.content === "string"
              ? [message.content]
              : message.content.flatMap((part) => ("text" in part ? [part.text] : [])),
          )
          .join("\n"),
      );
      const text =
        first && prompts.length === 1
          ? first === "prose"
            ? "The reply gets the price right and cites the sheet."
            : ""
          : JSON.stringify({ grade, unstated });
      return {
        content: [{ type: "text", text }],
        finishReason: { unified: "stop", raw: undefined },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        warnings: [],
      };
    },
  });
}

/** Presses the case's button once, on a scripted model that cites `quote`, judged as `judge` says. */
async function pressed(
  id: string,
  quote: string,
  judge: { grade: string; unstated: number[]; first?: "prose" | "empty" },
) {
  const group = callHelpSet().find((each) => each.name === `call-help-${id}`);
  const item = group?.items[0];
  if (!group || !item) throw new Error(`No case ${id}.`);
  const calls: ModelCall[] = [];
  const model = helping(quote, calls);
  // The press answers on an Ollama choice; the model is scripted, so the server is always here.
  const ollamaModels: CoreAdapters["ollamaModels"] = {
    describe: async () => null,
    loaded: async () => null,
    running: async () => true,
  };
  const opened = await group.open({
    embedder: createFakeEmbedder(),
    ollamaModels,
    keep: false,
    log: () => undefined,
    embeddings: false,
    recordTimings: true,
    chatModels: () => () => model,
  });
  try {
    const { library } = opened;
    const { id: providerId } = await library.core.saveChatProvider({
      kind: "ollama",
      modelId: "local-model",
    });
    const recorder = library.timings;
    if (!recorder || !opened.meeting) throw new Error("The case opened without its Meeting.");
    const judged: string[] = [];
    const roles: string[][] = [];
    const run = await runOnArm(item, {
      library,
      meeting: opened.meeting,
      recorder,
      choice: { providerId, modelId: "local-model" },
      model: "ollama/local-model",
      arm: "today",
      grade: async () => "unread",
      claimsJudge: judging(judge.grade, judge.unstated, judged, judge.first, roles),
    });
    return { run, calls, judged, roles };
  } finally {
    await opened.close();
  }
}

describe("The call-help cases", () => {
  test.each([
    ["first", CALL_HELP_CASES, 15],
    ["held-out", CALL_HELP_HELD_OUT, 15],
    ["fresh", CALL_HELP_FRESH, 8],
    ["documents", CALL_HELP_DOCUMENTS, 12],
  ] as const)(
    "%s set: as many cases in each language, each with ids of its own, Documents of its own, and the lines it rests on in them",
    (_, cases, perLanguage) => {
      expect(new Set(cases.map((each) => each.id)).size).toBe(2 * perLanguage);
      expect(cases.filter((each) => each.language === "en")).toHaveLength(perLanguage);
      expect(cases.filter((each) => each.language === "zh-CN")).toHaveLength(perLanguage);
      for (const each of cases) {
        const said = callOf(each).map((turn) => turn.text);
        expect(each.documents.length, each.id).toBeGreaterThan(0);
        for (const group of each.rests) {
          expect(group.length, each.id).toBeGreaterThan(0);
          for (const rest of group) {
            if (rest.in === TRANSCRIPT) expect(said, each.id).toContain(rest.line);
            else {
              const document = each.documents.find((one) => one.file === rest.in);
              expect(document?.text, each.id).toContain(rest.line);
            }
          }
        }
      }
    },
  );

  test.each([
    ["the held-out set", CALL_HELP_HELD_OUT, [CALL_HELP_CASES]],
    ["the fresh slice", CALL_HELP_FRESH, [CALL_HELP_CASES, CALL_HELP_HELD_OUT]],
    [
      "the Documents set",
      CALL_HELP_DOCUMENTS,
      [CALL_HELP_CASES, CALL_HELP_HELD_OUT, CALL_HELP_FRESH],
    ],
  ])("%s shares no case and no Document with a set before it", (_, cases, before) => {
    const ids = new Set(before.flat().map((each) => each.id));
    const files = new Set(before.flat().flatMap((each) => each.documents.map((one) => one.file)));
    for (const each of cases) {
      expect(ids.has(each.id), each.id).toBe(false);
      for (const document of each.documents) expect(files.has(document.file), each.id).toBe(false);
    }
  });

  test("a case that needs a line said before the rollout talk has the talk between them, and a short one has none", () => {
    const earlier = CALL_HELP_CASES.filter((each) => each.needs === "earlier");
    expect(earlier.map((each) => each.id)).toEqual([
      "en-answer-earlier",
      "en-say-records",
      "zh-answer-earlier",
      "zh-say-records",
    ]);
    for (const each of earlier) {
      const call = callOf(each).map((turn) => turn.text);
      const before = (each.before ?? []).map((turn) => turn.text);
      expect(call.length - before.length - each.turns.length, each.id).toBe(24);
    }
    const short = CALL_HELP_CASES.find((each) => each.id === "en-answer-sso");
    expect(short && callOf(short)).toHaveLength(5);
  });
});

describe("A press during the call", { timeout: 120_000 }, () => {
  test("is heard with the call's lines and its own Document, and read as the panel shows it: its words, a whole option, cited and judged", async () => {
    const { run, calls, judged } = await pressed("en-answer-sso", ENTERPRISE, {
      grade: "right",
      unstated: [],
    });

    expect(run.status).toBe("done");
    expect(block(calls[0]?.prompt ?? "", "live-transcript")).toContain(
      "Does Enterprise include single sign-on, and what does it cost per seat?",
    );
    expect(block(calls[0]?.prompt ?? "", "found-in-documents")).toContain(ENTERPRISE);
    expect(run.firstWordsMs).toEqual(expect.any(Number));
    expect(run.firstOptionMs).toEqual(expect.any(Number));
    expect(run.firstOptionMs ?? 0).toBeGreaterThanOrEqual(run.firstWordsMs ?? Infinity);
    expect(run.doneMs ?? 0).toBeGreaterThanOrEqual(run.firstOptionMs ?? Infinity);
    expect(run.found).toBe(1);
    expect(run.cited).toBe(true);
    expect(run.grade).toBe("right");
    expect(run.falseSupported).toBe(0);
    expect(run.failures).toEqual([]);
    expect(
      run.requests?.filter((each) => each.kind === "model" && each.step === null),
    ).toHaveLength(2);
    expect(judged[0]).toContain("★ Yes, Enterprise is $45 a seat with single sign-on [1]");
    expect(judged[0]).toContain(`[1] Price sheet 2026: “${ENTERPRISE}” (found)`);
  });

  test("a found Citation of another line than the case rests on isn't cited, and a sentence the judge says its quote doesn't state is a false Supported", async () => {
    const { run } = await pressed("en-answer-sso", TEAM, { grade: "wrong", unstated: [1] });

    expect(run.status).toBe("done");
    expect(run.found).toBe(1);
    expect(run.cited).toBe(false);
    expect(run.grade).toBe("wrong");
    expect(run.falseSupported).toBe(1);
  });

  test("a judge that answers in words first is asked once more, and the JSON it gives then counts", async () => {
    const { run, judged } = await pressed("en-answer-sso", ENTERPRISE, {
      grade: "partly",
      unstated: [],
      first: "prose",
    });

    expect(judged).toHaveLength(2);
    expect(judged[1]).toContain("The reply gets the price right and cites the sheet.");
    expect(run.grade).toBe("partly");
  });

  // protects=a judge whose first reply holds no text is asked again as at first, never with its empty reply sent back, which Anthropic refuses once the prompt cache marks it; fails_when=the empty reply is replayed in the second request; no_claim=what a real judge writes (#2701).
  test("a judge that writes nothing at first is asked again without its empty reply, and the JSON it gives then counts", async () => {
    const { run, judged, roles } = await pressed("en-answer-sso", ENTERPRISE, {
      grade: "right",
      unstated: [],
      first: "empty",
    });

    expect(judged).toHaveLength(2);
    expect(roles[1]).toEqual(["system", "user"]);
    expect(run.status).toBe("done");
    expect(run.grade).toBe("right");
  });

  test("a number the judge names that no found Citation shows with is no false Supported", async () => {
    const { run } = await pressed("en-answer-sso", ENTERPRISE, { grade: "right", unstated: [2] });

    expect(run.cited).toBe(true);
    expect(run.falseSupported).toBe(0);
  });
});

describe("The newest stretch of the live transcript", () => {
  const passage = (id: string, words: number) =>
    `<passage id="${id}" document="Transcript" location="12:0${id.slice(1)}">\n${"talk ".repeat(words).trim()}\n</passage>`;
  const request = (...passages: string[]) =>
    `Before.\n\n<live-transcript>\n${passages.join("\n\n")}\n</live-transcript>\n\nSay no politely`;

  test("keeps the newest Passages within 400 tokens and drops the older, the rest of the request as it was", () => {
    const cut = newestStretch(request(passage("P1", 300), passage("P2", 300), passage("P3", 300)));

    expect(cut).toContain('id="P3"');
    expect(cut).not.toContain('id="P1"');
    expect(cut.startsWith("Before.\n\n<live-transcript>\n")).toBe(true);
    expect(cut.endsWith("</live-transcript>\n\nSay no politely")).toBe(true);
  });

  test("keeps the newest Passage even when it alone is longer, and a short call whole", () => {
    expect(newestStretch(request(passage("P1", 20), passage("P2", 2000)))).not.toContain('id="P1"');
    expect(newestStretch(request(passage("P1", 20), passage("P2", 2000)))).toContain('id="P2"');
    const short = request(passage("P1", 20), passage("P2", 20));
    expect(newestStretch(short)).toBe(short);
  });
});

describe("The ledger", () => {
  const folders: string[] = [];
  afterEach(async () => {
    await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true })));
  });
  const ledgerPath = async () => {
    const folder = await mkdtemp(join(tmpdir(), "incarnamind-ledger-"));
    folders.push(folder);
    return join(folder, "spent.json");
  };

  test("a run counts what the runs before it spent, its own as it goes, and only its last count", async () => {
    const path = await ledgerPath();
    const first = await openLedger(path, "first");
    expect(first.before).toBe(0);
    await first.record(1.25);
    await first.record(2.5);
    const second = await openLedger(path, "second");
    expect(second.before).toBe(2.5);
    await second.record(4);
    const third = await openLedger(path, "third");
    expect(third.before).toBe(6.5);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ first: 2.5, second: 4 });
  });

  test("no ledger counts nothing before; a file that isn't one, or a run named twice, stops the run", async () => {
    expect((await openLedger(null, "alone")).before).toBe(0);
    const path = await ledgerPath();
    await writeFile(path, "[1, 2]");
    await expect(openLedger(path, "next")).rejects.toThrow("isn't a ledger");
    await writeFile(path, JSON.stringify({ first: 1 }));
    await expect(openLedger(path, "first")).rejects.toThrow("already has a run named first");
  });
});
