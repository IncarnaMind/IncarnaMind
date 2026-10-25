import { writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  acceptPlainTextKeys,
  addDocuments,
  closeSettings,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  openAdvancedModels,
  openDocumentTags,
  openSettings,
  removeDataFolder,
  useLocalChatModel,
} from "./app";

const JEV_KEY = "jev-smoke-key";

/** How likely each Tag is, by name, for every Document. Others: 0.02. */
const PROBABILITIES: Record<string, number> = { Paper: 0.92, Report: 0.5 };

/**
 * A Jev-compatible server on this computer (so no consent is asked): it
 * answers `POST /v1/systemone` the way TypeSafe documents it.
 */
async function startFakeJev(): Promise<{ server: Server; url: string }> {
  const server = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    const ok =
      request.method === "POST" &&
      request.url === "/v1/systemone" &&
      request.headers.authorization === `Bearer ${JEV_KEY}`;
    if (!ok) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ detail: "Invalid API key." }));
      return;
    }
    const { questions } = JSON.parse(text) as {
      questions: Record<string, { instructions: string }>;
    };
    const answers = Object.fromEntries(
      Object.entries(questions).map(([id, question]) => {
        const name = /“(.+)”/.exec(question.instructions)?.[1] ?? "";
        return [id, { type: "noul", noul: PROBABILITIES[name] ?? 0.02 }];
      }),
    );
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ model: "jev-1.13.0", answers, usage: {} }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

let dataDir: string;
let sources: string;
let jev: { server: Server; url: string };
test.beforeEach(async () => {
  dataDir = await createDataFolder();
  sources = await createDataFolder();
  jev = await startFakeJev();
});
test.afterEach(async () => {
  jev.server.closeAllConnections();
  await new Promise((resolve) => jev.server.close(resolve));
  await removeDataFolder(dataDir);
  await removeDataFolder(sources);
});

test("with a Jev key, Jev tags Documents instead of the chat model, and an unsure Tag can be confirmed", async () => {
  const summary = join(sources, "Attention.txt");
  await writeFile(summary, "A report on attention: the dominant sequence transduction models.\n");
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);

  // Settings → Models → Advanced → Tagging: a key and a Jev-compatible server, tested, then used.
  const tagging = await openAdvancedModels(await openSettings(window, "models"));
  const section = tagging.getByTestId("jev-settings");
  await section.getByTestId("jev-set-up").click();
  const form = section.getByTestId("jev-form");
  await form.getByLabel("Jev API key").fill(JEV_KEY);
  await form.getByText("Server, model and review").click();
  await form.getByLabel("Server URL (optional)").fill(jev.url);
  await expect(form.getByLabel("Needs review from (%)")).toHaveValue("35");
  await expect(form.getByLabel("to (%)")).toHaveValue("65");
  await form.getByRole("button", { name: "Test connection" }).click();
  await expect(form.getByTestId("connection-test")).toHaveText("Connected: the provider answered.");
  await acceptPlainTextKeys(window, form);
  await form.getByRole("button", { name: "Use Jev for tagging" }).click();
  await expect(section).toContainText("Your Jev key is saved.");
  // Automatic tags with Jev now, before the chat model.
  await expect(window.getByTestId("tagging-automatic-line")).toHaveText(
    "Using TypeSafe Jev, with your Jev key",
  );
  await expect(section).toContainText(`Server: ${jev.url}`);
  await closeSettings(window);

  // A saved Jev setup is a choice of the User's under Advanced: it opens by itself.
  const reopened = await openSettings(window, "models");
  await expect(reopened.getByTestId("models-advanced")).toHaveAttribute("open", "");
  await expect(reopened.getByTestId("jev-settings")).toContainText("Your Jev key is saved.");
  await closeSettings(window);

  await addDocuments(window, [summary]);

  // Paper is likely; Report is unsure, so it is applied and marked for review. The
  // Document's Tag picker shows its Tags.
  const item = window.getByTestId("document-list-item");
  await expect(item).toHaveAttribute("data-tagging", "tagged");
  const tags = await openDocumentTags(item);
  await expect(tags).toHaveCount(2);
  const paper = tags.filter({ hasText: "Paper" });
  const report = tags.filter({ hasText: "Report" });
  await expect(paper).toHaveAttribute("title", "Paper: added automatically, 92% likely");
  await expect(paper).not.toHaveAttribute("data-needs-review");
  await expect(report).toHaveAttribute("data-needs-review", "true");
  await expect(report).toHaveAttribute("title", /only 50% likely/);
  await expect(report).toContainText("needs review");
  // Only the unsure one can be confirmed.
  const confirm = item.getByTestId("confirm-document-tag");
  await expect(confirm).toHaveCount(1);

  // Confirming it makes it the User's.
  await item.getByRole("button", { name: "Confirm Report on Attention" }).click();
  await expect(report).toHaveAttribute("data-source", "user");
  await expect(report).not.toHaveAttribute("data-needs-review");
  await expect(item.locator("[data-needs-review]")).toHaveCount(0);
  await expect(confirm).toHaveCount(0);
  await app.close();
});
