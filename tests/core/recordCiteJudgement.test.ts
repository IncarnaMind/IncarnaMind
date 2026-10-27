import { generateText } from "ai";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { judgeRecordCite } from "../../src/core/answers/checks/recordCites";
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
      await judgeRecordCite(
        model,
        "The claim",
        "Smith Dep. 45:3",
        "Exact lines",
        new AbortController().signal,
        "en",
      ),
    ).toEqual({ outcome: "supported" });
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(vi.mocked(generateText).mock.calls[0]?.[0]?.prompt).toContain("Exact lines");
    expect(vi.mocked(generateText).mock.calls[0]?.[0]?.prompt).toContain("Smith Dep. 45:3");
  });

  test("Partly keeps both parts from the same fixed passage", async () => {
    vi.mocked(generateText)
      .mockResolvedValueOnce({ text: "neither" } as never)
      .mockResolvedValueOnce({ text: "Covered: speed\nNot covered: robustness" } as never);
    expect(
      await judgeRecordCite(
        model,
        "The claim",
        "Ex. 7 at 3",
        "Only page 3",
        new AbortController().signal,
        "en",
      ),
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
      await judgeRecordCite(
        model,
        "The claim",
        "ECF No. 41 at 5",
        "Only page 5",
        new AbortController().signal,
        "en",
      ),
    ).toEqual({ outcome: "not-found" });
    expect(vi.mocked(generateText).mock.calls[1]?.[0]?.prompt).toContain("Only page 5");
  });

  test("a malformed first reply is a failure, never a supported result", async () => {
    vi.mocked(generateText).mockResolvedValue({ text: "unreadable" } as never);
    expect(
      await judgeRecordCite(
        model,
        "The claim",
        "PL-000123",
        "The identifier",
        new AbortController().signal,
        "en",
      ),
    ).toEqual({
      failed: { kind: "malformed", message: "The check gave no verdict." },
    });
  });
});
