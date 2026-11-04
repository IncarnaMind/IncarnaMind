import { readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  createDataFolder,
  dismissChatSetup,
  interceptOpenPath,
  launchApp,
  pathsOpened,
  removeDataFolder,
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

test("Settings opens the logs folder, whose log says what happened without the User's content", async () => {
  await writeFile(join(sources, "Merger plan.md"), "# Northwind\n\nThe codeword is zanzibar.\n");
  await writeFile(join(sources, "Broken.pdf"), "This isn't a PDF.");
  const { app, window } = await launchApp(dataDir);
  await dismissChatSetup(window);
  await window
    .getByTestId("add-documents-input")
    .setInputFiles([join(sources, "Merger plan.md"), join(sources, "Broken.pdf")]);
  const items = window.getByTestId("document-list-item");
  await expect(items.filter({ hasText: "Merger plan" })).toHaveAttribute("data-status", "ready");
  await expect(items.filter({ hasText: "Broken" })).toHaveAttribute("data-status", "failed");
  // An error nothing in the window caught, quoting the User's text.
  await window.evaluate(() => {
    setTimeout(() => {
      throw new Error('The editor failed on "The codeword is zanzibar."');
    });
  });
  await interceptOpenPath(app);

  await window.getByRole("button", { name: "Settings" }).click();
  await window.getByTestId("settings").getByTestId("open-logs-folder").click();

  await expect.poll(() => pathsOpened(app)).toHaveLength(1);
  const [opened] = await pathsOpened(app);
  expect(await realpath(opened ?? "")).toBe(await realpath(join(dataDir, "logs")));
  const log = await readFile(join(dataDir, "logs", "incarnamind.log"), "utf8");
  expect(log).toMatch(
    / INFO {2}app\.start version=\S+ electron=\S+ os=\S+ osVersion=\S+ arch=\S+ packaged=\S+ pid=\d+\n/,
  );
  expect(log).toMatch(/ INFO {2}document\.status documentId=\S+ kind=markdown status=ready/);
  expect(log).toMatch(/ WARN {2}document\.failed documentId=\S+ kind=pdf reason=unreadable/);
  expect(log).toContain(
    'ERROR window.uncaught kind=error error="Error: The editor failed on [redacted]"',
  );
  for (const content of ["Merger", "Northwind", "codeword", "zanzibar", "Broken"]) {
    expect(log).not.toContain(content);
  }
  await app.close();
});
