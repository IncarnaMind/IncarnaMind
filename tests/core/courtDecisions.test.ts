import type { JSONContent } from "@tiptap/core";
import type { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test } from "vitest";
import type { ClaimCheckAttributes, Core } from "../../src/core";
import { claimSpans } from "../../src/renderer/src/editor/claimChecks";
import { checkGenerate, checkReply, isCheckRun, type Plan } from "../helpers/checks";
import { askAndFinish, type SourceFile, setUpWithDocuments } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { waitForProcessing } from "../helpers/documents";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { readMind, writeMind } from "../helpers/minds";
import { type ModelCall, type ScriptedReply, scriptedModel } from "../helpers/models";
import { connectorTo, startWeb, webSearchingModel } from "../helpers/web";

const TIDES: SourceFile = {
  name: "Tides.md",
  contents: "# Tides\n\nHarbours publish the times of high water every year.",
};

const OPINION: SourceFile = {
  name: "Hallmark Builders v Rio Grande Supply.md",
  contents: [
    "# Hallmark Builders, Inc. v. Rio Grande Supply Co.",
    "",
    "512 S.W.3d 101 (Tex. 2017)",
    "",
    "A supplier lien attaches when the materials are delivered to the site.",
  ].join("\n"),
};

/** A slip opinion: its caption names the parties, and it has no reporter citation. */
const SLIP_OPINION: SourceFile = {
  name: "opinion-15-0123.md",
  contents: [
    "# Hallmark Builders, Inc., Petitioner, v. Rio Grande Supply Co., Respondent",
    "",
    "No. 15-0123. Supreme Court of Texas.",
    "",
    "A supplier lien attaches when the materials are delivered to the site.",
  ].join("\n"),
};

const CITATION = "Hallmark Builders v. Rio Grande Supply, 512 S.W.3d 101 (Tex. 2017)";
const INVENTED = `See ${CITATION}.`;
const LIEN = "A supplier lien attaches when the materials are delivered to the site";
const LIEN_CITED = `${LIEN}, see ${CITATION}.`;
const LIEN_UNDER = `Under ${CITATION}, ${LIEN.toLowerCase()}.`;
const LIEN_PLAIN = `${LIEN}.`;
const PENGUINS = "Penguins nest on the cliffs above the harbour.";
const PENGUINS_CITED = `Penguins nest on cliffs, as held in ${CITATION}.`;
const HARBOUR = "Harbours publish the times of high water every year.";
const HARBOUR_CITED = `${HARBOUR.slice(0, -1)}, see ${CITATION}.`;

const supports: Plan = { verdict: "supported", quote: `${LIEN}.`, says: "It says so." };
const PLANS: Record<string, Plan> = {
  [INVENTED]: { verdict: "unsupported" },
  [PENGUINS]: { verdict: "unsupported" },
  [PENGUINS_CITED]: { verdict: "unsupported" },
  [LIEN_CITED]: supports,
  [LIEN_UNDER]: supports,
  [LIEN_PLAIN]: supports,
  [HARBOUR_CITED]: {
    verdict: "supported",
    quote: HARBOUR,
    says: "Tides says harbours publish them every year.",
  },
};

const MEMO: SourceFile = {
  name: "Memo on payment rights.md",
  contents: [
    "# Memo on payment rights",
    "",
    "To the client team, from the construction group, 4 March 2025. This note sets out where we stand on lien rights on the Brazos job and what we recommend before the next payment falls due, so that nobody is surprised.",
    "",
    `${LIEN}. See ${CITATION}.`,
  ].join("\n"),
};

const SHORT_MEMO: SourceFile = {
  name: "Lien note.md",
  contents: `# Lien note\n\n${LIEN}. See ${CITATION}.`,
};

const NAMED_ALERT: SourceFile = {
  name: "Hallmark Builders v Rio Grande Supply - client alert.md",
  contents: `# Client alert\n\nThe Supreme Court of Texas decided a lien case this year. ${LIEN}.`,
};

const CLIENT_ALERT: SourceFile = {
  name: "Client alert 2017.md",
  contents: [
    "# Client alert",
    "",
    `Hallmark Builders and Rio Grande Supply went to the Supreme Court of Texas this year, and the court gave its view. ${LIEN}.`,
  ].join("\n"),
};

const OPINION_ADDRESS = "http://opinions.example/hallmark";
const FILLER = Array.from(
  { length: 6 },
  () =>
    "<p>Construction law lets suppliers of materials secure payment against the property improved with them, provided they give the owner written notice within the time the statute allows.</p>",
).join("");
const OPINION_PAGE = `<html><head><title>Hallmark Builders v. Rio Grande Supply</title></head><body><article><h1>Hallmark Builders v. Rio Grande Supply</h1><p>${LIEN}. ${CITATION}.</p>${FILLER}</article></body></html>`;

