/**
 * What Organize needs before a run of the User's own (#1569, ADR-0022), through the core as the
 * Library's button and ⌘K use it: with no model at all, a model; the first time a cloud service
 * would read the Documents, the card naming that service; once allowed, nothing; in Local mode,
 * nothing asks. Every request each model gets is counted, so "nothing is sent" is checked.
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test } from "vitest";
import { type Core, DATABASE_FILE } from "../../src/core";
import type { ChatModelSpec } from "../../src/core/providers/models";
import { openDatabase } from "../../src/core/storage";
import { translate } from "../../src/shared/i18n";
import { createTempDataFolder, startCore } from "../helpers/core";
import { addAndProcess, createSourceFolder, writeSourceFile } from "../helpers/documents";
import { planReply, proposedFor } from "../helpers/library";

/** A model for each provider kind that plans every Document into "Harbour", counting its requests. */
function counting() {
  const sent: Record<string, number> = {};
  const createChatModel = (spec: ChatModelSpec) =>
    new MockLanguageModelV4({
      doGenerate: async (options) => {
        sent[spec.kind] = (sent[spec.kind] ?? 0) + 1;
        const user = options.prompt.find((message) => message.role === "user");
        const text =
          user && typeof user.content !== "string"
            ? user.content.map((part) => ("text" in part ? part.text : "")).join("")
            : "";
        const planned = planReply(text, { name: "Harbour", description: "Port work." });
        // One Document at a time: the first Folder it is offered.
        const offered = /"groups":\[\{"id":"([^"]+)"/.exec(text)?.[1];
        const one = offered && JSON.stringify({ groupId: offered, tags: [], newTags: [] });
        return {
          content: [{ type: "text", text: planned?.text ?? one ?? JSON.stringify({ tags: [] }) }],
          finishReason: { unified: "stop", raw: undefined },
          warnings: [],
          usage: {
            inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 1, text: 1, reasoning: undefined },
          },
        };
      },
    });
  return { sent: (kind: string) => sent[kind] ?? 0, createChatModel };
}

async function setup() {
  const models = counting();
  const dataDir = await createTempDataFolder();
  const core = startCore(dataDir, { createChatModel: models.createChatModel });
  const sources = await createSourceFolder();
  const paths = await Promise.all(
    [1, 2, 3].map((index) =>
      writeSourceFile(sources, `Survey ${index}.md`, `Berth survey ${index} at the north quay.`),
    ),
  );
  const documents = await addAndProcess(core, paths);
  return { core, dataDir, models, ids: documents.map((each) => each.id) };
}

const ANTHROPIC = { id: "https://api.anthropic.com", name: "Anthropic" };

const useAnthropic = (core: Core) =>
  core.saveChatProvider({ kind: "anthropic", apiKey: "sk-ant-test", modelId: "claude-haiku-5-5" });

/** How many of these Documents wait in the Review for the new Folder "Harbour". */
const intoHarbour = async (core: Core, ids: readonly string[]) =>
  (await Promise.all(ids.map((id) => proposedFor(core, id)))).filter(
    (place) => place === "new:Harbour",
  ).length;

const consentOf = async (core: Core) =>
  (await core.listDataFlows()).find(
    (each) => each.flow.id === "classification" && each.flow.service.id === ANTHROPIC.id,
  )?.consent ?? "not-asked";

