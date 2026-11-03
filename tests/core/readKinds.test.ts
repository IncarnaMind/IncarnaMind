import { describe, expect, test } from "vitest";
import { type ReadInput, readKinds, toolReadKind } from "../../src/core/answers/readKinds";
import type { AnswerToolCall, ThirdPartyReason } from "../../src/core/api";

/** What an approval card names the Answer read, by kind (#2240). */

const read = (
  documentId: string,
  documentName: string,
  kind: "markdown" | "web" | "transcript" = "markdown",
) => ({ documentId, documentName, kind });

const call = (
  source: AnswerToolCall["source"],
  tool: string,
  more: { status?: AnswerToolCall["status"]; connector?: { id: string; name: string } } = {},
): Pick<AnswerToolCall, "source" | "tool" | "status" | "connector"> => ({
  source,
  tool,
  status: more.status ?? "done",
  ...(more.connector && { connector: more.connector }),
});

const input = (more: Partial<ReadInput> = {}): ReadInput => ({
  reads: [],
  transcripts: new Set<string>(),
  calls: [],
  reasons: [],
  titlesRead: [],
  webAddress: () => null,
  ...more,
});

const empty = {
  documents: [],
  webPages: [],
  webPageTitles: [],
  webSearchResults: false,
  connectors: [],
  scriptOutput: false,
  transcript: false,
  otherText: false,
};

