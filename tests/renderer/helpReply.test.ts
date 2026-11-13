/**
 * A help button's Answer during a call, read as the floating panel lays it out: options
 * with the recommended first and what each leads to, readings with the moment they rest on,
 * and short lines, while it streams too.
 */
import { describe, expect, test } from "vitest";
import {
  citationNumbers,
  helpItems,
  helpParts,
  helpToKeep,
  quoted,
  sentencePassed,
  uncheckedReason,
} from "../../src/renderer/src/helpReply";
import { citedSentences } from "../../src/shared/citedSentences";
import { readHelpReply, shownItems } from "../../src/shared/helpReplyRead";
import type { MeetingHelpKind } from "../../src/shared/meetingHelp";

const textOf = (pieces: ReturnType<typeof readHelpReply>[number]["lead"]) =>
  pieces.map((piece) => (piece.kind === "text" ? piece.text : `[${piece.marker}]`)).join("");

describe("A help reply", () => {
  test("options: the recommended first, each with what it leads to, its Citation kept apart", () => {
    const items = readHelpReply(
      "★ We can't go below list, but we can extend the pilot to 60 days. [^1]\n→ keeps the deal moving\n\nLet me check with the team.\n→ buys time",
    );
    expect(items).toHaveLength(2);
    expect(items[0]?.recommended).toBe(true);
    expect(textOf(items[0]?.lead ?? [])).toBe(
      "We can't go below list, but we can extend the pilot to 60 days. [1]",
    );
    expect(textOf(items[0]?.effect ?? [])).toBe("keeps the deal moving");
    expect(items[1]?.recommended).toBe(false);
    expect(textOf(items[1]?.effect ?? [])).toBe("buys time");
  });

  test("an option shows in quotation marks of the panel's own, the model's own read off, its Citation after them", () => {
    const [item] = helpItems(
      { text: '★ "Yes, Enterprise is $45 a seat" [^1]\n→ answers at once', status: "done" },
      "answer",
    );
    expect(textOf(quoted(item?.lead ?? []))).toBe("“Yes, Enterprise is $45 a seat”[1]");
    const [chinese] = helpItems(
      { text: "★ 是的，企业版每席位每月 $45。[^2]\n→ 直接回答", status: "done" },
      "answer",
    );
    expect(textOf(quoted(chinese?.lead ?? []))).toBe("“是的，企业版每席位每月 $45。”[2]");
  });

  test("readings: the moment of the transcript is a note between the reading and its move", () => {
    const items = readHelpReply(
      "★ They want the total for 40 seats under £10k\n12:04 “our budget stops at ten thousand” [^1]\n→ give the tiered price\n\nThey may be comparing you with another vendor\n12:06 “the other quote we have” [^2]\n→ ask what matters most",
    );
    expect(items).toHaveLength(2);
    expect(items[0]?.notes.map(textOf)).toEqual(["12:04 “our budget stops at ten thousand” [1]"]);
    expect(items[1]?.notes.map(textOf)).toEqual(["12:06 “the other quote we have” [2]"]);
  });

  test("lines: each bullet is one, with no lead-in or Citation definitions shown", () => {
    const items = readHelpReply(
      "**Summary**\n- The launch moves to 18 November [^1]\n- The preview stays on 28 October\n\n[^1]: Transcript",
    );
    expect(items.map((item) => textOf(item.lead))).toEqual([
      "Summary",
      "The launch moves to 18 November [1]",
      "The preview stays on 28 October",
    ]);
  });

  test("only the first star is a recommendation", () => {
    const items = readHelpReply("★ One\n→ a\n\n★ Two\n→ b");
    expect(items.map((item) => item.recommended)).toEqual([true, false]);
  });

  test("the panel shows at most two options, dropping a lead-in or a remark a model adds anyway", () => {
    const items = readHelpReply(
      "I'll answer from the transcript.\n\n★ One\n→ a\n\nTwo\n→ b\n\nThree\n→ c\n\nNote: check the price.",
    );
    const shown = shownItems(items, { shape: "options", leadIn: false, streaming: false });
    expect(shown.map((item) => textOf(item.lead))).toEqual(["One", "Two"]);
  });

  test("Am I leading them? keeps its first line; an option being written shows as it streams", () => {
    const leading = readHelpReply(
      "A little: it suggests the answer.\n★ Ask instead: what happened?\n→ hears",
    );
    expect(
      shownItems(leading, { shape: "options", leadIn: true, streaming: false }).map((item) =>
        textOf(item.lead),
      ),
    ).toEqual(["A little: it suggests the answer.", "Ask instead: what happened?"]);
    const writing = readHelpReply("★ We can extend the pil");
    expect(shownItems(writing, { shape: "options", leadIn: false, streaming: true })).toHaveLength(
      1,
    );
  });

  test("short lines keep only the marked ones, at most three", () => {
    const items = readHelpReply("Here is the summary:\n- a\n- b\n- c\n- d");
    expect(
      shownItems(items, { shape: "lines", leadIn: false, streaming: false }).map((item) =>
        textOf(item.lead),
      ),
    ).toEqual(["a", "b", "c"]);
  });

  test("with the live text behind, its one line shows first, in every shape, and alone when it is all there is (#1366)", () => {
    const behind = "The live text is behind, so this rests on the lines so far.";
    const shown = (text: string, shape: "options" | "lines") =>
      shownItems(readHelpReply(text), { shape, leadIn: true, streaming: false }).map((item) =>
        textOf(item.lead),
      );
    expect(shown(`${behind}\n\n★ One\n→ a\n\nTwo\n→ b`, "options")).toEqual([behind, "One", "Two"]);
    expect(shown(`${behind}\n\n- a\n- b\n- c`, "lines")).toEqual([behind, "a", "b"]);
    expect(shown(behind, "options")).toEqual([behind]);
    expect(shown(behind, "lines")).toEqual([behind]);
  });

  // protects=while a reply is written, the notes a model writes before its form (and the core then takes back) are never drawn, so no words show and then vanish: the outline stays until the first "★" or "- " line; fails_when=the notes are drawn while streaming, or a finished reply or a lead-in line is hidden; no_claim=how the outline looks (#2526).
  test("while it streams, nothing before the first ★ or - line is drawn; once written, as before", () => {
    const notes = "The newest lines: they ask about single sign-on, and the price sheet has it.";
    const shown = (text: string, shape: "options" | "readings" | "lines", streaming: boolean) =>
      shownItems(readHelpReply(text), { shape, leadIn: false, streaming }).map((item) =>
        textOf(item.lead),
      );
    expect(shown(notes, "options", true)).toEqual([]);
    expect(shown(`${notes}\n\n★ Yes, Enterprise inclu`, "options", true)).toEqual([
      "Yes, Enterprise inclu",
    ]);
    expect(shown(`${notes}\n\n★ One\n→ a\n\nTwo`, "options", true)).toEqual(["One", "Two"]);
    expect(shown(notes, "readings", true)).toEqual([]);
    expect(shown(notes, "lines", true)).toEqual([]);
    expect(shown(`${notes}\n- The pilot starts on 3 March`, "lines", true)).toEqual([
      "The pilot starts on 3 March",
    ]);
    expect(shown("One\n→ a\n\nTwo\n→ b", "options", false)).toEqual(["One", "Two"]);
    expect(shown("The pilot starts on 3 March", "lines", false)).toEqual([
      "The pilot starts on 3 March",
    ]);
    const leading = readHelpReply(`A little: it suggests the answer.\n\n${notes}`);
    expect(
      shownItems(leading, { shape: "options", leadIn: true, streaming: true }).map((item) =>
        textOf(item.lead),
      ),
    ).toEqual(["A little: it suggests the answer."]);
  });

  // protects=a finished reply shows every option or reading the panel showed while it was written, an item whose "→" line the core took back as the model's working included, in English and Chinese: a reply of one such item no longer ends with only the heading; fails_when=an item with no "→" line is dropped once the reply ends; no_claim=why the core takes the line back (#2767).
  test("once written, an option or reading whose → line was taken back still shows, in English and Chinese", () => {
    const shown = (text: string, shape: "options" | "readings", streaming: boolean) =>
      shownItems(readHelpReply(text), { shape, leadIn: false, streaming }).map((item) =>
        textOf(item.lead),
      );
    // Each reply as Claude Haiku 5.5 or DeepSeek V4.1 Flash wrote it, with its last "→" line
    // taken back once its Citations were recorded.
    const replies = [
      {
        shape: "readings" as const,
        text: "★ They want the system live before their June audit, within a fixed budget\n5:56 “Let me be straight about where we are” [^1]",
        shows: ["They want the system live before their June audit, within a fixed budget"],
      },
      {
        shape: "readings" as const,
        text: "★ 对方想要在六月审计前上线，并把每月预算控制在五万以内\n5:32 “我们必须在六月审计之前上线” [^1]",
        shows: ["对方想要在六月审计前上线，并把每月预算控制在五万以内"],
      },
      {
        shape: "options" as const,
        text: "★ How many support agents would your team have when the add-on starts, since we price it per agent at $12 a month [^1]",
        shows: [
          "How many support agents would your team have when the add-on starts, since we price it per agent at $12 a month [1]",
        ],
      },
      {
        shape: "options" as const,
        text: "★ 客服增值包的定价是按坐席数每月 80 元，你们预估需要多少个坐席 [^1]",
        shows: ["客服增值包的定价是按坐席数每月 80 元，你们预估需要多少个坐席 [1]"],
      },
      {
        shape: "readings" as const,
        text: "★ They want the rollout running before their June audit, within a fixed budget of eight thousand dollars a month\n5:56 “Let me be straight about where we are[^3].” [^1]\n→ Confirm June timeline and price against $8k/month cap\n\nActually, a more explicit reading of their last lines:\n\n★ They want the rollout finished before June, and total cost held at eight thousand dollars a month\n6:00 “We need this running before our audit in June[^4].” [^2]",
        shows: [
          "They want the rollout running before their June audit, within a fixed budget of eight thousand dollars a month",
          "They want the rollout finished before June, and total cost held at eight thousand dollars a month",
        ],
      },
      {
        shape: "readings" as const,
        text: "★ 对方想要在六月审计前上线，并把每月预算控制在五万以内\n5:32 “我们必须在六月审计之前上线” [^1]\n→ 先确认上线时间表能否赶在六月前，再谈价格\n\n★ 对方想先确认实施的时间安排和人员投入，再谈价格\n0:00 “在谈价格之前，能先讲讲头两周一般怎么安排吗” [^2]",
        shows: [
          "对方想要在六月审计前上线，并把每月预算控制在五万以内",
          "对方想先确认实施的时间安排和人员投入，再谈价格",
        ],
      },
    ];
    for (const reply of replies) {
      expect(shown(reply.text, reply.shape, false)).toEqual(reply.shows);
    }
    const [reading] = readHelpReply(replies[0]?.text ?? "");
    expect(reading?.notes.map(textOf)).toEqual([
      "5:56 “Let me be straight about where we are” [1]",
    ]);
    expect(reading?.effect).toBeNull();
  });

  // protects=the same reply shows no less once it ends than as it was last written: the item being written stays, and a remark another item follows is left out in both, in English and Chinese; fails_when=the end drops an item the last write showed; no_claim=what the core takes back (#2767).
  test("a reply shows no less once written than as it was last written, in English and Chinese", () => {
    const shown = (text: string, shape: "options" | "readings", streaming: boolean) =>
      shownItems(readHelpReply(text), { shape, leadIn: false, streaming }).map((item) =>
        textOf(item.lead),
      );
    const remark =
      "★ One\n→ a\n\nActually, a more explicit reading of their last lines:\n\n★ Two\n→ b";
    const replies: [string, "options" | "readings"][] = [
      ["★ We can extend the pil", "options"],
      ["★ 我们可以把试用延长", "options"],
      [
        "★ They want the system live before their June audit, within a fixed budget\n5:56 “Let me be straight about where we are.” [^1]\n→ Confirm a June go-live date, then probe the $8,000 monthly ceiling\n\nThey want the monthly cost held at eight thousand dollars\n6:00 “within eight thousand a month” [^2]",
        "readings",
      ],
      [
        "★ 对方想要在六月审计前上线，并把每月预算控制在五万以内\n5:32 “我们必须在六月审计之前上线” [^1]\n→ 先确认上线时间表能否赶在六月前，再谈价格\n\n对方想先确认实施的时间安排",
        "readings",
      ],
      ["I'll read it from the call.\n\n★ One\n→ a\n\nTwo", "options"],
      [remark, "readings"],
    ];
    for (const [text, shape] of replies) {
      const written = shown(text, shape, true);
      expect(written.length).toBeGreaterThan(0);
      expect(shown(text, shape, false)).toEqual(written);
    }
    expect(shown(remark, "readings", false)).toEqual(["One", "Two"]);
    expect(shown("One\n→ a\n\n★ Two\n→ b", "options", false)).toEqual(["One", "Two"]);
  });

  // protects=a help Answer stopped while it was written is read as it was then: what came before its first option stays undrawn, so one stopped before it shows no item and the panel says it was stopped, while what it wrote of its form stays, in English and Chinese; fails_when=a stopped Answer's notes show as an option, or what it wrote of its form is dropped; no_claim=the panel's wording (the smoke test) (#2778).
  test("a stopped Answer shows only what it wrote of its form, its lead-in line apart, in English and Chinese", () => {
    const notes = "The newest lines ask about the Enterprise price, and the price sheet has it.";
    const shown = (text: string, kind: MeetingHelpKind, status: "stopped" | "done" = "stopped") =>
      helpItems({ text, status }, kind).map((item) => textOf(item.lead));
    expect(shown("", "want")).toEqual([]);
    expect(shown(notes, "answer")).toEqual([]);
    expect(shown("最新的几句在问企业版的价格。", "want")).toEqual([]);
    expect(shown(notes, "sum")).toEqual([]);
    expect(shown(`${notes}\n\n★ Yes, Enterprise is $45 a se`, "answer")).toEqual([
      "Yes, Enterprise is $45 a se",
    ]);
    expect(shown("最新的几句在问价格。\n\n★ 对方想先确认价格\n→ 先报价", "want")).toEqual([
      "对方想先确认价格",
    ]);
    expect(shown(`${notes}\n- The launch moves to 18 November`, "sum")).toEqual([
      "The launch moves to 18 November",
    ]);
    expect(shown(notes, "answer", "done")).toEqual([notes]);
    const behind = "The live text is behind, so this rests on the lines so far.";
    const parts = (text: string, kind: MeetingHelpKind, textBehind: boolean) => {
      const { lead, options } = helpParts(
        { text, status: "stopped", steps: textBehind ? { textBehind } : null },
        kind,
      );
      return { lead: lead.map((item) => textOf(item.lead)), options: options.length };
    };
    expect(parts(`${behind}\n\n`, "want", true)).toEqual({ lead: [behind], options: 0 });
    expect(parts("实时转写跟不上，以下只依据已转写的内容。\n\n", "sum", true)).toEqual({
      lead: ["实时转写跟不上，以下只依据已转写的内容。"],
      options: 0,
    });
    expect(parts("A little: it suggests the answer.", "leading", false)).toEqual({
      lead: ["A little: it suggests the answer."],
      options: 0,
    });
    expect(parts(`${behind}\n\n★ One\n→ a`, "answer", true)).toEqual({
      lead: [behind],
      options: 1,
    });
  });

  // protects=Pin and Add to note are offered only for an ended Answer that shows an option, reading, short line or Am I leading them?'s lead-in, never for the app's line that the live text is behind alone, a stopped Answer or nothing, in English and Chinese; fails_when=they are offered with nothing to keep, or withheld from a suggestion; no_claim=the panel's layout (#2778).
  test("an Answer has something to pin or add only when it ended with a line of its own", () => {
    const behind = "The live text is behind, so this rests on the lines so far.";
    const keeps = (text: string, kind: MeetingHelpKind, status: "done" | "stopped" = "done") =>
      helpToKeep({ text, status, steps: { textBehind: true } }, kind);
    expect(keeps(`${behind}\n\n★ One\n→ a`, "answer")).toBe(true);
    expect(keeps("实时转写跟不上，以下只依据已转写的内容。\n\n- 一行", "sum")).toBe(true);
    expect(keeps(behind, "answer")).toBe(false);
    expect(keeps("实时转写跟不上，以下只依据已转写的内容。", "sum")).toBe(false);
    expect(keeps(`${behind}\n\n★ One\n→ a`, "answer", "stopped")).toBe(false);
    expect(
      helpToKeep({ text: "A little: it suggests the answer.", status: "done" }, "leading"),
    ).toBe(true);
    expect(helpToKeep({ text: "## What to ask next", status: "done" }, "ask")).toBe(false);
  });

  test("while it streams, an option before its arrow has no effect yet", () => {
    const items = readHelpReply("★ We can extend the pil");
    expect(items).toHaveLength(1);
    expect(items[0]?.effect).toBeNull();
  });

  // protects=the call help panel numbers its Citations from 1 in the order the reply cites them, a figure's input's ("[^9001]") included, as the assistant does (#1831); fails_when=a chip or source row reads "9001"; no_claim=how a chip looks.
  test("Citations are numbered from 1 in the order cited, never by the core's marker", () => {
    const items = readHelpReply(
      "★ Net debt is £310 million [^9001], inside the covenant [^2].\n→ answers at once\n\nThe rate was 4% [^2] [^7].\n→ gives the detail",
    );
    const known = new Set([9001, 2]);
    expect([...citationNumbers(items, (marker) => known.has(marker))]).toEqual([
      [9001, 1],
      [2, 2],
    ]);
  });

  // protects=a ✓ shows only where the sentence check passed the sentence a chip is cited in, counted as the core counts its markers (#2847); fails_when=a found or judged Citation alone shows ✓, a short line takes the ✓ its marker earned elsewhere, or the panel's places and the core's disagree; no_claim=what the check decides.
  test("a Citation shows ✓ only where the check passed the sentence it is cited in, the places counted as the core counts them", () => {
    const text =
      "## Notes\n★ Yes, Enterprise is $45 a seat [^1]\n→ Same price [^1]\n\nI'll confirm it in writing today [^2][^1]\n→ buys time\n[^9]: a definition";
    const chips = readHelpReply(text).flatMap((item) =>
      [item.lead, ...item.notes, item.effect ?? []]
        .flat()
        .flatMap((piece) => (piece.kind === "citation" ? [piece] : [])),
    );
    expect(chips.map(({ marker, at }) => [marker, at])).toEqual([
      [1, 0],
      [1, 1],
      [2, 2],
      [1, 3],
    ]);
    // The core's count: the judged sentences hold the first and last two places, the short line none.
    expect(citedSentences(text).map((each) => each.at)).toEqual([[0], [2, 3]]);

    const judged = {
      check: "unsupported" as const,
      judgedAt: "2026-11-09T20:00:00.000Z",
      passedAt: [0],
    };
    expect(chips.map((chip) => sentencePassed(judged, chip.at))).toEqual([
      true,
      false,
      false,
      false,
    ]);
    // Found by its quote, or judged as a Citation, it shows no ✓ without a place that passed.
    const foundOnly = { check: "found" as const, passedAt: undefined };
    const judgedOnly = {
      check: "found" as const,
      judgedAt: "2026-11-09T20:00:00.000Z",
      passedAt: undefined,
    };
    expect(sentencePassed(foundOnly, 0)).toBe(false);
    expect(sentencePassed(judgedOnly, 0)).toBe(false);
  });

  test("a chip names why its sentence was never checked only where the User can act on it", () => {
    expect(uncheckedReason({ check: "not-checked", checkReason: "monthly-limit" })).toBe(
      "monthly-limit",
    );
    expect(uncheckedReason({ check: "not-checked", checkReason: "answer-limit" })).toBe(
      "answer-limit",
    );
    expect(uncheckedReason({ check: "not-checked", checkReason: "small-model" })).toBe(
      "small-model",
    );
    // Kept too short by a limit to finish (#2962).
    expect(uncheckedReason({ check: "not-checked", checkReason: "monthly-limit-unfinished" })).toBe(
      "monthly-limit-unfinished",
    );
    expect(uncheckedReason({ check: "not-checked", checkReason: "answer-limit-unfinished" })).toBe(
      "answer-limit-unfinished",
    );
    // A line the check doesn't judge, a quote not found, and a sentence it judged say nothing more.
    expect(uncheckedReason({ check: "not-checked", checkReason: null })).toBeNull();
    expect(uncheckedReason({ check: "not-found", checkReason: "quote-not-on-pages" })).toBeNull();
    expect(uncheckedReason({ check: "unsupported", checkReason: null })).toBeNull();
  });
});