describe("What Organize needs before it runs (#1569)", () => {
  // protects=with no AI model at all, Organize asks for a model and sends nothing; fails_when=it offers the consent card or runs; no_claim=the key field's own flow.
  test("no model at all: it asks for a model", async () => {
    const { core, models } = await setup();
    expect(await core.startOrganize()).toEqual({ ready: false, needs: "model", noProvider: true });
    expect(models.sent("anthropic")).toBe(0);
  });

  // protects=a cloud model set up but not yet allowed for Organize gets the card naming its service, not "needs an AI model", and nothing is kept or sent; fails_when=it says no model, keeps the model, records consent or sends; no_claim=the card's words, tested with the trace.
  test("a cloud model with no consent: the card, naming its service", async () => {
    const { core, models } = await setup();
    await useAnthropic(core);

    expect(await core.startOrganize()).toEqual({
      ready: false,
      needs: "consent",
      service: ANTHROPIC,
      declined: false,
      model: "chat",
    });
    expect((await core.getLibrary()).settings.organizeWith).toBeNull();
    expect(await consentOf(core)).toBe("not-asked");
    expect(models.sent("anthropic")).toBe(0);
  });

  // protects=Allow and organize records the classification consent for the service the card named, keeps the model, and the run then sends; a second press asks nothing; fails_when=Allow sends before recording, records nothing, or the second press asks; no_claim=which Folder the plan proposes.
  test("Allow and organize: the consent for that service, then no card again", async () => {
    const { core, models, ids } = await setup();
    await useAnthropic(core);

    expect(await core.allowOrganize(ANTHROPIC.id)).toEqual({ ready: true, model: "chat" });
    expect(await consentOf(core)).toBe("accepted");
    expect((await core.getLibrary()).settings.organizeWith).toMatchObject({ kind: "chat" });
    expect(models.sent("anthropic")).toBe(0);

    await core.organizeLibrary({ forService: ANTHROPIC.id });
    expect(models.sent("anthropic")).toBeGreaterThan(0);
    expect(await intoHarbour(core, ids)).toBe(3);
    expect(await core.startOrganize()).toEqual({ ready: true, model: "chat" });
  });

  // protects=an Allow for a service the card didn't name records nothing; fails_when=any service id is allowed; no_claim=the window's own check.
  test("Allow for another service records nothing", async () => {
    const { core } = await setup();
    await useAnthropic(core);

    const now = await core.allowOrganize("https://api.openai.com");
    expect(now).toMatchObject({ ready: false, needs: "consent", service: ANTHROPIC });
    expect(await consentOf(core)).toBe("not-asked");
  });

  // protects=a model on this computer sends nothing, so Organize runs without asking and keeps it; fails_when=it asks for consent or a model; no_claim=what the local model proposes.
  test("a model on this computer: it runs without asking", async () => {
    const { core } = await setup();
    await core.saveChatProvider({ kind: "ollama", modelId: "main-chat" });

    expect(await core.startOrganize()).toEqual({ ready: true, model: "chat" });
    expect((await core.getLibrary()).settings.organizeWith).toMatchObject({ kind: "chat" });
  });

  // protects=Local mode sends nothing to a cloud service and asks nothing: the press says why; fails_when=it shows the card or sends; no_claim=the notice's place.
  test("Local mode: nothing asks, and nothing is sent", async () => {
    const { core, models } = await setup();
    await useAnthropic(core);
    await core.setLocalOnly(true);

    const refused = await core.startOrganize().catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(Error);
    expect((refused as Error).message).toBe(translate("en", "error.tagging.cloudPaused"));
    expect(await consentOf(core)).toBe("not-asked");
    expect(models.sent("anthropic")).toBe(0);
  });

  // protects=after the User's earlier no, the card says so, and its Allow sends this run alone, storing neither the consent nor the model (#2252); fails_when=it lifts the no, keeps the model, or sends without the press; no_claim=the window's words.
  test("after an earlier no: Allow sends this once and keeps nothing", async () => {
    const { core, dataDir, models, ids } = await setup();
    await useAnthropic(core);
    const at = new Date().toISOString();
    const db = openDatabase(join(dataDir, DATABASE_FILE));
    try {
      db.run(
        `INSERT INTO data_flow_consents
           (id, flow, service_id, service_name, decision, data_kinds, created_at, updated_at)
         VALUES (?, 'classification', ?, ?, 'declined', '[]', ?, ?)`,
        [randomUUID(), ANTHROPIC.id, ANTHROPIC.name, at, at],
      );
    } finally {
      db.close();
    }

    expect(await core.startOrganize()).toMatchObject({ needs: "consent", declined: true });
    // The window's Allow under a no runs once; allowOrganize alone records nothing.
    expect(await core.allowOrganize(ANTHROPIC.id)).toMatchObject({ declined: true });
    expect(models.sent("anthropic")).toBe(0);

    await core.organizeLibrary({ forService: ANTHROPIC.id, once: true });
    expect(models.sent("anthropic")).toBeGreaterThan(0);
    expect(await intoHarbour(core, ids)).toBe(3);
    expect(await consentOf(core)).toBe("declined");
    expect((await core.getLibrary()).settings.organizeWith).toBeNull();
    expect(await core.startOrganize()).toMatchObject({ needs: "consent", declined: true });

    // One Document at a time, with none named: every Document, once, and still nothing kept.
    const harbour = await core.createLibraryGroup({ name: "Harbour", description: "Port work." });
    const before = models.sent("anthropic");
    await core.classifyDocuments(undefined, { forService: ANTHROPIC.id, once: true });
    expect(models.sent("anthropic")).toBe(before + 3);
    expect(await Promise.all(ids.map((id) => proposedFor(core, id)))).toEqual([
      harbour.id,
      harbour.id,
      harbour.id,
    ]);
    expect(await consentOf(core)).toBe("declined");
    expect((await core.getLibrary()).settings.organizeWith).toBeNull();
  });
});
