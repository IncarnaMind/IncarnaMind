import { describe, expect, test } from "vitest";
import type { AnswerToolCall, MindChange } from "../../src/core/api";
import { changedMinds } from "../../src/renderer/src/changedMinds";
import { translate } from "../../src/shared/i18n";

/*
 * The rows of an Answer's card of Minds changed (#202): one per Mind, in the
 * order the Answer first changed each, with every request of its changes there
 * and what its calls did: paragraphs written whole, places changed.
 */

let calls = 0;
const call = (tool: string, mindChange?: MindChange): AnswerToolCall => ({
  id: `call-${++calls}`,
  tool,
  source: "minds",
  input: {},
  status: mindChange ? "done" : "failed",
  resultCount: null,
  ...(mindChange && { mindChange }),
});

describe("The Minds an Answer changed", () => {
  // protects=one row per Mind, in order, with all its requests, made once it was made, and its counts from the calls; fails_when=a Mind shows twice, a request is lost, a made Mind reads as edited, or an edit counts as written; no_claim=how the card draws them.
  test("one row per Mind, in the order first changed, with every request there and what was done", () => {
    const rows = changedMinds({
      toolCalls: [
        call("read_mind"),
        call("edit_mind", { mindId: "a", created: false, request: "r1", proposals: 2 }),
        call("create_mind", {
          mindId: "b",
          created: true,
          request: "r2",
          proposals: 3,
          paragraphs: 2,
        }),
        call("add_to_mind", {
          mindId: "a",
          created: false,
          request: "r3",
          proposals: 1,
          paragraphs: 1,
        }),
        call("add_to_mind", {
          mindId: "b",
          created: false,
          request: "r4",
          proposals: 1,
          paragraphs: 1,
        }),
        call("edit_mind"),
      ],
    });
    expect(rows).toEqual([
      {
        mindId: "a",
        created: false,
        requests: ["r1", "r3"],
        wrote: 1,
        changed: 2,
        tables: 0,
        unlinkedSources: 0,
        droppedSources: 0,
        extraCells: 0,
      },
      {
        mindId: "b",
        created: true,
        requests: ["r2", "r4"],
        wrote: 3,
        changed: 0,
        tables: 0,
        unlinkedSources: 0,
        droppedSources: 0,
        extraCells: 0,
      },
    ]);
  });

  // protects=an empty Mind made with nothing in it is still a row, with no request; fails_when=it is left off the card; no_claim=none beyond protects.
  test("an empty Mind made is a row with no requests; an Answer that changed none has none", () => {
    expect(
      changedMinds({
        toolCalls: [call("create_mind", { mindId: "c", created: true, request: "", proposals: 0 })],
      }),
    ).toEqual([
      {
        mindId: "c",
        created: true,
        requests: [],
        wrote: 0,
        changed: 0,
        tables: 0,
        unlinkedSources: 0,
        droppedSources: 0,
        extraCells: 0,
      },
    ]);
    expect(changedMinds({ toolCalls: [call("read_mind")] })).toEqual([]);
  });

  // protects=a revision of the assistant's own waiting text counts its paragraphs as written, not places changed, and one that only removed text writes none; fails_when=it reads "Changed N places", or a removal reads as written; no_claim=none beyond protects.
  test("a revision of its own waiting text counts as paragraphs written, a removal as none", () => {
    expect(
      changedMinds({
        toolCalls: [
          call("edit_mind", {
            mindId: "a",
            created: false,
            request: "r1",
            proposals: 5,
            paragraphs: 3,
            revised: true,
          }),
        ],
      }),
    ).toEqual([
      {
        mindId: "a",
        created: false,
        requests: ["r1"],
        wrote: 3,
        changed: 0,
        tables: 0,
        unlinkedSources: 0,
        droppedSources: 0,
        extraCells: 0,
      },
    ]);
    expect(
      changedMinds({
        toolCalls: [
          call("edit_mind", {
            mindId: "a",
            created: false,
            request: "r1",
            proposals: 0,
            revised: true,
          }),
        ],
      }),
    ).toEqual([
      {
        mindId: "a",
        created: false,
        requests: ["r1"],
        wrote: 0,
        changed: 0,
        tables: 0,
        unlinkedSources: 0,
        droppedSources: 0,
        extraCells: 0,
      },
    ]);
  });

  // protects=a table counts as a table, never as a place or as nothing: a rewrite's table isn't one of its places changed, and an added table alone still makes the row say what was added (#961); fails_when=a table alone reads as 0 changes, or a rewrite's table is also counted as a place; no_claim=how the card words it.
  test("tables count as tables: a rewrite's table is no place changed, and a table alone is something", () => {
    expect(
      changedMinds({
        toolCalls: [
          call("edit_mind", {
            mindId: "a",
            created: false,
            request: "r1",
            proposals: 5,
            tables: 1,
          }),
          call("add_to_mind", {
            mindId: "b",
            created: false,
            request: "r2",
            proposals: 2,
            tables: 1,
          }),
          call("edit_mind", {
            mindId: "c",
            created: false,
            request: "r3",
            proposals: 1,
            tables: 1,
          }),
        ],
      }),
    ).toEqual([
      {
        mindId: "a",
        created: false,
        requests: ["r1"],
        wrote: 0,
        changed: 4,
        tables: 1,
        unlinkedSources: 0,
        droppedSources: 0,
        extraCells: 0,
      },
      {
        mindId: "b",
        created: false,
        requests: ["r2"],
        wrote: 0,
        changed: 0,
        tables: 1,
        unlinkedSources: 0,
        droppedSources: 0,
        extraCells: 0,
      },
      {
        mindId: "c",
        created: false,
        requests: ["r3"],
        wrote: 0,
        changed: 0,
        tables: 1,
        unlinkedSources: 0,
        droppedSources: 0,
        extraCells: 0,
      },
    ]);
  });

  // protects=what a Mind's tables kept as text is summed over its calls, for the card's note (#961); fails_when=a call's unlinked sources or extra cells are lost; no_claim=how the card words it.
  test("sources that couldn't be linked and extra cells add up per Mind", () => {
    const [row] = changedMinds({
      toolCalls: [
        call("add_to_mind", {
          mindId: "a",
          created: false,
          request: "r1",
          proposals: 1,
          tables: 1,
          unlinkedSources: 2,
          droppedSources: 1,
        }),
        call("edit_mind", {
          mindId: "a",
          created: false,
          request: "r2",
          proposals: 1,
          tables: 1,
          unlinkedSources: 1,
          extraCells: 3,
        }),
      ],
    });
    expect(row).toMatchObject({ tables: 2, unlinkedSources: 3, droppedSources: 1, extraCells: 3 });
  });

  // protects=the card's note on a table's sources uses the glossary's word for a Citation's source, 出处, in Chinese (#961); fails_when=it says 来源; no_claim=how the card lays it out.
  test("the note on a table's sources says 出处 in Chinese", () => {
    expect(translate("zh-CN", "mindChanges.unlinked.one")).toBe(
      "· 表格中有 1 处出处无法关联，已作为文字显示",
    );
    expect(translate("zh-CN", "mindChanges.unlinked", { count: 3 })).toBe(
      "· 表格中有 3 处出处无法关联，已作为文字显示",
    );
    expect(translate("zh-CN", "mindChanges.dropped", { count: 2 })).toBe(
      "· 有 2 处出处无法匹配，已删去",
    );
  });
});