let blocks = 0;
const paragraph = (text: string): JSONContent & { attrs: { id: string } } => ({
  type: "paragraph",
  attrs: { id: `court-${++blocks}` },
  content: [{ type: "text", text }],
});

async function checkParagraph(
  core: Core,
  sentences: readonly string[],
): Promise<ClaimCheckAttributes[]> {
  const mind = await core.createMind({ title: "Draft" });
  const client = await connectToMind(core, mind.id);
  const body = sentences.join(" ");
  const block = paragraph(body);
  writeMind(client, [block]);
  await client.settled();
  await core.checkSentences({
    requestId: crypto.randomUUID(),
    mindId: mind.id,
    action: "find-support",
    from: { blockId: block.attrs.id, offset: 0 },
    to: { blockId: block.attrs.id, offset: body.length },
  });
  await client.settled();
  return claimSpans(readMind(client)).map((span) => span.check);
}

const summary = (checks: readonly ClaimCheckAttributes[]) =>
  checks.map((each) => [each.text, each.state, each.citedCaseUnchecked, each.citedCaseFound]);

async function checked(sentences: readonly string[], files: readonly SourceFile[]) {
  const setup = await setUpWithDocuments(scriptedChecker(), files);
  return checkParagraph(setup.core, sentences);
}

function scriptedChecker(calls: ModelCall[] = []): MockLanguageModelV4 {
  return scriptedModel(
    (call: ModelCall): ScriptedReply => {
      if (isCheckRun(call)) {
        calls.push(call);
        return checkReply(call, PLANS);
      }
      if (!call.tools.includes("search_web")) return { text: "I didn't search the web." };
      if (!call.results.some((result) => result.tool === "search_web")) {
        return { calls: [{ tool: "search_web", input: { query: "Hallmark Builders" } }] };
      }
      if (!call.results.some((result) => result.tool === "read_web_page")) {
        return {
          calls: [
            { tool: "read_web_page", input: { url: OPINION_ADDRESS, query: "supplier lien" } },
          ],
        };
      }
      return { text: "I read the opinion." };
    },
    { generate: checkGenerate(PLANS) },
  );
}

describe("A sentence that cites a court decision", () => {
  test("no Document holds is unsupported and says so; the sentence beside it doesn't", async () => {
    const checks = await checked([INVENTED, PENGUINS], [TIDES]);

    expect(summary(checks)).toEqual([
      [INVENTED, "unsupported", true, false],
      [PENGUINS, "unsupported", false, false],
    ]);
  });

  test("is checked against its opinion when it is among the Documents, and says it was found there", async () => {
    const checks = await checked([LIEN_CITED, PENGUINS_CITED], [TIDES, OPINION]);

    expect(summary(checks)).toEqual([
      [LIEN_CITED, "supported", false, true],
      [PENGUINS_CITED, "unsupported", false, false],
    ]);
    expect(checks[0]?.evidence).toMatchObject({
      documentName: "Hallmark Builders v Rio Grande Supply",
      quote: `${LIEN}.`,
    });
  });

  test.each([
    ["a memo that cites it", MEMO],
    ["a short memo whose first Passage cites it", SHORT_MEMO],
    ["a Document named for the case and a client alert", NAMED_ALERT],
    ["a client alert that names both parties", CLIENT_ALERT],
  ])(
    "is not found in %s: the sentence it backs stays Supported, and its cited case is unchecked",
    async (_what, file) => {
      const checks = await checked([LIEN_CITED], [TIDES, file]);

      expect(summary(checks)).toEqual([[LIEN_CITED, "supported", true, false]]);
    },
  );

  test("finds a slip opinion with no reporter citation, whatever words come before the case's name", async () => {
    const checks = await checked([LIEN_UNDER], [TIDES, SLIP_OPINION]);

    expect(summary(checks)).toEqual([[LIEN_UNDER, "supported", false, true]]);
  });

  test("that another Document supports stays Supported, and its cited case is flagged unchecked", async () => {
    const checks = await checked([HARBOUR_CITED], [TIDES]);

    expect(summary(checks)).toEqual([[HARBOUR_CITED, "supported", true, false]]);
  });

  test("gets no verdict from a model that never searches, though the check looked the case up", async () => {
    const calls: ModelCall[] = [];
    const model = scriptedModel(
      (call): ScriptedReply => {
        if (isCheckRun(call)) calls.push(call);
        return { text: "Verdict: unsupported" };
      },
      { generate: checkGenerate(PLANS) },
    );
    const { core } = await setUpWithDocuments(model, [TIDES, OPINION]);

    const checks = await checkParagraph(core, [INVENTED]);

    expect(checks).toMatchObject([{ state: "not-checked", reason: "unread" }]);
    expect(calls).toHaveLength(2);
  });
});

