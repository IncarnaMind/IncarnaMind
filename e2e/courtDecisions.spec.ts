import { writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { formatShortDate } from "../src/shared/dates";
import { translate } from "../src/shared/i18n";
import { savedPageSource } from "../src/shared/webSource";
import { buildPdf } from "../tests/helpers/pdf";
import {
  addDocuments,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  newMind,
  pointAndClick,
  removeDataFolder,
  setLanguage,
  setWindowSize,
  slideSelect,
  useLocalChatModel,
} from "./app";

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

const TIDES = buildPdf([
  { lines: ["Harbour times", "Harbours publish the times of high water every 12 months."] },
]);
const HARBOURS = buildPdf([
  { lines: ["Harbour times", "Harbours publish the times of high water every year."] },
]);
const OPINION = buildPdf([
  {
    lines: [
      "Hallmark Builders, Inc. v. Rio Grande Supply Co.",
      "512 S.W.3d 101 (Tex. 2017)",
      "A supplier lien attaches when the materials are delivered to the job site.",
    ],
  },
]);
const CITATION = "Hallmark Builders v. Rio Grande Supply, 512 S.W.3d 101 (Tex. 2017)";
const INVENTED = `See ${CITATION}.`;
const BESIDE = "Penguins nest on the harbour cliffs.";
const BACKED = `Harbours publish the times of high water every year, see ${CITATION}.`;
const HELD = `A supplier lien attaches when the materials are delivered to the job site, see ${CITATION}.`;

const WORDS = {
  en: {
    title: "This cites a court decision.",
    body: "IncarnaMind can’t check that this case exists or says this. Check it in your legal research service before you rely on it.",
    nothing: "I didn’t find this in “All Documents”.",
    unchecked:
      "Not checked: the cited case isn’t in your Documents. Check it in your legal research service before you rely on it.",
    held: (document: string, location: string) =>
      `Quote found in your copy of the opinion (${document}, ${location}). Not checked whether it was overruled or changed. Check it in your legal research service before you rely on it.`,
    page: "p. 1",
  },
  "zh-CN": {
    title: "本句引用了法院判决。",
    body: "IncarnaMind 无法核对该判决是否存在、是否这样说。依赖前请在你的法律数据库中查证。",
    nothing: "未在“全部文档”中找到。",
    unchecked: "未核对：引用的判决不在你的文档中。依赖前请在你的法律数据库中查证。",
    held: (document: string, location: string) =>
      `已在你保存的判决书中找到引文（${document}，${location}）。未核对是否已被推翻或修改。依赖前请在你的法律数据库中查证。`,
    page: "第 1 页",
  },
} as const;

async function findSupportFor(window: Page, texts: readonly string[], firstWords: string) {
  const editor = window.getByTestId("mind-editor");
  await editor.click();
  for (const [index, text] of texts.entries()) {
    if (index > 0) await window.keyboard.press("Enter");
    await window.keyboard.type(text);
  }
  const lines = editor.locator(":scope > p");
  const last = texts.length - 1;
  await slideSelect(window, lines.first(), firstWords, {
    line: lines.nth(last),
    words: (texts[last] ?? "").split(" ").at(-1) ?? "",
  });
  await pointAndClick(
    window,
    window.getByTestId("selection-menu").getByTestId("selection-action-find-support"),
  );
  const marks = window.getByTestId("claim-mark");
  await expect(marks).toHaveCount(texts.length);
  for (let index = 0; index < texts.length; index++) {
    await expect(marks.nth(index)).not.toHaveAttribute("data-check", "checking");
  }
}

for (const language of ["en", "zh-CN"] as const) {
  test(`a cited court decision no Document holds is a card that says it can't be checked, with Remove the mark only (${language})`, async () => {
    test.setTimeout(120_000);
    const words = WORDS[language];
    await writeFile(join(sources, "Tides.pdf"), TIDES);
    const { app, window } = await launchApp(dataDir, { fakeChat: true, home: sources });
    await setWindowSize(app, window, 1440, 900);
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await setLanguage(window, language);
    await addDocuments(window, [join(sources, "Tides.pdf")]);
    await newMind(window);
    await findSupportFor(window, [INVENTED, BESIDE], "See Hallmark");
    const marks = window.getByTestId("claim-mark");
    const card = window.getByTestId("claim-card");

    await pointAndClick(window, marks.first());
    await expect(marks.first()).toHaveAttribute("data-check", "unsupported");
    await expect(card.getByTestId("claim-badge")).toHaveAttribute("data-check", "unsupported");
    await expect(card.getByTestId("claim-badge")).toHaveText(words.title);
    await expect(card.getByTestId("claim-court-decision")).toHaveText(words.body);
    await expect(card.getByTestId("claim-nothing")).toHaveCount(0);
    await expect(card.getByTestId("claim-find-sources")).toHaveCount(0);
    await expect(card.getByTestId("claim-search-web")).toHaveCount(0);
    await expect(card.getByTestId("claim-cut-sentence")).toHaveCount(0);
    await expect(card.getByTestId("claim-keep")).toHaveCount(0);
    await expect(card.getByTestId("claim-remove")).toBeVisible();

    await window.keyboard.press("Escape");
    await expect(card).toHaveCount(0);
    await pointAndClick(window, marks.nth(1));
    await expect(card.getByTestId("claim-nothing")).toHaveText(words.nothing);
    await expect(card.getByTestId("claim-court-decision")).toHaveCount(0);
    await expect(card.getByTestId("claim-search-web")).toBeVisible();

    await window.keyboard.press("Escape");
    await expect(card).toHaveCount(0);
    await pointAndClick(window, marks.first());
    await pointAndClick(window, card.getByTestId("claim-remove"));
    await expect(marks).toHaveCount(1);
    await app.close();
  });

  test(`a Supported sentence whose cited case is in no Document stays Supported, and its card says the citation isn't checked (${language})`, async () => {
    test.setTimeout(120_000);
    const words = WORDS[language];
    await writeFile(join(sources, "Harbours.pdf"), HARBOURS);
    const { app, window } = await launchApp(dataDir, { fakeChat: true, home: sources });
    await setWindowSize(app, window, 1440, 900);
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await setLanguage(window, language);
    await addDocuments(window, [join(sources, "Harbours.pdf")]);
    await newMind(window);
    await findSupportFor(window, [BACKED], "Harbours publish");
    const marks = window.getByTestId("claim-mark");
    await expect(marks.first()).toHaveAttribute("data-check", "supported");

    await pointAndClick(window, marks.first());
    const card = window.getByTestId("claim-card");
    await expect(card.getByTestId("claim-badge")).toHaveAttribute("data-check", "supported");
    await expect(card.getByTestId("claim-cited-case-unchecked")).toHaveText(words.unchecked);
    await expect(card.getByTestId("claim-court-decision")).toHaveCount(0);
    await expect(card.getByTestId("claim-court-decision-held")).toHaveCount(0);
    await app.close();
  });

  test(`a cited court decision whose opinion is among the Documents is checked against it, and the card says where it was found (${language})`, async () => {
    test.setTimeout(120_000);
    const words = WORDS[language];
    await writeFile(join(sources, "Tides.pdf"), TIDES);
    await writeFile(join(sources, "Hallmark Builders v Rio Grande Supply.pdf"), OPINION);
    const { app, window } = await launchApp(dataDir, { fakeChat: true, home: sources });
    await setWindowSize(app, window, 1440, 900);
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await setLanguage(window, language);
    await addDocuments(window, [
      join(sources, "Tides.pdf"),
      join(sources, "Hallmark Builders v Rio Grande Supply.pdf"),
    ]);
    await newMind(window);
    await findSupportFor(window, [HELD], "A supplier");
    const marks = window.getByTestId("claim-mark");
    await expect(marks.first()).toHaveAttribute("data-check", "supported");

    await pointAndClick(window, marks.first());
    const card = window.getByTestId("claim-card");
    await expect(card.getByTestId("claim-badge")).toHaveAttribute("data-check", "supported");
    await expect(card.getByTestId("claim-court-decision-held")).toHaveText(
      words.held("Hallmark Builders v Rio Grande Supply", words.page),
    );
    await expect(card.getByTestId("claim-court-decision")).toHaveCount(0);
    await expect(card.getByTestId("claim-cited-case-unchecked")).toHaveCount(0);
    await expect(card.getByTestId("claim-web-source")).toHaveCount(0);
    await app.close();
  });
}

const OPINION_PATH =
  "/opinions/2017/supreme-court/hallmark-builders-v-rio-grande-supply-512-sw3d-101.html";
const OPINION_TITLE = "Hallmark Builders v. Rio Grande Supply";
const OPINION_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${OPINION_TITLE}</title></head><body><article><h1>${OPINION_TITLE}</h1><p>A supplier lien attaches when the materials are delivered to the job site.</p><p>${CITATION}.</p>${Array.from(
  { length: 6 },
  () =>
    "<p>Construction law lets suppliers of materials secure payment against the property improved with them, provided they give the owner written notice within the time the statute allows.</p>",
).join("")}</article></body></html>`;

test.describe("a web page the User saved", () => {
  let server: Server;
  let port: number;
  test.beforeEach(async () => {
    server = createServer((request, response) => {
      if (request.url === OPINION_PATH) {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(OPINION_PAGE);
      } else {
        response.writeHead(404);
        response.end("Not found");
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const bound = server.address();
    if (bound === null || typeof bound === "string") throw new Error("The server has no port.");
    port = bound.port;
  });
  test.afterEach(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  for (const language of ["en", "zh-CN"] as const) {
    test(`counts as the opinion, and the card names it with its address cut in the middle and the day it was saved (${language})`, async () => {
      test.setTimeout(120_000);
      const address = `http://127.0.0.1:${port}${OPINION_PATH}`;
      const { app, window } = await launchApp(dataDir, {
        fakeChat: true,
        home: sources,
        web: port,
      });
      await setWindowSize(app, window, 1440, 900);
      await dismissChatSetup(window);
      await useLocalChatModel(window);
      await setLanguage(window, language);
      await window.getByTestId("plus-menu").click();
      await window.getByTestId("plus-more").click();
      await window.getByTestId("plus-add-web-page").click();
      const dialog = window.getByTestId("add-web-page-dialog");
      await dialog.getByTestId("add-web-page-addresses").fill(address);
      await dialog.getByTestId("add-web-page-confirm").click();
      await expect(dialog).toBeHidden();
      const row = window.getByTestId("document-list-item").filter({ hasText: OPINION_TITLE });
      await expect(row).toHaveAttribute("data-status", "ready");
      await newMind(window);
      await findSupportFor(window, [HELD], "A supplier");
      const marks = window.getByTestId("claim-mark");
      await expect(marks.first()).toHaveAttribute("data-check", "supported");

      await pointAndClick(window, marks.first());
      const card = window.getByTestId("claim-card");
      const source = card.getByTestId("claim-web-source");
      const t = (
        ...args: Parameters<typeof translate> extends [unknown, ...infer Rest] ? Rest : never
      ) => translate(language, ...args);
      const savedAt = new Date().toISOString();
      const shown = savedPageSource({ address, savedAt }, language, t, { compact: true });
      await expect(source).toHaveText(shown);
      expect(shown).toContain("…");
      expect(shown).not.toContain(address);
      expect(shown).toContain(formatShortDate(savedAt, language));
      await expect(source).toHaveAttribute(
        "title",
        savedPageSource({ address, savedAt }, language, t, { compact: false }),
      );
      await expect(card.getByTestId("claim-cited-case-unchecked")).toHaveCount(0);
      await expect(card.getByTestId("claim-court-decision-held")).toContainText(
        language === "en" ? `(${OPINION_TITLE}, ` : `（${OPINION_TITLE}，`,
      );
      await app.close();
    });
  }
});
