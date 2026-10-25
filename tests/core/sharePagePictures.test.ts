import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { HtmlValidate } from "html-validate/node";
import { parseHTML } from "linkedom";
import { describe, expect, test } from "vitest";
import type { CapturePage, Core, DrawnPage } from "../../src/core";
import { CITED_PAGES_FOLDER } from "../../src/core/citedPages";
import { createFakeTextRecognizer } from "../../src/core/documents/scan/fake";
import { drawPictures, planPicture } from "../../src/core/exports/sharedPictures";
import {
  askAndFinish,
  citationsIn,
  citingModel,
  type ShownPassage,
  setUpWithDocuments,
} from "../helpers/citations";
import { PNG, savedPage } from "../helpers/citedPages";
import { NO_MODEL_FILES, queryDatabase } from "../helpers/core";
import { buildPdf } from "../helpers/pdf";

const SPRING = "Spring tides happen at new moon and at full moon.";
const TIDES = buildPdf([
  { lines: ["Tides and the Moon", "The Moon's gravity raises two tidal bulges on the Earth."] },
  {
    lines: [
      "Spring and neap tides",
      "The Sun's pull adds to the Moon's twice a month.",
      SPRING,
      "Neap tides fall between them, at the quarter moons.",
      "Tide tables give the height of each high and low water.",
    ],
  },
]);
const SCAN = readFileSync(join(import.meta.dirname, "../fixtures/scans/en-clean.jpg"));
const DECK = new Uint8Array(
  readFileSync(new URL("../fixtures/formats/Quarterly Research Update.pptx", import.meta.url)),
);

/** A viewer drawing a slide off screen, its text a line to a run. */
const viewer: CapturePage = async () => ({
  data: PNG,
  type: "image/png",
  width: 800,
  height: 600,
  text: [
    { text: "Quarterly update", breakAfter: true, box: { x: 40, y: 40, width: 160, height: 20 } },
    {
      text: "The western region grew fastest",
      breakAfter: true,
      box: { x: 40, y: 70, width: 310, height: 20 },
    },
  ],
});

const byDocument = (passages: ShownPassage[], name: string) =>
  passages.find((passage) => passage.document === name)?.id ?? "none";

/** A Mind whose Answer cites a PDF's page, a slide, a scan and a quote that isn't on its page. */
async function citedMind() {
  const model = citingModel({
    query: "spring tides western region cracks",
    records: (passages) => [
      { marker: 1, passage: byDocument(passages, "Tides"), pageFrom: 2, pageTo: 2, quote: SPRING },
      {
        marker: 2,
        passage: byDocument(passages, "Deck"),
        location: "slide 3",
        quote: "The western region grew fastest",
      },
      {
        marker: 3,
        passage: byDocument(passages, "Site survey"),
        pageFrom: 1,
        pageTo: 1,
        quote: "two cracks in the east wall",
      },
      {
        marker: 4,
        passage: byDocument(passages, "Tides"),
        pageFrom: 1,
        pageTo: 1,
        quote: "The Moon pushes the oceans away",
      },
    ],
    answer: "Spring tides [^1]; the west grew [^2]; the wall cracked [^3]; the Moon pushes [^4].",
  });
  const setup = await setUpWithDocuments(
    model,
    [
      { name: "Tides.pdf", contents: TIDES },
      { name: "Deck.pptx", contents: DECK },
      { name: "Site survey.pdf", contents: buildPdf([{ scan: SCAN }]) },
    ],
    {
      capturePage: viewer,
      textRecognizer: createFakeTextRecognizer({
        script: {
          pages: {
            1: {
              lines: [
                "Site survey, 12 October",
                "The survey found two cracks in the east wall above the door.",
                "Scaffolding stays up until the spring.",
              ],
            },
          },
        },
      }),
      textRecognitionModelSource: NO_MODEL_FILES,
    },
  );
  const { answerId } = await askAndFinish(setup.core, setup.client, setup.mind.id, "Tides?");
  const citations = citationsIn(setup.client, answerId);
  const pages: DrawnPage[] = [];
  for (const cited of citations.slice(0, 3)) pages.push(await savedPage(setup.core, cited));
  return { ...setup, citations, pages };
}

