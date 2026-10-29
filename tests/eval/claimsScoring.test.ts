/**
 * The claims request's scoring (eval/repeats, #1682): what each call decided of each sentence,
 * as the app reads its replies, and the left-out rate of each claim kind.
 */
import { describe, expect, test } from "vitest";
import { claimKindOf, KIND_SETS, SETS } from "../../eval/repeats/cases";
import {
  type ClaimRow,
  claimsReport,
  decisionOf,
  decisionsIn,
  summariseClaims,
} from "../../eval/repeats/claimsScore";
import type { ClaimsRequest } from "../../eval/repeats/requests";

const request = (asked: string[], reply: string): ClaimsRequest => ({
  asked: asked.map((text, index) => `[${index + 1}] ${text}`).join("\n"),
  reply,
  inputTokens: 100,
  outputTokens: 10,
  ms: 500,
});

const richRequest = (sentences: readonly { number: number; text: string }[], reply: unknown): ClaimsRequest => ({
  ...request([], ""),
  asked: JSON.stringify({ sentences }),
  reply: JSON.stringify(reply),
});

describe("What a call of the claims request decided", () => {
  test("a sentence the first reply skips is decided by the reply asked again, alone, with its own number", () => {
    const first = request(["A claim.", "Another claim.", "Not one?"], '{"1": "claim", "3": "no"}');
    const again: ClaimsRequest = { ...first, asked: "[2] Another claim.", reply: '{"2": "claim"}' };
    const found = decisionsIn([first, again]);

    expect(decisionOf(found, "A claim.")).toBe("claim");
    expect(decisionOf(found, "Another claim.")).toBe("claim");
    expect(decisionOf(found, "Not one?")).toBe("left-out");
    expect(decisionOf(found, "A figure of 12%.")).toBe("not-shown");
  });

  test("a sentence no reply decides is undecided; with no readable reply, every sentence is unread", () => {
    const first = request(["A claim.", "Another claim."], '{"1": "claim"}');
    const again: ClaimsRequest = { ...first, asked: "[2] Another claim.", reply: "{}" };
    expect(decisionOf(decisionsIn([first, again]), "Another claim.")).toBe("undecided");
    expect(decisionOf(decisionsIn([request(["A claim."], "No idea.")]), "A claim.")).toBe("unread");
  });

  test.each([
    { fact: "  Revenue rose.\nWe should wait.  ", claim: "Revenue rose.", opinion: "We should wait.", question: "Should we wait?\nUntil next year?" },
    { fact: "  收入增长。\n我们应该等待。  ", claim: "收入增长。", opinion: "我们应该等待。", question: "是否等待？\n等到明年吗？" },
  ])("rich replies keep exact multiline words and global numbers: $claim", ({ fact, claim, opinion, question }) => {
    const found = decisionsIn([richRequest([{ number: 13, text: fact }, { number: 27, text: question }], {
      sentences: [
        { number: 13, parts: [{ kind: "fact", text: claim }, { kind: "opinion", text: opinion }] },
        { number: 27, parts: [] },
      ],
    })]);
    expect(decisionOf(found, fact)).toBe("claim");
    expect(decisionOf(found, question)).toBe("left-out");
    expect(decisionOf(found, fact.trim())).toBe("not-shown");
  });

  test.each(["We should wait.\nThis seems risky.", "我们应该等待。\n这似乎有风险。"])(
    "a missing-only rich retry decides its original global number: %s", (opinion) => {
      const fact = "Revenue rose.";
      const first = richRequest([{ number: 13, text: fact }, { number: 27, text: opinion }], {
        sentences: [{ number: 13, parts: [{ kind: "fact", text: fact }] }],
      });
      const again = richRequest([{ number: 27, text: opinion }], {
        sentences: [{ number: 27, parts: [{ kind: "opinion", text: opinion }] }],
      });
      const found = decisionsIn([first, again]);
      expect(decisionOf(found, fact)).toBe("claim");
      expect(decisionOf(found, opinion)).toBe("left-out");
      expect(decisionOf(decisionsIn([first]), opinion)).toBe("undecided");
    },
  );

  test("a readable empty rich inventory is undecided; an invalid literal part is unread", () => {
    const sentences = [{ number: 27, text: "收入增长。\n我们应该等待。" }];
    const empty = richRequest(sentences, { sentences: [] });
    expect(decisionOf(decisionsIn([empty]), sentences[0]?.text ?? "")).toBe("undecided");
    const invalid = richRequest(sentences, { sentences: [{ number: 27, parts: [{ kind: "fact", text: "Unstated words." }] }] });
    expect(decisionOf(decisionsIn([invalid]), sentences[0]?.text ?? "")).toBe("unread");
  });
});

describe("The left-out rate of each kind", () => {
  const row = (call: number, key: string, decision: ClaimRow["decision"]): ClaimRow => {
    const sentence = KIND_SETS[0]?.sentences.find((each) => each.key === key);
    if (!sentence) throw new Error(`No sentence ${key}`);
    return { set: "en-kinds", model: "m", call, ...sentence, decision };
  };

  test("counts a claim left out or undecided, and a sentence that makes no claim named", () => {
    const rows = [
      row(1, "lunch", "claim"),
      row(2, "lunch", "left-out"),
      row(3, "lunch", "undecided"),
      row(1, "opinion", "left-out"),
      row(2, "opinion", "claim"),
      row(3, "opinion", "left-out"),
      row(1, "salary", "not-shown"),
    ];
    const [summary] = summariseClaims(rows, new Map());

    expect(summary?.kinds).toEqual([
      { claim: "negation", sentences: 1, asked: 3, wrong: 2, undecided: 1 },
      { claim: "none", sentences: 1, asked: 3, wrong: 1, undecided: 0 },
    ]);
    expect(summary?.notShown).toEqual(["salary"]);
    expect(claimsReport(summary ? [summary] : [], { commit: "abc", spent: 0, calls: 3 })).toContain(
      "| negation | 1 | 3 | 2 | 1 | 66.7% |",
    );
  });

  test("every conflict sentence has a kind, and the claim kinds Minds hold every kind and sentences that make no claim", () => {
    for (const set of SETS.filter((each) => each.id.endsWith("-conflicts"))) {
      const kinds = new Set(set.sentences.map((sentence) => claimKindOf(set, sentence)));
      for (const kind of ["negation", "number", "name", "modal", "party"] as const) {
        expect(kinds).toContain(kind);
      }
    }
    for (const set of KIND_SETS) {
      const kinds = set.sentences.map((sentence) => sentence.claim);
      for (const kind of ["negation", "number", "name", "modal", "party", "none"] as const) {
        expect(kinds.filter((each) => each === kind).length).toBeGreaterThanOrEqual(3);
      }
    }
  });
});
