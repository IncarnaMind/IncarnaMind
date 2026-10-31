/**
 * Pictures in a Note (#1937): a Block kept in the Note's data, exported with it
 * to Word, PDF, Markdown and a shared page, read as nothing by a Question's
 * context, and sent to a model only when the User selected the picture to ask
 * about and that model reads images.
 */
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import type { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test } from "vitest";
import type { Core, CoreAdapters, MindFocus } from "../../src/core";
import { answerEnded } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { checkWellFormed, part, unzip } from "../helpers/docx";
import { connectToMind } from "../helpers/mindClient";
import { note, writeMind } from "../helpers/minds";
import { scriptedModels, streamingModel } from "../helpers/models";
import { fakePrinter } from "../helpers/printer";

/** One pixel, as the PNG an editor keeps. */
const PIXEL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const PIXEL_BYTES = Buffer.from(PIXEL.split(",")[1] as string, "base64");
/** A second picture of its own: a 2 × 1 PNG, so its file is a file of its own. */
const OTHER_PIXEL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAD0lEQVR4nGP4z8DA8J8BAAf/Af8Bf4mnAAAAAElFTkSuQmCC";

function picture(alt = "A chart", src = PIXEL): { type: string; attrs: Record<string, unknown> } {
  return { type: "picture", attrs: { id: randomUUID(), src, alt, width: 1, height: 1 } };
}

async function setUp(adapters: Partial<CoreAdapters> = {}) {
  const core = startCore(await createTempDataFolder(), adapters);
  const mind = await core.createMind({ title: "Tides" });
  const client = await connectToMind(core, mind.id);
  return { core, mind, client };
}

const decode = (data: Uint8Array) => new TextDecoder().decode(data);

/** The parts of what a model was last sent, whichever message holds them. */
function partsOf(model: MockLanguageModelV4, call = 0): { type: string; mediaType?: string }[] {
  return (model.doStreamCalls[call]?.prompt ?? []).flatMap((message) =>
    typeof message.content === "string" ? [] : (message.content as { type: string }[]),
  );
}

const imageParts = (model: MockLanguageModelV4, call = 0) =>
  partsOf(model, call).filter(
    (part) => part.type === "file" && part.mediaType?.startsWith("image/"),
  );

/** A Mind with a Note and one picture; `core` answers with the model given. */
async function setUpWithPicture(provider: "vision" | "local") {
  const model = streamingModel("A chart of spring tides.");
  const models = scriptedModels(model);
  const core = startCore(await createTempDataFolder(), { createChatModel: models.createChatModel });
  const saved =
    provider === "vision"
      ? await core.saveChatProvider({ kind: "openai", apiKey: "sk-test", modelId: "gpt-6.1-sol" })
      : await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
  if (saved.service) await core.allowDataFlow("chat", saved.service.id);
  const mind = await core.createMind({ title: "Tides" });
  const client = await connectToMind(core, mind.id);
  const chart = picture();
  writeMind(client, [note("Spring tides come twice a month."), chart]);
  await client.settled();
  const id = String(chart.attrs.id);
  return { core, model, mind, id };
}

/** Asks a Question in a new conversation about the Mind, where `focus` says the User is. */
function askAbout(core: Core, mindId: string, focus: MindFocus | null) {
  return core.askInConversation({ text: "What does this show?", mindId, focus });
}

