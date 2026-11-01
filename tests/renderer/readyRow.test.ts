import { describe, expect, test } from "vitest";
import { readyRowOf } from "../../src/renderer/src/readyRow";

/*
 * What the first-open card's Ask row shows (#2218): the ready Question while nothing is asked,
 * what the press is waiting for while it is, and the reasons it has no Question — never a button
 * that takes a press and does nothing.
 */

const waiting = (patch: Partial<Parameters<typeof readyRowOf>[0]> = {}) =>
  readyRowOf({
    question: "What’s the leverage cap?",
    waitingFor: "Northwind Retail · Q3 2026 results",
    asking: false,
    pressedFor: null,
    reading: null,
    unread: 0,
    busy: false,
    ...patch,
  });

describe("the Ask row", () => {
  // protects=the row names the Document it is reading and offers Stop; fails_when=the Question can be pressed again while its Answer waits
  test("says what the press waits for, and the next Document as the read goes on", () => {
    expect(waiting({ asking: true })).toEqual({
      kind: "waiting",
      document: "Northwind Retail · Q3 2026 results",
    });
    expect(
      waiting({ asking: true, waitingFor: "Northwind Retail · Q3 2026 results later" }),
    ).toEqual({ kind: "waiting", document: "Northwind Retail · Q3 2026 results later" });
  });

  // protects=the row keeps saying what the press waits for when the core's answer moves on (the last Document read, the Question about their own file); fails_when=the pressed button comes back and the press can swallow itself
  test("keeps the name from the press when the core's answer moves on", () => {
    expect(waiting({ asking: true, waitingFor: null, pressedFor: "Their file" })).toEqual({
      kind: "waiting",
      document: "Their file",
    });
  });

  // protects=with nothing to name, the Question is still not pressable while its Answer waits; fails_when=a press can be taken twice
  test("offers no pressable Question while its Answer waits", () => {
    expect(waiting({ asking: true, waitingFor: null, pressedFor: null })).toEqual({
      kind: "question",
      disabled: true,
    });
  });

  // protects=the Question is pressable when nothing is in the way; fails_when=it is never pressable
  test("a Question with nothing in the way can be pressed", () => {
    expect(waiting()).toEqual({ kind: "question", disabled: false });
    expect(waiting({ busy: true })).toEqual({ kind: "question", disabled: true });
  });

  // protects=each of the row's other lines, so the reserved row is never blank; fails_when=one of them is missing
  test("says which file is reading, which could not be read, or to ask one's own", () => {
    expect(waiting({ question: null, reading: "Their brief" })).toEqual({
      kind: "reading",
      document: "Their brief",
    });
    expect(waiting({ question: null, unread: 2 })).toEqual({ kind: "unread", count: 2 });
    expect(waiting({ question: null })).toEqual({ kind: "own" });
  });
});