describe("An option the model wrapped in its own quotation marks (#2925)", () => {
  // protects=the panel shows an option the model wrapped in its own quotation marks in one pair of the panel's own, each chip at its marker's place, the place its check's verdict names; fails_when=the panel shows two pairs of marks, or a chip's place differs from the check's; no_claim=how the chip looks.
  test("shows in one pair of the panel's own, its chips where the check counts them", () => {
    const reply =
      '★ "We can extend the pilot to 60 days [^1]"\n→ keeps the deal moving [^2]\n\n“Let me check with the team” [^3]\n→ buys time';
    const items = helpItems({ text: reply, status: "done" }, "say");
    expect(items.map((item) => textOf(quoted(item.lead)))).toEqual([
      "“We can extend the pilot to 60 days”[1]",
      "“Let me check with the team”[3]",
    ]);
    const chips = items.flatMap((item) =>
      [item.lead, item.effect ?? []]
        .flat()
        .flatMap((piece) => (piece.kind === "citation" ? [piece.at] : [])),
    );
    expect(chips).toEqual(citedSentences(reply).flatMap((sentence) => sentence.at));
    expect(chips).toEqual([0, 1, 2]);
  });

  // protects=a reading and a short line are no options to say: they show as written, the model's marks kept; fails_when=a reading's moment or a quoted short line loses its marks, or shows in the panel's; no_claim=what the check finds.
  test("a reading and a short line keep the model's marks", () => {
    const [reading] = helpItems(
      { text: '★ "We can\'t go above forty" [^1]\n→ offer the two-year term', status: "done" },
      "want",
    );
    expect(reading?.said).toBe(false);
    expect(textOf(reading?.lead ?? [])).toBe('"We can\'t go above forty" [1]');
    const [line] = helpItems(
      { text: '- "nothing is drilled through the roof" [^1]', status: "done" },
      "sum",
    );
    expect(line?.said).toBe(false);
    expect(textOf(line?.lead ?? [])).toBe('"nothing is drilled through the roof" [1]');
  });
});
