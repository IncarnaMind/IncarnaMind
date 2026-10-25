import { randomUUID } from "node:crypto";
import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { CoreBridge } from "../src/core/api";
import { translate } from "../src/shared/i18n";
import { startHeaderMcp } from "../tests/helpers/headerMcp";
import {
  acceptPlainTextKeys,
  createDataFolder,
  dismissChatSetup,
  removeDataFolder,
  setLanguage,
  setWindowSize,
} from "./app";
import { endFeel, FEEL_FOLDER, startFeel } from "./feel";

for (const language of ["en", "zh-CN"] as const)
  for (const width of [900, 1600]) {
    test(`remote keys, SSE, errors and import by keyboard · ${language} · ${width}`, async () => {
      const t = (key: Parameters<typeof translate>[1]) => translate(language, key);
      const key = randomUUID();
      const server = await startHeaderMcp({
        header: "Authorization",
        value: `Bearer ${key}`,
        legacy: 404,
      });
      const imported = await startHeaderMcp({ header: "X-Custom-Key", value: key, legacy: true });
      const dataDir = await createDataFolder();
      const flow = `1995-after-${language}-${width}`;
      const run = await startFeel(dataDir, flow, { fakeChat: true });
      const { window, app } = run;
      const evidence = process.env.INCARNAMIND_CONNECTOR_EVIDENCE;
      const shot = async (step: string) => {
        if (!evidence) return;
        await mkdir(evidence, { recursive: true });
        await window.screenshot({ path: join(evidence, `${flow}-${step}.png`) });
      };
      try {
        await setWindowSize(app, window, width, 900);
        await dismissChatSetup(window);
        await window.keyboard.press("ControlOrMeta+k");
        await window.getByTestId("palette-search").fill("Connectors");
        const command = window.locator('[data-key="command:settings.connectors"]');
        await expect(command).toBeVisible();
        await window.keyboard.press("Enter");
        await expect(window.getByTestId("palette")).toBeHidden();
        await expect(window.getByTestId("settings")).toHaveAttribute("data-page", "connectors");
        await setLanguage(window, language);
        const page = window.getByTestId("settings-page-connectors");
        await page.getByTestId("connector-add-custom").focus();
        await window.keyboard.press("Enter");
        const form = page.getByTestId("connector-form");
        await form.getByLabel(t("connectors.form.name"), { exact: true }).fill("Tides");
        await form.getByLabel(t("remoteConnectors.form.url"), { exact: false }).fill(server.url);
        const field = form.getByLabel(t("remoteConnectors.key.label"), { exact: false });
        await expect(field).toHaveAttribute("type", "password");
        await shot("form");
        const options = form.getByText(t("remoteConnectors.key.options"), { exact: true });
        await options.focus();
        await window.keyboard.press("Enter");
        await expect(
          form.getByLabel(t("remoteConnectors.key.header"), { exact: false }),
        ).toHaveValue("Authorization");
        await options.press("Enter");
        await field.fill(randomUUID()).catch(() => {
          throw new Error("Could not enter the synthetic key.");
        });
        await acceptPlainTextKeys(window, form);
        await form.getByRole("button", { name: t("connectors.form.add"), exact: true }).focus();
        await window.keyboard.press("Enter");
        const connector = page.getByTestId("connector");
        await expect(connector).toHaveAttribute("data-state", "error");
        await expect(connector.getByTestId("connector-error")).toContainText(
          t("connectors.error.key-refused"),
        );
        await shot("refused");
        await connector
          .getByRole("button", { name: t("remoteConnectors.key.change"), exact: true })
          .focus();
        await window.keyboard.press("Enter");
        const replacement = connector.locator('input[type="password"]');
        await expect(replacement).toBeFocused();
        await replacement.fill(key).catch(() => {
          throw new Error("Could not enter the synthetic replacement key.");
        });
        await replacement.press("Enter");
        await expect(connector).toHaveAttribute("data-state", "ready");
        await expect(connector).toContainText(t("remoteConnectors.connection.sse"));
        await expect(connector.getByTestId("connector-key-mask")).toContainText("••••••••");
        expect((await page.textContent())?.includes(key)).toBe(false);
        await shot("connected");
        await server.close();
        await window.evaluate(async () => {
          const bridge = (globalThis as unknown as { incarnamind: CoreBridge }).incarnamind;
          const connector = (await bridge.listConnectors()).find((each) => each.name === "Tides");
          if (connector) await bridge.restartConnector(connector.id);
        });
        await expect(connector.getByTestId("connector-error")).toHaveAttribute(
          "data-error-kind",
          "unreachable",
        );
        await expect(connector.getByTestId("connector-error")).toContainText("Tides");
        await connector.getByRole("button", { name: t("connectors.retry"), exact: true }).hover();
        await connector.getByRole("button", { name: t("connectors.retry"), exact: true }).click();
        await expect(connector.getByTestId("connector-error")).toHaveAttribute(
          "data-error-kind",
          "unreachable",
        );
        await shot("unreachable");
        await page.getByTestId("connectors-back").click();
        await page.getByTestId("connector-add-custom").click();
        await page.getByRole("tab", { name: t("connectors.custom.import"), exact: true }).click();
        const importing = page.getByTestId("connector-import-form");
        await importing
          .getByLabel(t("connectors.import.json"), { exact: true })
          .fill(
            JSON.stringify({
              mcpServers: {
                Imported: { type: "sse", url: imported.url, headers: { "X-Custom-Key": key } },
              },
            }),
          )
          .catch(() => {
            throw new Error("Could not enter the synthetic configuration.");
          });
        await importing
          .getByRole("button", { name: t("connectors.import.preview"), exact: true })
          .click();
        await expect(importing).toContainText("X-Custom-Key");
        await expect(importing).toContainText(t("remoteConnectors.connection.sse"));
        await expect(importing.locator("textarea")).toHaveCount(0);
        expect((await importing.textContent())?.includes(key)).toBe(false);
        await shot("import");
        await importing.getByTestId("connector-import-confirm").focus();
        await window.keyboard.press("Enter");
        const row = page.getByTestId("connected-connector").filter({ hasText: "Imported" });
        await expect(row).toHaveAttribute("data-state", "ready");
        const bounds = await page.boundingBox();
        expect(bounds?.width ?? 0).toBeLessThanOrEqual(width);
      } finally {
        await endFeel(run);
        if (evidence)
          await copyFile(join(FEEL_FOLDER, `${flow}.mp4`), join(evidence, `${flow}.mp4`));
        await server.close();
        await imported.close();
        await removeDataFolder(dataDir);
      }
    });
  }
