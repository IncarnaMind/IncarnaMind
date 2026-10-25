import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { corePropertiesXml, xlsxOf } from "../tests/helpers/office";
import { buildPdf } from "../tests/helpers/pdf";
import {
  addDocuments,
  createDataFolder,
  dismissChatSetup,
  frontMindName,
  launchApp,
  newMind,
  openFolderInLibrary,
  placeAssistant,
  removeDataFolder,
  setWindowSize,
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

const UUID_NAME = "49ed72de-a284-4da6-b515-1ddbb7c0a8f1";

/** One Document of each kind, one of them named by a UUID with a title of its own. */
async function writeSources(): Promise<string[]> {
  const paths = {
    text: join(sources, "Quarterly report.txt"),
    markdown: join(sources, "Reading notes.md"),
    csv: join(sources, "Figures.csv"),
    xlsx: join(sources, `${UUID_NAME}.xlsx`),
    pdf: join(sources, "Field guide.pdf"),
  };
  await writeFile(paths.text, "Quarterly financial report. Revenue increased this year.");
  await writeFile(paths.markdown, "# Reading notes\n\nNotes on the tides.");
  await writeFile(paths.csv, "Unit,Beds\n1,3\n2,2\n");
  await writeFile(
    paths.xlsx,
    xlsxOf(
      [
        {
          name: "Sheet1",
          rows: [
            ["Unit", "Beds"],
            [1, 3],
          ],
        },
      ],
      {
        coreXml: corePropertiesXml({ title: "Rent roll for Upper Grosvenor Street" }),
      },
    ),
  );
  await writeFile(paths.pdf, buildPdf([{ lines: ["The field guide describes the tides."] }]));
  return Object.values(paths);
}

async function addFolder(window: Page, name: string): Promise<void> {
  await window.evaluate(async (folderName) => {
    const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
    await bridge.createLibraryGroup({ name: folderName, description: "" });
  }, name);
}

test("the Library is a tab beside the Mind, which stays in its own tab, and it comes back after a restart", async () => {
  let session = await launchApp(dataDir);
  try {
    let { window } = session;
    await dismissChatSetup(window);
    await newMind(window);
    await window.keyboard.type("Tide notes");
    await expect(window.getByTestId("mind-tab")).toHaveCount(1);

    await window.getByTestId("open-library").click();
    const library = window.getByTestId("library");
    await expect(library).toBeVisible();
    // A tab beside the Mind's, which is still there, and not shown.
    await expect(window.getByTestId("library-tab")).toHaveAttribute("aria-selected", "true");
    await expect(window.getByTestId("mind-tab")).toHaveCount(1);
    await expect(window.getByTestId("mind-tab")).toHaveAttribute("aria-selected", "false");
    await expect(window.getByRole("button", { name: "Back to Mind" })).toHaveCount(0);
    // It starts with its title, then the search.
    await expect(library.locator("input, h1").first()).toContainText("Library");
    await expect(library.locator("input").first()).toHaveAttribute("type", "search");

    // Back to the Mind by its tab: the Library's tab stays open.
    await window.getByTestId("mind-tab").click();
    await expect(frontMindName(window)).toHaveText("Tide notes");
    await expect(library).toHaveCount(0);
    await expect(window.getByTestId("library-tab")).toHaveCount(1);
    await window.getByTestId("library-tab").click();
    await expect(library).toBeVisible();

    await session.app.close();
    session = await launchApp(dataDir);
    window = session.window;
    await expect(window.getByTestId("home-tab")).toHaveAttribute("aria-selected", "true");
    await window.keyboard.press("ControlOrMeta+w");
    await expect(window.getByTestId("home-tab")).toHaveCount(0);
    await expect(window.getByTestId("library")).toBeVisible();

    // It closes like a Mind's tab; the Mind is shown again.
    await window.getByTestId("library-tab").getByTestId("tab-close").click();
    await expect(window.getByTestId("library-tab")).toHaveCount(0);
    await expect(frontMindName(window)).toHaveText("Tide notes");
    await session.app.close();
    session = await launchApp(dataDir);
    await expect(session.window.getByTestId("library-tab")).toHaveCount(0);
  } finally {
    await session.app.close();
  }
});

test("each kind of Document has its own icon, names show no extension, and a machine-made name shows the title", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await dismissChatSetup(window);
    await addDocuments(window, await writeSources());
    await window.getByTestId("open-library").click();
    const library = window.getByTestId("library");
    const rows = library.getByTestId("library-document");
    await expect(rows).toHaveCount(5);

    // A mark of its own for each kind; Excel and CSV share one.
    const marks = await rows
      .locator("svg[data-kind]")
      .evaluateAll((icons) =>
        icons.map((icon) => [
          icon.getAttribute("data-kind"),
          icon.querySelector("path:last-child")?.getAttribute("d"),
        ]),
      );
    const byKind = new Map(marks as [string, string][]);
    expect([...byKind.keys()].sort()).toEqual(["csv", "markdown", "pdf", "text", "xlsx"]);
    expect(byKind.get("csv")).toBe(byKind.get("xlsx"));
    const distinct = new Set([...byKind.values()]);
    expect(distinct.size).toBe(4);

    // No extension in names; the tooltip carries the file's name.
    const names = await library.getByTestId("library-document-name").allTextContents();
    for (const name of names) expect(name).not.toMatch(/\.(txt|md|csv|xlsx|pdf)$/i);
    const quarterly = rows.filter({ hasText: "Quarterly report" });
    await expect(quarterly.getByRole("button").first()).toHaveAttribute(
      "title",
      /Quarterly report\.txt/,
    );

    // The UUID-named workbook shows its own title; the file name stays in the tooltip and Get info.
    const sheet = rows.filter({ hasText: "Rent roll for Upper Grosvenor Street" });
    await expect(sheet).toHaveCount(1, { timeout: 15_000 });
    await expect(sheet.getByTestId("library-document-name")).toHaveText(
      "Rent roll for Upper Grosvenor Street",
    );
    await expect(sheet.getByRole("button").first()).toHaveAttribute("title", new RegExp(UUID_NAME));
    await sheet.locator("[data-row-main]").focus();
    await window.keyboard.press("ControlOrMeta+i");
    await expect(window.getByTestId("info-panel").getByTestId("info-path")).toContainText(
      `${UUID_NAME}.xlsx`,
    );
    await window.keyboard.press("Escape");
    // The sidebar shows the title too.
    await expect(
      window
        .getByTestId("document-list-item")
        .filter({ hasText: "Rent roll for Upper Grosvenor Street" }),
    ).toHaveCount(1);
  } finally {
    await app.close();
  }
});

