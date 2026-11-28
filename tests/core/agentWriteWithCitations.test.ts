/**
 * Writing a Note with sources in one call (#3753): `propose_changes` and `create_mind` accept
 * inline `[cite:passageId: exact quote]` (and `[cite:path: exact quote]` outside a run grant) so
 * an agent doesn't need a separate `cite` round-trip before writing. IncarnaMind confirms each
 * quote the same way `cite` does: confirmed quotes attach as real Citations, while unconfirmed
 * quotes are never attached, leave no stray text in the Note, and are reported in plain words.
 */
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { findInlineQuoteTags, rewriteInlineQuoteTags } from "../../src/core/agents/inlineCitations";
import {
  createPassageCiteRegistry,
  formatCitedTimedText,
  formatCitedWindow,
  sentenceSpansOf,
} from "../../src/core/agents/passageCites";
import { ALL_SHARED_ID, CITATION_NODE } from "../../src/core/api";
import { createCanvasFiles } from "../../src/main/canvasFiles";
import { translate } from "../../src/shared/i18n";
import { buildAgentShim, connectLegacyAgent, startAgentsCore } from "../helpers/agents";
import { createTempDataFolder } from "../helpers/core";
import { addAndProcess, createSourceFolder, writeSourceFile } from "../helpers/documents";
import { connectToMind } from "../helpers/mindClient";
import { note, readMind, writeMind } from "../helpers/minds";
import { replyingModel } from "../helpers/models";

const TIDES = [
  "# Tides",
  "",
  "Spring tides happen twice a month, at new moon and full moon. Their range is the largest of the month.",
  "",
  "Neap tides come at the first and third quarters of the moon. Their range is the smallest of the month.",
  "",
  "Section 4.1: Harbour clocks run from 06:00 to 22:00 [winter schedule].",
].join("\n");

const SPRING = "Spring tides happen twice a month, at new moon and full moon.";
const NEAP = "Neap tides come at the first and third quarters of the moon.";
const COLON_BRACKET = "Section 4.1: Harbour clocks run from 06:00 to 22:00 [winter schedule].";

const BUDGET = [
  "# 季度预算",
  "",
  "华东团队第三季度营收达到 420 万元，同比增长 18%。",
  "华南团队第三季度营收为 310 万元，保持稳定。",
].join("\n");

const EAST_ZH = "华东团队第三季度营收达到 420 万元，同比增长 18%。";
const SOUTH_ZH = "华南团队第三季度营收为 310 万元，保持稳定。";

interface CitationOut {
  cite: string;
  check: string;
  document: string | null;
  location: string | null;
  quote: string | null;
  changed: boolean;
  text?: string;
}

interface ProposedOut {
  mindId: string;
  status: string;
  waiting: number;
  markdown: string;
  version: string;
  citations: CitationOut[];
  uncited: string[];
}

interface CreatedOut {
  mindId: string;
  title: string;
  folder: string;
  citations: CitationOut[];
  uncited: string[];
}

function structured<T>(result: unknown): T {
  const { isError, structuredContent, content } = result as {
    isError?: boolean;
    structuredContent?: unknown;
    content?: { text?: string }[];
  };
  expect(isError ?? false, content?.[0]?.text).toBe(false);
  return structuredContent as T;
}

function refusal(result: unknown): string {
  const { isError, content } = result as { isError?: boolean; content?: { text?: string }[] };
  expect(isError).toBe(true);
  return content?.[0]?.text ?? "";
}

/** Collects every Citation node and every text node inside a Mind's ProseMirror tree. */
async function inspectMind(
  core: Awaited<ReturnType<typeof startAgentsCore>>["core"],
  mindId: string,
): Promise<{ citations: Record<string, unknown>[]; text: string }> {
  const client = await connectToMind(core, mindId);
  const doc = readMind(client);
  const citations: Record<string, unknown>[] = [];
  const words: string[] = [];
  doc.descendants((node) => {
    if (node.type.name === CITATION_NODE) citations.push(node.attrs as Record<string, unknown>);
    if (node.isText && node.text) words.push(node.text);
  });
  return { citations, text: words.join("\n") };
}