describe("What the approval card names (#2240)", () => {
  test("each kind alone", () => {
    expect(readKinds(input({ reads: [read("d1", "Q3 notes")] }))).toEqual({
      ...empty,
      documents: ["Q3 notes"],
    });
    expect(
      readKinds(
        input({
          reads: [read("w1", "Q3 board pack.pdf", "web")],
          webAddress: () => "http://files.example/report",
        }),
      ),
    ).toEqual({ ...empty, webPages: ["files.example"] });
    expect(readKinds(input({ calls: [call("web", "search_web")] }))).toEqual({
      ...empty,
      webSearchResults: true,
    });
    expect(readKinds(input({ calls: [call("sources", "find_sources")] }))).toEqual({
      ...empty,
      webSearchResults: true,
    });
    expect(
      readKinds(
        input({
          calls: [call("connector", "search_issues", { connector: { id: "c1", name: "Gmail" } })],
        }),
      ),
    ).toEqual({ ...empty, connectors: ["Gmail"] });
    expect(readKinds(input({ calls: [call("skill", "run_skill_script")] }))).toEqual({
      ...empty,
      scriptOutput: true,
    });
    expect(readKinds(input({ calls: [call("analysis", "run_analysis")] }))).toEqual({
      ...empty,
      scriptOutput: true,
    });
    expect(
      readKinds(
        input({
          reads: [read("t1", "Transcript", "transcript")],
          transcripts: new Set(["t1"]),
        }),
      ),
    ).toEqual({ ...empty, transcript: true });
  });

  // protects=the count is of Documents by id: two files with one name are two; fails_when=one name stands in for two files; no_claim=what the card says.
  test("two Documents with one name are two, and one read twice is one", () => {
    const kinds = readKinds(input({ reads: [read("d1", "Q3 notes"), read("d2", "Q3 notes")] }));
    expect(kinds.documents).toEqual(["Q3 notes", "Q3 notes"]);
    expect(
      readKinds(input({ reads: [read("d1", "Q3 notes"), read("d1", "Q3 notes")] })).documents,
    ).toEqual(["Q3 notes"]);
  });

  test("Connectors are one entry each, however many calls they made", () => {
    const kinds = readKinds(
      input({
        calls: [
          call("connector", "search_issues", { connector: { id: "c1", name: "Gmail" } }),
          call("connector", "read_thread", { connector: { id: "c1", name: "Gmail" } }),
          call("connector", "search_issues", { connector: { id: "c2", name: "飞书" } }),
        ],
      }),
    );
    expect(kinds.connectors).toEqual(["Gmail", "飞书"]);
  });

  // protects=a Tool call this list does not know is named as other text, never left off; fails_when=a new kind of read vanishes from the card; no_claim=what a real Tool reads.
  test("a call of an unclassified kind is other text", () => {
    const unknown = {
      source: "future",
      tool: "read_page",
      status: "done",
    } as unknown as Pick<AnswerToolCall, "source" | "tool" | "status" | "connector">;
    expect(toolReadKind(unknown)).toBe("other");
    expect(readKinds(input({ calls: [unknown] })).otherText).toBe(true);
    expect(toolReadKind(call("web", "read_page_text"))).toBe("other");
  });

  test("a web page whose address is gone or is no address is other text", () => {
    for (const address of [null, "not an address", "file:///report"]) {
      const kinds = readKinds(
        input({ reads: [read("w1", "Q3 board pack.pdf", "web")], webAddress: () => address }),
      );
      expect(kinds.webPages).toEqual([]);
      expect(kinds.otherText).toBe(true);
    }
  });

  test("third-party text the list cannot name is other text; a web page read is named", () => {
    const reason = (
      via: ThirdPartyReason["via"],
      source: ThirdPartyReason["source"],
    ): ThirdPartyReason => (via === "read" ? { via, source } : { via, source });
    expect(readKinds(input({ reasons: [reason("context", "imported")] })).otherText).toBe(true);
    expect(readKinds(input({ reasons: [reason("mind", "web-page")] })).otherText).toBe(true);
    expect(readKinds(input({ reasons: [reason("read", "imported")] })).otherText).toBe(true);
    expect(readKinds(input({ reasons: [reason("read", "checked-document")] })).otherText).toBe(
      true,
    );
    expect(readKinds(input({ reasons: [reason("read", "web-page")] })).otherText).toBe(true);
    expect(
      readKinds(
        input({
          reads: [read("w1", "Q3 board pack.pdf", "web")],
          webAddress: () => "http://files.example/report",
          reasons: [reason("read", "web-page")],
        }),
      ).otherText,
    ).toBe(false);
    expect(
      readKinds(
        input({ calls: [call("web", "search_web")], reasons: [reason("read", "web-page")] }),
      ).otherText,
    ).toBe(false);
  });

  // protects=a page read and its title names the page once, as a web page; fails_when=the title adds a second entry or an unnamed bucket; no_claim=the page and its title.
  test("a saved page read and its title is one web page, never a title", () => {
    const kinds = readKinds(
      input({
        reads: [read("w1", "Q3 Report.pdf", "web")],
        titlesRead: ["w1"],
        webAddress: () => "https://files.example/report",
      }),
    );
    expect(kinds).toEqual({ ...empty, webPages: ["files.example"] });
    expect(kinds.webPageTitles).toEqual([]);
    expect(JSON.stringify(kinds)).not.toContain("Q3 Report.pdf");
  });

  // protects=a Run reading only a saved page and its title shows no other text; fails_when=the title adds an unnamed bucket; no_claim=the page and its title.
  test("a Run reading only a saved page and its title shows no other text", () => {
    expect(
      readKinds(
        input({
          reads: [read("w1", "Q3 Report.pdf", "web")],
          titlesRead: ["w1"],
          webAddress: () => "https://files.example/report",
        }),
      ).otherText,
    ).toBe(false);
  });

  // protects=a title whose page was never read names that page's title by its host, never other text and never a quoted Document; fails_when=the title is other text, a Document, or a read page; no_claim=what list_commands showed.
  test("a saved page's title alone is its own kind, by its host", () => {
    expect(
      readKinds(
        input({
          titlesRead: ["w1"],
          reads: [read("d1", "Budget")],
          calls: [call("connector", "lookup_tide", { connector: { id: "c1", name: "Tides" } })],
          webAddress: (id) => (id === "w1" ? "https://files.example/report" : null),
        }),
      ),
    ).toEqual({
      ...empty,
      documents: ["Budget"],
      webPageTitles: ["files.example"],
      connectors: ["Tides"],
    });
  });

  test("three pages' titles are three titles, by host", () => {
    expect(
      readKinds(
        input({
          titlesRead: ["w1", "w2", "w3"],
          webAddress: (id) => `https://${id}.example/report`,
        }),
      ).webPageTitles,
    ).toEqual(["w1.example", "w2.example", "w3.example"]);
  });

  test("a title whose page has no address is other text", () => {
    expect(readKinds(input({ titlesRead: ["w1"], webAddress: () => null })).otherText).toBe(true);
  });

  test("a call that failed, or was denied, read nothing", () => {
    expect(readKinds(input({ calls: [call("web", "search_web", { status: "failed" })] }))).toEqual(
      empty,
    );
    expect(
      readKinds(
        input({
          calls: [
            call("connector", "book_boat", {
              status: "failed",
              connector: { id: "c1", name: "Tides" },
            }),
          ],
        }),
      ),
    ).toEqual(empty);
  });
});