test("a Folder's section holds in the narrowest window that keeps groups side by side, with a Document open beside it: its name on one line, Document actions only in Document menus", async () => {
  const { app, window } = await launchApp(dataDir);
  try {
    await dismissChatSetup(window);
    await addDocuments(window, await writeSources());
    await addFolder(window, "Reports & presentations");
    await setWindowSize(app, window, 1000, 700);
    // At 1,000px the groups keep side by side only with the assistant at the bottom (#253).
    await placeAssistant(window, { dock: "bottom" });
    await window.getByTestId("open-library").click();
    const library = window.getByTestId("library");
    // Put a Document in the Folder, and open it in a group beside the Library.
    await window.evaluate(async () => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      const snapshot = await bridge.getLibrary();
      const documents = await bridge.listDocuments();
      const group = snapshot.groups.find((each) => each.name === "Reports & presentations");
      if (group && documents[0]) await bridge.assignDocumentGroup(documents[0].id, group.id);
    });
    await openFolderInLibrary(window, "Reports & presentations");
    const folder = library
      .getByTestId("library-section")
      .filter({ hasText: "Reports & presentations" });
    const row = folder.getByTestId("library-document").first();
    await expect(row).toBeVisible();
    await row.getByRole("button").first().click();
    await expect(window.getByTestId("viewer")).toBeVisible();

    const name = folder.getByTestId("library-section-name");
    await expect(name).toHaveText("Reports & presentations");
    const box = await name.evaluate((element) => {
      const style = getComputedStyle(element);
      const lineHeight =
        Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.3;
      const rect = element.getBoundingClientRect();
      return { width: rect.width, lines: Math.round(rect.height / lineHeight) };
    });
    // Never a few letters wide, and never broken by letter: one line, cut with "…" if it must.
    expect(box.width).toBeGreaterThan(100);
    expect(box.lines).toBe(1);
    expect(await library.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );

    // The Folder's menu asks about the Folder; "this Document" is for a Document.
    const head = folder.getByTestId("library-section-head");
    await head.hover();
    await head.getByTestId("folder-menu").click();
    await expect(
      window.getByTestId("folder-actions").filter({ visible: true }).getByTestId("folder.ask"),
    ).toHaveText("Ask about this Folder");
    await expect(library.getByText("this Document")).toHaveCount(0);
    await window.keyboard.press("Escape");
  } finally {
    await app.close();
  }
});
