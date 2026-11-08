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
import { marksAsBefore, newestStretch } from "../../eval/speed/arms";
import { callHelpSet } from "../../eval/speed/callHelp";
import { CALL_HELP_CASES, callOf, TRANSCRIPT } from "../../eval/speed/callHelpCases";
import { openLedger } from "../../eval/speed/ledger";
import { runOnArm } from "../../eval/speed/paired";
import type { CoreAdapters } from "../../src/core";
import { meetingHelpInstructions } from "../../src/core/answers/meetingHelp";
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
  test("15 cases a language, each with ids of its own, Documents of its own, and the lines it rests on in them", () => {
    expect(new Set(CALL_HELP_CASES.map((each) => each.id)).size).toBe(30);
    expect(CALL_HELP_CASES.filter((each) => each.language === "en")).toHaveLength(15);
    expect(CALL_HELP_CASES.filter((each) => each.language === "zh-CN")).toHaveLength(15);
    for (const each of CALL_HELP_CASES) {
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

describe("Call help's form as worded before #2847, for the arm that runs it", () => {
  const OPTION_BEFORE =
    '- Each option is two lines: what the User could say, as they would say it aloud, one sentence of at most 25 words with no quotation marks around it (the panel shows it as a quote), its Citation markers at its end; then a line starting with "→ " and what saying it leads to, in at most eight words, with no Citation marker.';
  const LINE_BEFORE =
    '- At most three short lines, each starting with "- ", each one sentence of at most 20 words, its Citation markers at its end.';
  const READING =
    '- Each reading is three lines: what they want, in one sentence, as a reading of what they said and never as a fact; then the moment of the transcript it rests on: its time and a few words they said in quotation marks, with no punctuation before the closing mark, then its Citation marker; then a line starting with "→ " and the move it suggests, in at most ten words.';

  test.each([
    {
      kind: "answer" as const,
      call: null,
      kept: OPTION_BEFORE,
      example:
        "★ We can't go below list for Enterprise, but we can extend the pilot to 60 days [^1]",
    },
    {
      kind: "no" as const,
      call: "Chinese",
      kept: OPTION_BEFORE,
      example: "★ 企业版价格没法低于标价，但我们可以把试用延长到 60 天 [^1]",
    },
    {
      kind: "sum" as const,
      call: "Chinese",
      kept: LINE_BEFORE,
      example: "- 上线推迟到 11 月 18 日 [^1]",
    },
    {
      kind: "want" as const,
      call: null,
      kept: READING,
      example: "12:04 “our budget stops at ten thousand” [^1]",
    },
  ])(
    "$kind in $call: each line as it was, and the marker rule gone",
    ({ kind, call, kept, example }) => {
      const now = meetingHelpInstructions(kind, {
        found: true,
        language: "en",
        callLanguage: call,
      });

      const before = marksAsBefore(now);

      expect(now).toContain("Put each Citation marker right after the words its quote supports");
      expect(before).not.toContain("Put each Citation marker");
      expect(before.split("\n")).toContain(kept);
      expect(before.split("\n")).toContain(example);
      expect(before.split("\n")).toHaveLength(now.split("\n").length - 1);
    },
  );
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
