import type { JSONContent } from "@tiptap/core";
import { describe, expect, test } from "vitest";
import { InvalidInputError, NotFoundError } from "../../src/core";
import { DEFAULT_MIND_STYLE, type MindStyle } from "../../src/shared/mindStyle";
import { createTempDataFolder, manualClock, startCore } from "../helpers/core";
import { checkWellFormed, part, unzip } from "../helpers/docx";
import { connectToMind } from "../helpers/mindClient";
import { heading, writeMind } from "../helpers/minds";
import { fakePrinter } from "../helpers/printer";

const SERIF_LARGE: MindStyle = { font: "serif", size: "large" };

const paragraph = (value: string): JSONContent => ({
  type: "paragraph",
  content: [{ type: "text", text: value }],
});

async function setUp() {
  const dataDir = await createTempDataFolder();
  const core = startCore(dataDir, { now: manualClock().now });
  return { core, dataDir };
}

/** A Mind with a heading and a line of text, in the font the test gives it. */
async function writtenMind(core: ReturnType<typeof startCore>, style?: MindStyle) {
  const mind = await core.createMind({ title: "Tides" });
  const client = await connectToMind(core, mind.id);
  writeMind(client, [heading(1, "Spring tides"), paragraph("Spring tides happen at new moon.")]);
  if (style) await core.setMindStyle(mind.id, style);
  return mind;
}

const decode = (data: Uint8Array) => new TextDecoder().decode(data);

