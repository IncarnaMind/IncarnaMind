import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { buildPdf } from "../tests/helpers/pdf";
import {
  addDocuments,
  askInAssistant,
  createDataFolder,
  dismissChatSetup,
  mindWrittenBefore,
  pointAndClick,
  removeDataFolder,
  setWindowSize,
  showCountWhileWriting,
  startSamples,
  stopSamples,
  useLocalChatModel,
} from "./app";
import { endFeel, startFeel } from "./feel";

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

const editorOf = (window: import("@playwright/test").Page) =>
  window.locator('[data-testid="mind-editor"]:visible');

test("first open, a Question, its Citation, and the Mind checked", async () => {
  test.setTimeout(150_000);
  await writeFile(
    join(sources, "Tides.pdf"),
    buildPdf([
      {
        lines: [
          "Harbour times",
          "Harbours publish the times of high water every 12 months.",
          "Spring tides come at new moon and at full moon.",
        ],
      },
    ]),
  );
  const run = await startFeel(dataDir, "first-open", { fakeChat: true });
  const { app, window, feel } = run;
  await setWindowSize(app, window, 1440, 900);

  await feel.step("choose a model", async () => {
    await dismissChatSetup(window);
    await useLocalChatModel(window);
  });
  await feel.step("add a Document", async () => {
    await addDocuments(window, [join(sources, "Tides.pdf")]);
  });
  await feel.step("new Mind", async () => {
    await pointAndClick(window, window.getByTestId("plus-menu"));
    await pointAndClick(window, window.getByTestId("plus-new-mind"));
    await expect(editorOf(window)).toBeFocused();
  });
  await feel.expectFocus("new Mind", editorOf(window));
  await feel.step("write a line", async () => {
    await window.keyboard.type("Harbour notes");
    await window.keyboard.press("Enter");
    await window.keyboard.type("Harbours publish the times of high water every 6 months.");
    await expect(editorOf(window)).toContainText("every 6 months");
  });

  let answer = window.getByTestId("assistant-answer");
  await feel.step("ask a Question", async () => {
    answer = await askInAssistant(window, "When do harbours publish the times of high water?");
    await expect(answer.getByTestId("citation-chip").first()).toBeVisible();
  });
  const chip = answer.getByTestId("citation-chip").first();
  await feel.step("open a Citation", async () => {
    await pointAndClick(window, chip);
    await expect(window.getByTestId("citation-card")).toBeVisible();
  });
  await feel.step("close the Citation", async () => {
    await window.keyboard.press("Escape");
    await expect(window.getByTestId("citation-card")).toBeHidden();
  });
  // A clicked chip leaves focus where it was (CitationView), so closing finds it there still.
  await feel.expectFocus("close the Citation", window.getByTestId("composer-input"));

  await feel.step("check the Mind", async () => {
    await pointAndClick(window, editorOf(window));
    await window.keyboard.press("ControlOrMeta+k");
    await expect(window.getByTestId("palette-search")).toBeFocused();
    await window.keyboard.type("check this mind");
    await pointAndClick(
      window,
      window.getByTestId("palette-item").filter({ hasText: "Checks this Note" }).first(),
    );
    const card = window.getByTestId("check-card");
    const ask = card.getByTestId("mind-check-ask").getByTestId("mind-check-check");
    const done = card.getByTestId("health-checked-all");
    // A model on this computer may ask first, with the claims it named.
    await expect(ask.or(done)).toBeVisible({ timeout: 30_000 });
    if (await ask.isVisible()) await pointAndClick(window, ask);
    await expect(done).toBeVisible({ timeout: 30_000 });
  });

  await endFeel(run);
});

