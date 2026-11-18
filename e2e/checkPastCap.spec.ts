import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import type { CoreBridge } from "../src/core/api";
import {
  addDocuments,
  checkCard,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  motionSettled,
  newMind,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  useLocalChatModel,
} from "./app";

/**
 * A sentence past the most one write checks says why in its card, and Check checks it alone.
 */
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

const QUOTE_ONE = "QN methods are much faster than GD algorithms";
const UNCITED = "Penguins nest on the harbour cliffs.";

test("a sentence past the most one write checks says why, in English and Chinese, and Check checks it alone", async () => {
  test.setTimeout(120_000);
  await writeFile(join(sources, "Tutorial one.md"), `# One\n\n${QUOTE_ONE} in practice.\n`);
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setWindowSize(app, window, 1600, 900);
  await addDocuments(window, [join(sources, "Tutorial one.md")]);
  const documentIds = await window.evaluate(async () =>
    (await (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.listDocuments()).map(
      (each) => each.id,
    ),
  );
  await newMind(window);
  const editor = window.getByTestId("mind-editor");
  // As a write of the assistant's leaves the sentences past the most it checks.
  const pastCap = (id: string, text: string, ...citations: object[]) => ({
    type: "paragraph",
    content: [
      {
        type: "text",
        text,
        marks: [
          {
            type: "claimCheck",
            attrs: {
              id,
              request: "write-1",
              action: "check-against-documents",
              state: "not-checked",
              reason: "too-many",
              text,
              scope: { folderId: null, widened: false },
              versions: [],
              excluded: [],
              checkedAt: "2026-10-18T09:00:00.000Z",
            },
          },
        ],
      },
      ...citations,
    ],
  });
  const missing = {
    type: "citation",
    attrs: {
      passageId: "passage-1",
      documentId: documentIds[0],
      documentName: "Tutorial one",
      pageFrom: 1,
      pageTo: 1,
      quote: "A quote the page doesn't hold.",
      check: "not-found",
      checkReason: "quote-not-on-pages",
    },
  };
  await editor.evaluate(
    (dom, content) => {
      (dom as unknown as { editor: Editor }).editor.commands.insertContentAt(0, content);
    },
    [pastCap("past-1", UNCITED), pastCap("past-2", "Gulls nest on the harbour walls.", missing)],
  );
  const marks = window.getByTestId("claim-mark");
  const card = window.getByTestId("claim-card");
  /** Opens the card of the claim not checked yet from the badge's row for them (#1941). */
  const openCardFor = async () => {
    await pointAndClick(window, (await checkCard(window)).getByTestId("health-toCheck"));
    await expect(card).toBeVisible();
    await motionSettled(window);
  };
  await expect(marks).toHaveCount(2);
  // A sentence the write left unchecked has no mark on the page, and its Citation that
  // isn't found has its own state on its marker: the two never disagree.
  await expect(marks.last()).toHaveAttribute("data-check", "not-checked");
  await expect(marks.last()).toBeHidden();
  const marker = editor.getByTestId("citation-chip");
  await expect(marker).toHaveAttribute("data-check", "not-found");
  await expect(marker.locator(".citation-marker-icon")).toBeVisible();
  for (const [language, reason, now] of [
    [
      "en",
      "Not checked yet: only the first 12 cited sentences are checked as they’re written",
      "Check",
    ],
    ["zh-CN", "尚未核对：写入时只核对前 12 句带引用的话", "核对"],
  ] as const) {
    await setLanguage(window, language);
    await motionSettled(window);
    await openCardFor();
    await expect(card.getByTestId("claim-reason")).toContainText(reason);
    await expect(card.getByTestId("claim-check-now")).toHaveText(now);
    await expect(card.getByTestId("claim-check-again")).toHaveCount(0);
    await window.keyboard.press("Escape");
  }

  await motionSettled(window);
  await openCardFor();
  await pointAndClick(window, card.getByTestId("claim-check-now"));
  await expect(marks.first()).not.toHaveAttribute("data-claim", "past-1");
  await expect(marks.first()).toHaveAttribute("data-check", "unsupported");
  await expect(marks.last()).toHaveAttribute("data-claim", "past-2");
  await expect(marks.last()).toHaveAttribute("data-check", "not-checked");
  await app.close();
});
