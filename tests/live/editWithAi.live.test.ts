/**
 * Edit with AI (#93) against real models: Improve writing and Translate on a
 * cited paragraph, in English and in Chinese, and on one with a footnote the
 * User wrote, through the core as the app uses it. Each model runs only when its key (or, for Ollama, its name) is in
 * the environment, and is skipped otherwise, so `npx vitest run` makes no
 * request without one. It checks that each reply comes back as Proposals,
 * never as an edit, and that the paragraph's Citation is still there, and
 * still found, once they are accepted, and its footnote with its text.
 *
 *   INCARNAMIND_LIVE_ANTHROPIC_KEY   Claude (INCARNAMIND_LIVE_ANTHROPIC_MODEL, Haiku by default)
 *   INCARNAMIND_LIVE_OPENAI_KEY      OpenAI (INCARNAMIND_LIVE_OPENAI_MODEL, its quick-tasks model by default)
 *   INCARNAMIND_LIVE_OLLAMA_MODEL    a model in Ollama on this computer, e.g. qwen3.5:4b, in local
 *                                    mode; or an Ollama cloud model (gpt-oss:20b-cloud), outside it
 *
 * Names of their own, so a key a shell has for other tools never starts paid requests here.
 *
 * A second test (#94) puts a change out of date by editing its words, and
 * has Regenerate make it again from them, then regenerates an Answer the
 * User edited, which comes back as changes over their version.
 *
 * A third (#202) shortens a whole note of four paragraphs and a heading, and
 * checks that its changes come in while the model still writes, paragraph by
 * paragraph, and that the model says why.
 *
 * Set INCARNAMIND_LIVE_REPORT to a file to keep what each model gave back.
 */
import { appendFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import {
  type ChatProviderKind,
  CITATION_NODE,
  type Core,
  type Document,
  type EditAction,
  FOOTNOTE_NODE,
  PROPOSAL_ATTRIBUTE,
  PROPOSAL_DELETE_MARK,
  PROPOSAL_INSERT_MARK,
} from "../../src/core";
import { catalogProvider } from "../../src/core/providers/catalog/providers";
import { createAiSdkChatModel } from "../../src/core/providers/models";
import { isCloudModelName } from "../../src/core/providers/ollamaCloud";
import { updateRequest } from "../../src/shared/citationUpdate";
import {
  outOfDateProposals,
  pendingProposals,
  proposalRequestOf,
  resolveProposals,
} from "../../src/shared/proposals";
import { createTempDataFolder, nextEvent, startCore } from "../helpers/core";
import { addAndProcess, writeSourceFile } from "../helpers/documents";
import { connectToMind, type MindClient } from "../helpers/mindClient";
import { answerText, question, readMind, writeMind } from "../helpers/minds";

const TIDES = {
  name: "Tides.md",
  contents: [
    "# Tides",
    "",
    "Spring tides happen at new moon and at full moon, when the Sun and the Moon pull together.",
  ].join("\n"),
};
const CHAOXI = {
  name: "潮汐.md",
  contents: "# 潮汐\n\n大潮出现在新月和满月前后，这时太阳和月亮的引力叠加在一起。",
};

interface Live {
  name: string;
  kind: ChatProviderKind;
  apiKey: string | undefined;
  model: string;
  local: boolean;
}

const LIVE: Live[] = [
  {
    name: "Anthropic",
    kind: "anthropic",
    apiKey: process.env.INCARNAMIND_LIVE_ANTHROPIC_KEY,
    model:
      process.env.INCARNAMIND_LIVE_ANTHROPIC_MODEL ??
      (catalogProvider("anthropic")?.roles.quickTasks as string),
    local: false,
  },
  {
    name: "OpenAI",
    kind: "openai",
    apiKey: process.env.INCARNAMIND_LIVE_OPENAI_KEY,
    model:
      process.env.INCARNAMIND_LIVE_OPENAI_MODEL ??
      (catalogProvider("openai")?.roles.quickTasks as string),
    local: false,
  },
  {
    name: "Ollama",
    kind: "ollama",
    apiKey: process.env.INCARNAMIND_LIVE_OLLAMA_MODEL ? "" : undefined,
    model: process.env.INCARNAMIND_LIVE_OLLAMA_MODEL ?? "",
    local: !isCloudModelName(process.env.INCARNAMIND_LIVE_OLLAMA_MODEL ?? ""),
  },
];

/**
 * The paragraph's text, Proposals shown as [-removed-] and {+added+}, a
 * Citation as ⟨its check⟩, a footnote as ^[its text].
 */
function shown(client: MindClient, blockId: string): string {
  let line = "";
  readMind(client).descendants((node) => {
    if (node.attrs.id !== blockId) return true;
    node.forEach((child) => {
      const kind = (child.attrs[PROPOSAL_ATTRIBUTE] as { kind?: string } | null)?.kind;
      const inline = child.isText
        ? (child.text ?? "")
        : child.type.name === FOOTNOTE_NODE
          ? `^[${child.textContent}]`
          : `⟨${String(child.attrs.check)}⟩`;
      const marks = child.marks.map((mark) => mark.type.name);
      if (marks.includes(PROPOSAL_DELETE_MARK) || kind === "delete") line += `[-${inline}-]`;
      else if (marks.includes(PROPOSAL_INSERT_MARK) || kind === "insert") line += `{+${inline}+}`;
      else line += inline;
    });
    return false;
  });
  return line.replace(/-\]\[-|\+\}\{\+/g, "");
}

function footnotesOf(client: MindClient, blockId: string): string[] {
  const found: string[] = [];
  readMind(client).descendants((node) => {
    if (node.attrs.id !== blockId) return true;
    node.forEach((child) => {
      if (child.type.name === FOOTNOTE_NODE) found.push(child.textContent);
    });
    return false;
  });
  return found;
}

function citationsOf(client: MindClient, blockId: string): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  readMind(client).descendants((node) => {
    if (node.attrs.id !== blockId) return true;
    node.descendants((child) => {
      if (child.type.name === CITATION_NODE) found.push(child.attrs);
    });
    return false;
  });
  return found;
}

