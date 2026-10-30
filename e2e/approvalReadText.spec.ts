import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import {
  acceptPlainTextKeys,
  addDocuments,
  addTideConnector,
  assistantAnswers,
  createDataFolder,
  dismissChatSetup,
  launchApp,
  motionSettled,
  newMind,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "./app";

/*
 * The approval card's line naming what the Answer read (#2240): a Document by name, a web page by
 * host (never the title it wrote itself) and a Connector by its name, in English and Chinese. A
 * local OpenAI-compatible chat model, test-only, does what the smoke fake can't: it searches the
 * Documents, reads the Tides Connector, then asks to record a meeting, so one card shows all three.
 */

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
const MODEL = "smoke-model";
const SEARCH = "Q3 board pack";
const TIDE = "tides__lookup_tide";
const ADDRESS = "http://files.example/report";
/** The page writes its own title, to look like one of the User's files on the card. */
const TITLE = "Q3 board pack.pdf";

interface Turn {
  tools: string[];
  results: { tool: string; text: string }[];
}

type Reply = { text: string } | { call: { name: string; input: unknown } };

/** What the model has been told so far, as Chat Completions sends it. */
function turnOf(body: Record<string, unknown>): Turn {
  const messages = (body.messages ?? []) as Record<string, unknown>[];
  const names = new Map<string, string>();
  for (const message of messages) {
    for (const call of (message.tool_calls ?? []) as { id: string; function?: { name?: string } }[])
      names.set(call.id, call.function?.name ?? "");
  }
  return {
    tools: ((body.tools ?? []) as { function?: { name?: string } }[]).map(
      (tool) => tool.function?.name ?? "",
    ),
    results: messages
      .filter((message) => message.role === "tool")
      .map((message) => ({
        tool: names.get(String(message.tool_call_id)) ?? "",
        text: String(message.content ?? ""),
      })),
  };
}

function replyFor(turn: Turn): Reply {
  if (!turn.results.some((each) => each.tool === "search_documents"))
    return { call: { name: "search_documents", input: { query: SEARCH } } };
  if (!turn.results.some((each) => each.tool === TIDE))
    return { call: { name: TIDE, input: { place: "Dover" } } };
  if (!turn.results.some((each) => each.tool === "run_command"))
    return { call: { name: "run_command", input: { command: "meeting.record" } } };
  return { text: "Done." };
}

const sse = (events: object[]) =>
  `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;

/** The reply as Chat Completions streams it: one tool call, or the text, then its usage. */
function chunks(reply: Reply, model: string): object[] {
  const chunk = (delta: object, finish: string | null) => ({
    id: "chatcmpl-smoke",
    object: "chat.completion.chunk",
    created: 1_790_000_000,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
  const events: object[] = [chunk({ role: "assistant", content: "" }, null)];
  if ("text" in reply) events.push(chunk({ content: reply.text }, null));
  else {
    events.push(
      chunk(
        {
          tool_calls: [
            {
              index: 0,
              id: `call_${reply.call.name}`,
              type: "function",
              function: { name: reply.call.name, arguments: JSON.stringify(reply.call.input) },
            },
          ],
        },
        null,
      ),
    );
  }
  events.push(chunk({}, "text" in reply ? "stop" : "tool_calls"));
  events.push({
    ...chunk({}, null),
    choices: [],
    usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
  });
  return events;
}

/** A local OpenAI-compatible model: no network, no key, test-only. */
async function startCompletions(): Promise<{ baseUrl: string; close(): Promise<void> }> {
  const server = createServer((request, response) => {
    const url = request.url ?? "";
    if (request.method === "GET" && url.endsWith("/models")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          object: "list",
          data: [{ id: MODEL, object: "model", created: 1, owned_by: "smoke" }],
        }),
      );
      return;
    }
    let body = "";
    request.on("data", (piece) => (body += piece));
    request.on("end", () => {
      const parsed = JSON.parse(body || "{}") as Record<string, unknown>;
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      response.end(sse(chunks(replyFor(turnOf(parsed)), String(parsed.model))));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** A page whose text a search for `SEARCH` finds, long enough to be kept. */
const REPORT_PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${TITLE}</title></head>
<body><article><h1>Q3 board pack</h1>
<p>Q3 board pack: revenue grew 4% in the third quarter, the finance team told the board.</p>
<p>Operating costs were held flat while the company opened two new offices and hired in the sales team.</p>
<p>The board noted that the fourth quarter would carry the cost of the new pricing work and the annual audit.</p>
<p>Management expects the full year to track the plan, with a modest improvement in the margin.</p>
</article></body></html>`;

async function saveReportPage(window: Page): Promise<void> {
  const documentId = await window.evaluate(
    async ({ address, html }) => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      const saved = await bridge.saveWebPage({ address, html });
      if (saved.outcome !== "saved") throw new Error(`The page wasn't saved: ${saved.outcome}.`);
      return saved.document.id;
    },
    { address: ADDRESS, html: REPORT_PAGE },
  );
  await expect
    .poll(
      async () =>
        window.evaluate(async (id) => {
          const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
          return (await bridge.listDocuments()).find((each) => each.id === id)?.status ?? "gone";
        }, documentId),
      { timeout: 30_000 },
    )
    .toBe("ready");
}

