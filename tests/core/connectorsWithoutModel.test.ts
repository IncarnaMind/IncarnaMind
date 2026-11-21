import { describe, expect, test } from "vitest";
import { logFileIn, testProcesses, tideServer, waitForState } from "../helpers/connectors";
import { createTempDataFolder, startCore } from "../helpers/core";

/*
 * Settings lists no Connectors page while no model is set up and no Connector is on (#3537). That
 * hides a page and nothing else: a Connector connected before the last model went keeps running,
 * keeps the consent it was connected with, stays in Settings › Privacy, and is switched off from
 * the page that stays listed for it.
 */
describe("A connected Connector when the last model is removed", { timeout: 30_000 }, () => {
  async function connectedWithAModel() {
    const dataDir = await createTempDataFolder();
    const core = startCore(dataDir, { processes: testProcesses() });
    const model = await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
    const connector = await core.addConnector(tideServer(logFileIn(dataDir)));
    await waitForState(core, connector.id, "ready");
    const connectorsFlow = async () =>
      (await core.listRegisteredDataFlows()).find((flow) => flow.id === "connectors");
    return { core, model, connector, connectorsFlow };
  }

  test("stays on, keeps its consent, and is still listed with the other services in Privacy", async () => {
    const { core, model, connector, connectorsFlow } = await connectedWithAModel();
    const consentBefore = (await core.listDataFlows()).filter(
      (each) => each.flow.id === "connectors",
    );
    const service = `connector:${connector.id}`;
    expect(consentBefore).toEqual([expect.objectContaining({ consent: "accepted", chosen: true })]);

    await core.deleteChatProvider(model.id);

    expect(await core.getChatReadiness()).toEqual({ ready: false, reason: "no-provider" });
    expect(await core.listConnectors()).toEqual([
      expect.objectContaining({ id: connector.id, enabled: true, state: "ready" }),
    ]);
    expect((await core.listDataFlows()).filter((each) => each.flow.id === "connectors")).toEqual(
      consentBefore,
    );
    expect((await connectorsFlow())?.services).toEqual([
      expect.objectContaining({
        flow: expect.objectContaining({ service: { id: service, name: "Tides" } }),
        consent: "accepted",
      }),
    ]);
  });

  test("is switched off, and on again, with no model set up, its consent as it was", async () => {
    const { core, model, connector, connectorsFlow } = await connectedWithAModel();
    await core.deleteChatProvider(model.id);

    const off = await core.setConnectorEnabled(connector.id, false);

    expect(off.enabled).toBe(false);
    expect((await core.listConnectors()).some((each) => each.enabled)).toBe(false);

    const on = await core.setConnectorEnabled(connector.id, true);

    expect(on.enabled).toBe(true);
    expect((await connectorsFlow())?.services).toEqual([
      expect.objectContaining({ consent: "accepted", chosen: true }),
    ]);
  });
});
