import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import type { CoreBridge } from "../src/core/api";
import { buildPdf } from "../tests/helpers/pdf";
import {
  addDocuments,
  checkCard,
  createDataFolder,
  dismissChatSetup,
  exportFromMenu,
  launchApp,
  nameMind,
  newMind,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  useLocalChatModel,
  useOutputLocation,
} from "./app";

/*
 * A Note whose every verdict is handled reads ✓ Checked (#2313, the 2026-11-08 walk): a sentence
 * supported, one the User keeps as their view, and one a check can't settle while it and its file
 * stay as they are (a figure its workbook works out anew each time). The badge, the card, Home,
 * the Export menu and the Saved line say the same line, "Checked {time} · 1 sentence can't be
 * checked", and a second Check sends nothing. The checks are written into the page, so no model
 * judges anything.
 */

const TIDES = buildPdf([
  { lines: ["Harbour times", "Harbours publish the times of high water every 12 months."] },
]);

const WORDS = {
  en: {
    checked: /^Checked \S/,
    cant: "1 sentence can’t be checked",
    rows: { supported: "1 supported", cantCheck: "1 can’t be checked" },
    unchanged: "Nothing changed since ",
  },
  "zh-CN": {
    checked: /^已核对 \S/,
    cant: "1 句无法核对",
    rows: { supported: "1 句有依据", cantCheck: "1 句无法核对" },
    unchanged: "自 ",
  },
} as const;

const SENTENCES = {
  supported: "Harbours publish the times of high water every 12 months.",
  kept: "The harbour feels busiest in spring.",
  volatile: "The tide table's running total is 4.2 metres today.",
};

let dataDir: string;
let sources: string;
let out: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  sources = await createDataFolder();
  out = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
  await removeDataFolder(sources);
  await removeDataFolder(out);
});

const checked = (id: string, state: string, text: string, extra: Record<string, unknown> = {}) => ({
  type: "text",
  text,
  marks: [
    {
      type: "claimCheck",
      attrs: {
        id,
        request: "check-1",
        action: "check-against-documents",
        state,
        text,
        scope: { folderId: null, widened: false },
        versions: [],
        excluded: [],
        checkedAt: "2026-11-08T09:00:00.000Z",
        ...extra,
      },
    },
  ],
});
const paragraph = (...content: object[]) => ({ type: "paragraph", content });

for (const language of ["en", "zh-CN"] as const) {
  const words = WORDS[language];

  test(`a Note whose verdicts are all handled reads Checked in the badge, the card, Home, Export and the Saved line, and a second Check sends nothing (${language})`, async () => {
    test.setTimeout(180_000);
    await writeFile(join(sources, "Tides.pdf"), TIDES);
    const { app, window } = await launchApp(dataDir, { fakeChat: true });
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await setLanguage(window, language);
    await setWindowSize(app, window, 1440, 900);
    await useOutputLocation(window, out);
    await addDocuments(window, [join(sources, "Tides.pdf")]);
    const [tides] = await window.evaluate(() =>
      (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.listDocuments(),
    );
    const passage = {
      passageId: "passage-1",
      documentId: tides?.id,
      documentName: "Tides",
      contentHash: tides?.contentHash,
      pageFrom: 1,
      pageTo: 1,
      location: null,
      quote: SENTENCES.supported,
      check: "found",
      checkReason: null,
    };

    // Each check read the Document as it is now, after it was added: nothing added since could
    // change a verdict, so a second Check has nothing to send.
    const versions = [{ documentId: tides?.id, contentHash: tides?.contentHash }];
    const checkedAt = new Date().toISOString();

    await newMind(window);
    await nameMind(window, "Harbour notes");
    const editor = window.getByTestId("mind-editor");
    await editor.evaluate(
      (dom, nodes) => {
        const { editor: current } = dom as unknown as { editor: Editor };
        current.commands.insertContentAt(current.state.doc.content.size, nodes);
      },
      [
        // Supported with no Citation of its own: a contradiction watch has nothing to read.
        paragraph(
          checked("check-1", "supported", SENTENCES.supported, {
            evidence: passage,
            versions,
            checkedAt,
          }),
        ),
        paragraph(checked("check-2", "unsupported", SENTENCES.kept, { kept: true, checkedAt })),
        paragraph(
          checked("check-3", "not-checked", SENTENCES.volatile, {
            reason: "workbook-volatile",
            versions,
            checkedAt,
          }),
        ),
      ],
    );

    // The badge: ✓ Checked, with what a check can't settle named beside it.
    const badge = window.getByTestId("check-badge");
    await expect(badge).toHaveAttribute("data-state", "checked");
    await expect(badge.locator(".check-badge-words")).toHaveText(words.checked);

    // The card: the same line, and each sentence once, none of them "not checked".
    const card = await checkCard(window);
    const line = card.getByTestId("health-all-checked");
    await expect(line).toHaveText(words.checked);
    await expect(line).toContainText(words.cant);
    const shown = (await line.textContent()) ?? "";
    await expect(card.getByTestId("health-supported")).toContainText(words.rows.supported);
    await expect(card.getByTestId("health-cantCheck")).toContainText(words.rows.cantCheck);
    await expect(card.getByTestId("health-toCheck")).toHaveCount(0);

    // A second Check sends nothing: nothing changed since.
    await pointAndClick(window, card.getByTestId("badge-check-mind"));
    await expect(card.getByTestId("mind-check-unchanged")).toContainText(words.unchanged);
    await expect(window.getByTestId("badge-stop")).toHaveCount(0);
    await expect(badge).toHaveAttribute("data-state", "checked");
    await window.keyboard.press("Escape");

    // Home's row quotes the same line.
    await window.getByTestId("sidebar-home").click();
    const row = window
      .getByTestId("home-recent-row")
      .filter({ has: window.getByTestId("row-text").getByText("Harbour notes", { exact: true }) });
    await expect(row.getByTestId("home-recent-state")).toHaveText(shown);
    await row.getByTestId("home-recent-open").click();

    // The Export menu and the Saved line quote it too.
    await pointAndClick(window, window.getByTestId("export-mind"));
    await expect(window.getByTestId("export-note-state")).toContainText(shown);
    await window.keyboard.press("Escape");
    await exportFromMenu(window, "docx");
    const saved = window.getByTestId("export-result").getByTestId("export-unchecked");
    await expect(saved).toHaveText(shown.split(" · "));
    await app.close();
  });
}
