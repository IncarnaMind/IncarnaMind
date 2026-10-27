import { describe, expect, test } from "vitest";
import type { AnswerToolCall, ConversationAnswer, ConversationMessage } from "../../src/core";
import { conversationContext, estimateTokens } from "../../src/core/answers/context";
import { type ChangeState, toolRecord, toolRecordLines } from "../../src/core/answers/toolRecord";

/**
 * The record of what an Answer's Tool calls really did, as the next
 * Question reads it: what each changed and in which Mind, or why nothing
 * changed, from the calls' cards alone.
 */

const names = (mindId: string) => (mindId === "m1" ? "Tide notes" : null);

const call = (
  fields: Partial<AnswerToolCall> & Pick<AnswerToolCall, "tool" | "source">,
): AnswerToolCall => ({ id: fields.tool, input: {}, status: "done", resultCount: null, ...fields });

describe("The record of an Answer's Tool calls", () => {
  // protects=each kind of call reads as what it really did, its Mind by its name now; fails_when=a failed call reads as done, a change loses its Mind or count, or a revision reads as an addition; no_claim=how a model reads it.
  test("each call as what it did", () => {
    const change = (fields: object) => ({
      mindId: "m1",
      created: false,
      request: "r",
      proposals: 7,
      ...fields,
    });
    expect(
      toolRecordLines(
        [
          call({
            tool: "search_documents",
            source: "documents",
            input: { query: "tides" },
            resultCount: 8,
          }),
          call({
            tool: "read_document",
            source: "documents",
            input: { document: "Filing", pages: "12–13" },
            resultCount: 2,
          }),
          call({
            tool: "search_documents",
            source: "documents",
            input: { query: "moon" },
            status: "failed",
          }),
          call({
            tool: "create_mind",
            source: "minds",
            input: { title: "Tides" },
            mindChange: change({ created: true }),
          }),
          call({
            tool: "create_mind",
            source: "minds",
            input: { title: "Empty" },
            mindChange: change({ mindId: "m2", created: true, proposals: 0 }),
          }),
          call({ tool: "add_to_mind", source: "minds", mindChange: change({ proposals: 1 }) }),
          call({
            tool: "edit_mind",
            source: "minds",
            input: { part: "Summary" },
            mindChange: change({ proposals: 2 }),
          }),
          call({ tool: "edit_mind", source: "minds", mindChange: change({ revised: true }) }),
          call({ tool: "edit_mind", source: "minds", input: { mind: "Q3 review" } }),
          call({
            tool: "edit_mind",
            source: "minds",
            status: "failed",
            mindProblem: { kind: "waiting", mindId: "m1", count: 12, mixed: false },
          }),
          call({
            tool: "read_mind",
            source: "minds",
            status: "failed",
            input: { mind: "Chapter 9" },
            mindProblem: { kind: "not-found", name: "Chapter 9" },
          }),
          call({
            tool: "read_web_page",
            source: "web",
            input: { url: "https://example.com" },
            webPage: { address: "https://example.com", documentId: "d", name: "Example" },
          }),
          call({
            tool: "book_boat",
            source: "connector",
            connector: { id: "c", name: "Boats" },
            status: "failed",
            approval: "denied",
          }),
          call({ tool: "sign_in", source: "connector", status: "failed", signInRequired: true }),
        ],
        names,
      ),
    ).toEqual([
      "- search_documents “tides”: 8 Passages",
      "- read_document “Filing” pages 12–13: 2 Passages",
      "- search_documents “moon”: failed",
      "- create_mind: made the Mind “Tide notes” and proposed 7 changes, waiting for the User",
      "- create_mind: made the Mind “Empty”, empty",
      "- add_to_mind “Tide notes”: proposed 1 new Block, waiting for the User",
      "- edit_mind “Tide notes” (section “Summary”): proposed 2 changes, waiting for the User",
      "- edit_mind “Tide notes”: revised your own waiting text in place, and proposed 7 changes, waiting for the User",
      "- edit_mind “Q3 review”: no change was needed",
      "- edit_mind “Tide notes”: nothing changed: 12 changes the assistant can't revise waited there for the User",
      "- read_mind “Chapter 9”: couldn't read it: no Mind is called “Chapter 9”",
      "- read_web_page https://example.com: saved as the Document “Example”",
      "- book_boat (the Connector “Boats”): the User denied it, so it wasn't made",
    ]);
  });

  // protects=a Word export's line in the record says where the file went (the Output location), how the text IncarnaMind wrote was marked, and where that choice came from now that nothing is asked; fails_when=the line is a bare folder, or loses the marking or its source, so a later reply "corrects" a true one; no_claim=how a model reads it.
  test("a Word export says its marking, and where the choice came from (#1535, #1945)", () => {
    const exported = (marking: object) =>
      call({
        tool: "run_command",
        source: "commands",
        command: {
          command: "mind.export",
          run: "r1",
          items: [{ kind: "mind", id: "m1", name: "Tides" }],
          file: {
            path: "/out/Tides.docx",
            name: "Tides.docx",
            folder: "/out",
            inDefaultFolder: false,
          },
          inOutputLocation: true,
          marking,
        } as never,
      });
    const lines = (each: AnswerToolCall) => toolRecordLines([each], names, () => null).at(0);
    expect(lines(exported({ choice: "leave", how: "default" }))).toBe(
      "- run_command mind.export: 1 item (“Tides”), saved as “Tides.docx” in the Output location, /out; the text IncarnaMind wrote is left unmarked, using the default for Word exports; that choice is now saved",
    );
    expect(lines(exported({ choice: "mark", how: "earlier" }))).toBe(
      "- run_command mind.export: 1 item (“Tides”), saved as “Tides.docx” in the Output location, /out; the text IncarnaMind wrote is marked with comments, following the choice saved for Word exports",
    );
    expect(lines(exported({ choice: "mark", how: "this-file" }))).toContain(
      "as the User's request named it for this file, their saved choice unchanged",
    );
  });

  // protects=the record says how many Citations a change wrote and how many markers it left out, and how many the reply holds; fails_when=a page whose Citations were lost reads as cited, or the reply's are left out; no_claim=none beyond protects.
  test("the Citations a change wrote, the markers it left out, and the reply's", () => {
    const made = call({
      tool: "create_mind",
      source: "minds",
      mindChange: { mindId: "m1", created: true, request: "r", proposals: 7, cited: 6 },
    });
    const lost = call({
      tool: "add_to_mind",
      source: "minds",
      mindChange: { mindId: "m1", created: false, request: "r", proposals: 2, unrecorded: 3 },
    });
    expect(toolRecord([made, lost], names, 9).split("\n").slice(2, -1)).toEqual([
      "- create_mind: made the Mind “Tide notes” and proposed 7 changes, waiting for the User, with 6 Citations",
      "- add_to_mind “Tide notes”: proposed 2 new Blocks, waiting for the User; 3 markers had no Citation recorded with cite, so they were left out",
      "- cite: 9 Citations in your reply; each reads as its source in brackets, like [Tides, p. 3]",
    ]);
  });

  // protects=an Answer with no calls adds no record, and one with calls is wrapped for the model; fails_when=an empty record is sent, or the block isn't marked; no_claim=none beyond protects.
  test("no calls, no record; otherwise one block", () => {
    expect(toolRecord([], names)).toBe("");
    expect(
      toolRecord(
        [call({ tool: "read_mind", source: "minds", input: { mind: "Tide notes" } })],
        names,
      ),
    ).toBe(
      [
        "<tool-record>",
        "What the Tools of your Answer above really did, as IncarnaMind recorded it:",
        "- read_mind “Tide notes”: read it",
        "</tool-record>",
      ].join("\n"),
    );
  });
});