describe("a Mind's font and text size", () => {
  test("are the default until the Mind chooses, then kept, and kept across a restart", async () => {
    const { core, dataDir } = await setUp();
    const mind = await core.createMind({ title: "Tides" });
    expect(await core.getMindStyle(mind.id)).toEqual(DEFAULT_MIND_STYLE);

    expect(await core.setMindStyle(mind.id, SERIF_LARGE)).toEqual(SERIF_LARGE);
    const other = await core.createMind({ title: "Contracts" });
    expect(await core.getMindStyle(other.id)).toEqual(DEFAULT_MIND_STYLE);

    core.close();
    const after = startCore(dataDir, { now: manualClock().now });
    expect(await after.getMindStyle(mind.id)).toEqual(SERIF_LARGE);

    const georgia: MindStyle = { font: { family: "Georgia" }, size: "small" };
    expect(await after.setMindStyle(mind.id, georgia)).toEqual(georgia);
    // Undo sets the one before.
    expect(await after.setMindStyle(mind.id, SERIF_LARGE)).toEqual(SERIF_LARGE);
    expect(await after.setMindStyle(mind.id, DEFAULT_MIND_STYLE)).toEqual(DEFAULT_MIND_STYLE);
  });

  test("a style that isn't a font and a size, or a Mind that isn't there, is refused", async () => {
    const { core } = await setUp();
    const mind = await core.createMind({ title: "Tides" });
    for (const style of [
      { font: "cursive", size: "default" },
      { font: "serif" },
      { font: { family: "" }, size: "default" },
      null,
    ]) {
      await expect(core.setMindStyle(mind.id, style as never)).rejects.toBeInstanceOf(
        InvalidInputError,
      );
    }
    await expect(core.setMindStyle("no-such-mind", SERIF_LARGE)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(core.getMindStyle("no-such-mind")).rejects.toBeInstanceOf(NotFoundError);
    expect(await core.getMindStyle(mind.id)).toEqual(DEFAULT_MIND_STYLE);
  });
});

describe("the default for new Minds", () => {
  test("is the default style until the User makes another the default", async () => {
    const { core } = await setUp();
    expect((await core.getSettings()).user.newMindStyle).toEqual(DEFAULT_MIND_STYLE);
    const first = await core.createMind({ title: "First" });
    expect(await core.getMindStyle(first.id)).toEqual(DEFAULT_MIND_STYLE);
  });

  test("starts each new Mind in it, and leaves the Minds made before as they were", async () => {
    const { core, dataDir } = await setUp();
    const before = await core.createMind({ title: "Before" });
    const mono: MindStyle = { font: "mono", size: "small" };
    await core.setMindStyle(before.id, mono);
    await core.updateSettings({ user: { newMindStyle: SERIF_LARGE } });

    const folder = await core.createLibraryGroup({ name: "Reports", description: "" });
    const made = await core.createMind({ title: "After" });
    const inFolder = await core.createMind({ title: "In a Folder", folderId: folder.id });
    expect(await core.getMindStyle(made.id)).toEqual(SERIF_LARGE);
    expect(await core.getMindStyle(inFolder.id)).toEqual(SERIF_LARGE);
    expect(await core.getMindStyle(before.id)).toEqual(mono);

    // Each Mind keeps its own: choosing for one never moves the default, or another Mind.
    await core.setMindStyle(made.id, DEFAULT_MIND_STYLE);
    expect((await core.getSettings()).user.newMindStyle).toEqual(SERIF_LARGE);
    expect(await core.getMindStyle(inFolder.id)).toEqual(SERIF_LARGE);

    core.close();
    const after = startCore(dataDir, { now: manualClock().now });
    expect((await after.getSettings()).user.newMindStyle).toEqual(SERIF_LARGE);
    const next = await after.createMind({ title: "Next" });
    expect(await after.getMindStyle(next.id)).toEqual(SERIF_LARGE);
  });

  test("changing it back makes the next Mind default again", async () => {
    const { core } = await setUp();
    await core.updateSettings({ user: { newMindStyle: SERIF_LARGE } });
    await core.updateSettings({ user: { newMindStyle: DEFAULT_MIND_STYLE } });
    const mind = await core.createMind({ title: "Plain" });
    expect(await core.getMindStyle(mind.id)).toEqual(DEFAULT_MIND_STYLE);
  });
});

describe("what exports keep of a Mind's font", () => {
  test("Word writes the default as the document's own body font, and the others by name", async () => {
    const { core } = await setUp();
    const plain = await writtenMind(core);
    const serif = await writtenMind(core, { font: "serif", size: "default" });
    const mono = await writtenMind(core, { font: "mono", size: "large" });
    const songti = await writtenMind(core, { font: { family: "Songti SC" }, size: "default" });
    const awkward = await writtenMind(core, {
      font: { family: 'Fonts & "Co" <1>' },
      size: "default",
    });

    const docDefaults = async (mindId: string) => {
      const exported = await core.exportMind(mindId, { format: "docx" });
      const styles = part(unzip(exported.data), "word/styles.xml");
      checkWellFormed(styles);
      return /<w:rPrDefault><w:rPr>(<w:rFonts [^>]*\/>)/.exec(styles)?.[1];
    };
    expect(await docDefaults(plain.id)).toBe(
      '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/>',
    );
    expect(await docDefaults(serif.id)).toBe(
      '<w:rFonts w:ascii="Source Serif 4" w:hAnsi="Source Serif 4" w:cs="Source Serif 4"/>',
    );
    expect(await docDefaults(mono.id)).toBe(
      '<w:rFonts w:ascii="JetBrains Mono" w:hAnsi="JetBrains Mono" w:cs="JetBrains Mono"/>',
    );
    expect(await docDefaults(songti.id)).toBe(
      '<w:rFonts w:ascii="Songti SC" w:hAnsi="Songti SC" w:cs="Songti SC"/>',
    );
    expect(await docDefaults(awkward.id)).toContain(
      'w:ascii="Fonts &amp; &quot;Co&quot; &lt;1&gt;"',
    );
  });

  test("Word's footnotes name no face of their own, so they are in the Mind's font", async () => {
    const { core } = await setUp();
    const mind = await core.createMind({ title: "Tides" });
    const client = await connectToMind(core, mind.id);
    writeMind(client, [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "Neap tides are weak" },
          { type: "footnote", attrs: { id: "fn-1" }, content: [{ type: "text", text: "Twice." }] },
        ],
      },
    ]);
    await core.setMindStyle(mind.id, { font: "mono", size: "large" });

    const files = unzip((await core.exportMind(mind.id, { format: "docx" })).data);
    expect(part(files, "word/footnotes.xml")).toContain("Twice.");
    expect(part(files, "word/footnotes.xml")).not.toContain("<w:rFonts");
    const styles = part(files, "word/styles.xml");
    const footnoteText = /<w:style [^>]*w:styleId="FootnoteText">[\s\S]*?<\/w:style>/.exec(styles);
    expect(footnoteText?.[0]).toBeDefined();
    expect(footnoteText?.[0]).not.toContain("<w:rFonts");
    expect(styles).toContain('<w:rFonts w:ascii="JetBrains Mono"');
  });

  test("a PDF is set in the Mind's font, footnotes included, and the default leaves the print page's own", async () => {
    const { printed, printer } = fakePrinter();
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir, { now: manualClock().now, printer });
    const noted = async (style?: MindStyle) => {
      const mind = await core.createMind({ title: "Tides" });
      const client = await connectToMind(core, mind.id);
      writeMind(client, [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Neap tides are weak" },
            {
              type: "footnote",
              attrs: { id: "fn-1" },
              content: [{ type: "text", text: "Twice." }],
            },
          ],
        },
      ]);
      if (style) await core.setMindStyle(mind.id, style);
      await core.exportMind(mind.id, { format: "pdf" });
      return printed.at(-1);
    };

    expect((await noted())?.fontFamily).toBeUndefined();
    expect((await noted({ font: "mono", size: "small" }))?.fontFamily).toBe(
      '"JetBrains Mono",var(--serif)',
    );
    const installed = await noted({ font: { family: "Songti SC" }, size: "default" });
    expect(installed?.fontFamily).toBe('"Songti SC",var(--serif)');
    // The footnote is part of the same page: it names no face of its own.
    expect(installed?.notes).toEqual(["Twice."]);
  });

  test("Markdown drops it", async () => {
    const { core } = await setUp();
    const plain = await writtenMind(core);
    const styled = await writtenMind(core, { font: { family: "Songti SC" }, size: "large" });
    const markdown = async (mindId: string) =>
      decode((await core.exportMind(mindId, { format: "markdown" })).data);
    expect(await markdown(styled.id)).toBe(await markdown(plain.id));
    expect(await markdown(styled.id)).not.toMatch(/Songti|font/i);
  });

  test("HTML keeps it inline, ahead of the page's own fonts, and the default adds nothing", async () => {
    const { core } = await setUp();
    const plain = await writtenMind(core);
    const serif = await writtenMind(core, { font: "serif", size: "default" });
    const installed = await writtenMind(core, { font: { family: "Songti SC" }, size: "default" });
    const hostile = await writtenMind(core, {
      font: { family: 'Evil"; } body { display: none; } </style><script>x</script> x {"' },
      size: "default",
    });
    const html = async (mindId: string, format: "html" | "share-page" = "html") =>
      decode((await core.exportMind(mindId, { format, citationCards: false })).data);

    expect(await html(plain.id)).not.toContain("body{font-family:");
    expect(await html(serif.id)).toContain('body{font-family:"Source Serif 4",var(--serif)}');
    expect(await html(installed.id)).toContain('body{font-family:"Songti SC",var(--serif)}');
    expect(await html(installed.id, "share-page")).toContain(
      'body{font-family:"Songti SC",var(--serif)}',
    );

    // A name that is hostile can't close the style element or the string it sits in.
    const file = await html(hostile.id);
    expect((file.match(/<\/style>/g) ?? []).length).toBe(1);
    expect(file).not.toContain("<script>");
    expect(file).not.toContain('"; } body { display: none');
  });

  test("the share page with Citation cards keeps it too", async () => {
    const { core } = await setUp();
    const mind = await writtenMind(core, { font: { family: "Songti SC" }, size: "default" });
    const file = decode((await core.exportMind(mind.id, { format: "share-page" })).data);
    expect(file).toContain('body{font-family:"Songti SC",var(--serif)}');
  });
});

