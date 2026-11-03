import { generateText } from "ai";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  judgeRecordCite,
  judgeResolvedRecordCites,
} from "../../src/core/answers/checks/recordCites";
import type { PreparedChatModel } from "../../src/core/providers/chat";
import type { ResolvableRecordCiteResult } from "../../src/core/recordCites/resolver";

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, generateText: vi.fn() };
});

const model = {
  model: {},
  capabilities: { facts: { temperature: 0 } },
} as unknown as PreparedChatModel;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("support judgement for one exact record-cite passage", () => {
  test("Supported uses only the resolved passage and needs no second request", async () => {
    vi.mocked(generateText).mockResolvedValue({ text: "Judgement: supported" } as never);
    expect(
      await judgeRecordCite(model, "The claim", "Exact lines", new AbortController().signal, "en"),
    ).toEqual({ outcome: "supported" });
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(vi.mocked(generateText).mock.calls[0]?.[0]?.prompt).toContain(
      "<quote>\nExact lines\n</quote>",
    );
    expect(vi.mocked(generateText).mock.calls[0]?.[0]?.prompt).not.toContain("Smith Dep. 45:3");
  });

  test("Partly keeps both complete parts from the same fixed passage", async () => {
    vi.mocked(generateText)
      .mockResolvedValueOnce({ text: "Judgement: partly" } as never)
      .mockResolvedValueOnce({ text: "Covered: speed\nNot covered: robustness" } as never);
    expect(
      await judgeRecordCite(model, "The claim", "Only page 3", new AbortController().signal, "en"),
    ).toEqual({
      outcome: "partly",
      covered: "speed",
      uncovered: "robustness",
    });
    expect(generateText).toHaveBeenCalledTimes(2);
  });

  test("Unsupported does not widen to another source", async () => {
    vi.mocked(generateText)
      .mockResolvedValueOnce({ text: "Judgement: partly" } as never)
      .mockResolvedValueOnce({ text: "No parts" } as never);
    expect(
      await judgeRecordCite(model, "The claim", "Only page 5", new AbortController().signal, "en"),
    ).toEqual({ outcome: "unsupported" });
    expect(vi.mocked(generateText).mock.calls[1]?.[0]?.prompt).toContain("Only page 5");
  });

  test("a cited topic without one complete supporting assertion is Unsupported in one request", async () => {
    vi.mocked(generateText).mockResolvedValue({ text: "Judgement: unsupported" } as never);
    expect(
      await judgeRecordCite(model, "The claim", "Only page 2", new AbortController().signal, "en"),
    ).toEqual({ outcome: "unsupported" });
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(vi.mocked(generateText).mock.calls[0]?.[0]?.instructions).toContain(
      "complete independent assertion",
    );
  });

  test("reads the word on the last Judgement line after the model's reasons", async () => {
    vi.mocked(generateText).mockResolvedValue({
      text: "The Passage states the date the sentence gives.\n\nJudgement: supported",
    } as never);
    expect(
      await judgeRecordCite(model, "The claim", "Exact lines", new AbortController().signal, "en"),
    ).toEqual({ outcome: "supported" });
  });

  test("a reply that changes its Judgement, hedges it or goes on after it is unreadable", async () => {
    for (const text of [
      "Judgement: unsupported\nWait, actually.\nJudgement: supported",
      "Judgement: supported, partly",
      "Judgement: supported\nThe Passage also names the date.",
      "Judgement: partly supported",
    ]) {
      vi.mocked(generateText).mockResolvedValueOnce({ text } as never);
      expect(
        await judgeRecordCite(
          model,
          "The claim",
          "Exact lines",
          new AbortController().signal,
          "en",
        ),
      ).toEqual({ unreadable: true });
    }
  });

  test("one Judgement line that ends the reply reads, in bold or with a stop", async () => {
    for (const text of [
      "The Passage states it.\n**Judgement:** supported.",
      "The Passage states it.\nJudgement: **supported**\n",
    ]) {
      vi.mocked(generateText).mockResolvedValueOnce({ text } as never);
      expect(
        await judgeRecordCite(
          model,
          "The claim",
          "Exact lines",
          new AbortController().signal,
          "en",
        ),
      ).toEqual({ outcome: "supported" });
    }
  });

  test("an answer in the contradiction check's words is unreadable, never partial", async () => {
    vi.mocked(generateText).mockResolvedValue({ text: "conflict" } as never);
    expect(
      await judgeRecordCite(model, "The claim", "Exact lines", new AbortController().signal, "en"),
    ).toEqual({ unreadable: true });
  });

  test("a malformed first reply is a failure, never a supported result", async () => {
    vi.mocked(generateText).mockResolvedValue({ text: "unreadable" } as never);
    expect(
      await judgeRecordCite(
        model,
        "The claim",
        "The identifier",
        new AbortController().signal,
        "en",
      ),
    ).toEqual({ unreadable: true });
  });

  test("raw record citations are not judged as factual assertions", async () => {
    const claim = "The deadline continued until June 8 (ECF No. 41 at 3; Id. at 2).";
    const cite = (raw: string, passage: string): ResolvableRecordCiteResult => ({
      raw,
      from: claim.indexOf(raw),
      to: claim.indexOf(raw) + raw.length,
      outcome: "found",
      passage,
    });
    vi.mocked(generateText).mockResolvedValue({ text: "Judgement: supported" } as never);

    const judged = await judgeResolvedRecordCites(
      [cite("ECF No. 41 at 3", "Page 3"), cite("Id. at 2", "Page 2")],
      model,
      claim,
      new AbortController().signal,
      "en",
    );

    expect(judged).toMatchObject({
      recordCites: [{ outcome: "supported" }, { outcome: "supported" }],
    });
    const prompt = vi.mocked(generateText).mock.calls[1]?.[0]?.prompt;
    expect(prompt).toContain("The deadline continued until June 8");
    expect(prompt).not.toContain("ECF No. 41 at 3");
    expect(prompt).not.toContain("Id. at 2");
  });

  test("a resolved not-found keeps a supported nearby suggestion, and choices need no model", async () => {
    const results: ResolvableRecordCiteResult[] = [
      {
        raw: "Smith Dep. 45:3",
        outcome: "found",
        documentId: "doc-1",
        documentName: "Smith Deposition",
        contentHash: "hash-1",
        location: { kind: "page", from: 45, to: 45, lines: { from: 3, to: 3 } },
        pageFrom: 45,
        pageTo: 45,
        passage: "The named lines",
        nearby: {
          location: { kind: "page", from: 47, to: 47, lines: { from: 5, to: 9 } },
          pageFrom: 47,
          pageTo: 47,
          passage: "Nearby support",
        },
      },
      { raw: "Ex. 7 at 3", outcome: "choose", candidates: [{ id: "doc-2", name: "Exhibit 7" }] },
    ];
    vi.mocked(generateText)
      .mockResolvedValueOnce({ text: "Judgement: unsupported" } as never)
      .mockResolvedValueOnce({ text: "Judgement: supported" } as never);
    expect(
      await judgeResolvedRecordCites(
        results,
        model,
        "The claim",
        new AbortController().signal,
        "en",
      ),
    ).toEqual({
      recordCites: [{ ...results[0], outcome: "unsupported" }, results[1]],
    });
    expect(generateText).toHaveBeenCalledTimes(2);
  });

  test("a judgement stopped part way is Not checked, stopped, and no later cite is sent", async () => {
    const controller = new AbortController();
    vi.mocked(generateText).mockImplementation(async () => {
      controller.abort();
      throw Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
    });
    const found = (raw: string): ResolvableRecordCiteResult => ({
      raw,
      outcome: "found",
      documentId: "doc-1",
      contentHash: "hash-1",
      location: { kind: "page", from: 3, to: 3 },
      pageFrom: 3,
      pageTo: 3,
      passage: "The cited lines",
    });
    const judged = await judgeResolvedRecordCites(
      [found("Ex. 7 at 3"), found("Ex. 8 at 3")],
      model,
      "The claim",
      controller.signal,
      "en",
    );

    expect(judged.recordCites.map((cite) => [cite.outcome, cite.reason])).toEqual([
      ["not-checked", "stopped"],
      ["not-checked", "stopped"],
    ]);
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  test("a supported cited passage does not show its nearby candidate", async () => {
    const result: ResolvableRecordCiteResult = {
      raw: "Ex. 7 at 3",
      outcome: "found",
      documentId: "doc-1",
      location: { kind: "page", from: 3, to: 3 },
      pageFrom: 3,
      pageTo: 3,
      passage: "Exact support",
      nearby: {
        location: { kind: "page", from: 4, to: 4 },
        pageFrom: 4,
        pageTo: 4,
        passage: "Unneeded nearby text",
      },
    };
    vi.mocked(generateText).mockResolvedValue({ text: "Judgement: supported" } as never);

    const judged = await judgeResolvedRecordCites(
      [result],
      model,
      "The claim",
      new AbortController().signal,
      "en",
    );

    expect(judged).toMatchObject({ recordCites: [{ outcome: "supported" }] });
    expect("recordCites" in judged && judged.recordCites[0]?.nearby).toBeUndefined();
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  test("one unreadable cite is Not checked while later cites keep their outcomes", async () => {
    const results = ["First", "Second", "Third"].map(
      (raw): ResolvableRecordCiteResult => ({
        raw,
        outcome: "found",
        passage: `${raw} passage`,
        nearby: {
          location: { kind: "page", from: 1, to: 1 },
          pageFrom: 1,
          pageTo: 1,
          passage: "Unverified nearby text",
        },
      }),
    );
    vi.mocked(generateText)
      .mockResolvedValueOnce({ text: "Judgement: supported" } as never)
      .mockResolvedValueOnce({ text: "unreadable" } as never)
      .mockResolvedValueOnce({ text: "Judgement: supported" } as never);

    const judged = await judgeResolvedRecordCites(
      results,
      model,
      "The claim",
      new AbortController().signal,
      "en",
    );

    expect(judged.recordCites.map((result) => result.outcome)).toEqual([
      "supported",
      "not-checked",
      "supported",
    ]);
    expect(judged.recordCites[1]).toMatchObject({ reason: "malformed" });
    expect(judged.recordCites[1]?.nearby).toBeUndefined();
    expect(judged.failure).toEqual({ unreadable: true });
    expect(generateText).toHaveBeenCalledTimes(3);
  });

  test("nearby candidates are tried until one supports the claim", async () => {
    const result: ResolvableRecordCiteResult = {
      raw: "Smith Dep. 45:3",
      outcome: "found",
      passage: "Wrong cited lines",
      nearbyCandidates: [
        {
          location: { kind: "page", from: 45, to: 45, lines: { from: 4, to: 4 } },
          pageFrom: 45,
          pageTo: 45,
          passage: "Unrelated later lines",
        },
        {
          location: { kind: "page", from: 45, to: 45, lines: { from: 2, to: 2 } },
          pageFrom: 45,
          pageTo: 45,
          passage: "Supporting earlier lines",
        },
      ],
    };
    vi.mocked(generateText)
      .mockResolvedValueOnce({ text: "Judgement: unsupported" } as never)
      .mockResolvedValueOnce({ text: "Judgement: unsupported" } as never)
      .mockResolvedValueOnce({ text: "Judgement: supported" } as never);

    const judged = await judgeResolvedRecordCites(
      [result],
      model,
      "The claim",
      new AbortController().signal,
      "en",
    );

    expect(judged.recordCites[0]).toMatchObject({
      outcome: "unsupported",
      nearby: { passage: "Supporting earlier lines" },
    });
    expect(judged.recordCites[0]).not.toHaveProperty("nearbyCandidates");
  });

  test("an unreadable optional nearby reply only omits the suggestion", async () => {
    const result: ResolvableRecordCiteResult = {
      raw: "Smith Dep. 45:3",
      outcome: "found",
      passage: "Wrong cited lines",
      nearby: {
        location: { kind: "page", from: 45, to: 45, lines: { from: 4, to: 4 } },
        pageFrom: 45,
        pageTo: 45,
        passage: "Unreadable nearby reply",
      },
    };
    vi.mocked(generateText)
      .mockResolvedValueOnce({ text: "Judgement: unsupported" } as never)
      .mockResolvedValueOnce({ text: "unreadable" } as never);

    const judged = await judgeResolvedRecordCites(
      [result],
      model,
      "The claim",
      new AbortController().signal,
      "en",
    );

    expect(judged.recordCites[0]).toMatchObject({ outcome: "unsupported" });
    expect(judged.recordCites[0]?.nearby).toBeUndefined();
    expect(judged.failure).toBeUndefined();
  });
});