describe("A picture's exports", () => {
  test("Word holds the picture as its own part, with the User's description", async () => {
    const { core, mind, client } = await setUp();
    writeMind(client, [note("Spring tides."), picture()]);
    await client.settled();

    const exported = await core.exportMind(mind.id, { format: "docx" });
    const files = unzip(exported.data);
    const document = part(files, "word/document.xml");
    checkWellFormed(document);
    expect(files.get("word/media/image1.png")).toEqual(PIXEL_BYTES);
    expect(document).toContain('<a:blip r:embed="rIdImage1"/>');
    expect(document).toContain('descr="A chart"');
  });

  test("PDF draws the picture where it stands, and HTML and a shared page keep it", async () => {
    const { printed, printer } = fakePrinter();
    const { core, mind, client } = await setUp({ printer });
    writeMind(client, [note("Spring tides."), picture()]);
    await client.settled();

    await core.exportMind(mind.id, { format: "pdf" });
    expect(printed[0]?.body).toContain("<img");
    expect(printed[0]?.body).toContain(PIXEL);

    const html = decode((await core.exportMind(mind.id, { format: "html" })).data);
    expect(html).toContain(PIXEL);

    const shared = decode(
      (await core.exportMind(mind.id, { format: "share-page", citationCards: true })).data,
    );
    expect(shared).toContain(PIXEL);
  });

  test("Markdown links a file written beside it, never a data URL in the text", async () => {
    const { core, mind, client } = await setUp();
    writeMind(client, [note("Spring tides."), picture()]);
    await client.settled();

    const exported = await core.exportMind(mind.id, { format: "markdown" });
    const [file] = exported.files ?? [];
    expect(file?.name).toMatch(/^picture-[0-9a-f]{12}\.png$/);
    expect(Buffer.from(file?.data ?? [])).toEqual(PIXEL_BYTES);
    const markdown = decode(exported.data);
    expect(markdown).toContain(`![A chart](${file?.name})`);
    expect(markdown).not.toContain("data:image");
  });

  test("saving the Markdown writes the picture in the same folder, and writing it again the new one", async () => {
    const { core, mind, client } = await setUp();
    writeMind(client, [note("Spring tides."), picture()]);
    await client.settled();

    const saved = await core.saveMindExport(mind.id, { format: "markdown" });
    if (saved.status !== "saved") throw new Error(`Not saved: ${saved.status}`);
    expect(
      (await readdir(saved.file.folder)).filter((name) => /^picture-[0-9a-f]{12}\.png$/.test(name)),
    ).toHaveLength(1);

    // A second picture, and the export written again into the same file: both files are beside it.
    const other = picture("A second chart", OTHER_PIXEL);
    writeMind(client, [note("Spring tides."), picture(), other]);
    await client.settled();
    await core.rewriteMindExport(mind.id, { format: "markdown" }, saved.file.path);
    const markdown = await readFile(saved.file.path, "utf8");
    const linked = [...markdown.matchAll(/picture-[0-9a-f]{12}\.png/g)].map((match) => match[0]);
    const names = await readdir(saved.file.folder);
    for (const name of new Set(linked)) expect(names).toContain(name);
  });
});

describe("A picture and the model", () => {
  test("a Question about the Note sends the note's words and never the picture", async () => {
    const { core, model, mind } = await setUpWithPicture("vision");
    const result = await askAbout(core, mind.id, null);
    if (!result.asked) throw new Error(`Not asked: ${JSON.stringify(result)}`);
    await answerEnded(core, result.answerId);

    expect(imageParts(model)).toEqual([]);
    const userText = (model.doStreamCalls[0]?.prompt ?? [])
      .filter((message) => message.role === "user")
      .map((message) =>
        typeof message.content === "string"
          ? message.content
          : message.content.map((part) => ("text" in part ? part.text : "")).join(""),
      )
      .join("\n");
    expect(userText).not.toContain("data:image");
    // The picture's own description is not read either: a model that wasn't asked about it reads words only.
    expect(userText).not.toContain("A chart");
  });

  test("a picture the User selected to ask about goes to a model that reads images", async () => {
    const { core, model, mind, id } = await setUpWithPicture("vision");
    const result = await askAbout(core, mind.id, { selection: "", blockIds: [id], pictures: [id] });
    if (!result.asked) throw new Error(`Not asked: ${JSON.stringify(result)}`);
    await answerEnded(core, result.answerId);

    const [sent] = imageParts(model);
    expect(sent?.mediaType).toBe("image/png");
    const part = (model.doStreamCalls[0]?.prompt ?? [])
      .flatMap((message) =>
        typeof message.content === "string"
          ? []
          : (message.content as { type: string; data?: { data?: Uint8Array } }[]),
      )
      .find((each) => each.type === "file");
    expect(Buffer.from(part?.data?.data ?? [])).toEqual(PIXEL_BYTES);
  });

  test("a model that can't read pictures is sent none, though the User selected one", async () => {
    const { core, model, mind, id } = await setUpWithPicture("local");
    const result = await askAbout(core, mind.id, { selection: "", blockIds: [id], pictures: [id] });
    if (!result.asked) throw new Error(`Not asked: ${JSON.stringify(result)}`);
    await answerEnded(core, result.answerId);

    expect(imageParts(model)).toEqual([]);
    expect(JSON.stringify(model.doStreamCalls[0]?.prompt ?? [])).not.toContain("data:image");
  });

  test("in Local mode nothing is sent, picture or words", async () => {
    const { core, model, mind, id } = await setUpWithPicture("vision");
    await core.setLocalOnly(true);
    const result = await askAbout(core, mind.id, { selection: "", blockIds: [id], pictures: [id] });
    expect(result.asked).toBe(false);
    expect(model.doStreamCalls).toEqual([]);
  });
});