async function sharedPage(core: Core, mindId: string) {
  const exported = await core.exportMind(mindId, { format: "share-page" });
  const html = new TextDecoder().decode(exported.data);
  return { html, document: parseHTML(html).document };
}

/** A WebP picture's size in pixels, read from its header. */
function webpSize(bytes: Uint8Array): { width: number; height: number } {
  const data = Buffer.from(bytes);
  if (data.toString("latin1", 0, 4) !== "RIFF" || data.toString("latin1", 8, 12) !== "WEBP") {
    throw new Error("Not a WebP picture.");
  }
  const chunk = data.toString("latin1", 12, 16);
  if (chunk === "VP8 ") {
    return { width: data.readUInt16LE(26) & 0x3fff, height: data.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === "VP8L") {
    const bits = data.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  return { width: data.readUIntLE(24, 3) + 1, height: data.readUIntLE(27, 3) + 1 };
}

/** The picture a card shows: the one the page writes once, that its card points at. */
function pictureOf(document: ReturnType<typeof parseHTML>["document"], number: number) {
  const shown = document.getElementById(`card-${number}`)?.querySelector(".card-picture svg");
  const id = shown?.querySelector("use")?.getAttribute("href")?.slice(1) ?? "";
  const href = document.querySelector(`.pictures image[id="${id}"]`)?.getAttribute("href") ?? "";
  if (!shown || !href.startsWith("data:image/webp;base64,")) return null;
  const encoded = href.slice(href.indexOf(",") + 1);
  return { shown, encoded, bytes: new Uint8Array(Buffer.from(encoded, "base64")) };
}

describe("a web page to share: page pictures", { timeout: 60_000 }, () => {
  test("a PDF's page and a scan are cropped to at most a third of the page around the quote, and a slide is whole", async () => {
    const { core, mind, pages } = await citedMind();

    const { html, document } = await sharedPage(core, mind.id);

    for (const [number, page] of [
      [1, pages[0]],
      [3, pages[2]],
    ] as const) {
      const picture = pictureOf(document, number);
      if (!picture || !page) throw new Error(`Card ${number} has no picture.`);
      const size = webpSize(picture.bytes);
      expect(size.width).toBeLessThanOrEqual(Math.min(page.width, 1600));
      expect(size.height).toBeLessThanOrEqual(page.height / 3);
      expect(picture.bytes.length, "no more than its page").toBeLessThan(page.data.length);
      expect(picture.shown.getAttribute("viewBox")).toBe(`0 0 ${size.width} ${size.height}`);
      expect(picture.shown.getAttribute("aria-label")).toMatch(/^Picture of /);
    }
    const slide = pictureOf(document, 2);
    expect(slide && webpSize(slide.bytes)).toEqual({ width: 800, height: 600 });
    expect(document.getElementById("card-2")?.textContent).toContain("A picture of this slide.");
    expect(document.getElementById("card-1")?.textContent).toContain(
      "A picture of this part of the page. The whole Document isn’t in this file.",
    );
    expect(document.getElementById("card-3")?.textContent).toContain("Text read from a scan");
    const report = await new HtmlValidate({
      extends: ["html-validate:recommended"],
    }).validateString(html);
    expect(
      report.results.flatMap((result) =>
        result.messages.map((message) => `${message.ruleId}: ${message.message}`),
      ),
    ).toEqual([]);

    // A quote that isn't on its page has nothing to point at: its card is its words.
    expect(pictureOf(document, 4)).toBeNull();
    expect(document.getElementById("card-4")?.querySelector(".card-passage")?.textContent).toBe(
      "“The Moon pushes the oceans away”",
    );
  });

  test("the sheet's counts: each Document's quotes and pictures, and about what they weigh", async () => {
    const { core, mind } = await citedMind();

    const preview = await core.previewSharePage(mind.id, { format: "share-page" });
    const { document } = await sharedPage(core, mind.id);

    expect(
      preview.documents.map(({ name, quotes, pictures, textOnly }) => [
        name,
        quotes,
        pictures,
        textOnly,
      ]),
    ).toEqual([
      ["Tides", 2, 1, false],
      ["Deck", 1, 1, false],
      ["Site survey", 1, 1, false],
    ]);
    for (const [number, name] of [
      [1, "Tides"],
      [3, "Site survey"],
    ] as const) {
      const drawn = pictureOf(document, number)?.encoded.length ?? 0;
      const estimate = preview.documents.find((each) => each.name === name)?.pictureBytes ?? 0;
      expect(estimate / drawn, `${name}'s estimate`).toBeGreaterThan(0.7);
      expect(estimate / drawn, `${name}'s estimate`).toBeLessThan(1.3);
    }
  });

  test("a Document kept as text gives its Citations text cards; with every one kept so, the file is the size the sheet said", async () => {
    const { core, mind, documents } = await citedMind();
    const ids = Object.fromEntries(documents.map((each) => [each.name, each.id]));

    await core.setSharePageTextOnly(mind.id, [ids.Tides ?? ""]);
    const { document } = await sharedPage(core, mind.id);

    expect(pictureOf(document, 1)).toBeNull();
    expect(document.getElementById("card-1")?.querySelector(".card-passage")?.textContent).toBe(
      `“${SPRING}”`,
    );
    expect(pictureOf(document, 2)).not.toBeNull();
    const preview = await core.previewSharePage(mind.id, { format: "share-page" });
    expect(preview.documents.map(({ name, textOnly }) => [name, textOnly])).toEqual([
      ["Tides", true],
      ["Deck", false],
      ["Site survey", false],
    ]);

    await core.setSharePageTextOnly(mind.id, Object.values(ids));
    const text = await core.exportMind(mind.id, { format: "share-page" });
    expect(text.data.length).toBe(preview.textBytes);
    await core.setSharePageTextOnly(mind.id, []);
    expect(
      (await core.previewSharePage(mind.id, { format: "share-page" })).documents.every(
        (each) => !each.textOnly,
      ),
    ).toBe(true);
  });

  test("on a page dense with text the estimate holds within 30%, and a picture two Citations share is written once", async () => {
    const words =
      "the quarterly results show that margins fell as online sales slowed while stores held up".split(
        " ",
      );
    const line = (n: number) =>
      `${Array.from({ length: 14 }, (_, at) => words[(n * 7 + at) % words.length]).join(" ")} ${n}.`;
    const quoted = line(20);
    const model = citingModel({
      query: "margins online stores",
      records: (passages) => [
        {
          marker: 1,
          passage: byDocument(passages, "Results"),
          pageFrom: 1,
          pageTo: 1,
          quote: quoted,
        },
        {
          marker: 2,
          passage: byDocument(passages, "Results"),
          pageFrom: 1,
          pageTo: 1,
          quote: quoted,
        },
      ],
      answer: "Margins fell [^1], as the results say [^2].",
    });
    const setup = await setUpWithDocuments(model, [
      {
        name: "Results.pdf",
        contents: buildPdf([{ lines: Array.from({ length: 44 }, (_, n) => line(n)) }]),
      },
    ]);
    const { answerId } = await askAndFinish(setup.core, setup.client, setup.mind.id, "Margins?");
    const [cited] = citationsIn(setup.client, answerId);
    if (!cited) throw new Error("Nothing was cited.");
    await savedPage(setup.core, cited);

    const preview = await setup.core.previewSharePage(setup.mind.id, { format: "share-page" });
    const { html, document } = await sharedPage(setup.core, setup.mind.id);

    expect(preview.documents.map(({ quotes, pictures }) => [quotes, pictures])).toEqual([[2, 1]]);
    expect(document.querySelectorAll(".pictures image")).toHaveLength(1);
    expect(document.querySelectorAll(".card-picture use")).toHaveLength(2);
    const drawn = pictureOf(document, 1)?.encoded.length ?? 0;
    expect(html.split("data:image/webp").length - 1).toBe(1);
    const estimate = preview.documents[0]?.pictureBytes ?? 0;
    expect(estimate / drawn).toBeGreaterThan(0.7);
    expect(estimate / drawn).toBeLessThan(1.3);
  });

  test("a saved page that can't be read leaves its Citation a text card, and the rest of the page is made", async () => {
    const { core, mind, dataDir } = await citedMind();
    const [tides] = queryDatabase<{ id: string; image_type: string }>(
      dataDir,
      `SELECT p.id, p.image_type FROM cited_pages p JOIN documents d ON d.id = p.document_id
       WHERE d.name = 'Tides' AND p.image_type IS NOT NULL AND p.deleted_at IS NULL`,
    );
    if (!tides) throw new Error("Tides's page wasn't saved.");
    writeFileSync(join(dataDir, CITED_PAGES_FOLDER, `${tides.id}.jpg`), "not a picture");

    const { document } = await sharedPage(core, mind.id);

    expect(pictureOf(document, 1)).toBeNull();
    expect(document.getElementById("card-1")?.querySelector(".card-passage")?.textContent).toBe(
      `“${SPRING}”`,
    );
    expect(pictureOf(document, 2)).not.toBeNull();
    expect(pictureOf(document, 3)).not.toBeNull();
  });

  test("a contradicted quote is outlined in red on its picture, a found one washed green", async () => {
    const canvas = createCanvas(800, 1100);
    const context = canvas.getContext("2d");
    context.fillStyle = "#fff";
    context.fillRect(0, 0, 800, 1100);
    context.fillStyle = "#000";
    context.font = "16px sans-serif";
    const lines = ["The covenant held until April.", "It was breached in May.", "Talks went on."];
    for (const [index, text] of lines.entries()) context.fillText(text, 60, 500 + index * 24);
    const page: DrawnPage = {
      data: new Uint8Array(canvas.toBuffer("image/png")),
      type: "image/png",
      width: 800,
      height: 1100,
      text: lines.map((text, index) => ({
        text,
        breakAfter: true,
        box: { x: 60, y: 486 + index * 24, width: text.length * 8, height: 18 },
      })),
    };
    const attributes = {
      quote: "It was breached in May.",
      location: { kind: "page" as const, from: 1, to: 1 },
      pageFrom: 1,
      pageTo: 1,
    };
    const outlined = planPicture(page, attributes, "contradicted", []);
    const washed = planPicture(page, attributes, "found", []);
    if (!outlined || !washed) throw new Error("No picture was planned.");

    const drawn = await drawPictures([outlined, washed]);

    const colours = async (result: (typeof drawn)[number] | undefined) => {
      if (!result || !("data" in result)) throw new Error("A picture wasn't drawn.");
      const image = await loadImage(Buffer.from(result.data));
      const surface = createCanvas(image.width, image.height);
      surface.getContext("2d").drawImage(image, 0, 0);
      const pixels = surface.getContext("2d").getImageData(0, 0, image.width, image.height).data;
      let red = 0;
      let wash = 0;
      for (let at = 0; at < pixels.length; at += 4) {
        const [r = 0, g = 0, b = 0] = [pixels[at], pixels[at + 1], pixels[at + 2]];
        if (r > 140 && g < 90 && b < 90) red++;
        if (Math.abs(r - 220) < 8 && Math.abs(g - 243) < 8 && Math.abs(b - 228) < 8) wash++;
      }
      return { red, wash };
    };
    const contradicted = await colours(drawn[0]);
    const found = await colours(drawn[1]);
    expect(contradicted.red).toBeGreaterThan(100);
    expect(contradicted.wash).toBe(0);
    expect(found.wash).toBeGreaterThan(100);
    expect(found.red).toBe(0);
  });
});
