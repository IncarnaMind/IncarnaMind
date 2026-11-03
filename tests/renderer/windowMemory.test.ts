import { describe, expect, test } from "vitest";
import type { AskedQuote } from "../../src/core/api";
import { draftsFrom, withQuotes, withReloaded } from "../../src/renderer/src/composer";

/*
 * What a reload of the window's page puts back of the composer (#1500): the drafts it kept,
 * as far as they read.
 */

const draft = { text: "Which tide is highest?", scope: null, skill: null, pastes: [] };

describe("The drafts a reload leaves", () => {
  test("a draft that reads is kept as it was, with its scope, Skill and pastes", () => {
    const full = {
      text: "Compare these",
      scope: { folderIds: ["f"], tagIds: [], documentIds: ["d"] },
      skill: "summarise-document",
      pastes: [
        { id: "p1", text: "A long paste.", place: { mindId: "mind", conversationId: null } },
      ],
    };

    expect(draftsFrom({ mind: draft, other: full })).toEqual({ mind: draft, other: full });
  });

  test("a draft that doesn't read is dropped and the others stay", () => {
    expect(
      draftsFrom({
        good: draft,
        noText: { ...draft, text: 3 },
        badScope: { ...draft, scope: { folderIds: "f", tagIds: [], documentIds: [] } },
        badPaste: { ...draft, pastes: [{ id: 1, text: "x" }] },
        placeLessPaste: { ...draft, pastes: [{ id: "p1", text: "x" }] },
        notAnObject: "text",
      }),
    ).toEqual({ good: draft });
  });

  // protects=what the app put in a composer by itself at its start, a Question that waited for Continue, is not wiped by what a reload left, and stays over it in the same Mind; fails_when=the reload's drafts replace the app's (#1500).
  test("what the app already put in a composer wins over what the reload left", () => {
    const kept = { ...draft, text: "What is in my Documents?" };
    const left = { mind: { ...draft, text: "An older draft" }, other: draft };

    expect(withReloaded({ mind: kept }, left)).toEqual({ mind: kept, other: draft });
    expect(withReloaded({ mind: kept }, null)).toEqual({ mind: kept });
    expect(withReloaded({}, left)).toEqual(left);
  });

  test("nothing, or something that isn't a set of drafts, is no drafts", () => {
    expect(draftsFrom(null)).toEqual({});
    expect(draftsFrom("drafts")).toEqual({});
    expect(draftsFrom([draft])).toEqual({});
  });
});

const quoteOn = (page: number, words = "Margins recover."): AskedQuote => ({
  documentId: "d",
  documentName: "Rate cuts",
  quote: words,
  pageFrom: page,
  pageTo: page,
  location: { kind: "page", from: page, to: page },
});

describe("The words selected to ask about, in a draft (#101)", () => {
  test("a reload keeps a draft's quotes, and drops a draft whose quotes don't read", () => {
    const asking = { ...draft, quotes: [quoteOn(2)] };

    expect(draftsFrom({ asking, broken: { ...draft, quotes: [{ quote: 3 }] } })).toEqual({
      asking,
    });
  });

  test("quotes put together go each once, and as many as a Question takes", () => {
    const pages = Array.from({ length: 12 }, (_, index) => quoteOn(index + 1));

    expect(withQuotes([quoteOn(2)], [quoteOn(2), quoteOn(3)])).toEqual([quoteOn(2), quoteOn(3)]);
    expect(withQuotes([quoteOn(2)], [quoteOn(2, "Other words.")])).toHaveLength(2);
    expect(withQuotes(pages.slice(0, 6), pages.slice(6))).toEqual(pages.slice(0, 10));
  });
});
