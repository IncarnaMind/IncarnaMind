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
  openDocumentTags,
  openSettings,
  organizeRow,
  removeDataFolder,
  runCommand,
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

test("with a Jev key, Jev tags Documents instead of the chat model, and its Tag waits in the Review until confirmed", async () => {
  const summary = join(sources, "Attention.txt");
  await writeFile(summary, "A report on attention: the dominant sequence transduction models.\n");
  const { app, window } = await launchApp(dataDir, { fakeChat: true });
  await dismissChatSetup(window);
  await useLocalChatModel(window);

  // Settings › AI › Organize and Tags: Jev set up in place from the picker's foot, with a key
  // and a Jev-compatible server, then chosen with Use this.
  const settings = await openSettings(window, "ai");
  const { picker } = organizeRow(settings);
  await picker.selectOption("set-up:jev");
  const form = settings.getByTestId("jev-sorting-set-up").getByTestId("jev-form");
  await form.getByLabel("Jev API key").fill(JEV_KEY);
  await form.getByText("Server, model and threshold").click();
  await form.getByLabel("Server URL (optional)").fill(jev.url);
  await expect(form.getByLabel("Suggest from (%)")).toHaveValue("35");
  await form.getByRole("button", { name: "Test connection" }).click();
  await expect(form.getByTestId("connection-test")).toHaveText("Connected: the provider answered.");
  await acceptPlainTextKeys(window, form);
  await form.getByTestId("jev-save").click();
  await expect(form).toHaveCount(0);
  await expect(picker.locator("option:checked")).toHaveText(/TypeSafe Jev/);
  await closeSettings(window);

  // Its key is one row of Accounts and keys, used for Organize and Tags.
  const reopened = await openSettings(window, "ai");
  await expect(
    reopened
      .locator('[data-testid="sorting-key-row"][data-host="jev"]')
      .getByTestId("sorting-key-status"),
  ).toContainText("Used for Organize and Tags");
  await closeSettings(window);

  await addDocuments(window, [summary]);

  // Paper is the likelier kind, and one kind a Document is proposed: it waits in the Review,
  // and nothing is on the Document before Confirm (#2339).
  const item = window.getByTestId("document-list-item");
  await expect(item).toHaveAttribute("data-tagging", "tagged");
  await expect(item.getByTestId("tag-chip")).toHaveCount(0);
  await runCommand(window, "library.open", "Open the Library");
  await window.getByTestId("organize-waiting-review").click();
  const review = window.getByTestId("organize-review");
  await expect(review.getByTestId("organize-review-title")).toHaveText("Suggested Tags");
  await expect(review.getByTestId("organize-review-chip")).toHaveText(["Paper"]);

  // Confirming makes it the User's.
  await review.getByTestId("organize-review-confirm").click();
  const tags = await openDocumentTags(item);
  await expect(tags).toHaveCount(1);
  await expect(tags.filter({ hasText: "Paper" })).toHaveAttribute("data-source", "user");
  await app.close();
});
