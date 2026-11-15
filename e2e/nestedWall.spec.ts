import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import {
  addDocuments,
  coreOf,
  createDataFolder,
  dismissChatSetup,
  expectReadyDocuments,
  launchApp,
  motionSettled,
  nameMind,
  newMind,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  useLocalChatModel,
} from "./app";

/**
 * A Folder keeping its work inside it, inside another that does, is a wall of its own (#246): a
 * Citation in its Note to a Document of the outer Folder says where that Document is kept, as the
 * core refuses to read it again. Set INCARNAMIND_SCREENSHOTS to a folder to also save screenshots.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
const QUOTE = "Termination notice: 90 days.";

const WORDS = {
  en: {
    outer: "Client A",
    inner: "Sealed",
    note: "Sealed note",
    file: "Client A lease.txt",
    text: "The notice is 90 days",
    kept: "Kept inside Client A",
  },
  "zh-CN": {
    outer: "客户甲",
    inner: "保密",
    note: "保密笔记",
    file: "客户甲租约.txt",
    text: "通知期为 90 天",
    kept: "仅在“客户甲”内使用",
  },
} as const;

let dataDir: string;
let sources: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  sources = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
  await removeDataFolder(sources);
});

for (const language of ["en", "zh-CN"] as const) {
  test(`a Citation in a Note behind an inner wall says the outer wall keeps its Document (${language})`, async () => {
    const w = WORDS[language];
    await writeFile(join(sources, w.file), `${QUOTE}\n`);
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await setLanguage(window, language);
    await setWindowSize(app, window, 900, 800);
    await addDocuments(window, [join(sources, w.file)]);
    await expectReadyDocuments(window, 1);
    await newMind(window, { title: true });
    await nameMind(window, w.note);
    const cited = await (await coreOf(window)).evaluate(async (core, names) => {
      const [document] = await core.listDocuments();
      const mind = (await core.listMinds()).find((each) => each.title === names.note);
      if (!document || !mind) throw new Error("The Document or the Note isn't there.");
      const outer = await core.createLibraryGroup({ name: names.outer, description: "" });
      await core.updateLibraryGroup(outer.id, {
        name: names.outer,
        description: "",
        keepInside: true,
      });
      const inner = await core.createLibraryGroup({
        name: names.inner,
        description: "",
        parentId: outer.id,
      });
      await core.updateLibraryGroup(inner.id, {
        name: names.inner,
        description: "",
        keepInside: true,
      });
      await core.assignDocumentGroup(document.id, outer.id);
      await core.moveToFolder({ mindIds: [mind.id], folderId: inner.id });
      return { id: document.id, name: document.name, contentHash: document.contentHash };
    }, w);

    const editor = window.getByTestId("mind-editor");
    await editor.evaluate(
      (dom, blocks) => {
        const { editor: tiptap } = dom as unknown as { editor: Editor };
        tiptap.commands.insertContentAt(tiptap.state.doc.content.size, blocks);
      },
      [
        {
          type: "paragraph",
          content: [
            { type: "text", text: `${w.text} ` },
            {
              type: "citation",
              attrs: {
                passageId: `passage-${cited.id}`,
                documentId: cited.id,
                documentName: cited.name,
                contentHash: cited.contentHash,
                location: { kind: "lines", from: 1, to: 1 },
                quote: QUOTE,
                check: "found",
              },
            },
          ],
        },
      ],
    );
    const citation = editor.getByTestId("citation");
    await expect(citation).toHaveCount(1);
    await pointAndClick(window, citation.getByTestId("citation-chip"));
    const card = window.getByTestId("citation-card");
    await expect(card).toBeVisible();
    await motionSettled(window);
    if (SCREENSHOTS)
      await window.screenshot({ path: join(SCREENSHOTS, `nested-wall-${language}-900.png`) });
    await expect(card.getByTestId("citation-kept-inside")).toHaveText(w.kept);
    await app.close();
  });
}