describe("inline quote tag parsing and rewriting", () => {
  it("rewrites confirmed inline tags, strips unconfirmed ones cleanly, handles colons/brackets/tables, and leaves code and minted tokens untouched", () => {
    const input = [
      "Revenue rose [cite:p-1: Section 4.1: 06:00 [winter]] [cite:p-1: wrong quote].",
      "[cite:p-1: wrong quote] Leading unconfirmed stripped.",
      "华东增长[cite:p-2: 未找到的引文]。",
      "| Metric | £4.2m [cite:p-1: Revenue was £4.2m] | £3.1m [cite:p-1: wrong quote] |",
      "Keep existing [cite:k3x9a2b7] untouched.",
      "Pipe fallback [cite:p-1|Revenue was £4.2m].",
      "Sentence handle [cite:k3x9a.2] and unknown [cite:k3x9a.99].",
      "Inline `[cite:p-1: Revenue was £4.2m]` and `[cite:k3x9a.2]` stay literal.",
      "```markdown",
      "Fenced [cite:p-1: Revenue was £4.2m] and [cite:k3x9a.2] stay literal.",
      "```",
    ].join("\n");

    const tags = findInlineQuoteTags([input]);
    expect(
      tags.map((each) =>
        each.kind === "sentence"
          ? `sentence:${each.handle}.${each.index}`
          : `${each.ref} => ${each.quote}`,
      ),
    ).toEqual([
      "p-1 => Section 4.1: 06:00 [winter]",
      "p-1 => wrong quote",
      "p-1 => wrong quote",
      "p-2 => 未找到的引文",
      "p-1 => Revenue was £4.2m",
      "p-1 => wrong quote",
      "p-1 => Revenue was £4.2m",
      "sentence:k3x9a.2",
      "sentence:k3x9a.99",
    ]);

    const [rewritten] = rewriteInlineQuoteTags([input], (tag) => {
      if (tag.kind === "sentence") {
        return tag.handle === "k3x9a" && tag.index === 2 ? "[cite:sent2345]" : null;
      }
      return tag.quote === "Section 4.1: 06:00 [winter]"
        ? "[cite:abcd2345]"
        : tag.quote === "Revenue was £4.2m"
          ? "[cite:efgh6789]"
          : null;
    });
    expect(rewritten).toBe(
      [
        "Revenue rose [cite:abcd2345].",
        "Leading unconfirmed stripped.",
        "华东增长。",
        "| Metric | £4.2m [cite:efgh6789] | £3.1m |",
        "Keep existing [cite:k3x9a2b7] untouched.",
        "Pipe fallback [cite:efgh6789].",
        "Sentence handle [cite:sent2345] and unknown.",
        "Inline `[cite:p-1: Revenue was £4.2m]` and `[cite:k3x9a.2]` stay literal.",
        "```markdown",
        "Fenced [cite:p-1: Revenue was £4.2m] and [cite:k3x9a.2] stay literal.",
        "```",
      ].join("\n"),
    );
  });
});