describe("a Mind's line spacing", () => {
  test("is the text size's own until chosen, kept, made the default for new Minds, and refused out of range", async () => {
    const { core, dataDir } = await setUp();
    const mind = await core.createMind({ title: "Tides" });
    const airy: MindStyle = { font: "default", size: "default", lineSpacing: 1.5 };
    expect(await core.setMindStyle(mind.id, airy)).toEqual(airy);
    core.close();
    const after = startCore(dataDir, { now: manualClock().now });
    expect(await after.getMindStyle(mind.id)).toEqual(airy);
    // Back to the default, it is forgotten, so the Mind follows the default again.
    expect(await after.setMindStyle(mind.id, { ...airy, lineSpacing: "default" })).toEqual(
      DEFAULT_MIND_STYLE,
    );

    await after.updateSettings({ user: { newMindStyle: airy } });
    const made = await after.createMind({ title: "After" });
    expect(await after.getMindStyle(made.id)).toEqual(airy);

    for (const lineSpacing of [0, 0.4, 5.5, "double", Number.NaN]) {
      await expect(
        after.setMindStyle(mind.id, { ...airy, lineSpacing } as never),
      ).rejects.toBeInstanceOf(InvalidInputError);
    }
  });

  test("Word writes it as the document's own line spacing, and HTML as the page's", async () => {
    const { core } = await setUp();
    const plain = await writtenMind(core);
    const double = await writtenMind(core, { font: "default", size: "default", lineSpacing: 2 });
    const spacing = async (mindId: string) => {
      const exported = await core.exportMind(mindId, { format: "docx" });
      return /<w:pPrDefault><w:pPr>(<w:spacing [^>]*\/>)/.exec(
        part(unzip(exported.data), "word/styles.xml"),
      )?.[1];
    };
    expect(await spacing(plain.id)).toBe(
      '<w:spacing w:after="160" w:line="259" w:lineRule="auto"/>',
    );
    expect(await spacing(double.id)).toBe(
      '<w:spacing w:after="160" w:line="480" w:lineRule="auto"/>',
    );
    const html = async (mindId: string) =>
      decode((await core.exportMind(mindId, { format: "html" })).data);
    expect(await html(plain.id)).not.toContain("body{line-height:");
    expect(await html(double.id)).toContain("body{line-height:2.3}");
  });
});
