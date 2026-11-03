/** A sentence backed by the User's own notes alone shows the ticked box, not the green tick (#335). */
import { describe, expect, test } from "vitest";
import type { CitationAttributes } from "../../src/core/api";
import { supportedByOwnNotesOnly } from "../../src/shared/claimChecks";

const cited = (overrides: Partial<CitationAttributes> = {}): CitationAttributes => ({
  passageId: null,
  documentId: null,
  documentName: "Field visit",
  contentHash: "a".repeat(64),
  pageFrom: null,
  pageTo: null,
  location: null,
  quote: "Harbours publish the times of high water every week.",
  check: "found",
  checkReason: null,
  ...overrides,
});

describe("support from the User's own notes only", () => {
  test("is a ticked box when the deciding evidence is one of their notes", () => {
    expect(
      supportedByOwnNotesOnly({
        state: "supported",
        evidence: cited({ yourNoteAt: "2026-10-12T10:00:00.000Z" }),
      }),
    ).toBe(true);
  });

  test("is the ordinary tick when a Document of theirs also supports it", () => {
    expect(
      supportedByOwnNotesOnly({
        state: "supported",
        evidence: cited({ yourNoteAt: "2026-10-12T10:00:00.000Z" }),
        parts: [
          {
            verdict: "supported",
            evidence: [cited({ documentName: "Tides" })],
          },
        ],
      }),
    ).toBe(false);
  });

  test("is neither for another verdict, nor with nothing that supports it", () => {
    expect(
      supportedByOwnNotesOnly({
        state: "unsupported",
        evidence: cited({ yourNoteAt: "2026-10-12T10:00:00.000Z" }),
      }),
    ).toBe(false);
    expect(supportedByOwnNotesOnly({ state: "supported", evidence: null })).toBe(false);
  });

  test("is the ordinary tick when a Document was read whole to decide the sentence", () => {
    expect(
      supportedByOwnNotesOnly({
        state: "supported",
        evidence: cited({ yourNoteAt: "2026-10-12T10:00:00.000Z" }),
        readDocuments: [{ documentId: "tides", documentName: "Tides" }],
      }),
    ).toBe(false);
  });
});