describe("A saved web page as the opinion", { timeout: 30_000 }, () => {
  async function setUp(calls: ModelCall[] = [], gated = false) {
    const web = await startWeb({ "/hallmark": () => ({ status: 200, body: OPINION_PAGE }) });
    let release = () => {};
    let reach = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      reach = resolve;
    });
    const connect = connectorTo(web.port);
    const adapters = gated
      ? {
          web: {
            ...web.adapters.web,
            connector: (lookup: Parameters<typeof connect>[0]) => {
              const inner = connect(lookup);
              return (...args: Parameters<typeof inner>) => {
                reach();
                void gate.then(() => inner(...args));
              };
            },
          },
        }
      : web.adapters;
    const { model } = webSearchingModel(scriptedChecker(calls), [
      { url: OPINION_ADDRESS, title: "Hallmark Builders v. Rio Grande Supply" },
    ]);
    const core = startCore(await createTempDataFolder(), {
      createChatModel: () => model,
      ...adapters,
    });
    const provider = await core.saveChatProvider({
      kind: "anthropic",
      apiKey: "sk-ant-test",
      modelId: "claude-haiku-5-5",
    });
    if (!provider.service) throw new Error("Anthropic has a service.");
    await core.allowDataFlow("chat", provider.service.id);
    core.on("consent.requested", (request) => void core.respondToConsent(request.requestId, true));
    await core.updateSettings({ user: { webSearch: true } });
    const asking = await core.createMind({ title: "Research" });
    const client = await connectToMind(core, asking.id);
    return { core, asking, client, web, reached, release };
  }

  async function searchSavesOpinion(core: Core, asking: { id: string }, client: MindClient) {
    await askAndFinish(core, client, asking.id, "Search the web: Hallmark Builders v. Rio Grande");
    const [page] = await core.listDocuments();
    expect(page?.web).toMatchObject({ origin: "search" });
    return page;
  }

  test("a page the User saved counts as the opinion: it supports the sentence and is found there", async () => {
    const { core } = await setUp();
    const saved = await core.saveWebPage({ address: OPINION_ADDRESS, html: OPINION_PAGE });
    if (saved.outcome !== "saved") throw new Error("The page wasn't saved.");
    await waitForProcessing(core, [saved.document.id]);
    expect(saved.document.web?.origin).toBe("user");

    const [check] = await checkParagraph(core, [LIEN_CITED]);

    expect(check).toMatchObject({
      state: "supported",
      citedCaseUnchecked: false,
      citedCaseFound: true,
    });
    expect(check?.evidence).toMatchObject({
      documentId: saved.document.id,
      documentName: "Hallmark Builders v. Rio Grande Supply",
      quote: `${LIEN}.`,
    });
  });

  test("the User saving an address while a web search is saving it makes the page theirs", async () => {
    const { core, asking, client, reached, release } = await setUp([], true);
    const asked = askAndFinish(
      core,
      client,
      asking.id,
      "Search the web: Hallmark Builders v. Rio Grande",
    );
    await reached;
    const saving = core.saveWebPage({ address: OPINION_ADDRESS });
    release();
    await Promise.all([asked, saving]);

    const pages = await core.listDocuments();
    expect(pages).toHaveLength(1);
    expect(pages[0]?.web?.origin).toBe("user");
  });

  test("a page a web search saved never does: nothing it holds is shown to the check", async () => {
    const calls: ModelCall[] = [];
    const { core, asking, client } = await setUp(calls);
    await searchSavesOpinion(core, asking, client);

    const [cited] = await checkParagraph(core, [INVENTED]);

    expect(cited).toMatchObject({
      state: "unsupported",
      citedCaseUnchecked: true,
      evidence: null,
    });
    expect(calls.length).toBeGreaterThan(0);
    const shown = (list: readonly ModelCall[]) =>
      list.flatMap((call) => call.results.map((result) => result.text));
    expect(shown(calls).filter((text) => text.includes(LIEN))).toEqual([]);

    calls.length = 0;
    const [plain] = await checkParagraph(core, [LIEN_PLAIN]);
    expect(plain).toMatchObject({ state: "supported", citedCaseUnchecked: false });
    expect(shown(calls).filter((text) => text.includes(LIEN))).not.toEqual([]);
  });

  test("the User saving that page's address makes it count", async () => {
    const { core, asking, client } = await setUp();
    const page = await searchSavesOpinion(core, asking, client);

    const again = await core.saveWebPage({ address: page?.web?.address ?? "" });

    expect(again).toMatchObject({ outcome: "saved", existing: true });
    expect((await core.listDocuments())[0]?.web?.origin).toBe("user");
    const [check] = await checkParagraph(core, [LIEN_CITED]);
    expect(check).toMatchObject({
      state: "supported",
      citedCaseUnchecked: false,
      citedCaseFound: true,
    });
  });
});