const citationOf = (document: Document, quote: string) => ({
  type: CITATION_NODE,
  attrs: {
    passageId: "passage",
    documentId: document.id,
    documentName: document.name,
    contentHash: document.contentHash,
    quote,
    check: "found",
  },
});

async function edit(
  core: Core,
  client: MindClient,
  mindId: string,
  blockId: string,
  action: EditAction,
  instruction?: string,
) {
  let plain = "";
  readMind(client).descendants((node) => {
    if (node.attrs.id !== blockId) return true;
    // As the editor reads it: an inline node as one character, a footnote's text not at all.
    node.forEach((child) => {
      plain += child.isText ? (child.text ?? "") : "￼";
    });
    return false;
  });
  const started = Date.now();
  const result = await core.editWithAi({
    requestId: crypto.randomUUID(),
    mindId,
    from: { blockId, offset: 0 },
    to: { blockId, offset: plain.length },
    text: plain,
    action,
    ...(instruction && { instruction }),
  });
  await client.settled();
  return { result, seconds: (Date.now() - started) / 1000 };
}

describe.each(LIVE)("Edit with AI, live: $name", (live) => {
  test.skipIf(live.apiKey === undefined)(
    `${live.name}: Improve writing and Translate on cited paragraphs come back as changes, and their Citations survive`,
    { timeout: 600_000 },
    async () => {
      const dataDir = await createTempDataFolder();
      const sources = await createTempDataFolder();
      const core = startCore(dataDir, { createChatModel: createAiSdkChatModel });
      core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
      await core.saveChatProvider({
        kind: live.kind,
        ...(live.apiKey && { apiKey: live.apiKey }),
        modelId: live.model,
      });
      if (live.local) await core.setLocalOnly(true);
      const [tides, chaoxi] = await addAndProcess(core, [
        await writeSourceFile(sources, TIDES.name, TIDES.contents),
        await writeSourceFile(sources, CHAOXI.name, CHAOXI.contents),
      ]);
      const mind = await core.createMind({ title: "Tides" });
      const client = await connectToMind(core, mind.id);
      const english = "english";
      const chinese = "chinese";
      const footnoted = "footnoted";
      const cases: { blockId: string; action: EditAction; instruction?: string }[] = [
        { blockId: english, action: "improve" },
        { blockId: english, action: "translate", instruction: "Simplified Chinese (简体中文)" },
        { blockId: chinese, action: "improve" },
        { blockId: chinese, action: "translate", instruction: "English" },
        { blockId: footnoted, action: "improve" },
        { blockId: footnoted, action: "translate", instruction: "Simplified Chinese (简体中文)" },
      ];
      const report: string[] = [`## ${live.name} · ${live.model}`];
      for (const each of cases) {
        writeMind(client, [
          {
            type: "paragraph",
            attrs: { id: english },
            content: [
              {
                type: "text",
                text: "the spring tides they happens at a new moon and also when the moon is full ",
              },
              citationOf(tides as Document, "Spring tides happen at new moon and at full moon"),
              { type: "text", text: ", because sun and moon is pulling together." },
            ],
          },
          {
            type: "paragraph",
            attrs: { id: chinese },
            content: [
              { type: "text", text: "大潮一般是在新月和满月的前后出现的的，" },
              citationOf(chaoxi as Document, "大潮出现在新月和满月前后"),
              { type: "text", text: "因为太阳和月亮的引力它们叠加在一起。" },
            ],
          },
          {
            type: "paragraph",
            attrs: { id: footnoted },
            content: [
              {
                type: "text",
                text: "neap tides is weak because sun and moon pulls at right angle",
              },
              {
                type: FOOTNOTE_NODE,
                attrs: { id: "footnote" },
                content: [{ type: "text", text: "At the first and last quarter moons." }],
              },
              { type: "text", text: ", so the high water dont rise much." },
            ],
          },
        ]);
        await client.settled();
        const { result, seconds } = await edit(
          core,
          client,
          mind.id,
          each.blockId,
          each.action,
          each.instruction,
        );
        const proposed = shown(client, each.blockId);
        const made =
          result.kind === "proposed" ? proposalRequestOf(client.doc, result.request) : null;
        report.push(
          `- ${each.blockId} ${each.action}${each.instruction ? ` (${each.instruction})` : ""}: ${result.kind}${
            result.kind === "proposed"
              ? `, ${result.proposals} changes, ${result.droppedCitations} Citations dropped`
              : result.kind === "failed"
                ? `: ${result.error.kind}`
                : ""
          }, ${seconds.toFixed(1)} s\n  ${proposed}\n  why: ${made?.source === "edit-with-ai" ? (made.reason ?? "(none)") : "(none)"}`,
        );
        expect(result.kind, result.kind === "failed" ? result.error.kind : result.kind).toBe(
          "proposed",
        );
        // Nothing is applied before it is accepted: the text as it was is all there.
        expect(pendingProposals(client.blocks).length).toBeGreaterThan(0);
        client.doc.transact(() => {
          resolveProposals(client.blocks as Y.XmlFragment, () => true, "accept");
        }, "editor");
        await client.settled();
        const kept = citationsOf(client, each.blockId);
        report.push(`  accepted: ${shown(client, each.blockId)}`);
        if (each.blockId === footnoted) {
          expect(footnotesOf(client, footnoted)).toEqual(["At the first and last quarter moons."]);
        } else if (result.kind === "proposed" && result.droppedCitations === 0) {
          expect(kept).toHaveLength(1);
          expect(kept[0]?.check).toBe("found");
        }
      }
      if (process.env.INCARNAMIND_LIVE_REPORT) {
        await appendFile(process.env.INCARNAMIND_LIVE_REPORT, `${report.join("\n")}\n\n`);
      }
    },
  );
});

