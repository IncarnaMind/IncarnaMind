/**
 * "Cite as" in the Library (#286): a Document's reference record, read from
 * its file, edited in place, and filled by Look up, which asks once and sends
 * the DOI only, to a local stand-in for Crossref here.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { buildPdf } from "../tests/helpers/pdf";
import {
  type ReferenceServices,
  recordedAnswer,
  startReferenceServices,
} from "../tests/helpers/referenceServices";
import {
  addDocuments,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  removeDataFolder,
  setWindowSize,
  widthOf,
} from "./app";

const DOI = "10.1038/s41586-020-2649-2";

let dataDir: string;
let sources: string;
let services: ReferenceServices;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  sources = await createDataFolder();
  services = await startReferenceServices({
    crossref: { [DOI]: recordedAnswer("crossref-numpy.json") },
  });
});
test.afterEach(async () => {
  await services.close();
  await removeDataFolder(dataDir);
  await removeDataFolder(sources);
});

/** A paper with its DOI printed on page 1 and nothing else known, and a contract. */
async function writeSources(): Promise<string[]> {
  const paper = join(sources, "s41586-020-2649-2.pdf");
  const contract = join(sources, "Aldermoor MSA.pdf");
  await writeFile(
    paper,
    buildPdf([{ lines: ["Array programming with NumPy", `https://doi.org/${DOI}`] }]),
  );
  await writeFile(contract, buildPdf([{ lines: ["MASTER SERVICES AGREEMENT"] }]));
  return [paper, contract];
}

const row = (window: Page, name: string) =>
  window.getByTestId("library-document").filter({ hasText: name });

test("⌘-click and Shift-click anywhere on a row, its Needs details chip included, only change the selection, and Cite as opens from its own chip (#1509)", async () => {
  const session = await launchApp(dataDir, { fakeChat: true });
  try {
    const { app, window } = session;
    await setWindowSize(app, window, 1400, 800);
    await dismissChatSetup(window);
    await addDocuments(window, await writeSources());
    await window.getByTestId("open-library").click();
    const paper = row(window, "s41586-020-2649-2");
    const contract = row(window, "Aldermoor MSA");
    const chip = paper.getByTestId("cite-as-toggle");
    await expect(chip).toHaveText("Needs details");
    const selected = (target: Locator) => expect(target).toHaveAttribute("aria-selected", "true");
    const opensNothing = async () => {
      await expect(window.getByTestId("cite-as")).toHaveCount(0);
      await expect(window.getByRole("listbox")).toHaveCount(0);
    };

    // ⌘-click on the chip selects the row, and opens no panel.
    await chip.click({ modifiers: ["ControlOrMeta"] });
    await selected(paper);
    await opensNothing();

    // A second ⌘-click, on the other row's name, adds it; neither opens anything.
    await contract.getByTestId("library-document-name").click({ modifiers: ["ControlOrMeta"] });
    await selected(paper);
    await selected(contract);
    await opensNothing();

    // ⌘-click on the chip again takes its row out; Shift-click on it selects it from the anchor.
    await chip.click({ modifiers: ["ControlOrMeta"] });
    await expect(paper).toHaveAttribute("aria-selected", "false");
    await selected(contract);
    await chip.click({ modifiers: ["Shift"] });
    await selected(paper);
    await opensNothing();

    // Its own click opens it.
    await chip.click();
    await expect(paper.getByTestId("cite-as")).toBeVisible();
  } finally {
    await session.app.close();
  }
});