describe("A record within the context's budget", () => {
  const KEPT_WITH_SEARCHES = 26;
  const searches = Array.from({ length: 12 }, (_, at) =>
    call({
      tool: "search_documents",
      source: "documents",
      input: { query: `tides and the moon, part ${at + 1}` },
      resultCount: 8,
    }),
  );
  const answer = (toolCalls: AnswerToolCall[], text: string): ConversationAnswer => ({
    kind: "answer",
    id: "a1",
    conversationId: "c",
    questionId: "q1",
    text,
    citations: [],
    figures: [],
    analyses: [],
    model: null,
    status: "done",
    errorKind: null,
    errorMessage: null,
    errorSignInRoute: null,
    citationSupport: null,
    toolCalls,
    textOrigin: null,
    read: null,
    steps: null,
    createdAt: "2026-10-16T00:00:00.000Z",
    updatedAt: "2026-10-16T00:00:00.000Z",
  });
  const earlier = (reply: ConversationAnswer): ConversationMessage[] => [
    {
      kind: "question",
      id: "q1",
      conversationId: "c",
      text: "write a summary page",
      askedFrom: null,
      focus: null,
      scope: null,
      model: null,
      forcedSkill: null,
      analyse: false,
      quotes: [],
      createdAt: "2026-10-16T00:00:00.000Z",
    },
    reply,
  ];
  const QUESTION = "make it longer";
  const sent = (messages: ConversationMessage[], budget: number) =>
    conversationContext(messages, QUESTION, { budget, mindNames: names })
      .messages.map((message) => message.content)
      .join("\n\n");

  // protects=a record that doesn't fit its share of the budget is left out whole, never cut; fails_when=part of a record is sent; no_claim=none beyond protects.
  test("a record that doesn't fit is left out whole, never cut", () => {
    const reply = answer(searches, "The papers say the moon drives the tides. ".repeat(4));
    const record = toolRecord(searches, names);
    const budget = estimateTokens(QUESTION) + estimateTokens(record) - 20;

    const text = sent(earlier(reply), budget);

    expect(text).not.toContain("tool-record");
    expect(text).not.toContain("search_documents");
    expect(text.endsWith(QUESTION)).toBe(true);
  });

  /** A conversation of `turns` Questions, each Answer with `calls` and a reply as long as a paragraph. */
  const conversation = (
    turns: number,
    calls: (turn: number) => AnswerToolCall[],
    id = (turn: number) => `a${turn}`,
  ): ConversationMessage[] =>
    Array.from({ length: turns }, (_, at): ConversationMessage[] => {
      const reply = answer(calls(at), `Answer ${at + 1}. ${"Tides follow the moon. ".repeat(8)}`);
      const [question] = earlier(reply);
      return [
        { ...question, id: `q${at + 1}`, text: `Question ${at + 1}` } as ConversationMessage,
        { ...reply, id: id(at), questionId: `q${at + 1}` },
      ];
    }).flat();

  const keptAnswers = (text: string) => [...text.matchAll(/Answer (\d+)\. /g)].length;

  // protects=search-only records compete like Answer text: as many Answers are kept as before records had a share of the budget; fails_when=a conversation of searches keeps fewer Answers (it fell from 13 to 8 with a half-budget cap on every record); no_claim=none beyond protects.
  test("a conversation of searches keeps as many Answers as before", () => {
    const turns = conversation(30, () => searches.slice(0, 10));

    expect(keptAnswers(sent(turns, 6_000))).toBe(KEPT_WITH_SEARCHES);
  });

  const made = call({
    tool: "create_mind",
    source: "minds",
    mindChange: { mindId: "m1", created: true, request: "r", proposals: 2 },
  });

  // protects=the Answer's text goes before its record does, and the record then says its Answer is left out; fails_when=the record goes with the text, or still points at an Answer above; no_claim=none beyond protects.
  test("a record outlasts its Answer's text", () => {
    const reply = answer([made], "The page sums up both papers. ".repeat(80));
    const record = toolRecord([made], names);
    const budget = estimateTokens(QUESTION) + estimateTokens(record) * 4;

    const text = sent(earlier(reply), budget);

    expect(text).not.toContain("The page sums up");
    expect(text).toContain("What the Tools of an earlier Answer of yours really did");
    expect(text).not.toContain("your Answer above");
    expect(text).toContain("- create_mind: made the Mind “Tide notes” and proposed 2 changes");
    expect(text.endsWith(QUESTION)).toBe(true);
    expect(sent(earlier(reply), 100_000)).toContain(
      `The page sums up both papers.\n\n${record}\n\n${QUESTION}`,
    );
  });

  // protects=when the budget holds only one record, the one of a Mind that is still there is kept and the one of a deleted Mind, though newer, goes; fails_when=the deleted Mind's record takes the place of the live one's; no_claim=none beyond protects.
  test("a record of a deleted Mind goes before one of a Mind that is still there", () => {
    const page = (mindId: string, title: string) =>
      call({
        tool: "create_mind",
        source: "minds",
        input: { title },
        mindChange: { mindId, created: true, request: mindId, proposals: 2 },
      });
    const live = page("m1", "Tide notes");
    const deleted = page("m2", "Notes on the winter storms and the harbour wall");
    const gone = (change: { mindId: string }) =>
      change.mindId === "m2" ? { waiting: 0, accepted: 0, rejected: 0, gone: true } : null;
    const turns = conversation(2, (turn) => [turn === 0 ? live : deleted]);
    const records = [live, deleted].map((each) => toolRecord([each], names, 0, gone));
    const [kept = 0, left = 0] = records.map((record) => estimateTokens(record));
    expect(left).toBeGreaterThan(kept + 8);
    const budget = estimateTokens(QUESTION) + kept * 2 + 10;

    const text = conversationContext(turns, QUESTION, {
      budget,
      mindNames: names,
      changeStates: gone,
    })
      .messages.map((message) => message.content)
      .join("\n\n");

    expect(text).toContain("made the Mind “Tide notes”");
    expect(text).not.toContain("winter storms");
  });

  // protects=thirty turns with long Answers fit the same budget as before, the first turn's record and the newest Answer in it and the first Answer's text out; fails_when=the context grows past the budget, the first record is lost, or the newest Answer goes; no_claim=none beyond protects.
  test("thirty turns: the budget holds, the first record stays and the first Answer's text goes", () => {
    const turns: ConversationMessage[] = Array.from(
      { length: 30 },
      (_, at): ConversationMessage[] => {
        const reply = answer(
          at === 0 ? [made] : [],
          `Answer ${at + 1}. ${"Tides follow the moon. ".repeat(120)}`,
        );
        return [
          {
            ...earlier(reply)[0],
            id: `q${at + 1}`,
            text: `Question ${at + 1}`,
          } as ConversationMessage,
          { ...reply, id: `a${at + 1}`, questionId: `q${at + 1}` },
        ];
      },
    ).flat();
    const budget = 12_000;

    const text = sent(turns, budget);

    // The blank lines between pieces aren't counted in the budget, as before.
    expect(estimateTokens(text)).toBeLessThanOrEqual(budget + 20);
    expect(text).toContain("- create_mind: made the Mind “Tide notes” and proposed 2 changes");
    expect(text).not.toContain("Answer 1. ");
    expect(text).toContain("Answer 30. ");
  });
});

