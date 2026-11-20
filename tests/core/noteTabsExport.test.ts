import { randomUUID } from "node:crypto";
import type { JSONContent } from "@tiptap/core";
import { parseHTML } from "linkedom";
import { describe, expect, test } from "vitest";
import { createTempDataFolder, manualClock, startCore } from "../helpers/core";
import { checkWellFormed, paragraphsOf, part, unzip } from "../helpers/docx";
import { connectToMind } from "../helpers/mindClient";
import { heading, note, writeMind } from "../helpers/minds";
import { fakePrinter } from "../helpers/printer";

/*
 * Tabs in a Note (#3414) in a file: each tab a top-level section, its title a Heading 1 and every
 * section after the first on a new page, under the Note's own title. A Note without tabs is as it
 * always was.
 */

const tab = (title: string): JSONContent => ({
  type: "noteTab",
  attrs: { id: randomUUID(), title },
});

const REPORT: JSONContent[] = [
  tab("Summary"),
  heading(1, "Harbourline Ferries"),
  note("Sailings ran on time on most days."),
  tab("Fleet"),
  heading(2, "Refits"),
  note("Two ferries were refitted over the winter."),
];

async function setUp(blocks: JSONContent[]) {
  const { printed, printer } = fakePrinter();
  const core = startCore(await createTempDataFolder(), { now: manualClock().now, printer });
  const mind = await core.createMind({ title: "Harbourline Ferries" });
  const client = await connectToMind(core, mind.id);
  writeMind(client, blocks);
  await client.settled();
  return { core, mind, printed };
}

const decode = (data: Uint8Array) => new TextDecoder().decode(data);

describe("a Note with tabs, exported", () => {
  test("to Word: each tab a Heading 1 section, the second on a new page, under the Note's title", async () => {
    const { core, mind } = await setUp(REPORT);
    const files = unzip((await core.exportMind(mind.id, { format: "docx" })).data);
    const document = part(files, "word/document.xml");
    checkWellFormed(document);
    const paragraphs = paragraphsOf(document).filter((each) => each.text.trim() !== "");
    expect(paragraphs.map((each) => [each.style ?? "", each.text])).toEqual([
      ["Heading1", "Harbourline Ferries"],
      ["Heading1", "Summary"],
      ["", "Sailings ran on time on most days."],
      ["Heading1", "Fleet"],
      ["Heading2", "Refits"],
      ["", "Two ferries were refitted over the winter."],
    ]);
    const breakAt = document.indexOf('<w:br w:type="page"/>');
    expect(breakAt).toBeGreaterThan(document.indexOf("Sailings ran on time"));
    expect(breakAt).toBeLessThan(document.indexOf(">Fleet<"));
    expect(document.match(/<w:br w:type="page"\/>/g)).toHaveLength(1);
  });

  test("to Markdown: each tab's title a top-level heading, in order", async () => {
    const { core, mind } = await setUp(REPORT);
    const markdown = decode((await core.exportMind(mind.id, { format: "markdown" })).data);
    expect(markdown).toBe(
      [
        "# Harbourline Ferries",
        "# Summary",
        "Sailings ran on time on most days.",
        "# Fleet",
        "## Refits",
        "Two ferries were refitted over the winter.",
      ].join("\n\n") + "\n",
    );
  });

  test("to PDF and to a page to share: each tab a section under its title, the second on a new page in print", async () => {
    const { core, mind, printed } = await setUp(REPORT);
    await core.exportMind(mind.id, { format: "pdf" });
    const body = printed[0]?.body ?? "";
    const { document } = parseHTML(`<html><body>${body}</body></html>`);
    const titles = [...document.querySelectorAll("h2, h3")].map((each) => each.textContent);
    expect(titles).toEqual(["Harbourline Ferries", "Summary", "Fleet", "Refits"]);
    const breakAt = body.indexOf('<div class="page-break"></div>');
    expect(breakAt).toBeGreaterThan(body.indexOf("Sailings ran on time"));
    expect(breakAt).toBeLessThan(body.indexOf(">Fleet<"));

    const shared = parseHTML(
      decode((await core.exportMind(mind.id, { format: "share-page" })).data),
    ).document;
    const sections = [...shared.querySelectorAll("h2, h3")].map((each) => each.textContent);
    expect(sections).toEqual(["Harbourline Ferries", "Summary", "Fleet", "Refits"]);
  });

  test("a tab with no title of its own is named by its number in the file's language", async () => {
    const { core, mind } = await setUp([
      note("Sailings ran on time."),
      tab("Fleet"),
      note("Two ferries were refitted."),
    ]);
    const english = decode((await core.exportMind(mind.id, { format: "markdown" })).data);
    expect(english).toBe(
      ["# Tab 1", "Sailings ran on time.", "# Fleet", "Two ferries were refitted."].join("\n\n") +
        "\n",
    );
    await core.updateSettings({ user: { language: "zh-CN" } });
    const chinese = decode((await core.exportMind(mind.id, { format: "markdown" })).data);
    expect(chinese.startsWith("# 标签页 1\n\n")).toBe(true);
  });

  test("a Note without tabs is exported as it always was", async () => {
    const { core, mind } = await setUp([heading(1, "Harbourline Ferries"), note("On time.")]);
    const markdown = decode((await core.exportMind(mind.id, { format: "markdown" })).data);
    expect(markdown).toBe("# Harbourline Ferries\n\nOn time.\n");
  });
});