/** Asks in the assistant and hands back its Answer, which waits for the card. */
async function askAndWait(window: Page, question: string): Promise<Locator> {
  await window.keyboard.press("ControlOrMeta+j");
  await expect(window.getByTestId("composer-input")).toBeFocused();
  await window.keyboard.type(question);
  await window.keyboard.press("Enter");
  const answers = assistantAnswers(window);
  await expect(answers).toHaveCount(1);
  return answers.last();
}

async function shot(window: Page, card: Locator, name: string): Promise<void> {
  if (!SCREENSHOTS) return;
  await motionSettled(window);
  // In CSS pixels, as the 900px window is sized, not at the screen's scale factor.
  await card.screenshot({ path: join(SCREENSHOTS, `${name}.png`), scale: "css" });
  await window.screenshot({ path: join(SCREENSHOTS, `${name}-window.png`), scale: "css" });
}

/**
 * Launches the app on one of the two scenarios and shows the card at 900px: the Answer searches a
 * Document and the page, reads the Connector, then asks to record a meeting.
 */
async function cardFor(
  dataDir: string,
  sources: string,
  { pageOnly }: { pageOnly: boolean },
): Promise<{ app: ElectronApplication; window: Page; card: Locator; title: string }> {
  const { baseUrl, close } = await startCompletions();
  const { app, window } = await launchApp(dataDir, {});
  try {
    await acceptPlainTextKeys(window);
    await window.evaluate(
      async ({ baseUrl: url, model }) => {
        const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
        await bridge.saveChatProvider({
          kind: "openai-compatible",
          baseUrl: url,
          apiKey: "sk-smoke-completions",
          modelId: model,
        });
      },
      { baseUrl, model: MODEL },
    );
    await dismissChatSetup(window);
    await addTideConnector(window);
    // This model makes the Answer's calls only: automatic tagging, which asks for JSON, stays off.
    await window.evaluate(async () => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      await bridge.setTaggingWithAi(null, false);
      await bridge.dismissAutomaticOffNotice();
    });
    if (!pageOnly) {
      const path = join(sources, "Q3 board pack notes.md");
      await writeFile(
        path,
        "# Q3 board pack notes\n\nQ3 board pack: revenue grew 4% in the third quarter.\n",
      );
      await addDocuments(window, [path]);
    }
    await saveReportPage(window);
    await setWindowSize(app, window, 900, 900);
    await newMind(window);
    const answer = await askAndWait(
      window,
      "What does the Q3 board pack say? Look the tide up, then start recording a meeting.",
    );
    const card = answer.getByTestId("approval-card");
    await expect(card).toBeVisible({ timeout: 45_000 });
    await expect(card).toHaveAttribute("data-ask", "listen");
    const title = await window.evaluate(async () => {
      const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
      return (await bridge.listDocuments()).find((each) => each.kind === "web")?.name ?? "";
    });
    return { app, window, card, title };
  } catch (error) {
    await app.close();
    throw error;
  } finally {
    await close();
  }
}

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

test("the card names a Document, a web page by host and a Connector, in English and Chinese (#2240)", async () => {
  const { app, window, card } = await cardFor(dataDir, sources, { pageOnly: false });
  try {
    const line = card.getByTestId("approval-read-text");
    await expect(line).toContainText("This Answer read text you didn’t write:");
    await expect(line).toContainText("“Q3 board pack notes”");
    await expect(line).toContainText("a web page on files.example");
    await expect(line).toContainText("results from Tides");
    await expect(line).not.toContainText("other text");
    await shot(window, card, "approval-read-text-kinds-en");

    await setLanguage(window, "zh-CN");
    await expect(line).toContainText("这次回答读过不是你写的内容：");
    await expect(line).toContainText("“Q3 board pack notes”");
    await expect(line).toContainText("files.example 上的一个网页");
    await expect(line).toContainText("Tides 返回的内容");
    await expect(line).not.toContainText("其他内容");
    await shot(window, card, "approval-read-text-kinds-zh");
  } finally {
    await app.close();
  }
});

test("a page whose title imitates a Document is named by its host, in English and Chinese (#2240)", async () => {
  const { app, window, card, title } = await cardFor(dataDir, sources, { pageOnly: true });
  try {
    expect(title).toBe(TITLE);

    const line = card.getByTestId("approval-read-text");
    await expect(line).toContainText("a web page on files.example");
    // The page's own title never stands in for a Document the User wrote.
    await expect(line).not.toContainText(TITLE);
    await expect(line).not.toContainText("other text");
    await shot(window, card, "approval-read-text-impersonation-en");

    await setLanguage(window, "zh-CN");
    await expect(line).toContainText("files.example 上的一个网页");
    await expect(line).not.toContainText(TITLE);
    await expect(line).not.toContainText("其他内容");
    await shot(window, card, "approval-read-text-impersonation-zh");
  } finally {
    await app.close();
  }
});
