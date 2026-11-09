/**
 * The floating panel ends the check of a help reply it asked for itself once it no longer shows
 * it, and never ends the reply, a pinned one's check or one asked in the assistant (#2847).
 */
import { describe, expect, test } from "vitest";
import { createOwnHelps } from "../../src/renderer/src/meetingPanel/ownHelps";
import type { ShownHelp } from "../../src/shared/meetingPanel";

const help = (answerId: string): ShownHelp => ({ conversationId: "c1", answerId });

function panel() {
  const ended: string[] = [];
  const told: string[][] = [];
  const own = createOwnHelps({
    end: (each) => ended.push(each.answerId),
    tell: (helps) => told.push(helps.map((each) => each.answerId)),
  });
  return { own, ended, told };
}

describe("the panel's own help replies", () => {
  test("the next press ends the check of the reply it replaces", () => {
    const { own, ended, told } = panel();
    own.asked(help("a"));
    own.showing(["a"]);
    own.asked(help("b"));
    own.showing(["b"]);

    expect(ended).toEqual(["a"]);
    expect(told.at(-1)).toEqual(["b"]);
  });

  test("a pinned reply keeps its check until it is unpinned and no longer shows", () => {
    const { own, ended } = panel();
    own.asked(help("a"));
    own.showing(["a"]);
    own.asked(help("b"));
    own.showing(["b", "a"]);
    expect(ended).toEqual([]);

    own.showing(["b"]);
    expect(ended).toEqual(["a"]);
  });

  test("a reply asked in the assistant is never the panel's to end, though it shows it", () => {
    const { own, ended, told } = panel();
    own.showing(["from-assistant"]);
    own.asked(help("b"));
    own.showing(["b"]);

    expect(ended).toEqual([]);
    expect(told.at(-1)).toEqual(["b"]);
  });

  test("a reply asked before it shows isn't ended, and main hears of it once it shows", () => {
    const { own, ended, told } = panel();
    own.asked(help("a"));
    expect(told.at(-1)).toEqual([]);
    own.showing(["a"]);

    expect(ended).toEqual([]);
    expect(told.at(-1)).toEqual(["a"]);
  });

  test("each check ends once, however often the panel says what it shows", () => {
    const { own, ended } = panel();
    own.asked(help("a"));
    own.showing(["a"]);
    own.showing([]);
    own.showing([]);
    own.showing(["a"]);
    own.showing([]);

    expect(ended).toEqual(["a"]);
  });
});
