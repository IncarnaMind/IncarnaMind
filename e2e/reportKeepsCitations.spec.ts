import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { buildPdf } from "../tests/helpers/pdf";
import {
  addDocuments,
  askInAssistant,
  createDataFolder,
  dismissChatSetup,
  exportFromMenu,
  launchApp,
  newMind,
  pointAndClick,
  removeDataFolder,
  useOutputLocation as setOutputLocation,
  setWindowSize,
  useLocalChatModel,
} from "./app";

/*
 * A cited Mind turned into a report keeps its Citations (#1800): the scripted model reads the
 * Mind, keeps each of its Citations by the id it reads it with, and the report's Answer shows
 * them checked; New note under it carries them, and its Markdown export has their footnotes,
 * with no id or bracketed source anywhere.
 */

const TIDES = buildPdf([
  { lines: ["Tides and the Moon", "The Moon raises two bulges of water on the Earth."] },
  { lines: ["Spring and neap tides", "Spring tides happen at new moon and at full moon."] },
]);

let dataDir: string;
let sources: string;
let output: string;
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  sources = await createDataFolder();
  output = await createDataFolder();
});
test.afterEach(async () => {
  await removeDataFolder(dataDir);
  await removeDataFolder(sources);
  await removeDataFolder(output);
});

test("a cited Mind made a report in the Answer keeps its Citations, in a new Mind and its Markdown export", async () => {
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setWindowSize(app, window, 1440, 900);
  await writeFile(join(sources, "Tides.pdf"), TIDES);
  await addDocuments(window, [join(sources, "Tides.pdf")]);
  await newMind(window);
  const editor = window.getByTestId("mind-editor");

  const cited = await askInAssistant(window, "When do spring tides happen?");
  await pointAndClick(window, cited.getByTestId("answer-add"));
  await expect(editor.getByTestId("citation").first()).toHaveAttribute("data-check", "found");

  const report = await askInAssistant(window, "Turn this Mind into a report");
  const text = report.getByTestId("assistant-answer-text");
  await expect(text.getByTestId("citation").first()).toHaveAttribute("data-check", "found");
  await expect(text).not.toContainText(/C\d|\[Tides/);

  await pointAndClick(window, report.getByTestId("answer-write-note"));
  await expect(window.getByTestId("mind-tab")).toHaveCount(2);
  await expect(editor.getByTestId("citation").first()).toHaveAttribute("data-check", "found");
  await expect(editor).not.toContainText(/C\d|\[Tides/);

  await setOutputLocation(window, output);
  await exportFromMenu(window, "markdown");
  await expect(window.getByTestId("export-done")).toBeVisible();
  const [file] = (await readdir(output)).filter((name) => name.endsWith(".md"));
  const markdown = await readFile(join(output, file ?? ""), "utf8");
  expect(markdown).toMatch(/\[\^1\]/);
  expect(markdown).toMatch(/^\[\^1\]: .*Tides/m);
  expect(markdown).not.toMatch(/C\d|\[Tides/);
});