/** A core on the live model, with the Tides Document added and processed, and a Mind. */
async function liveCore(live: Live) {
  const dataDir = await createTempDataFolder();
  const sources = await createTempDataFolder();
  const core = startCore(dataDir, { createChatModel: createAiSdkChatModel });
  core.on("consent.requested", (asked) => void core.respondToConsent(asked.requestId, true));
  await core.saveChatProvider({
    kind: live.kind,
    ...(live.apiKey && { apiKey: live.apiKey }),
    modelId: live.model,
  });
  if (live.local) await core.setLocalOnly(true);
  const [tides] = await addAndProcess(core, [
    await writeSourceFile(sources, TIDES.name, TIDES.contents),
  ]);
  const mind = await core.createMind({ title: "Tides" });
  const client = await connectToMind(core, mind.id);
  return { core, client, mind, tides: tides as Document };
}

describe.each(LIVE)("Changes out of date, live: $name", (live) => {
  test.skipIf(live.apiKey === undefined)(
    `${live.name}: a change whose words the User edits is made again from them, and an edited Answer regenerated comes back as changes`,
    { timeout: 600_000 },
    async () => {
      const { core, client, mind, tides } = await liveCore(live);
      const report: string[] = [`## ${live.name} · ${live.model} (#94)`];
      const blockId = "english";
      writeMind(client, [
        {
          type: "paragraph",
          attrs: { id: blockId },
          content: [
            {
              type: "text",
              text: "the spring tides they happens at a new moon and also when the moon is full ",
            },
            citationOf(tides, "Spring tides happen at new moon and at full moon"),
            { type: "text", text: ", because sun and moon is pulling together." },
          ],
        },
      ]);
      await client.settled();
      const { result } = await edit(core, client, mind.id, blockId, "improve");
      report.push(`- improve: ${result.kind}\n  ${shown(client, blockId)}`);
      expect(result.kind).toBe("proposed");

      // The User writes among the words the first change that removes any would remove.
      const paragraph = client.blocks.get(0) as Y.XmlElement;
      const words = paragraph.toArray().find((child) => "toDelta" in child) as Y.XmlText;
      let at = 0;
      let typed = false;
      for (const run of words.toDelta() as { insert: unknown; attributes?: object }[]) {
        const length = typeof run.insert === "string" ? run.insert.length : 1;
        if (!typed && run.attributes && PROPOSAL_DELETE_MARK in run.attributes && length > 1) {
          words.insert(at + 1, "X");
          typed = true;
        }
        at += length;
      }
      expect(typed).toBe(true);
      await client.settled();
      const [stale] = [...outOfDateProposals(client.blocks)];
      expect(stale).toBeDefined();

      // Regenerate makes it again from the words as they are now.
      const started = Date.now();
      const again = await core.regenerateProposal({
        requestId: crypto.randomUUID(),
        mindId: mind.id,
        proposalId: stale ?? "",
      });
      await client.settled();
      report.push(
        `- regenerate: ${again.kind}, ${((Date.now() - started) / 1000).toFixed(1)} s\n  ${shown(client, blockId)}`,
      );
      expect(["proposed", "unchanged"]).toContain(again.kind);
      expect(outOfDateProposals(client.blocks).size).toBe(0);
      client.doc.transact(() => {
        resolveProposals(client.blocks as Y.XmlFragment, () => true, "accept");
      }, "editor");
      await client.settled();
      report.push(`  accepted: ${shown(client, blockId)}`);
      expect(citationsOf(client, blockId).map((citation) => citation.check)).toContain("found");

      // An Answer the User edited, regenerated: changes over their version, which stays until accepted.
      const asked = question("When do spring tides happen?");
      writeMind(client, [asked]);
      await client.settled();
      const answered = nextEvent(core, "answer.finished");
      const first = await core.askQuestion({ mindId: mind.id, questionId: asked.attrs.id });
      if (!first.asked) throw new Error(`Not asked: ${JSON.stringify(first)}`);
      const answerId = first.answerId;
      await answered;
      const answer = client.blocks.get(1) as Y.XmlElement;
      const own = new Y.XmlElement("paragraph");
      own.insert(0, [new Y.XmlText("My own note on this Answer.")]);
      answer.push([own]);
      await client.settled();
      const regenerated = nextEvent(core, "answer.finished");
      await core.regenerateAnswer({ mindId: mind.id, answerId });
      await regenerated;
      await client.settled();
      const waiting = pendingProposals(client.blocks).length;
      report.push(`- Answer regenerated over the User's edit: ${waiting} changes`);
      expect(waiting).toBeGreaterThan(0);
      const exported = new TextDecoder().decode(
        (await core.exportMind(mind.id, { format: "markdown" })).data,
      );
      expect(exported).toContain("My own note on this Answer.");
      client.doc.transact(() => {
        resolveProposals(client.blocks as Y.XmlFragment, () => true, "accept");
      }, "editor");
      await client.settled();
      report.push(`  accepted: ${answerText(client, answerId).slice(0, 300)}`);
      expect(answerText(client, answerId)).not.toContain("My own note on this Answer.");
      if (process.env.INCARNAMIND_LIVE_REPORT) {
        await appendFile(process.env.INCARNAMIND_LIVE_REPORT, `${report.join("\n")}\n\n`);
      }
    },
  );
});

