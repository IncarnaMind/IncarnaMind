import { describe, expect, test } from "vitest";
import type { Core, Document } from "../../src/core";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";

/*
 * A Citation's quote as its Document's text reads it (#905), through the core's public
 * interface: a word a PDF split at a line end is whole again, a quote that stops at one runs to
 * the end of its word, and a real hyphen stays. A text file's own lines stay, so a quote across
 * two turns of an interview reads as two (#3587). What the Citation check finds is unchanged.
 */

const PAGE = [
  "The harbour committee will review the case for the exist-",
  "ence of tides near the pier, and the em-",
  "ployment of staff on the av-",
  "erage day. The long-",
  "term plan, a long-term view of the co-",
  "operate scheme, is to be settled. The office and the council co-operate daily.",
].join("\n");

async function setUp(contents = PAGE) {
  const core = startCore(await createTempDataFolder());
  const sources = await createTempDataFolder();
  const [document] = await addAndProcess(core, [
    await writeSourceFile(sources, "Harbour.txt", contents),
  ]);
  return { core, document: document as Document };
}

const read = (core: Core, document: Document, quote: string) =>
  core.readableQuote({
    documentId: document.id,
    contentHash: document.contentHash,
    pageFrom: null,
    pageTo: null,
    quote,
  });

describe("A Citation's quote, read as words", () => {
  test("a quote cut at a line end runs to the end of its word", async () => {
    const { core, document } = await setUp();

    expect(await read(core, document, "review the case for the exist-")).toBe(
      "review the case for the existence",
    );
  });

  test("a word split inside a quote is whole again", async () => {
    const { core, document } = await setUp();

    expect(
      await read(core, document, "ence of tides near the pier, and the em-\nployment of staff"),
    ).toBe("ence of tides near the pier, and the employment of staff");
    expect(await read(core, document, "ployment of staff on the av-erage day")).toBe(
      "ployment of staff on the average day",
    );
  });

  test("a real hyphen stays where the page writes the word with one elsewhere", async () => {
    const { core, document } = await setUp();

    expect(await read(core, document, "The long-term plan")).toBe("The long-term plan");
    expect(await read(core, document, "view of the co-operate scheme")).toBe(
      "view of the co-operate scheme",
    );
  });

  test("a quote that isn't in the Document, or a Document that isn't there, gives nothing: the quote stays as it is", async () => {
    const { core, document } = await setUp();

    expect(await read(core, document, "Neap tides are the highest.")).toBeNull();
    expect(
      await read(core, { ...document, id: "00000000-0000-4000-8000-000000000000" }, "the pier"),
    ).toBeNull();
  });

  // protects=a text file's line is shown where the file breaks it, in Chinese too, as its viewer shows it (#3587); fails_when=two of its lines run together on a card
  test("a quote of a Document that has nothing to join keeps the file's lines, in Chinese too", async () => {
    const { core, document } = await setUp("潮汐每天涨落两次。\n朔望之时潮水最大。");

    expect(await read(core, document, "潮汐每天涨落两次。")).toBe("潮汐每天涨落两次。");
    expect(await read(core, document, "两次。\n朔望之时")).toBe("两次。\n朔望之时");
    expect(await read(core, document, "两次。朔望之时")).toBe("两次。\n朔望之时");
  });

  // protects=a quote that spans two turns of an interview shows them apart, the speaker and time on a line of their own, as the Document shows them, whichever spaces the agent's quote used (#3587); fails_when=the time runs into the next words ("00:18:56I tried", "00:18:56我试了") or the turns run together
  test.each([
    [
      "en",
      "Lin Xiaowen  00:18:40\nWhich tents did you try?\n\nChen Siqi  00:18:56\nI tried the ridge tent and the dome.\n",
      "Which tents did you try? Chen Siqi 00:18:56 I tried the ridge tent",
      "Which tents did you try?\n\nChen Siqi 00:18:56\nI tried the ridge tent",
    ],
    [
      "zh-CN",
      "林晓雯  00:18:40\n您试用了哪几款帐篷？\n\n陈思琪  00:18:56\n我试了山脊帐和穹顶帐。\n",
      "您试用了哪几款帐篷？陈思琪 00:18:56我试了山脊帐",
      "您试用了哪几款帐篷？\n\n陈思琪 00:18:56\n我试了山脊帐",
    ],
  ])("a quote across two turns keeps them apart (%s)", async (_language, transcript, quote, shown) => {
    const { core, document } = await setUp(transcript);

    expect(await read(core, document, quote)).toBe(shown);
  });
});
