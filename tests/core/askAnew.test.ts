import { describe, expect, test } from "vitest";
import { type AnswerEngineEvent, createAiSdkAnswerEngine } from "../../src/core/answers/engine";
import { anewInItsLanguage } from "../../src/core/answers/meetingHelp";
import { type ModelCall, scriptedModel } from "../helpers/models";

/** A reply written by the engine, the model giving `replies` in turn, as the Answer's text holds it. */
async function written(replies: readonly string[], asksAnew?: (firstLine: string) => boolean) {
  const calls: ModelCall[] = [];
  const model = scriptedModel((call) => {
    calls.push(call);
    return { text: replies[Math.min(calls.length, replies.length) - 1] ?? "" };
  });
  const events: AnswerEngineEvent[] = [];
  let text = "";
  /** The text as each event left it. */
  const texts: string[] = [];
  for await (const event of createAiSdkAnswerEngine().generate({
    instructions: () => "Answer briefly.",
    messages: [{ role: "user", content: "电池质保几年？" }],
    question: "电池质保几年？",
    model,
    documents: {
      documentCount: 0,
      searchDocuments: async () => ({ text: "", passageCount: 0 }),
      cite: () => "",
    },
    tools: [],
    signal: new AbortController().signal,
    ...(asksAnew && { asksAnew }),
  })) {
    events.push(event);
    if (event.type === "text-delta") text += event.text;
    if (event.type === "text-retracted") text = text.slice(0, -event.length);
    texts.push(text);
  }
  return { calls, events, text, texts };
}

const latin = (line: string) => /[A-Za-z]{3,}/.test(line);

describe("A typed reply in another language than its question and call, made anew once (#2925)", () => {
  // protects=a reply whose first line is in another language is made anew once with the very same request, nothing added for the reply to answer, and its first line stays on screen until the new reply's first words replace it, with one end; fails_when=the request is changed, the text is empty between the two, the first reply's end is announced, or the first reply is shown; no_claim=what a real model writes the second time.
  test("the same request again, the first line shown until the new reply's first words", async () => {
    const { calls, events, text, texts } = await written(
      ["The battery is covered for ten years.\nAsk them which model.", "电池质保十年。"],
      latin,
    );
    expect(calls).toHaveLength(2);
    expect(calls[1]?.prompt).toBe(calls[0]?.prompt);
    expect(calls[1]?.system).toBe(calls[0]?.system);
    expect(text).toBe("电池质保十年。");
    const retracted = events.findIndex((event) => event.type === "text-retracted");
    expect(texts[retracted - 1]).toMatch(/^The battery is covered/);
    expect(events[retracted + 1]).toEqual({ type: "text-delta", text: "电池质保十年。" });
    expect(texts.slice(0, retracted).every((each, at) => at === 0 || each !== "")).toBe(true);
    expect(events.filter((event) => event.type === "finished")).toHaveLength(1);
    // The runner is told before the new reply's first event, so none of it meets the first's records.
    const anew = events.findIndex((event) => event.type === "made-anew");
    expect(events.filter((event) => event.type === "made-anew")).toHaveLength(1);
    expect(anew).toBeGreaterThan(texts.findIndex((each) => each.startsWith("The battery")));
    expect(anew).toBeLessThan(retracted);
  });

  // protects=a reply of one line, which ends before any second line comes, is decided at its end, and its end isn't announced before the new reply's; fails_when=the first reply ends the Answer; no_claim=none beyond protects.
  test("a one-line reply is decided once it writes no more, and only the new reply ends", async () => {
    const { calls, events, text } = await written(
      ["The battery is covered for ten years.", "电池质保十年。"],
      latin,
    );
    expect(calls).toHaveLength(2);
    expect(text).toBe("电池质保十年。");
    expect(events.filter((event) => event.type === "finished")).toHaveLength(1);
  });

  // protects=it is made anew once only: the second reply is shown whatever its language; fails_when=it is asked a third time; no_claim=none beyond protects.
  test("once only: the second reply stands whatever its language", async () => {
    const { calls, text } = await written(
      ["The battery is covered for ten years.", "Ten years, for the battery."],
      latin,
    );
    expect(calls).toHaveLength(2);
    expect(text).toBe("Ten years, for the battery.");
  });

  // protects=a reply in its question's language, or a reply whose request doesn't ask for it, is never made anew and pays no wait; fails_when=it is asked twice; no_claim=none beyond protects.
  test("a reply in its question's language, or any other reply, is written once", async () => {
    const kept = await written(["电池质保十年。\n可以问他们型号。"], latin);
    expect(kept.calls).toHaveLength(1);
    expect(kept.events.some((event) => event.type === "made-anew")).toBe(false);
    expect((await written(["The battery is covered for ten years."])).calls).toHaveLength(1);
  });
});

describe("When a typed reply is made anew for its language (#2925)", () => {
  // protects=only when the question and the call are in one language is a first line in the other one made anew, in both directions; a Chinese question on an English call, or a line too short to tell, is left alone; fails_when=a line to say in the call's language is made anew, or a reply in the other language isn't; no_claim=how a model answers.
  test.each([
    ["电池质保几年？", "Chinese", "The battery is covered for ten years.", true],
    ["电池质保几年？", "Chinese", "★ 电池质保十年 [^1]", false],
    ["What's the battery's warranty?", "English", "电池质保十年。", true],
    ["What's the battery's warranty?", "English", "The battery is covered for ten years.", false],
    ["电池质保几年？", "Chinese", "★ 45 kWh", false],
  ])("a %s question on a %s call, first line “%s”: made anew %s", (asked, call, line, anew) => {
    expect(anewInItsLanguage(asked, call)?.(line)).toBe(anew);
  });

  test("a Chinese question on an English call, or a call whose language can't be told, isn't watched", () => {
    expect(anewInItsLanguage("电池质保几年？", "English")).toBeNull();
    expect(anewInItsLanguage("电池质保几年？", null)).toBeNull();
    expect(anewInItsLanguage("What's the battery's warranty?", "Chinese")).toBeNull();
  });
});