describe.each(LIVE)("Edit with AI as it writes, live: $name", (live) => {
  test.skipIf(live.apiKey === undefined)(
    `${live.name}: a whole note shortened comes in paragraph by paragraph, and says why`,
    { timeout: 600_000 },
    async () => {
      const { core, client, mind } = await liveCore(live);
      const report: string[] = [`## ${live.name} · ${live.model} (#202)`];
      const blocks = [
        {
          type: "heading",
          attrs: { id: "heading", level: 2 },
          content: [{ type: "text", text: "Tides at the harbour" }],
        },
        ...[
          "The tides at the harbour are really quite strong in the spring, and they come in very fast over the flats twice every single day.",
          "The harbour master publishes the times of high water every year, and the fishermen basically plan all of their trips around those published times.",
          "Neap tides are actually much weaker, because the Sun and the Moon pull at right angles to each other, so the water does not rise very much at all.",
          "In winter the storms can push the water even higher than the tables say, which is why the harbour wall was raised by a whole metre in 2019.",
        ].map((text, index) => ({
          type: "paragraph",
          attrs: { id: `paragraph-${index + 1}` },
          content: [{ type: "text", text }],
        })),
      ];
      writeMind(client, blocks);
      await client.settled();
      const plain = (id: string) => {
        let text = "";
        readMind(client).descendants((node) => {
          if (node.attrs.id === id) text = node.textContent;
          return text === "";
        });
        return text;
      };
      const last = "paragraph-4";
      // How many changes wait in the Mind each time it changes while the model writes.
      const seen: number[] = [];
      let done = false;
      core.on("mind.update", ({ mindId }) => {
        if (mindId !== mind.id || done) return;
        setTimeout(() => {
          if (!done) seen.push(pendingProposals(client.blocks).length);
        }, 0);
      });
      const started = Date.now();
      const result = await core.editWithAi({
        requestId: crypto.randomUUID(),
        mindId: mind.id,
        from: { blockId: "heading", offset: 0 },
        to: { blockId: last, offset: plain(last).length },
        text: blocks.map((block) => (block.content[0] as { text: string }).text).join("\n"),
        action: "shorten",
      });
      done = true;
      await client.settled();
      const request = result.kind === "proposed" ? result.request : "";
      const reason = proposalRequestOf(client.doc, request);
      const steps = [...new Set(seen)].filter((count) => count > 0);
      report.push(
        `- shorten the whole note: ${result.kind}${result.kind === "proposed" ? `, ${result.proposals} changes` : ""}, ${((Date.now() - started) / 1000).toFixed(1)} s`,
        `  changes waiting as they came: ${steps.join(", ")}`,
        `  why: ${reason?.source === "edit-with-ai" ? (reason.reason ?? "(none)") : "(none)"}`,
      );
      expect(result.kind).toBe("proposed");
      // More than one step: the first paragraphs' changes were in before the last was written.
      expect(steps.length).toBeGreaterThan(1);
      expect(reason?.source === "edit-with-ai" && reason.reason).toBeTruthy();
      client.doc.transact(() => {
        resolveProposals(client.blocks as Y.XmlFragment, () => true, "accept");
      }, "editor");
      await client.settled();
      report.push(
        `  accepted: ${readMind(client).textBetween(0, readMind(client).content.size, " | ")}`,
      );
      expect(plain("heading")).not.toBe("");
      if (process.env.INCARNAMIND_LIVE_REPORT) {
        await appendFile(process.env.INCARNAMIND_LIVE_REPORT, `${report.join("\n")}\n\n`);
      }
    },
  );
});