test("typing in a long Mind, its count shown", async () => {
  test.setTimeout(150_000);
  const run = await startFeel(dataDir, "typing-long-mind", { fakeChat: true });
  const { app, window, feel } = run;
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  const paragraph = (index: number) =>
    `Paragraph ${index}: ${Array.from({ length: 48 }, (_, word) => ["harbour", "tide", "cargo", "pier", "weather", "arrival"][word % 6]).join(" ")}.`;
  await mindWrittenBefore(
    window,
    "Harbour log",
    Array.from({ length: 100 }, (_, index) => ({ note: paragraph(index + 1) })),
  );

  await feel.step("open the long Mind", async () => {
    await pointAndClick(
      window,
      window.getByTestId("mind-list-item").filter({ hasText: "Harbour log" }),
    );
    await expect(editorOf(window)).toContainText("Paragraph 1:");
  });
  await showCountWhileWriting(window);

  await feel.step("type at the start", async () => {
    await pointAndClick(window, editorOf(window).getByText("Paragraph 1:"));
    await window.keyboard.press("End");
    await window.keyboard.type(" The pilot boarded at dawn and the tug came alongside at seven.");
    await expect(editorOf(window)).toContainText("came alongside at seven.");
  });
  await feel.step("scroll down", async () => {
    const box = await editorOf(window).boundingBox();
    if (!box) throw new Error("The Mind isn't showing.");
    await window.mouse.move(box.x + box.width / 2, box.y + 300);
    for (let turn = 0; turn < 8; turn++) await window.mouse.wheel(0, 900);
    await expect(editorOf(window).getByText("Paragraph 1:")).not.toBeInViewport();
  });
  const shown = await editorOf(window).evaluate(
    (editor) =>
      [...editor.querySelectorAll("p")]
        .find((paragraph) => paragraph.getBoundingClientRect().top > 300)
        ?.textContent?.split(":")[0] ?? "",
  );
  await feel.step("type further down", async () => {
    await pointAndClick(window, editorOf(window).getByText(`${shown}:`));
    await window.keyboard.press("End");
    await window.keyboard.type(" Rain at noon; the crane stopped for an hour.");
    await expect(editorOf(window)).toContainText("stopped for an hour.");
  });
  await feel.step("delete a word", async () => {
    for (let key = 0; key < 6; key++) await window.keyboard.press("Backspace");
    await expect(editorOf(window)).toContainText("stopped for an ");
  });

  await endFeel(run);
});

test("the assistant writes into the Mind, then Undo", async () => {
  test.setTimeout(150_000);
  const run = await startFeel(dataDir, "assistant-writes", { fakeChat: true });
  const { app, window, feel } = run;
  await setWindowSize(app, window, 1440, 900);
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await mindWrittenBefore(window, "Q3 review", [
    { heading: "Summary" },
    { note: "The quarter was good. Sales rose and the margin held." },
  ]);
  await pointAndClick(
    window,
    window.getByTestId("mind-list-item").filter({ hasText: "Q3 review" }),
  );
  await expect(editorOf(window)).toContainText("The quarter was good.");

  await feel.step("ask for a section", async () => {
    await askInAssistant(window, "Add a section on the risks");
    await expect(editorOf(window)).toContainText("The supplier is late.");
  });
  await feel.step("Undo in the Mind", async () => {
    await pointAndClick(window, editorOf(window).getByText("The quarter was good."));
    await window.keyboard.press("ControlOrMeta+z");
    await expect(editorOf(window)).not.toContainText("The supplier is late.");
  });

  await endFeel(run);
});

test("an Answer with a table wider than the panel, written to the end", async () => {
  test.setTimeout(150_000);
  await writeFile(
    join(sources, "Tides.pdf"),
    buildPdf([{ lines: ["Harbour times", "Spring tides come at new moon and at full moon."] }]),
  );
  const run = await startFeel(dataDir, "assistant-table", { fakeChat: true });
  const { app, window, feel } = run;
  await setWindowSize(app, window, 1440, 760);
  await feel.step("set up", async () => {
    await dismissChatSetup(window);
    await useLocalChatModel(window);
    await addDocuments(window, [join(sources, "Tides.pdf")]);
    await pointAndClick(window, window.getByTestId("plus-menu"));
    await pointAndClick(window, window.getByTestId("plus-new-mind"));
    await expect(editorOf(window)).toBeFocused();
  });
  // The thread has to be full first: in a short one the Question rises as each Answer grows (#1330).
  await feel.step("fill the thread", async () => {
    for (const day of ["Monday", "Tuesday", "Wednesday", "Thursday"]) {
      await askInAssistant(window, `What do tides do on ${day}`);
    }
  });

  await feel.step("ask for a table", async () => {
    const answer = await askInAssistant(window, "What do tides do in nine rows");
    await expect(answer.locator("table tr")).toHaveCount(10);
    const expand = answer.getByTestId("answer-open-table");
    await expect(expand).toBeVisible();
    await expect(expand).not.toHaveAttribute("aria-disabled", "true");
  });

  await feel.step("ask for a table that widens as it is written", async () => {
    await startSamples(window);
    const answer = await askInAssistant(window, "What do tides do, narrow then wide");
    await expect(answer.locator("table tr")).toHaveCount(8);
    await expect(answer.getByTestId("answer-open-table")).toBeVisible();
    // The check's sum also holds the columns re-fitting sideways as the table widens: the table
    // itself, frame by frame, must stay where it is.
    const samples = await stopSamples(window);
    expect(samples.some((sample) => sample.button === null)).toBe(true);
    expect(new Set(samples.map((sample) => Math.round(sample.top))).size).toBe(1);
  });

  await endFeel(run);
});
