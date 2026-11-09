import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { buildPdf } from "../tests/helpers/pdf";
import {
  addDocuments,
  askInAssistant,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  newMind,
  pointAt,
  removeDataFolder,
  setWindowSize,
  useLocalChatModel,
} from "./app";

/*
 * A quote shows as words (#905): the scripted model quotes the line of a PDF that is cut at a
 * hyphen where its line breaks, and the Citation's card shows the whole sentence that holds it
 * (#2739), the split word whole. The check still finds the quote as it was given.
 */

const HARBOUR = buildPdf([
  {
    lines: [
      "Harbour committee",
      "The harbour committee will review the case for the exist-",
      "ence of tides near the pier. The long-",
      "term plan is to be settled.",
    ],
  },
]);

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

test("a Citation's card shows a quote cut at a line-end hyphen in its whole sentence, the word whole, and the quote is still found", async () => {
  await writeFile(join(sources, "Harbour.pdf"), HARBOUR);
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);
  await setWindowSize(app, window, 1440, 900);
  await addDocuments(window, [join(sources, "Harbour.pdf")]);
  await newMind(window);
  await window.getByTestId("mind-editor").click();

  const answer = await askInAssistant(window, "Does the committee review the existence of tides?");

  const citation = answer.getByTestId("citation");
  await expect(citation).toHaveAttribute("data-check", "found");
  await pointAt(window, citation.getByTestId("citation-chip"));
  const quote = window.getByTestId("citation-card").locator("blockquote");
  await expect(quote).toHaveText(
    "The harbour committee will review the case for the existence of tides near the pier.",
  );
  await app.close();
});