describe("writing Notes with inline citations in one call (#3753)", () => {
  beforeAll(async () => {
    await buildAgentShim();
  }, 60_000);

  async function setup(options?: { language?: "en" | "zh-CN"; extraUnshared?: boolean }) {
    const kept = await createTempDataFolder();
    const { core } = await startAgentsCore(replyingModel(), {
      canvasFiles: createCanvasFiles(join(kept, "Canvases")),
    });
    if (options?.language) await core.updateSettings({ user: { language: options.language } });
    const coast = await core.createLibraryGroup({ name: "Coast", description: "Tides & budget." });
    const source = await createSourceFolder();
    const [tides, budget] = await addAndProcess(core, [
      await writeSourceFile(source, "Tides.md", TIDES),
      await writeSourceFile(source, "Budget.md", BUDGET),
    ]);
    if (!tides || !budget) throw new Error("Documents weren't added.");
    await core.assignDocumentGroup(tides.id, coast.id);
    await core.assignDocumentGroup(budget.id, coast.id);

    let secretPassageId = "";
    let privateFolderId = "";
    if (options?.extraUnshared) {
      const hidden = await core.createLibraryGroup({ name: "Private", description: "Unshared." });
      privateFolderId = hidden.id;
      const [secretDoc] = await addAndProcess(core, [
        await writeSourceFile(source, "Secret.md", "# Secret\n\nHidden harbour fee is £999.\n"),
      ]);
      if (!secretDoc) throw new Error("Secret wasn't added.");
      await core.assignDocumentGroup(secretDoc.id, hidden.id);
      await core.setAgentsEnabled(true);
      const admin = await connectLegacyAgent(
        (await core.connectAgent({ name: "Admin", folderIds: [ALL_SHARED_ID] })).launch,
      );
      const foundSecret = structured<{ passages: { passageId: string }[] }>(
        await admin.callTool({ name: "search", arguments: { query: "Hidden harbour fee" } }),
      );
      secretPassageId = foundSecret.passages[0]?.passageId ?? "";
      await admin.close();
    }

    await core.setAgentsEnabled(true);
    const { pairing, launch } = await core.connectAgent({
      name: "Claude Code",
      folderIds: [coast.id],
      propose: true,
    });
    const agent = await connectLegacyAgent(launch);
    const tidesSearch = structured<{ passages: { passageId: string; text: string }[] }>(
      await agent.callTool({ name: "search", arguments: { query: "Spring tides Neap tides" } }),
    );
    const budgetSearch = structured<{ passages: { passageId: string; text: string }[] }>(
      await agent.callTool({ name: "search", arguments: { query: "华东团队第三季度营收" } }),
    );
    return {
      core,
      coast,
      tides,
      budget,
      privateFolderId,
      pairing,
      agent,
      tidesPassageId: tidesSearch.passages[0]?.passageId ?? "",
      budgetPassageId: budgetSearch.passages[0]?.passageId ?? "",
      secretPassageId,
    };
  }

  // protects=propose_changes confirms inline citations (including colons, brackets, tables, and mixing with minted tokens) in one call without a separate cite call; fails_when=citations are missing, a separate cite call is required, or markers stay literal in the Note
  it("attaches confirmed inline citations in propose_changes in one call, including tables, colons/brackets, and mixing with minted tokens", async () => {
    const { core, coast, agent, pairing, tidesPassageId } = await setup();
    const mind = await core.createMind({ title: "Tide Brief", folderId: coast.id });
    const read = structured<{ version: string }>(
      await agent.callTool({ name: "read_mind", arguments: { mindId: mind.id, named: true } }),
    );

    const proposed = structured<ProposedOut>(
      await agent.callTool({
        name: "propose_changes",
        arguments: {
          mindId: mind.id,
          version: read.version,
          changes: [
            {
              paragraph: "¶0+",
              text: [
                `Spring tides arrive at new moon and full moon [cite:${tidesPassageId}: ${SPRING}], and harbour clocks run all day [cite:${tidesPassageId}: ${COLON_BRACKET}].`,
                "",
                "| Tide | Timing |",
                "| --- | --- |",
                `| Spring | Twice a month [cite:${tidesPassageId}: ${SPRING}] |`,
                `| Neap | Quarter moons [cite:${tidesPassageId}: ${NEAP}] |`,
              ].join("\n"),
            },
          ],
        },
      }),
    );

    expect(proposed.uncited).toEqual([]);
    expect(proposed.citations).toHaveLength(3);
    expect(proposed.citations.every((each) => each.check === "found" && !each.text)).toBe(true);
    expect(proposed.citations[0]?.cite).toMatch(/^\[cite:[a-z0-9]{8}\]$/);

    // Zero separate `cite` calls in the pairing's activity.
    const activities = await core.listAgentActivity(pairing.id);
    expect(activities.filter((each) => each.tool === "cite")).toHaveLength(0);

    // Proposals in the Note carry 4 real Citation nodes and zero literal [cite:…].
    const inspected = await inspectMind(core, mind.id);
    expect(inspected.citations).toHaveLength(4);
    expect(inspected.text).not.toMatch(/\[cite:/);
    expect(inspected.text).not.toContain("[quote not found]");

    // Existing minted token can be mixed with a new inline citation in `create_mind`.
    const mintedToken = proposed.citations[0]?.cite ?? "";
    const mixed = structured<CreatedOut>(
      await agent.callTool({
        name: "create_mind",
        arguments: {
          title: "Mixed Citations",
          markdown: `Spring tides come twice a month ${mintedToken}.\n\nNeap tides have the smallest range [cite:${tidesPassageId}: ${NEAP}].`,
        },
      }),
    );
    expect(mixed.uncited).toEqual([]);
    expect(mixed.citations).toHaveLength(2);
    expect(mixed.citations.every((each) => each.check === "found")).toBe(true);
    const mixedInspected = await inspectMind(core, mixed.mindId);
    expect(mixedInspected.citations).toHaveLength(2);
    expect(mixedInspected.text).not.toMatch(/\[cite:/);
    await agent.close();
  });

  // protects=create_mind confirms Chinese inline citations in one call without a separate cite call; fails_when=Chinese quotes fail to attach or leave raw markers
  it("attaches Chinese inline citations in create_mind in one call", async () => {
    const { core, agent, pairing, budgetPassageId } = await setup();
    const created = structured<CreatedOut>(
      await agent.callTool({
        name: "create_mind",
        arguments: {
          title: "第三季度营收简报",
          markdown: `华东团队第三季度实现 420 万元营收，同比增长 18%[cite:${budgetPassageId}: ${EAST_ZH}]。\n\n华南团队营收为 310 万元，整体保持稳定[cite:${budgetPassageId}: ${SOUTH_ZH}]。`,
        },
      }),
    );

    expect(created.uncited).toEqual([]);
    expect(created.citations).toHaveLength(2);
    expect(created.citations.every((each) => each.check === "found" && !each.text)).toBe(true);
    const inspected = await inspectMind(core, created.mindId);
    expect(inspected.citations).toHaveLength(2);
    expect(inspected.text).not.toMatch(/\[cite:/);

    const activities = await core.listAgentActivity(pairing.id);
    expect(activities.filter((each) => each.tool === "cite")).toHaveLength(0);
    await agent.close();
  });

  // protects=unconfirmed quotes and unknown/out-of-scope Passages never attach a wrong Citation or leave stray text in the Note, and are reported in plain words; fails_when=[quote not found] or [cite:…] lands in the Note, or an out-of-scope Passage is leaked
  it("drops unconfirmed and out-of-scope inline citations with no stray text and plain-words reports", async () => {
    const { core, agent, tidesPassageId, secretPassageId } = await setup({ extraUnshared: true });

    const created = structured<CreatedOut>(
      await agent.callTool({
        name: "create_mind",
        arguments: {
          title: "Partial Verification",
          markdown: [
            `Spring tides arrive twice every month at new and full moon [cite:${tidesPassageId}: ${SPRING}].`,
            "",
            `High winds double the tide height every Tuesday [cite:${tidesPassageId}: High winds double the tide height every Tuesday.].`,
            "",
            `Harbour fees are fixed annually [cite:${secretPassageId}: Hidden harbour fee is £999.].`,
          ].join("\n"),
        },
      }),
    );

    // Only the confirmed quote attached; zero stray text or markers in the Note.
    const inspected = await inspectMind(core, created.mindId);
    expect(inspected.citations).toHaveLength(1);
    expect(inspected.citations[0]?.quote).toBe(SPRING);
    expect(inspected.text).not.toMatch(/\[cite:/);
    expect(inspected.text).not.toContain("[quote not found]");
    expect(inspected.text).not.toContain("  .");
    expect(inspected.text).toContain("High winds double the tide height every Tuesday.");
    expect(inspected.text).toContain("Harbour fees are fixed annually.");

    // Sentences whose inline citations were dropped surface in `uncited`.
    expect(created.uncited).toEqual([
      "High winds double the tide height every Tuesday.",
      "Harbour fees are fixed annually.",
    ]);

    // Confirmed quote returns minted token with no error text.
    const found = created.citations.find((each) => each.quote === SPRING);
    expect(found?.check).toBe("found");
    expect(found?.text).toBeUndefined();

    // Unconfirmed quote reports plain-words detail + Passage excerpt to copy from.
    const notFound = created.citations.find(
      (each) => each.quote === "High winds double the tide height every Tuesday.",
    );
    expect(notFound?.check).toBe("not-found");
    expect(notFound?.text).toContain("Not attached:");
    expect(notFound?.text).toContain(SPRING);

    // Out-of-scope Passage is never leaked and includes the `notShared` hint.
    const secret = created.citations.find((each) => each.quote === "Hidden harbour fee is £999.");
    expect(secret?.check).toBe("not-found");
    expect(secret?.document).toBeNull();
    expect(secret?.text).toContain("Not attached:");
    expect(secret?.text).toContain(translate("en", "agents.notShared"));
    expect(secret?.text).not.toContain("£999");
    await agent.close();
  });

  it("reports unconfirmed inline citations in Simplified Chinese when interface language is zh-CN", async () => {
    const { agent, budgetPassageId } = await setup({ language: "zh-CN" });
    const created = structured<CreatedOut>(
      await agent.callTool({
        name: "create_mind",
        arguments: {
          title: "核对测试",
          markdown: `华东团队全年营收突破一亿元[cite:${budgetPassageId}: 华东团队全年营收突破一亿元。]。`,
        },
      }),
    );
    const failed = created.citations.find((each) => each.check === "not-found");
    expect(failed?.text).toContain("未添加：");
    expect(failed?.text).toContain(EAST_ZH);
    await agent.close();
  });

  // protects=own working files are refused identically to cite; fails_when=an inline citation attaches a quote from an own working file
  it("refuses own working files identically to cite", async () => {
    const { core, agent, tides, tidesPassageId } = await setup();
    await core.setNotCited(tides.id, true);
    const working = await agent.callTool({
      name: "create_mind",
      arguments: {
        title: "Workings",
        markdown: `Spring tides happen twice a month [cite:${tidesPassageId}: ${SPRING}].`,
      },
    });
    expect(refusal(working)).toContain("working file");
    await agent.close();
  });

  // protects=inline citations support file paths outside a run grant and keep the legacy two-call `cite` path working unchanged; fails_when=file-path citations fail or legacy `cite` breaks
  it("supports file-path inline citations outside a grant and keeps legacy cite working", async () => {
    const { core, coast, agent, tidesPassageId } = await setup();
    const outside = await createSourceFolder();
    const extraPath = join(outside, "Harbour.md");
    const HARBOUR_QUOTE = "The outer lock closes at midnight in winter.";
    await writeSourceFile(outside, "Harbour.md", `# Harbour\n\n${HARBOUR_QUOTE}\n`);

    const created = structured<CreatedOut>(
      await agent.callTool({
        name: "create_mind",
        arguments: {
          title: "Harbour Operations",
          markdown: [
            `The outer lock closes at midnight during winter [cite:${extraPath}: ${HARBOUR_QUOTE}].`,
            "",
            `No night ferry operates on Sundays [cite:${extraPath}: No night ferry operates on Sundays.].`,
          ].join("\n"),
        },
      }),
    );

    const inspected = await inspectMind(core, created.mindId);
    expect(inspected.citations).toHaveLength(1);
    expect(inspected.citations[0]?.quote).toBe(HARBOUR_QUOTE);
    expect(inspected.text).not.toMatch(/\[cite:/);
    const failedFile = created.citations.find((each) => each.check === "not-found");
    expect(failedFile?.text).toContain("Not attached:");
    expect(failedFile?.text).not.toContain(HARBOUR_QUOTE);

    // Legacy two-call `cite` -> `propose_changes` stays unchanged.
    const existing = await core.createMind({ title: "Legacy Note", folderId: coast.id });
    const client = await connectToMind(core, existing.id);
    writeMind(client, [note("Old line.")]);
    await client.settled();

    const legacyCited = structured<{ citations: { cite: string | null; check: string }[] }>(
      await agent.callTool({
        name: "cite",
        arguments: { citations: [{ passageId: tidesPassageId, quote: SPRING }] },
      }),
    );
    const token = legacyCited.citations[0]?.cite ?? "";
    expect(token).toMatch(/^\[cite:[a-z0-9]{8}\]$/);
    const read = structured<{ version: string }>(
      await agent.callTool({ name: "read_mind", arguments: { mindId: existing.id, named: true } }),
    );
    const legacyProp = structured<ProposedOut>(
      await agent.callTool({
        name: "propose_changes",
        arguments: {
          mindId: existing.id,
          version: read.version,
          changes: [{ paragraph: "¶1+", text: `Spring tides happen twice a month ${token}.` }],
        },
      }),
    );
    expect(legacyProp.citations).toHaveLength(1);
    expect(legacyProp.citations[0]?.check).toBe("found");
    expect(legacyProp.citations[0]?.text).toBeUndefined();
    expect(legacyProp.uncited).toEqual([]);
    await agent.close();
  });

  // protects=sentence handles from search/read_passages(cited:true) stay stable across windows, isolate pairings, and format Transcript timedText; fails_when=windowed reads renumber handles or another pairing resolves them
  it("indexes Passage sentences stably across windows and isolates handles by pairing", () => {
    const registry = createPassageCiteRegistry();
    const full = [
      "First sentence of the passage.",
      "Second sentence has 42% growth.",
      "---",
      "第三句是中文陈述。",
    ].join("\n");
    const spans = sentenceSpansOf(full);
    expect(spans.map((each) => [each.index, each.text])).toEqual([
      [1, "First sentence of the passage."],
      [2, "Second sentence has 42% growth."],
      [3, "第三句是中文陈述。"],
    ]);

    const first = registry.indexPassage("pairing-a", "passage-1", "hash-1", full);
    const again = registry.indexPassage("pairing-a", "passage-1", "hash-1", full);
    expect(again.handle).toBe(first.handle);
    expect(first.handle).toMatch(/^[a-z2-9]{5}$/);

    // Window starting at the second sentence keeps its true full-passage index (.2 and .3).
    const suffixStart = full.indexOf("Second sentence");
    const suffix = formatCitedWindow(full, suffixStart, full.length, first);
    expect(suffix).toContain(`[cite:${first.handle}.2] Second sentence has 42% growth.`);
    expect(suffix).toContain(`[cite:${first.handle}.3] 第三句是中文陈述。`);
    expect(suffix).not.toContain(`[cite:${first.handle}.1]`);

    // A clipped mid-sentence fragment at the start of an excerpt gets no handle.
    const clipped = formatCitedWindow(full, 10, full.length, first, true);
    expect(clipped).toMatch(/^…/);
    expect(clipped).not.toContain(`[cite:${first.handle}.1]`);
    expect(clipped).toContain(`[cite:${first.handle}.2] Second sentence has 42% growth.`);

    // Transcript timedText prefixes lines matching each span while preserving [time speaker].
    const timed =
      "[0:00 Me] First sentence of the passage.\n[0:05 Them] Second sentence has 42% growth.";
    expect(formatCitedTimedText(timed, first)).toBe(
      `[cite:${first.handle}.1] [0:00 Me] First sentence of the passage.\n[cite:${first.handle}.2] [0:05 Them] Second sentence has 42% growth.`,
    );

    // Pairing isolation: another pairing cannot resolve pairing-a's handle.
    expect(registry.lookup("pairing-a", first.handle, 2)?.quote).toBe(
      "Second sentence has 42% growth.",
    );
    expect(registry.lookup("pairing-b", first.handle, 2)).toBeNull();
    expect(registry.lookup("pairing-a", first.handle, 99)).toBeNull();
  });

  // protects=search(cited:true) and read_passages(cited:true) let an agent write Notes and report checks in one call with zero cite calls, while enforcing pairing isolation, scope revocation, and working-file refusal (#3753); fails_when=sentence handles fail to attach real Citations, leak across pairings or unshared Folders, or tag working files
  it("cites Notes and checks in one call using cited:true sentence handles with strict scope and pairing isolation", async () => {
    const { core, coast, privateFolderId, tides, budget, pairing, agent } = await setup({
      extraUnshared: true,
    });

    // read_passages({ documentId, cited: true }) prefixes sentences with pairing-scoped handles.
    const readDoc = structured<{ passages: { passageId: string; text: string }[] }>(
      await agent.callTool({
        name: "read_passages",
        arguments: { documentId: tides.id, cited: true },
      }),
    );
    const tidesText = readDoc.passages.map((each) => each.text).join("\n");
    const springMatch = tidesText.match(/(\[cite:[a-z2-9]{5}\.\d+\]) Spring tides happen/);
    const neapMatch = tidesText.match(/(\[cite:[a-z2-9]{5}\.\d+\]) Neap tides come/);
    expect(springMatch?.[1]).toBeTruthy();
    expect(neapMatch?.[1]).toBeTruthy();
    const springHandle = springMatch?.[1] ?? "";
    const neapHandle = neapMatch?.[1] ?? "";

    // search({ query, cited: true }) also returns sentence handles (stable for the same Passage).
    const searchedZh = structured<{ passages: { passageId: string; text: string }[] }>(
      await agent.callTool({
        name: "search",
        arguments: { query: "华东团队", cited: true },
      }),
    );
    const zhText = searchedZh.passages.map((each) => each.text).join("\n");
    const eastMatch = zhText.match(/(\[cite:[a-z2-9]{5}\.\d+\]) 华东团队第三季度/);
    expect(eastMatch?.[1]).toBeTruthy();
    const eastHandle = eastMatch?.[1] ?? "";

    // Create a new Note in one call using sentence handles (plus one fabricated handle).
    const fakeHandle = "[cite:zzzzz.99]";
    const created = structured<CreatedOut>(
      await agent.callTool({
        name: "create_mind",
        arguments: {
          title: "One-Call Handles Note",
          markdown: [
            "# One-Call Handles Note",
            "",
            `Spring tides occur twice monthly ${springHandle}.`,
            "",
            `华东营收达到 420 万元 ${eastHandle}${fakeHandle}。`,
          ].join("\n"),
        },
      }),
    );
    expect(created.uncited).toEqual([]);
    const foundCites = created.citations.filter((each) => each.check === "found");
    expect(foundCites).toHaveLength(2);
    expect(created.citations.find((each) => each.cite === fakeHandle)?.check).toBe("unknown");

    const inspected = await inspectMind(core, created.mindId);
    expect(inspected.citations).toHaveLength(2);
    expect(inspected.citations.map((each) => each.quote)).toEqual([SPRING, EAST_ZH]);
    expect(inspected.text).not.toMatch(/\[cite:/);

    // Every persisted Citation passes real core.recheckCitation.
    for (const c of inspected.citations) {
      const rechecked = await core.recheckCitation({
        mindId: created.mindId,
        documentId: String(c.documentId),
        quote: String(c.quote),
        pageFrom: typeof c.pageFrom === "number" ? c.pageFrom : null,
        pageTo: typeof c.pageTo === "number" ? c.pageTo : null,
        location: (c.location ?? null) as never,
      });
      expect("check" in rechecked ? rechecked.check : null).toBe("found");
    }

    // propose_changes also resolves sentence handles in one call.
    const readNote = structured<{ version: string }>(
      await agent.callTool({
        name: "read_mind",
        arguments: { mindId: created.mindId, named: true },
      }),
    );
    const proposed = structured<ProposedOut>(
      await agent.callTool({
        name: "propose_changes",
        arguments: {
          mindId: created.mindId,
          version: readNote.version,
          changes: [
            { paragraph: "¶2+", text: `Neap tides arrive at moon quarters ${neapHandle}.` },
          ],
        },
      }),
    );
    expect(proposed.status).toBe("applied");
    expect(proposed.citations.some((each) => each.check === "found" && each.quote === NEAP)).toBe(
      true,
    );

    // report_check accepts sentence handles directly (seamless check-as-it-lands follow-up).
    const toCheck = structured<{ task: string; sentences: { n: number; text: string }[] }>(
      await agent.callTool({
        name: "check_mind_yourself",
        arguments: { mindId: created.mindId },
      }),
    );
    const springSentence = toCheck.sentences.find((each) => each.text.includes("Spring tides"));
    expect(springSentence).toBeTruthy();
    const reported = structured<{ marked: number; unconfirmed: number[] }>(
      await agent.callTool({
        name: "report_check",
        arguments: {
          mindId: created.mindId,
          task: toCheck.task,
          results: [{ n: springSentence?.n ?? 1, verdict: "supported", cites: [springHandle] }],
        },
      }),
    );
    expect(reported.marked).toBe(1);
    expect(reported.unconfirmed).toEqual([]);

    // Pairing isolation: a second pairing cannot use the first pairing's sentence handle.
    const second = await core.connectAgent({
      name: "Second Agent",
      folderIds: [coast.id],
      propose: true,
    });
    const otherAgent = await connectLegacyAgent(second.launch);
    const stolen = structured<CreatedOut>(
      await otherAgent.callTool({
        name: "create_mind",
        arguments: {
          title: "Stolen Handle",
          markdown: `Spring tides occur twice monthly ${springHandle}.`,
        },
      }),
    );
    expect(stolen.citations.find((each) => each.cite === springHandle)?.check).toBe("unknown");
    expect((await inspectMind(core, stolen.mindId)).citations).toHaveLength(0);
    await otherAgent.close();

    // Moving a Document out of the agent's shared Folder revokes its earlier sentence handle with no leak.
    await core.assignDocumentGroup(budget.id, privateFolderId);
    const revoked = structured<CreatedOut>(
      await agent.callTool({
        name: "create_mind",
        arguments: {
          title: "Revoked Handle",
          markdown: `华东营收达到 420 万元 ${eastHandle}。`,
        },
      }),
    );
    const revokedOut = revoked.citations.find((each) => each.cite === eastHandle);
    expect(revokedOut?.check).toBe("not-found");
    expect(revokedOut?.document).toBeNull();
    expect(revokedOut?.quote).toBeNull();
    expect(revokedOut?.text).toContain(translate("en", "agents.notShared"));
    expect(revokedOut?.text).not.toContain("420");
    expect((await inspectMind(core, revoked.mindId)).citations).toHaveLength(0);

    // Own working files never get sentence handles from read_passages(cited:true).
    await core.setNotCited(tides.id, true);
    const workingRead = structured<{ passages: { text: string }[] }>(
      await agent.callTool({
        name: "read_passages",
        arguments: { documentId: tides.id, cited: true },
      }),
    );
    expect(workingRead.passages.map((each) => each.text).join("\n")).not.toMatch(/\[cite:/);

    // Zero `cite` calls were needed across the entire one-call test.
    const activity = await core.listAgentActivity(pairing.id);
    expect(activity.filter((each) => each.tool === "cite")).toHaveLength(0);

    await agent.close();
  });
});
