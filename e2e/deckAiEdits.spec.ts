/**
 * AI-proposed targeted edits on an open PowerPoint deck (#149 part 2), EN & ZH:
 * - Selecting a shape and asking your AI from the deck ask bar sends the deck, slide, shapeId,
 *   shapeName, and current text through `read_request`.
 * - An agent's `propose_deck_changes` waits in the deck viewer with before/after preview,
 *   confirms in one press with unchanged-slides receipt and Undo, and never overwrites the User's
 *   original `.pptx` file on disk.
 * - Text too long for its box shows the overflow warning with Shrink to fit / Ask AI to shorten.
 * Set INCARNAMIND_SCREENSHOTS to a folder to capture full-window EN & ZH stills at 1440 and 900.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, type Page, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { SHOW_AGENT_CONNECTION } from "../src/shared/agentConnection";
import { para, pptxOf, sp, txBody, xfrm } from "../tests/helpers/pptx";
import {
  acceptPlainTextKeys,
  agentsToConnect,
  catchCopies,
  closeSettings,
  copied,
  createDataFolder,
  dismissChatSetup,
  expectReadyDocuments,
  launchApp,
  openDocumentAt,
  openSettings,
  removeDataFolder,
  runFromPalette,
  setLanguage,
  setWindowSize,
} from "./app";

test.skip(!SHOW_AGENT_CONNECTION, "Your AI is hidden while SHOW_AGENT_CONNECTION is false.");

const SCREENSHOTS = process.env.INCARNAMIND_SCREENSHOTS;
const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>`;
const run = (text: string) => `<a:r><a:rPr lang="en-GB" sz="2000"/><a:t>${text}</a:t></a:r>`;
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const DECK = pptxOf({
  slides: [
    {
      shapes:
        sp({
          id: 2,
          name: "Title",
          spPr: xfrm(457200, 300000, 8000000, 700000),
          body: txBody(para([run("Harbour plan 2027")])),
        }) +
        sp({
          id: 3,
          name: "Summary Box",
          txBox: true,
          spPr: xfrm(457200, 1200000, 4800000, 900000),
          body: txBody(
            para([run("South quay holds 17 boats.")]),
            `<a:bodyPr wrap="square"><a:noAutofit/></a:bodyPr>`,
          ),
        }) +
        sp({
          id: 4,
          name: "Tight Note",
          txBox: true,
          spPr: xfrm(457200, 2400000, 2400000, 260000),
          body: txBody(
            para([run("Short note.")]),
            `<a:bodyPr wrap="square"><a:noAutofit/></a:bodyPr>`,
          ),
        }),
    },
    {
      shapes: sp({
        id: 2,
        name: "Slide Two",
        spPr: xfrm(457200, 500000, 7000000, 700000),
        body: txBody(para([run("Second slide stays untouched.")])),
      }),
    },
    {
      shapes: sp({
        id: 2,
        name: "Slide Three",
        spPr: xfrm(457200, 500000, 7000000, 700000),
        body: txBody(para([run("Third slide stays untouched.")])),
      }),
    },
  ],
  parts: [{ name: "_rels/.rels", data: ROOT_RELS }],
});

async function shot(window: Page, name: string) {
  if (!SCREENSHOTS) return;
  await mkdir(SCREENSHOTS, { recursive: true });
  await window.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
}

let dataDir: string;
let sources: string;
let home: string;

test.beforeEach(async () => {
  dataDir = await createDataFolder();
  sources = await realpath(await createDataFolder());
  home = await realpath(await createDataFolder());
});

test.afterEach(async () => {
  await removeDataFolder(dataDir);
  await removeDataFolder(sources);
  await removeDataFolder(home);
});

for (const lang of ["en", "zh-CN"] as const) {
  test(`targeted AI deck proposal, overflow choice, receipt, Undo, and ask box (${lang})`, async () => {
    const { app, window } = await launchApp(dataDir, { home });
    try {
      await dismissChatSetup(window);
      await setWindowSize(app, window, 1440, 900);
      await catchCopies(window);
      await acceptPlainTextKeys(window);

      const deckPath = join(sources, "Harbour plan.pptx");
      await writeFile(deckPath, DECK);
      const originalHash = sha256(new Uint8Array(DECK));

      const { documentId } = await window.evaluate(async (path) => {
        const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
        const folder = await bridge.createLibraryGroup({ name: "Coast", description: "" });
        const added = await bridge.addDocuments([path], { groupId: folder.id });
        return { folderId: folder.id, documentId: added.documents[0]?.id ?? "" };
      }, deckPath);
      await expectReadyDocuments(window, 1);

      // Connect an outside agent with write access to Coast.
      const page = await openSettings(window, "ai");
      await (await agentsToConnect(page))
        .locator('[data-client="other"]')
        .getByTestId("agent-connect")
        .click();
      const dialog = window.getByTestId("connect-agent-dialog");
      await dialog.getByTestId("connect-agent-name").fill("Deck AI");
      await dialog.getByTestId("agent-share-folders").check();
      await dialog.getByTestId("agent-folder").check();
      await dialog.getByTestId("agent-propose").check();
      await dialog.getByTestId("connect-agent-allow").click();
      const row = page.locator('[data-testid="agent-pairing"][data-name="Deck AI"]');
      await expect(row).toBeVisible();
      const settings = JSON.parse(await copied(window)) as {
        mcpServers: {
          incarnamind: { command: string; args: string[]; env: Record<string, string> };
        };
      };
      const server = settings.mcpServers.incarnamind;
      await closeSettings(window);

      if (lang === "zh-CN") await setLanguage(window, "zh-CN");

      // Open the deck in the viewer.
      await openDocumentAt(window, { documentId });
      await expect(window.getByTestId("viewer-deck-ask")).toBeVisible();

      // Test ⌘K command focuses the deck ask input.
      await runFromPalette(
        window,
        lang === "zh-CN" ? "让 AI 修改这页幻灯片" : "Ask your AI to change this slide",
      );
      await expect(window.getByTestId("viewer-deck-ask-input")).toBeFocused();

      // Send a deck edit request from the ask bar.
      await window.getByTestId("viewer-deck-ask-input").fill("Change 17 to 19 boats");
      await window.getByTestId("viewer-deck-ask-send").click();
      await expect(window.getByTestId("viewer-deck-ask-status")).toBeVisible();

      const agent = new Client({ name: "test-deck-agent", version: "1.0.0" });
      await agent.connect(
        new StdioClientTransport({
          command: server.command,
          args: server.args,
          env: server.env,
          stderr: "pipe",
        }),
      );
      try {
        // Verify read_request received the deck edit request.
        const reqRes = await agent.callTool({ name: "read_request", arguments: {} });
        const reqText = (reqRes.structuredContent as { request: string }).request;
        expect(reqText).toContain(documentId);
        expect(reqText).toContain("Change 17 to 19 boats");

        // Agent reads the deck and proposes a single-shape text update.
        const readRes = await agent.callTool({ name: "read_deck", arguments: { documentId } });
        const deckInfo = readRes.structuredContent as { version: string; slideCount: number };
        expect(deckInfo.slideCount).toBe(3);

        const propRes = await agent.callTool({
          name: "propose_deck_changes",
          arguments: {
            documentId,
            version: deckInfo.version,
            summary: lang === "zh-CN" ? "更新南码头船只数量" : "Update south quay boat count",
            changes: [
              {
                kind: "text",
                slide: 1,
                shape: "3",
                paragraphs: ["South quay holds 19 boats."],
              },
            ],
          },
        });
        expect((propRes.structuredContent as { status: string }).status).toBe("waiting");

        // Review bar shows before/after preview and Confirm button.
        const card = window.getByTestId("viewer-deck-proposal-card");
        await expect(card).toBeVisible();
        await expect(card.getByTestId("viewer-deck-proposal-before")).toContainText(
          "South quay holds 17 boats.",
        );
        await expect(card.getByTestId("viewer-deck-proposal-after")).toContainText(
          "South quay holds 19 boats.",
        );
        await shot(window, `deck-ai-proposal-1440-${lang}`);
        await setWindowSize(app, window, 900, 700);
        await shot(window, `deck-ai-proposal-900-${lang}`);
        await setWindowSize(app, window, 1440, 900);

        // Confirm -> receipt shows 2 unchanged, 1 changed, and original file stays byte-identical!
        await card.getByTestId("viewer-deck-proposal-confirm").click();
        const receipt = window.getByTestId("viewer-deck-receipt");
        await expect(receipt).toBeVisible();
        await expect(receipt).toContainText(
          lang === "zh-CN"
            ? "2 页幻灯片原样保留；修改了 1 页。"
            : "2 slides kept exactly as they were; 1 changed.",
        );
        await shot(window, `deck-ai-receipt-1440-${lang}`);
        await setWindowSize(app, window, 900, 700);
        await shot(window, `deck-ai-receipt-900-${lang}`);
        await setWindowSize(app, window, 1440, 900);

        expect(sha256(new Uint8Array(await readFile(deckPath)))).toBe(originalHash);

        // Undo from the receipt restores the prior state.
        await receipt.getByTestId("viewer-deck-receipt-undo").click();
        await expect(receipt).toBeHidden();

        // Now test overflow on the tight box (shape "4") on the currently open deck.
        const currentDocId = await window.evaluate(async () => {
          const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
          const docs = await bridge.listDocuments();
          return docs.find((d) => d.name.includes("Harbour plan"))?.id ?? "";
        });
        const read2 = await agent.callTool({
          name: "read_deck",
          arguments: { documentId: currentDocId || documentId },
        });
        const info2 = read2.structuredContent as { version: string; documentId: string };
        await agent.callTool({
          name: "propose_deck_changes",
          arguments: {
            documentId: info2.documentId,
            version: info2.version,
            summary: lang === "zh-CN" ? "补充详细说明" : "Expand note",
            changes: [
              {
                kind: "text",
                slide: 1,
                shape: "4",
                paragraphs: [
                  "This deliberately long paragraph will not fit inside a narrow quarter-inch text box on slide one without shrinking or shortening.",
                ],
              },
            ],
          },
        });
        await expect(window.getByTestId("viewer-deck-proposal-overflow")).toBeVisible();
        await expect(window.getByTestId("viewer-deck-proposal-shrink")).toBeVisible();
        await expect(window.getByTestId("viewer-deck-proposal-shorten")).toBeVisible();
        await shot(window, `deck-ai-overflow-1440-${lang}`);
        await setWindowSize(app, window, 900, 700);
        await shot(window, `deck-ai-overflow-900-${lang}`);
        await setWindowSize(app, window, 1440, 900);

        await window.getByTestId("viewer-deck-proposal-shrink").click();
        await expect(window.getByTestId("viewer-deck-receipt")).toBeVisible();
      } finally {
        await agent.close();
      }
    } finally {
      await app.close();
    }
  });
}
