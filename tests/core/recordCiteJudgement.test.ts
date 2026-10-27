import { generateText } from "ai";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  judgeRecordCite,
  judgeResolvedRecordCites,
  recordCiteVersions,
} from "../../src/core/answers/checks/recordCites";
import type { RecordCiteResult } from "../../src/core/api";
import type { PreparedChatModel } from "../../src/core/providers/chat";

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
    vi.mocked(generateText).mockResolvedValue({ text: "same" } as never);
    expect(
      await judgeRecordCite(model, "The claim", "Exact lines", new AbortController().signal, "en"),
    ).toEqual({ outcome: "supported" });
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(vi.mocked(generateText).mock.calls[0]?.[0]?.prompt).toContain(
      "<quote>\nExact lines\n</quote>",
    );
    expect(vi.mocked(generateText).mock.calls[0]?.[0]?.prompt).not.toContain("Smith Dep. 45:3");
  });

  test("Partly keeps both parts from the same fixed passage", async () => {
    vi.mocked(generateText)
      .mockResolvedValueOnce({ text: "neither" } as never)
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

  test("Not found does not widen to another source", async () => {
    vi.mocked(generateText)
      .mockResolvedValueOnce({ text: "conflict" } as never)
      .mockResolvedValueOnce({ text: "No parts" } as never);
    expect(
      await judgeRecordCite(model, "The claim", "Only page 5", new AbortController().signal, "en"),
    ).toEqual({ outcome: "not-found" });
    expect(vi.mocked(generateText).mock.calls[1]?.[0]?.prompt).toContain("Only page 5");
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
    ).toEqual({
      failed: { kind: "unknown", message: "The check gave no verdict." },
    });
  });

  test("a resolved not-found keeps a supported nearby suggestion, and choices need no model", async () => {
    const results: RecordCiteResult[] = [
      {
        raw: "Smith Dep. 45:3",
        outcome: "supported",
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
      .mockResolvedValueOnce({ text: "neither" } as never)
      .mockResolvedValueOnce({ text: "No parts" } as never)
      .mockResolvedValueOnce({ text: "same" } as never);
    expect(
      await judgeResolvedRecordCites(
        results,
        model,
        "The claim",
        new AbortController().signal,
        "en",
      ),
    ).toEqual({
      recordCites: [{ ...results[0], outcome: "not-found" }, results[1]],
    });
    expect(generateText).toHaveBeenCalledTimes(3);
    expect(recordCiteVersions(results)).toEqual([{ documentId: "doc-1", contentHash: "hash-1" }]);
  });

  test("a supported cited passage does not show its nearby candidate", async () => {
    const result: RecordCiteResult = {
      raw: "Ex. 7 at 3",
      outcome: "supported",
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
    vi.mocked(generateText).mockResolvedValue({ text: "same" } as never);

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
});