describe("What became of a change, in its record", () => {
  const change = (proposals: number): AnswerToolCall =>
    call({
      tool: "add_to_mind",
      source: "minds",
      input: { mind: "Tide notes" },
      mindChange: { mindId: "m1", created: false, request: "r", proposals },
    });
  const line = (proposals: number, state: ChangeState | null) =>
    toolRecordLines([change(proposals)], names, () => state)[0];

  // protects=each fate of a change reads as what the User did: all rejected, all accepted, part accepted with the rest waiting, a mix, a Mind since deleted, and, in its own turn, one that applies at once (#1559); fails_when=a rejected page, or one that applied, still reads as waiting; no_claim=none beyond protects.
  test.each([
    [5, { waiting: 0, accepted: 0, rejected: 5 }, "then the User rejected all 5"],
    [3, { waiting: 0, accepted: 3, rejected: 0 }, "then the User accepted all 3"],
    [1, { waiting: 0, accepted: 0, rejected: 1 }, "then the User rejected it"],
    [3, { waiting: 1, accepted: 2, rejected: 0 }, "then the User accepted 2 of 3, 1 still waiting"],
    [3, { waiting: 0, accepted: 2, rejected: 1 }, "then the User accepted 2 and rejected 1"],
    [3, { waiting: 3, accepted: 0, rejected: 0 }, "waiting for the User"],
    [3, { waiting: 0, accepted: 0, rejected: 0, gone: true }, "but the Mind is no longer there"],
    [
      2,
      { waiting: 0, accepted: 0, rejected: 0, applied: true },
      "applied in the Mind at once, with Undo",
    ],
  ])("%i changes, %j", (proposals, state, said) => {
    expect(line(proposals, state)).toBe(
      `- add_to_mind “Tide notes”: proposed ${proposals} new Block${proposals === 1 ? "" : "s"}, ${said}`,
    );
  });

  // protects=decisions that don't fit the change (an Undo brought changes back) are not believed, and no state reads as waiting as before; fails_when=a change brought back reads as rejected; no_claim=none beyond protects.
  test("decisions that don't fit what waits are left out, and no state reads as waiting", () => {
    expect(line(3, { waiting: 3, accepted: 0, rejected: 3 })).toContain(", waiting for the User");
    expect(line(3, { waiting: 2, accepted: 1, rejected: 1 })).toContain(
      ", 2 of 3 still waiting for the User",
    );
    expect(line(3, { waiting: 0, accepted: 3, rejected: 3 })).toContain(", none waiting any more");
    expect(line(3, null)).toContain(", waiting for the User");
  });
});