test("Needs details opens Cite as at the first missing field, and each field is edited in place", async () => {
  let session = await launchApp(dataDir);
  try {
    let { window } = session;
    await dismissChatSetup(window);
    await addDocuments(window, await writeSources());
    await window.getByTestId("open-library").click();

    // The paper needs details; the contract, which says nothing of itself, doesn't.
    const paper = row(window, "s41586-020-2649-2");
    const toggle = paper.getByTestId("cite-as-toggle");
    await expect(toggle).toHaveText("Needs details");
    await expect(toggle).toHaveAttribute("title", "Needed to cite it: title, authors, and date");
    await expect(row(window, "Aldermoor MSA").locator("[data-needs-details]")).toHaveCount(0);

    // It opens at the title, the first field missing.
    await toggle.hover();
    await toggle.click();
    const panel = paper.getByTestId("cite-as");
    await expect(panel.getByTestId("reference-type")).toHaveValue("article-journal");
    await expect(panel.getByTestId("reference-doi")).toHaveText(DOI);
    const titleField = panel.getByTestId("reference-title-input");
    await expect(titleField).toBeFocused();

    // An input method's Enter only picks its candidate: the field stays open.
    await window.keyboard.type("Array programming with NumPy");
    await titleField.dispatchEvent("keydown", { key: "Enter", isComposing: true, bubbles: true });
    await expect(titleField).toBeVisible();
    // Enter saves.
    await window.keyboard.press("Enter");
    await expect(panel.getByTestId("reference-title")).toHaveText("Array programming with NumPy");
    await expect(panel.getByTestId("reference-title")).toBeFocused();

    // Esc cancels: nothing changes.
    await panel.getByTestId("reference-volume").click();
    await window.keyboard.type("999");
    await window.keyboard.press("Escape");
    await expect(panel.getByTestId("reference-volume")).toHaveText("Empty");
    await expect(panel).toBeVisible();

    // A date that isn't one says why, and stays open until it is.
    await panel.getByTestId("reference-issued").click();
    await window.keyboard.type("soon");
    await window.keyboard.press("Enter");
    await expect(panel.getByRole("alert")).toHaveText(
      "Write a year, such as 2010, or a date, such as 2010-08-04",
    );
    await window.keyboard.press("ControlOrMeta+a");
    await window.keyboard.type("2020年9月16日");
    await window.keyboard.press("Enter");
    await expect(panel.getByTestId("reference-issued")).toHaveText("2020-09-16");

    // Authors, typed one after another; Chinese names stay whole.
    await panel.getByTestId("reference-authors").click();
    await window.keyboard.type("Harris, Charles R.; 张三");
    await window.keyboard.press("Enter");
    await expect(panel.getByTestId("reference-authors")).toHaveText("Harris, Charles R.; 张三");
    // The type, which the DOI suggested, is still a guess to check.
    await expect(toggle).toHaveText("Needs checking");

    // Undo takes the last change back.
    await expect(window.getByTestId("undo-message")).toHaveText(
      "Changed the authors of “s41586-020-2649-2”",
    );
    await window.getByTestId("undo-action").click();
    await expect(panel.getByTestId("reference-authors")).toHaveText("Needed to cite");
    await expect(toggle).toHaveText("Needs details");

    // Esc, outside a field, closes the panel and puts the focus back on its toggle.
    await panel.getByTestId("reference-title").focus();
    await window.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);
    await expect(toggle).toBeFocused();

    // The edits are kept.
    await session.app.close();
    session = await launchApp(dataDir);
    window = session.window;
    await window.getByTestId("open-library").click();
    await row(window, "s41586-020-2649-2").getByTestId("cite-as-toggle").click();
    await expect(
      row(window, "s41586-020-2649-2").getByTestId("cite-as").getByTestId("reference-title"),
    ).toHaveText("Array programming with NumPy");
  } finally {
    await session.app.close();
  }
});

test("Look up asks once, sends only the DOI, and fills the empty fields; in Chinese, at the narrowest window, it fits", async () => {
  const { app, window } = await launchApp(dataDir, { referenceLookup: services.url });
  try {
    await dismissChatSetup(window);
    await addDocuments(window, await writeSources());
    await window.evaluate(() =>
      (
        globalThis as unknown as {
          incarnamind: { updateSettings(patch: unknown): Promise<unknown> };
        }
      ).incarnamind.updateSettings({ user: { language: "zh-CN" } }),
    );
    await setWindowSize(app, window, 900, 660);
    await window.getByTestId("open-library").click();

    const paper = row(window, "s41586-020-2649-2");
    await paper.getByTestId("cite-as-toggle").click();
    const panel = paper.getByTestId("cite-as");
    await panel.getByTestId("reference-title-input").press("Escape");
    await expect(panel.getByTestId("reference-look-up")).toHaveAttribute(
      "title",
      "从 Crossref 补全空白字段。只发送 DOI。",
    );

    // Asked first: nothing is sent until the User allows it.
    await panel.getByTestId("reference-look-up").click();
    const consent = window.getByTestId("consent-dialog");
    await expect(consent).toBeVisible();
    await expect(consent).toContainText("Crossref");
    await expect(consent).toContainText("文档的 DOI 或 arXiv 编号，不含文档的其他任何内容");
    expect(services.requests).toEqual([]);
    await window.getByTestId("consent-allow").click();

    await expect(panel.getByTestId("reference-look-up-result")).toHaveText(
      "已从 Crossref 补全 9 个字段",
    );
    await expect(panel.getByTestId("reference-title")).toHaveText("Array programming with NumPy");
    await expect(panel.getByTestId("reference-containerTitle")).toHaveText("Nature");
    await expect(paper.getByTestId("cite-as-toggle")).toHaveText("引用信息");
    expect(services.requests.map((request) => request.path)).toEqual([
      `/works/${encodeURIComponent(DOI)}`,
    ]);

    // The panel fits in the Library at the narrowest window, its labels unbroken.
    const library = window.getByTestId("library");
    const panelBox = await panel.boundingBox();
    const libraryBox = await library.boundingBox();
    expect(panelBox && libraryBox && panelBox.x + panelBox.width).toBeLessThanOrEqual(
      (libraryBox?.x ?? 0) + (libraryBox?.width ?? 0),
    );
    const label = panel.locator("dt").filter({ hasText: "期刊" });
    expect(await widthOf(label)).toBeGreaterThanOrEqual(24);
    const lineHeight = await label.evaluate((element) => element.getBoundingClientRect().height);
    expect(lineHeight).toBeLessThan(40);

    // Asked once: a second Look up asks nothing.
    await panel.getByTestId("reference-look-up").click();
    await expect(panel.getByTestId("reference-look-up-result")).toHaveText(
      "Crossref 没有可补充的信息",
    );
    await expect(consent).toBeHidden();
  } finally {
    await app.close();
  }
});
