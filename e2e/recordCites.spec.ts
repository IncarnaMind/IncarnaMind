import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { Editor } from "@tiptap/core";
import type { CoreBridge, RecordCiteResult } from "../src/core/api";
import { type MessageKey, type MessageParams, translate } from "../src/shared/i18n";
import { buildPdf } from "../tests/helpers/pdf";
import {
  addDocuments,
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
import { encodeMp4, Film } from "./demo/film";

const RAWS = ["Smith Dep. 45:3–12", "Ex. 7 at 3", "Dkt. 41 at 5", "PL-000123"] as const;
const TEXT = RAWS.join(" ");
const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
const RECORDING = process.env.INCARNAMIND_RECORD;

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

function at(raw: string): { from: number; to: number } {
  const from = TEXT.indexOf(raw);
  if (from < 0) throw new Error(`Missing record cite ${raw}`);
  return { from, to: from + raw.length };
}

async function makeSources() {
  await mkdir(join(sources, "a"), { recursive: true });
  await mkdir(join(sources, "b"), { recursive: true });
  const record = buildPdf(
    Array.from({ length: 9 }, (_, index) => ({
      lines: [`Record page ${index + 1}`, `The record's passage on physical page ${index + 1}.`],
    })),
  );
  const duplicate = buildPdf(
    Array.from({ length: 5 }, (_, index) => ({
      lines: [
        `Duplicate filing page ${index + 1}`,
        index === 4 ? "The docket entry supports the source choice." : "Another docket page.",
      ],
    })),
  );
  const paths = {
    record: join(sources, "Record.pdf"),
    a: join(sources, "a", "Duplicate filing.pdf"),
    b: join(sources, "b", "Duplicate filing.pdf"),
  };
  await Promise.all([
    writeFile(paths.record, record),
    writeFile(paths.a, duplicate),
    writeFile(paths.b, duplicate),
  ]);
  return paths;
}

async function setup(window: Page, language: "en" | "zh-CN") {
  const paths = await makeSources();
  await addDocuments(window, [paths.record, paths.a, paths.b]);
  const documents = await window.evaluate(() =>
    (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.listDocuments(),
  );
  const byPath = (path: string) => {
    const document = documents.find((each) => each.path === path);
    if (!document) throw new Error(`No Document for ${path}`);
    return document;
  };
  const [recordPath, duplicateAPath, duplicateBPath] = await Promise.all([
    realpath(paths.record),
    realpath(paths.a),
    realpath(paths.b),
  ]);
  const record = byPath(recordPath);
  const duplicateA = byPath(duplicateAPath);
  const duplicateB = byPath(duplicateBPath);
  const [provider] = await window.evaluate(() =>
    (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind.listChatProviders(),
  );
  if (!provider) throw new Error("The fake local chat provider is missing.");
  expect(duplicateA.id).not.toBe(duplicateB.id);
  expect(duplicateA.contentHash).toBe(duplicateB.contentHash);
  expect(duplicateA.name).toBe(duplicateB.name);

  await setLanguage(window, language);
  await newMind(window);
  const mindId = await window.getByTestId("mind-pane").first().getAttribute("data-mind-id");
  if (!mindId) throw new Error("No Mind id");
  const location = {
    kind: "page",
    from: 4,
    to: 4,
    printed: { from: "45", to: "45" },
    lines: { from: 3, to: 12 },
  } as const;
  const cites: RecordCiteResult[] = [
    {
      raw: RAWS[0],
      ...at(RAWS[0]),
      outcome: "supported",
      documentId: record.id,
      documentName: record.name,
      contentHash: record.contentHash,
      location,
      pageFrom: 4,
      pageTo: 4,
      passage: "The deposition passage supports notice.",
    },
    {
      raw: RAWS[1],
      ...at(RAWS[1]),
      outcome: "partly",
      documentId: record.id,
      documentName: record.name,
      contentHash: record.contentHash,
      location: { kind: "page", from: 3, to: 3 },
      pageFrom: 3,
      pageTo: 3,
      passage: "The exhibit says delivery was attempted.",
      covered: "the delivery attempt",
      uncovered: "receipt by the defendant",
    },
    {
      raw: RAWS[2],
      ...at(RAWS[2]),
      outcome: "choose",
      location: { kind: "page", from: 5, to: 5 },
      candidates: [
        { id: duplicateA.id, name: duplicateA.name },
        { id: duplicateB.id, name: duplicateB.name },
      ],
    },
    {
      raw: RAWS[3],
      ...at(RAWS[3]),
      outcome: "not-found",
      documentId: record.id,
      documentName: record.name,
      contentHash: record.contentHash,
      location: { kind: "page", from: 8, to: 8 },
      pageFrom: 8,
      pageTo: 8,
      passage: "The resolved cited page does not state the damages figure.",
      nearby: {
        location: { kind: "page", from: 9, to: 9, lines: { from: 5, to: 9 } },
        pageFrom: 9,
        pageTo: 9,
        passage: "The nearby lines state the damages figure.",
      },
    },
  ];
  const attrs = {
    id: "check-record-cites",
    request: "request-record-cites",
    action: "check-against-documents",
    state: "supported",
    reason: null,
    detail: null,
    providerId: provider.id,
    modelId: "fake-model",
    text: TEXT,
    evidence: {
      passageId: "overall-passage",
      documentId: record.id,
      documentName: record.name,
      contentHash: record.contentHash,
      pageFrom: 1,
      pageTo: 1,
      location: { kind: "page", from: 1, to: 1 },
      quote: "The record supports the sentence overall.",
      check: "found",
      checkReason: null,
    },
    says: null,
    unsupported: null,
    calculation: null,
    citedCaseUnchecked: false,
    citedCaseFound: false,
    scope: { folderId: null, widened: false },
    versions: [],
    excluded: [],
    recordCites: cites,
    checkedAt: new Date(Date.now() + 60_000).toISOString(),
  };
  const editor = window.getByTestId("mind-editor");
  await editor.evaluate(
    (dom, input) => {
      (dom as unknown as { editor: Editor }).editor.commands.insertContentAt(0, {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: input.text,
            marks: [{ type: "claimCheck", attrs: input.attrs }],
          },
        ],
      });
    },
    { text: TEXT, attrs },
  );
  await expect(window.getByTestId("claim-mark")).toHaveCount(1);
  // Its overall check is Supported, but a cite that is Choose or Not found never sits under that glyph.
  await expect(window.getByTestId("claim-mark")).toHaveAttribute("data-check", "unsupported");
  return { mindId, duplicateA, duplicateB };
}

async function openCard(window: Page) {
  await pointAndClick(window, window.getByTestId("claim-mark"));
  const card = window.getByTestId("claim-card");
  await expect(card).toBeVisible();
  return card;
}

async function screenshot(window: Page, name: string) {
  if (!SCREENSHOTS) return;
  await motionSettled(window);
  await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

async function citationCount(window: Page): Promise<number> {
  return window.getByTestId("mind-editor").evaluate((dom) => {
    let count = 0;
    (dom as unknown as { editor: Editor }).editor.state.doc.descendants((node) => {
      if (node.type.name === "citation") count++;
    });
    return count;
  });
}

test("every record cite stays visible in raw order, opens its physical passage, and a duplicate-name choice survives relaunch", async () => {
  test.setTimeout(240_000);
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setWindowSize(app, window, 1440, 900);
  const film = RECORDING
    ? await Film.start(window, join(RECORDING, "frames"), new Map())
    : undefined;
  film?.keep(true);
  const { mindId, duplicateA, duplicateB } = await setup(window, "en");
  const card = await openCard(window);
  const t = (key: MessageKey, params?: MessageParams) => translate("en", key, params);

  await expect(card.getByTestId("claim-badge")).toHaveText(t("claim.state.recordCite"));
  await expect(card.getByTestId("claim-add-citation")).toHaveText(t("claim.addAsCitation"));
  const entries = card.getByTestId("record-cite");
  await expect(entries).toHaveCount(4);
  expect(await card.getByTestId("record-cite-raw").allTextContents()).toEqual(RAWS);
  const outcomes = ["supported", "partly", "choose", "not-found"] as const;
  for (const [index, outcome] of outcomes.entries()) {
    await expect(entries.nth(index)).toHaveAttribute("data-outcome", outcome);
  }
  await expect(entries.nth(1).getByTestId("record-cite-partly")).toHaveText(
    t("claim.recordCites.covered", {
      covered: "the delivery attempt",
      uncovered: "receipt by the defendant",
    }),
  );
  const missing = entries.nth(3);
  await expect(missing.getByTestId("record-cite-passage")).toHaveText(
    "The resolved cited page does not state the damages figure.",
  );
  await expect(missing.getByTestId("record-cite-nearby-passage")).toHaveText(
    "The nearby lines state the damages figure.",
  );
  expect(await citationCount(window)).toBe(0);
  await screenshot(window, "record-cites-en");

  await pointAndClick(window, missing.getByTestId("record-cite-open"));
  await expect(window.getByTestId("pdf-page-number")).toHaveValue("8");
  await openCard(window);
  await pointAndClick(window, missing.getByTestId("record-cite-open-nearby"));
  await expect(window.getByTestId("pdf-page-number")).toHaveValue("9");
  await openCard(window);

  const chooseEntry = entries.nth(2);
  const choose = chooseEntry.getByTestId("record-cite-choose");
  await choose.focus();
  await window.keyboard.press("Enter");
  const picker = window.getByTestId("record-cite-source-picker");
  const search = window.getByTestId("record-cite-source-search");
  const options = picker.getByTestId("record-cite-source-option");
  await expect(search).toBeFocused();
  await expect(card).toBeVisible();
  await expect(options).toHaveCount(2);
  expect(await options.allTextContents()).toHaveLength(2);
  await expect(options.nth(0)).toHaveAttribute("data-document-id", duplicateA.id);
  await expect(options.nth(1)).toHaveAttribute("data-document-id", duplicateB.id);
  expect(await options.getByTestId("record-cite-source-option-label").allTextContents()).toEqual([
    duplicateA.name,
    duplicateB.name,
  ]);
  await window.keyboard.press("Escape");
  await expect(picker).not.toBeVisible();
  await expect(card).toBeVisible();
  await expect(choose).toBeFocused();

  await window.keyboard.press("Enter");
  await expect(search).toBeFocused();
  await window.keyboard.press("ArrowDown");
  await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");
  await window.keyboard.press("Enter");
  await expect(picker).not.toBeVisible();
  await expect(card).toBeVisible();
  await expect(card.getByTestId("record-cite-problem")).toHaveCount(0);
  await expect(chooseEntry).toHaveAttribute("data-document-id", duplicateB.id);
  await expect(chooseEntry).not.toHaveAttribute("data-outcome", "choose");
  await expect(card.getByTestId("claim-badge")).toHaveText(t("claim.state.recordCite"));
  await expect(entries).toHaveCount(4);
  await expect
    .poll(() => chooseEntry.evaluate((entry) => entry.contains(document.activeElement)))
    .toBe(true);
  expect(await citationCount(window)).toBe(0);
  if (film && RECORDING) {
    film.mark("end");
    await film.stop();
    const master = join(RECORDING, "master.mp4");
    await film.master(master);
    await encodeMp4(master, join(RECORDING, "record-cites-flow.mp4"));
  }
  await app.close();

  const again = await launchApp(dataDir, { fakeChat: true });
  await setWindowSize(again.app, again.window, 1440, 900);
  // On Linux the relaunched window doesn't bring the Note's tab back; the sidebar lists it on every system.
  await pointAndClick(
    again.window,
    again.window.locator(`[data-testid="mind-list-item"][data-mind-id="${mindId}"]`),
  );
  await expect(again.window.getByTestId("mind-pane")).toHaveAttribute("data-mind-id", mindId);
  const reopened = await openCard(again.window);
  const persisted = reopened.getByTestId("record-cite").nth(2);
  await expect(persisted).toHaveAttribute("data-document-id", duplicateB.id);
  await expect(persisted).not.toHaveAttribute("data-outcome", "choose");
  await expect(reopened.getByTestId("record-cite")).toHaveCount(4);
  expect(await citationCount(again.window)).toBe(0);
  await again.app.close();
});

test("the narrow Chinese card keeps raw English cites and picker keyboard focus without overflowing", async () => {
  test.setTimeout(180_000);
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  // Shorter than the card with all four cites: it must fit the room under its mark (#1741).
  await setWindowSize(app, window, 900, 640);
  const { duplicateA, duplicateB } = await setup(window, "zh-CN");
  const card = await openCard(window);
  const t = (key: MessageKey, params?: MessageParams) => translate("zh-CN", key, params);

  expect(await card.getByTestId("record-cite-raw").allTextContents()).toEqual(RAWS);
  const outcomes = [
    "claim.state.supported",
    "claim.recordCites.partly",
    "claim.recordCites.choose",
    "claim.recordCites.not-found",
  ] as const;
  const labels = card.getByTestId("record-cite-outcome");
  for (const [index, key] of outcomes.entries()) {
    await expect(labels.nth(index)).toHaveText(t(key));
  }
  await expect(card.getByTestId("record-cite-nearby-location")).toContainText(
    t("location.page", { range: "9" }),
  );
  const choose = card.getByTestId("record-cite-choose");
  await choose.focus();
  await window.keyboard.press("Enter");
  const picker = window.getByTestId("record-cite-source-picker");
  const search = window.getByTestId("record-cite-source-search");
  await expect(search).toBeFocused();
  const options = picker.getByTestId("record-cite-source-option");
  await expect(options.nth(0)).toHaveAttribute("data-document-id", duplicateA.id);
  await expect(options.nth(1)).toHaveAttribute("data-document-id", duplicateB.id);
  await expect(options.nth(0)).toContainText("…/a/Duplicate filing.pdf");
  await screenshot(window, "record-cites-picker-narrow-zh");
  await window.keyboard.press("Escape");
  await expect(choose).toBeFocused();
  await expect(card).toBeVisible();

  const fits = await card.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return {
      horizontal: element.scrollWidth <= element.clientWidth,
      left: box.left >= 0,
      right: box.right <= globalThis.innerWidth,
      top: box.top >= 0,
      bottom: box.bottom <= globalThis.innerHeight,
      entries: [...element.querySelectorAll('[data-testid="record-cite"]')].every(
        (entry) => entry.scrollWidth <= entry.clientWidth,
      ),
    };
  });
  expect(fits).toEqual({
    horizontal: true,
    left: true,
    right: true,
    top: true,
    bottom: true,
    entries: true,
  });
  await screenshot(window, "record-cites-narrow-zh");
  await app.close();
});
