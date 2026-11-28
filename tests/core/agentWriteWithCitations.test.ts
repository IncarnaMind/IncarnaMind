/**
 * Writing and checking with inline citations and sentence handles (#3753).
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { OwnAiRunner } from "../../src/core/adapters";
import { MAX_CITES, sentencesOf } from "../../src/core/agents/access";
import { findInlineQuoteTags, rewriteInlineQuoteTags } from "../../src/core/agents/inlineCitations";
import {
  createPassageCiteRegistry,
  formatCitedTimedText,
  formatCitedWindow,
  sentenceSpansOf,
} from "../../src/core/agents/passageCites";
import {
  ALL_SHARED_ID,
  CITATION_NODE,
  type CitationLocation,
  type NoteTurnEvent,
} from "../../src/core/api";
import { createCanvasFiles } from "../../src/main/canvasFiles";
import { translate } from "../../src/shared/i18n";
import {
  buildAgentShim,
  connectLegacyAgent,
  startAgentsCore,
  startMeetingAgentsCore,
} from "../helpers/agents";
import { createTempDataFolder } from "../helpers/core";
import {
  addAndProcess,
  createSourceFolder,
  linkAndProcess,
  waitForDocuments,
  writeSourceFile,
} from "../helpers/documents";
import { handOver, started as startedHanded } from "../helpers/handedFiles";
import { connectToMind } from "../helpers/mindClient";
import { note, readMind, writeMind } from "../helpers/minds";
import { replyingModel } from "../helpers/models";
import { para, pptxOf, sp, txBody, xfrm } from "../helpers/pptx";

const TIDES = [
  "# Tides",
  "",
  "Spring tides happen twice a month, at new moon and full moon. Their range is the largest of the month.",
  "",
  "Neap tides come at the first and third quarters of the moon. Their range is the smallest of the month.",
  "",
  "Section 4.1: Harbour clocks run from 06:00 to 22:00 [winter schedule].",
  "",
  "Step 1] open the outer gate before sunrise.",
].join("\n");

const SPRING = "Spring tides happen twice a month, at new moon and full moon.";
const SPRING_RANGE = "Their range is the largest of the month.";
const NEAP = "Neap tides come at the first and third quarters of the moon.";
const COLON_BRACKET = "Section 4.1: Harbour clocks run from 06:00 to 22:00 [winter schedule].";
const RIGHT_BRACKET = "Step 1] open the outer gate before sunrise.";

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

function isCitationLocation(value: unknown): value is CitationLocation {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    typeof (value as { kind: unknown }).kind === "string"
  );
}

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
  it("parses and rewrites handles, lists/ranges, full-width separators, unbalanced brackets, malformed and unclosed tags", () => {
    const input = [
      "Revenue rose [cite:p-1: Section 4.1: 06:00 [winter]] [cite:p-1: wrong quote].",
      "[cite:p-1: wrong quote] Leading unconfirmed stripped.",
      "华东增长[cite:p-2：未找到的引文]。",
      "| Metric | £4.2m [cite:p-1｜Revenue was £4.2m] | £3.1m [cite:p-1: wrong quote] |",
      "Keep existing [cite:k3x9a2b7] untouched.",
      "Pipe fallback [cite:p-1|Revenue was £4.2m].",
      "Sentence handle [cite:k3x9a2.2] and range [cite:k3x9a2.2-3] and list [cite:k3x9a2.2, k3x9a2.3].",
      "Bad tags [cite:k3x9a2.0] and [cite:abcde] and [cite:p-1: broken [bracket [cite:k3x9a2.2].",
      "Right bracket [cite:p-1: Step 1] open gate].",
      "Inline `[cite:p-1: Revenue was £4.2m]` and `[cite:k3x9a2.2]` stay literal.",
      "Escaped \\[cite:k3x9a2.99] stays literal.",
      "Hard break stays  [cite:p-1: wrong quote]",
      "next line [cite:p-1: unclosed quote",
      "```markdown",
      "Fenced [cite:p-1: Revenue was £4.2m] and [cite:k3x9a2.2] stay literal.",
      "```",
    ].join("\n");

    const tags = findInlineQuoteTags([input]);
    expect(
      tags.map((each) => {
        if (each.kind === "sentence") return `sentence:${each.handle}.${each.index}`;
        if (each.kind === "sentence-list") {
          return `list:${each.refs.map((r) => `${r.handle}.${r.index}`).join(",")}`;
        }
        if (each.kind === "malformed") return `malformed:${each.raw}`;
        return `${each.ref} => ${each.quote}`;
      }),
    ).toEqual([
      "p-1 => Section 4.1: 06:00 [winter]",
      "p-1 => wrong quote",
      "p-1 => wrong quote",
      "p-2 => 未找到的引文",
      "p-1 => Revenue was £4.2m",
      "p-1 => wrong quote",
      "p-1 => Revenue was £4.2m",
      "sentence:k3x9a2.2",
      "list:k3x9a2.2,k3x9a2.3",
      "list:k3x9a2.2,k3x9a2.3",
      "malformed:[cite:k3x9a2.0]",
      "malformed:[cite:abcde]",
      "malformed:[cite:p-1: broken [bracket",
      "sentence:k3x9a2.2",
      "p-1 => Step 1] open gate",
      "p-1 => wrong quote",
      "malformed:[cite:p-1: unclosed quote",
    ]);

    const [rewritten] = rewriteInlineQuoteTags([input], (tag) => {
      if (tag.kind === "sentence") {
        return tag.handle === "k3x9a2" && tag.index === 2 ? "[cite:sent2345]" : null;
      }
      if (tag.kind === "sentence-list") return "[cite:sent2345] [cite:sent6789]";
      if (tag.kind === "malformed") return null;
      if (tag.quote === "Section 4.1: 06:00 [winter]") return "[cite:abcd2345]";
      if (tag.quote === "Revenue was £4.2m") return "[cite:efgh6789]";
      if (tag.quote === "Step 1] open gate") return "[cite:brkt2345]";
      return null;
    });
    expect(rewritten).toBe(
      [
        "Revenue rose [cite:abcd2345].",
        "Leading unconfirmed stripped.",
        "华东增长。",
        "| Metric | £4.2m [cite:efgh6789] | £3.1m |",
        "Keep existing [cite:k3x9a2b7] untouched.",
        "Pipe fallback [cite:efgh6789].",
        "Sentence handle [cite:sent2345] and range [cite:sent2345] [cite:sent6789] and list [cite:sent2345] [cite:sent6789].",
        "Bad tags and and [cite:sent2345].",
        "Right bracket [cite:brkt2345].",
        "Inline `[cite:p-1: Revenue was £4.2m]` and `[cite:k3x9a2.2]` stay literal.",
        "Escaped \\[cite:k3x9a2.99] stays literal.",
        "Hard break stays  ",
        "next line",
        "```markdown",
        "Fenced [cite:p-1: Revenue was £4.2m] and [cite:k3x9a2.2] stay literal.",
        "```",
      ].join("\n"),
    );

    const crlf = "```text\r\n[cite:k3x9a2.2]\r\n```\r\nAfter fence [cite:k3x9a2.2].";
    expect(rewriteInlineQuoteTags([crlf], () => "[cite:crlf2345]")[0]).toBe(
      "```text\r\n[cite:k3x9a2.2]\r\n```\r\nAfter fence [cite:crlf2345].",
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

    const activities = await core.listAgentActivity(pairing.id);
    expect(activities.filter((each) => each.tool === "cite")).toHaveLength(0);

    const inspected = await inspectMind(core, mind.id);
    expect(inspected.citations).toHaveLength(4);
    expect(inspected.text).not.toMatch(/\[cite:/);
    expect(inspected.text).not.toContain("[quote not found]");

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

  // protects=create_mind confirms Chinese inline citations (including full-width ： and ｜ separators) in one call; fails_when=Chinese quotes or full-width separators fail to attach or leave raw markers
  it("attaches Chinese inline citations with ASCII and full-width separators in create_mind", async () => {
    const { core, agent, pairing, budgetPassageId } = await setup();
    const created = structured<CreatedOut>(
      await agent.callTool({
        name: "create_mind",
        arguments: {
          title: "第三季度营收简报",
          markdown: `华东团队第三季度实现 420 万元营收，同比增长 18%[cite:${budgetPassageId}：${EAST_ZH}]。\n\n华南团队营收为 310 万元，整体保持稳定[cite:${budgetPassageId}｜${SOUTH_ZH}]。`,
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

  // protects=every non-minted [cite:…] form (ranges, lists, bare handles, zero indices, unbalanced brackets, right brackets inside quotes, unclosed tags) is either resolved or stripped and reported with zero raw [cite:…] or [quote not found] text in the Note; fails_when=raw [cite:…], stray ], or [quote not found] lands in the Note or an unbalanced [ breaks later handles on the line
  it("resolves handle ranges/lists and strips malformed, bare-handle, bracketed, and unclosed tags through MCP", async () => {
    const { core, coast, agent, tides, tidesPassageId } = await setup();
    const readDoc = structured<{ passages: { text: string }[] }>(
      await agent.callTool({
        name: "read_passages",
        arguments: { documentId: tides.id, cited: true },
      }),
    );
    const tidesText = readDoc.passages.map((each) => each.text).join("\n");
    const springMatch = tidesText.match(/\[cite:([a-z2-9]{6})\.(\d+)\] Spring tides happen/);
    const rangeMatch = tidesText.match(/\[cite:([a-z2-9]{6})\.(\d+)\] Their range is the largest/);
    const neapMatch = tidesText.match(/\[cite:([a-z2-9]{6})\.(\d+)\] Neap tides come/);
    expect(springMatch?.[1]).toBeTruthy();
    expect(rangeMatch?.[1]).toBe(springMatch?.[1]);
    expect(neapMatch?.[1]).toBe(springMatch?.[1]);
    const h = springMatch?.[1] ?? "";
    const n1 = Number(springMatch?.[2]);
    const n2 = Number(rangeMatch?.[2]);
    const n3 = Number(neapMatch?.[2]);

    const created = structured<CreatedOut>(
      await agent.callTool({
        name: "create_mind",
        arguments: {
          title: "Edge Forms",
          markdown: [
            `Range covers both spring facts [cite:${h}.${n1}-${n2}].`,
            "",
            `List covers spring and neap [cite:${h}.${n1}, ${h}.${n3}].`,
            "",
            `Quote with right bracket attaches cleanly [cite:${tidesPassageId}: ${RIGHT_BRACKET}].`,
            "",
            `Unbalanced open bracket does not break the later handle [cite:${tidesPassageId}: broken [bracket [cite:${h}.${n1}].`,
            "",
            `Zero index and bare handles strip cleanly [cite:${h}.0] [cite:${h}] [cite:abcde].`,
            "",
            `Unclosed tag at end of line strips cleanly [cite:${tidesPassageId}: unclosed quote`,
          ].join("\n"),
        },
      }),
    );

    const inspected = await inspectMind(core, created.mindId);
    expect(inspected.text).not.toMatch(/\[cite:/);
    expect(inspected.text).not.toContain("[quote not found]");
    expect(inspected.text).not.toContain("open the outer gate before sunrise].");
    expect(inspected.citations.map((each) => each.quote)).toEqual([
      SPRING,
      SPRING_RANGE,
      SPRING,
      NEAP,
      RIGHT_BRACKET,
      SPRING,
    ]);

    const malformedReports = created.citations.filter(
      (each) => each.text === translate("en", "agents.propose.citationMalformed"),
    );
    expect(malformedReports.map((each) => each.cite)).toEqual(
      expect.arrayContaining([
        `[cite:${tidesPassageId}: broken [bracket`,
        `[cite:${h}.0]`,
        `[cite:${h}]`,
        "[cite:abcde]",
        `[cite:${tidesPassageId}: unclosed quote`,
      ]),
    );
    expect(created.uncited).toEqual([
      "Zero index and bare handles strip cleanly.",
      "Unclosed tag at end of line strips cleanly",
    ]);

    const existing = await core.createMind({ title: "Uncited After Strip", folderId: coast.id });
    const readMindOut = structured<{ version: string }>(
      await agent.callTool({
        name: "read_mind",
        arguments: { mindId: existing.id, named: true },
      }),
    );
    const proposed = structured<ProposedOut>(
      await agent.callTool({
        name: "propose_changes",
        arguments: {
          mindId: existing.id,
          version: readMindOut.version,
          changes: [
            {
              paragraph: "¶0+",
              text: "Harbour boats double in winter [cite:zzzzzz.99].",
            },
          ],
        },
      }),
    );
    expect(proposed.uncited).toEqual(["Harbour boats double in winter."]);
    const propInspected = await inspectMind(core, existing.id);
    expect(propInspected.citations).toHaveLength(0);
    expect(propInspected.text).not.toMatch(/\[cite:/);
    await agent.close();
  });

  // protects=unconfirmed quotes and out-of-scope Passages never attach a wrong Citation or leave stray text, and are reported in plain words; fails_when=[quote not found] or [cite:…] lands in the Note, or an out-of-scope Passage is leaked
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

    const inspected = await inspectMind(core, created.mindId);
    expect(inspected.citations).toHaveLength(1);
    expect(inspected.citations[0]?.quote).toBe(SPRING);
    expect(inspected.text).not.toMatch(/\[cite:/);
    expect(inspected.text).not.toContain("[quote not found]");
    expect(inspected.text).not.toContain("  .");
    expect(inspected.text).toContain("High winds double the tide height every Tuesday.");
    expect(inspected.text).toContain("Harbour fees are fixed annually.");
    expect(created.uncited).toEqual([
      "High winds double the tide height every Tuesday.",
      "Harbour fees are fixed annually.",
    ]);

    const found = created.citations.find((each) => each.quote === SPRING);
    expect(found?.check).toBe("found");
    expect(found?.text).toBeUndefined();

    const notFound = created.citations.find(
      (each) => each.quote === "High winds double the tide height every Tuesday.",
    );
    expect(notFound?.check).toBe("not-found");
    expect(notFound?.text).toContain("Not attached:");
    expect(notFound?.text).toContain(SPRING);

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

    const empty = await agent.callTool({
      name: "create_mind",
      arguments: {
        title: "空白笔记",
        markdown: "[cite:zzzzzz.99]",
      },
    });
    expect(refusal(empty)).toBe(translate("zh-CN", "agents.create.emptyText"));
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

  // protects=inline file-path citations work outside a run grant, cap at MAX_CITES with excess reported, and keep legacy cite unchanged; fails_when=file-path citations break, exceed MAX_CITES, or regress legacy cite
  it("supports file-path inline citations, caps them at MAX_CITES, and keeps legacy cite working", async () => {
    const { core, coast, agent, tidesPassageId } = await setup();
    const outside = await createSourceFolder();
    const extraPath = join(outside, "Harbour.md");
    const lines = Array.from(
      { length: MAX_CITES + 2 },
      (_, idx) => `Berth ${idx + 1} opens daily.`,
    );
    await writeSourceFile(outside, "Harbour.md", `# Harbour\n\n${lines.join("\n")}\n`);

    const created = structured<CreatedOut>(
      await agent.callTool({
        name: "create_mind",
        arguments: {
          title: "Harbour Operations",
          markdown: lines.map((line) => `${line} [cite:${extraPath}: ${line}]`).join("\n\n"),
        },
      }),
    );

    const inspected = await inspectMind(core, created.mindId);
    expect(inspected.citations).toHaveLength(MAX_CITES);
    expect(inspected.text).not.toMatch(/\[cite:/);
    const cappedReports = created.citations.filter(
      (each) =>
        each.text === translate("en", "agents.propose.citationTooManyFiles", { max: MAX_CITES }),
    );
    expect(cappedReports).toHaveLength(2);

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

  // protects=sentence handle registry bounds LRU per pairing, never reuses evicted handles, uses a per-run prefix, and shares sentence segmentation with sentencesOf; fails_when=one pairing evicts another, an evicted handle is reassigned, or a restarted run accepts an older handle
  it("bounds LRU per pairing, never reuses evicted handles, rejects earlier runs, and shares sentence segmentation", () => {
    const full = [
      "First sentence of the passage.",
      "Second sentence has 42% growth.",
      "---",
      "第三句是中文陈述。",
    ].join("\n");
    expect(sentencesOf(full)).toEqual([
      "First sentence of the passage.",
      "Second sentence has 42% growth.",
      "---",
      "第三句是中文陈述。",
    ]);
    const spans = sentenceSpansOf(full, { maxChars: 1_000, requireWord: true });
    expect(spans.map((each) => [each.index, each.text])).toEqual([
      [1, "First sentence of the passage."],
      [2, "Second sentence has 42% growth."],
      [3, "第三句是中文陈述。"],
    ]);

    const registry = createPassageCiteRegistry({ maxPerPairing: 2, runPrefix: "ab" });
    const first = registry.indexPassage("pairing-a", "passage-1", "hash-1", full);
    const again = registry.indexPassage("pairing-a", "passage-1", "hash-1", full);
    expect(again.handle).toBe(first.handle);
    expect(first.handle).toMatch(/^ab[a-z2-9]{4}$/);

    const otherPairing = registry.indexPassage("pairing-b", "passage-9", "hash-9", full);
    const second = registry.indexPassage("pairing-a", "passage-2", "hash-2", full);
    const third = registry.indexPassage("pairing-a", "passage-3", "hash-3", full);
    expect(registry.lookup("pairing-a", first.handle, 1)).toBeNull();
    expect(registry.lookup("pairing-a", second.handle, 1)?.quote).toBe(
      "First sentence of the passage.",
    );
    expect(registry.lookup("pairing-a", third.handle, 1)?.quote).toBe(
      "First sentence of the passage.",
    );
    expect(registry.lookup("pairing-b", otherPairing.handle, 1)?.quote).toBe(
      "First sentence of the passage.",
    );

    const reindexed = registry.indexPassage("pairing-a", "passage-1", "hash-1", full);
    expect(reindexed.handle).not.toBe(first.handle);

    const restarted = createPassageCiteRegistry({ maxPerPairing: 2, runPrefix: "cd" });
    expect(restarted.lookup("pairing-a", third.handle, 1)).toBeNull();

    const suffixStart = full.indexOf("Second sentence");
    const suffix = formatCitedWindow(full, suffixStart, full.length, first);
    expect(suffix).toContain(`[cite:${first.handle}.2] Second sentence has 42% growth.`);
    expect(suffix).toContain(`[cite:${first.handle}.3] 第三句是中文陈述。`);
    expect(suffix).not.toContain(`[cite:${first.handle}.1]`);

    const clipped = formatCitedWindow(full, 10, full.length, first, true);
    expect(clipped).toMatch(/^…/);
    expect(clipped).not.toContain(`[cite:${first.handle}.1]`);
    expect(clipped).toContain(`[cite:${first.handle}.2] Second sentence has 42% growth.`);

    const timed =
      "[0:00 Me] First sentence of the passage. Second sentence has 42% growth.\n[0:05 Them] 第三句是中文陈述。";
    expect(formatCitedTimedText(timed, first)).toBe(
      `[cite:${first.handle}.1] [0:00 Me] First sentence of the passage. [cite:${first.handle}.2] Second sentence has 42% growth.\n[cite:${first.handle}.3] [0:05 Them] 第三句是中文陈述。`,
    );

    expect(registry.lookup("pairing-b", second.handle, 2)).toBeNull();
    expect(registry.lookup("pairing-a", second.handle, 99)).toBeNull();
  });

  // protects=search/read_passages(cited:true) handles attach real Citations in create_mind, propose_changes, report_check, check_citations, show_citation, and reject stolen, revoked, deleted, changed, and working-file handles; fails_when=stale/revoked/deleted handles attach, leak text, or misreport out-of-reach handles
  it("cites Notes, checks, and handles changed, deleted, revoked, and working-file Documents through MCP", async () => {
    const { core, coast, privateFolderId, tides, budget, pairing, agent } = await setup({
      extraUnshared: true,
    });

    const readDoc = structured<{ passages: { passageId: string; text: string }[] }>(
      await agent.callTool({
        name: "read_passages",
        arguments: { documentId: tides.id, cited: true },
      }),
    );
    const tidesText = readDoc.passages.map((each) => each.text).join("\n");
    const springHandle =
      tidesText.match(/(\[cite:[a-z2-9]{6}\.\d+\]) Spring tides happen/)?.[1] ?? "";
    const neapHandle = tidesText.match(/(\[cite:[a-z2-9]{6}\.\d+\]) Neap tides come/)?.[1] ?? "";
    expect(springHandle).toBeTruthy();
    expect(neapHandle).toBeTruthy();

    const searchedZh = structured<{ passages: { passageId: string; text: string }[] }>(
      await agent.callTool({
        name: "search",
        arguments: { query: "华东团队", cited: true },
      }),
    );
    const eastHandle =
      searchedZh.passages
        .map((each) => each.text)
        .join("\n")
        .match(/(\[cite:[a-z2-9]{6}\.\d+\]) 华东团队第三季度/)?.[1] ?? "";
    expect(eastHandle).toBeTruthy();

    const fakeHandle = "[cite:zzzzzz.99]";
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
    expect(created.citations.filter((each) => each.check === "found")).toHaveLength(2);
    const fakeReport = created.citations.find((each) => each.cite === fakeHandle);
    expect(fakeReport?.check).toBe("unknown");
    expect(fakeReport?.text).toBe(translate("en", "agents.propose.citationUnknownHandle"));

    const inspected = await inspectMind(core, created.mindId);
    expect(inspected.citations).toHaveLength(2);
    expect(inspected.citations.map((each) => each.quote)).toEqual([SPRING, EAST_ZH]);
    expect(inspected.text).not.toMatch(/\[cite:/);

    for (const c of inspected.citations) {
      const rechecked = await core.recheckCitation({
        mindId: created.mindId,
        documentId: String(c.documentId),
        quote: String(c.quote),
        pageFrom: typeof c.pageFrom === "number" ? c.pageFrom : null,
        pageTo: typeof c.pageTo === "number" ? c.pageTo : null,
        location: isCitationLocation(c.location) ? c.location : null,
      });
      expect("check" in rechecked ? rechecked.check : null).toBe("found");
    }

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

    const toCheck = structured<{ task: string; sentences: { n: number; text: string }[] }>(
      await agent.callTool({
        name: "check_mind_yourself",
        arguments: { mindId: created.mindId },
      }),
    );
    const springSentence = toCheck.sentences.find((each) => each.text.includes("Spring tides"));
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

    const checkedDraft = structured<{ citations: CitationOut[]; uncited: string[] }>(
      await agent.callTool({
        name: "check_citations",
        arguments: {
          text: `Spring tides occur twice a month ${springHandle}.\n\nHarbour boats double every winter ${fakeHandle}.`,
        },
      }),
    );
    expect(checkedDraft.citations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ cite: springHandle, check: "found", quote: SPRING }),
        expect.objectContaining({ cite: fakeHandle, check: "unknown" }),
      ]),
    );
    expect(checkedDraft.uncited).toEqual(["Harbour boats double every winter."]);

    const shown = structured<{ shown: boolean; document: string }>(
      await agent.callTool({ name: "show_citation", arguments: { cite: springHandle } }),
    );
    expect(shown.shown).toBe(true);
    expect(shown.document).toBe("Tides");

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
    expect(revokedOut?.text).toContain(translate("en", "agents.propose.citationHandleOutOfReach"));
    expect(revokedOut?.text).toContain(translate("en", "agents.notShared"));
    expect(revokedOut?.text).not.toContain("420");
    expect((await inspectMind(core, revoked.mindId)).citations).toHaveLength(0);

    const fenced = structured<CreatedOut>(
      await agent.callTool({
        name: "create_mind",
        arguments: {
          title: "Fenced Example",
          markdown: `\`\`\`text\r\n${springHandle}\r\n\`\`\`\r\nSpring tides come twice a month ${springHandle}.`,
        },
      }),
    );
    expect(fenced.citations.some((each) => each.check === "found" && each.quote === SPRING)).toBe(
      true,
    );
    const fencedInspected = await inspectMind(core, fenced.mindId);
    expect(fencedInspected.citations).toHaveLength(1);
    expect(fencedInspected.text).toContain(springHandle);

    await core.setNotCited(tides.id, true);
    const workingRead = structured<{ passages: { text: string }[] }>(
      await agent.callTool({
        name: "read_passages",
        arguments: { documentId: tides.id, cited: true },
      }),
    );
    expect(workingRead.passages.map((each) => each.text).join("\n")).not.toMatch(/\[cite:/);
    await core.setNotCited(tides.id, false);

    await core.deleteDocument(tides.id);
    const afterDelete = structured<CreatedOut>(
      await agent.callTool({
        name: "create_mind",
        arguments: {
          title: "Deleted Source",
          markdown: `Spring tides occur twice a month ${springHandle}.`,
        },
      }),
    );
    const deletedOut = afterDelete.citations.find((each) => each.cite === springHandle);
    expect(deletedOut?.check).toBe("not-found");
    expect(deletedOut?.text).toContain(translate("en", "agents.propose.citationHandleOutOfReach"));
    expect((await inspectMind(core, afterDelete.mindId)).citations).toHaveLength(0);

    const activity = await core.listAgentActivity(pairing.id);
    expect(activity.filter((each) => each.tool === "cite")).toHaveLength(0);
    await agent.close();
  });

  // protects=a handle issued before a Document changes on disk never attaches the outdated quote; fails_when=a stale handle attaches after the Document text changes
  it("rejects a sentence handle when the Document changes between search and write", async () => {
    const kept = await createTempDataFolder();
    const { core } = await startAgentsCore(replyingModel(), {
      canvasFiles: createCanvasFiles(join(kept, "Canvases")),
    });
    const folder = await createSourceFolder();
    const filePath = await writeSourceFile(
      folder,
      "Harbour.md",
      "# Harbour\n\nNorth pier holds 14 boats every summer.\n",
    );
    const [doc] = await linkAndProcess(core, folder);
    if (!doc) throw new Error("Linked Document wasn't added.");
    await core.setAgentsEnabled(true);
    const { launch } = await core.connectAgent({
      name: "Claude Code",
      folderIds: [ALL_SHARED_ID],
      propose: true,
    });
    const agent = await connectLegacyAgent(launch);
    const found = structured<{ passages: { text: string }[] }>(
      await agent.callTool({
        name: "search",
        arguments: { query: "North pier holds 14 boats", cited: true },
      }),
    );
    const handle =
      found.passages
        .map((each) => each.text)
        .join("\n")
        .match(/(\[cite:[a-z2-9]{6}\.\d+\]) North pier holds 14 boats/)?.[1] ?? "";
    expect(handle).toBeTruthy();

    await writeFile(filePath, "# Harbour\n\nNorth pier holds 28 boats every summer.\n", "utf8");
    await core.reconcileDocuments();
    await waitForDocuments(core, (docs) => {
      const updated = docs.find((each) => each.id === doc.id);
      expect(updated?.status).toBe("ready");
      expect(updated?.contentHash).not.toBe(doc.contentHash);
    });

    const created = structured<CreatedOut>(
      await agent.callTool({
        name: "create_mind",
        arguments: {
          title: "After Change",
          markdown: `North pier holds 14 boats every summer ${handle}.`,
        },
      }),
    );
    expect(created.citations.find((each) => each.cite === handle)?.check).toBe("not-found");
    const inspected = await inspectMind(core, created.mindId);
    expect(inspected.citations).toHaveLength(0);
    expect(inspected.text).not.toMatch(/\[cite:/);
    await agent.close();
  });

  // protects=sentence handles resolve cleanly in propose_deck_changes, save_as_word, and conversation reply chips instead of landing raw or disappearing; fails_when=deck text keeps raw [cite:…], Word drops citations, or reply turns omit the citation chip
  it("resolves sentence handles across propose_deck_changes, save_as_word, and chat-reply citations", async () => {
    const { core, coast, writer, files, added } = await startedHanded();
    const survey = added[0];
    if (!survey) throw new Error("Survey wasn't added.");
    const agent = await connectLegacyAgent(writer.launch);
    const readSurvey = structured<{ passages: { text: string }[] }>(
      await agent.callTool({
        name: "read_passages",
        arguments: { documentId: survey.id, cited: true },
      }),
    );
    const handle =
      readSurvey.passages
        .map((each) => each.text)
        .join("\n")
        .match(/(\[cite:[a-z2-9]{6}\.\d+\]) The north quay holds 42 boats/)?.[1] ?? "";
    expect(handle).toBeTruthy();

    const deckPath = join(files, "Harbour.pptx");
    const slideXml = sp({
      id: 2,
      name: "Summary Box",
      spPr: xfrm(457_200, 914_400, 5_000_000, 914_400),
      body: txBody(para("South quay holds 17 boats.")),
    });
    await writeFile(
      deckPath,
      new Uint8Array(
        pptxOf({
          slides: [{ shapes: slideXml }],
        }),
      ),
    );
    const handed = structured<{ fileId: string }>(
      await handOver(agent, { path: deckPath, folderId: coast.id }),
    );
    const readDeck = structured<{ version: string }>(
      await agent.callTool({ name: "read_deck", arguments: { documentId: handed.fileId } }),
    );
    const deckProp = structured<{
      proposalId: string;
      status: string;
      unfoundCitations?: string[];
    }>(
      await agent.callTool({
        name: "propose_deck_changes",
        arguments: {
          documentId: handed.fileId,
          version: readDeck.version,
          summary: "Update quay counts",
          changes: [
            {
              kind: "text",
              slide: 1,
              shape: "2",
              paragraphs: [`North quay holds 42 boats ${handle}.`],
            },
          ],
        },
      }),
    );
    expect(deckProp.status).toBe("waiting");
    expect(deckProp.unfoundCitations ?? []).toEqual([]);
    await core.acceptDeckProposal(deckProp.proposalId);
    const readAfterDeck = structured<{
      slides: {
        shapes: {
          shapeId: string;
          paragraphs?: string[];
          citations?: { quote: string }[];
        }[];
      }[];
    }>(await agent.callTool({ name: "read_deck", arguments: { documentId: handed.fileId } }));
    const updatedShape = readAfterDeck.slides[0]?.shapes.find((each) => each.shapeId === "2");
    expect(updatedShape?.paragraphs).toEqual(["North quay holds 42 boats."]);
    expect(updatedShape?.citations).toHaveLength(1);
    expect(updatedShape?.citations?.[0]?.quote).toContain("42 boats");

    const wordSaved = structured<{ citations: CitationOut[] }>(
      await agent.callTool({
        name: "save_as_word",
        arguments: {
          title: "Harbour Summary",
          folderId: coast.id,
          markdown: `North quay holds 42 boats ${handle}.`,
        },
      }),
    );
    expect(wordSaved.citations).toEqual([
      expect.objectContaining({ check: "found", quote: expect.stringContaining("42 boats") }),
    ]);
    await agent.close();

    let replyHandle = "";
    const ownRunner: OwnAiRunner = {
      installed: async () => true,
      status: async () => ({ kind: "ready" }),
      choosesModes: () => false,
      purge: async () => true,
      async run(request) {
        request.started?.();
        const conn = await connectLegacyAgent(request.server);
        const found = structured<{ passages: { text: string }[] }>(
          await conn.callTool({
            name: "search",
            arguments: { query: "Spring tides happen twice", cited: true },
          }),
        );
        replyHandle =
          found.passages
            .map((each) => each.text)
            .join("\n")
            .match(/(\[cite:[a-z2-9]{6}\.\d+\]) Spring tides happen/)?.[1] ?? "";
        await conn.close();
        return { kind: "finished", reply: `Spring tides occur twice a month ${replyHandle}.` };
      },
    };
    const kept = await createTempDataFolder();
    const { core: convCore } = await startAgentsCore(replyingModel(), {
      ownAi: ownRunner,
      canvasFiles: createCanvasFiles(join(kept, "Canvases")),
    });
    const folder = await convCore.createLibraryGroup({ name: "Coast", description: "" });
    const src = await createSourceFolder();
    const [doc] = await addAndProcess(convCore, [await writeSourceFile(src, "Tides.md", TIDES)]);
    if (!doc) throw new Error("Tides wasn't added.");
    await convCore.assignDocumentGroup(doc.id, folder.id);
    const mind = await convCore.createMind({ title: "Tides Q&A", folderId: folder.id });
    await convCore.setAgentsEnabled(true);
    await convCore.connectAgent({
      name: "Claude Code",
      client: "claude-code",
      folderIds: [folder.id],
      propose: true,
    });
    const events: NoteTurnEvent[] = [];
    convCore.on("agents.noteTurn", (event) => events.push(event));
    await convCore.askInNote({ mindId: mind.id, words: "When do spring tides happen?" });
    await expect
      .poll(() => events.some((event) => event.state !== "working"), { timeout: 5_000 })
      .toBe(true);
    const turns = await convCore.noteTurnsForMind(mind.id);
    expect(replyHandle).toBeTruthy();
    expect(turns[0]?.citations).toEqual([
      expect.objectContaining({
        token: replyHandle.slice("[cite:".length, -1),
        quote: SPRING,
      }),
    ]);
  });

  // protects=a recorded meeting Transcript read with cited:true tags every sentence in both text and timedText, and attaches verified Transcript Citations in one call; fails_when=timedText misses sentence handles or Transcript citations fail to attach
  it("reads a recorded meeting Transcript end to end with cited:true and cites it in one call", async () => {
    const { core, recordMeeting } = await startMeetingAgentsCore({
      mine: ["Move the North crossing to 07:10. Inform the pier master tonight."],
      theirs: ["The harbour can open the slipway fifteen minutes earlier."],
    });
    const coast = await core.createLibraryGroup({ name: "Coast", description: "" });
    const meeting = await recordMeeting(coast.id, "Harbour Scheduling Call");
    await core.setAgentsEnabled(true);
    const { pairing, launch } = await core.connectAgent({
      name: "Claude Code",
      folderIds: [coast.id],
      propose: true,
    });
    const agent = await connectLegacyAgent(launch);

    const readTranscript = structured<{
      passages: { text: string; timedText?: string }[];
    }>(
      await agent.callTool({
        name: "read_passages",
        arguments: { documentId: meeting.transcriptId, cited: true },
      }),
    );
    const timedAll = readTranscript.passages.map((each) => each.timedText ?? "").join("\n");
    const firstHandle =
      timedAll.match(/(\[cite:[a-z2-9]{6}\.\d+\]) \[[^\]]+\] Move the North crossing/)?.[1] ?? "";
    const secondHandle =
      timedAll.match(/(\[cite:[a-z2-9]{6}\.\d+\]) Inform the pier master tonight\./)?.[1] ?? "";
    const thirdHandle =
      timedAll.match(/(\[cite:[a-z2-9]{6}\.\d+\]) \[[^\]]+\] The harbour can open/)?.[1] ?? "";
    expect(firstHandle).toBeTruthy();
    expect(secondHandle).toBeTruthy();
    expect(thirdHandle).toBeTruthy();

    const created = structured<CreatedOut>(
      await agent.callTool({
        name: "create_mind",
        arguments: {
          title: "Harbour Call Notes",
          markdown: [
            `- Move the North crossing to 07:10 ${firstHandle} and inform the pier master tonight ${secondHandle}.`,
            `- The harbour can open the slipway fifteen minutes earlier ${thirdHandle}.`,
          ].join("\n"),
        },
      }),
    );
    expect(created.uncited).toEqual([]);
    expect(created.citations.filter((each) => each.check === "found")).toHaveLength(3);
    const inspected = await inspectMind(core, created.mindId);
    expect(inspected.citations).toHaveLength(3);
    expect(inspected.text).not.toMatch(/\[cite:/);

    const activity = await core.listAgentActivity(pairing.id);
    expect(activity.filter((each) => each.tool === "cite")).toHaveLength(0);
    await agent.close();
  });
});