/**
 * Update the sentence… (#99): a sentence whose Citation now quotes the Document's new words is asked
 * to agree with them. Each run writes the sentence anew with its Citation, asks as the app does,
 * accepts what comes back, and checks that the new words are in, the old ones are out, and the
 * Citation is still there and found. `INCARNAMIND_LIVE_RUNS` runs each language that many times.
 */
const UPDATES = [
  {
    language: "English",
    file: "Amendment.md",
    contents: "# Notice\n\nFor the Supplier, the notice period is forty-five (45) days.\n",
    before: "For the Supplier, the notice period is sixty (60) days.",
    quote: "For the Supplier, the notice period is forty-five (45) days.",
    now: "forty-five",
    gone: "sixty",
  },
  {
    language: "Chinese",
    file: "修订协议.md",
    contents: "# 第 12.2 条\n\n供应商的通知期为四十五（45）天。\n",
    before: "供应商的通知期为六十（60）天。",
    quote: "供应商的通知期为四十五（45）天。",
    now: "四十五",
    gone: "六十",
  },
] as const;

describe.each(LIVE)("Update the sentence, live: $name", (live) => {
  test.skipIf(live.apiKey === undefined)(
    `${live.name}: a sentence follows the new words its Citation quotes, in English and in Chinese, and keeps its Citation`,
    { timeout: 900_000 },
    async () => {
      const runs = Number(process.env.INCARNAMIND_LIVE_RUNS ?? 3);
      const report: string[] = [`## ${live.name} · ${live.model} (#99, Update the sentence)`];
      for (const update of UPDATES) {
        let followed = 0;
        let kept = 0;
        let changes = 0;
        for (let run = 1; run <= runs; run++) {
          const dataDir = await createTempDataFolder();
          const sources = await createTempDataFolder();
          const core = startCore(dataDir, { createChatModel: createAiSdkChatModel });
          core.on(
            "consent.requested",
            (asked) => void core.respondToConsent(asked.requestId, true),
          );
          await core.saveChatProvider({
            kind: live.kind,
            ...(live.apiKey && { apiKey: live.apiKey }),
            modelId: live.model,
          });
          if (live.local) await core.setLocalOnly(true);
          const [document] = await addAndProcess(core, [
            await writeSourceFile(sources, update.file, update.contents),
          ]);
          const mind = await core.createMind({ title: update.language });
          const client = await connectToMind(core, mind.id);
          writeMind(client, [
            {
              type: "paragraph",
              attrs: { id: "sentence" },
              content: [
                { type: "text", text: `${update.before} ` },
                citationOf(document as Document, update.quote),
              ],
            },
          ]);
          await client.settled();
          const { result } = await edit(
            core,
            client,
            mind.id,
            "sentence",
            "instruction",
            updateRequest(update.quote),
          );
          if (result.kind === "proposed") {
            changes++;
            client.doc.transact(() => {
              resolveProposals(client.blocks as Y.XmlFragment, () => true, "accept");
            }, "editor");
            await client.settled();
          }
          const text = shown(client, "sentence");
          const citations = citationsOf(client, "sentence");
          const follows = text.includes(update.now) && !text.includes(update.gone);
          const still = citations.length === 1 && citations[0]?.check === "found";
          if (follows) followed++;
          if (still) kept++;
          report.push(`- ${update.language} run ${run}: ${result.kind}, ${text}`);
          core.close();
        }
        report.push(
          `  ${update.language}: asked ${changes}/${runs}, sentence follows ${followed}/${runs}, Citation kept and found ${kept}/${runs}`,
        );
        expect(kept).toBe(runs);
        expect(followed).toBe(runs);
      }
      if (process.env.INCARNAMIND_LIVE_REPORT) {
        await appendFile(process.env.INCARNAMIND_LIVE_REPORT, `${report.join("\n")}\n\n`);
      }
    },
  );
});
