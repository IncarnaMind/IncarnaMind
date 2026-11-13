/**
 * The mark where a figure couldn't be calculated, beside changes still waiting (#3024): an
 * assistant's write and Edit with AI read the paragraphs as they read with their own change accepted
 * and no other's, so the words their change takes out and the words another request adds are not
 * counted, and the rule that keeps the mark (#2577) judges the change and nothing else.
 */
import type { JSONContent } from "@tiptap/core";
import { describe, expect, onTestFinished, test } from "vitest";
import * as Y from "yjs";
import { createElement } from "../../src/core/answers/blocks";
import { MIND_CONTENT_FIELD } from "../../src/core/api";
import { paragraphPlaces } from "../../src/core/proposals/placed";
import type { MarkJSON, NodeJSON } from "../../src/shared/blockJson";
import { markKeyOf } from "../../src/shared/markKeys";
import { pendingProposals } from "../../src/shared/proposals";
import { askAssistant } from "../helpers/assistant";
import { setUpWithDocuments } from "../helpers/citations";
import { createTempDataFolder, startCore } from "../helpers/core";
import { type EditCall, editingModel, plainOf } from "../helpers/editing";
import { connectToMind } from "../helpers/mindClient";
import { heading, resolveChanges, shownWithChanges, writeMind } from "../helpers/minds";
import {
  type ModelCall,
  type ScriptedReply,
  scriptedModel,
  scriptedModels,
} from "../helpers/models";

/** The editor's one character for an inline node, the mark among them (`shownWithChanges`). */
const MARK = String.fromCodePoint(0xfffc);

const removes = (request: string): MarkJSON[] => [
  { type: "proposalDelete", attrs: { id: `${request}-removes`, request } },
];
const adds = (request: string): MarkJSON[] => [
  { type: "proposalInsert", attrs: { id: `${request}-adds`, request } },
];
const text = (value: string, marks?: MarkJSON[]): NodeJSON => ({
  type: "text",
  text: value,
  ...(marks && { marks }),
});
const mark: NodeJSON = { type: "missingNumber" };

function paragraphOf(content: NodeJSON[]): Y.XmlFragment {
  const doc = new Y.Doc();
  const blocks = doc.getXmlFragment(MIND_CONTENT_FIELD);
  blocks.push([createElement({ type: "paragraph", attrs: { id: "p" }, content })]);
  return blocks;
}

describe("a paragraph read for a request's own change, as paragraphPlaces says it is", () => {
  const waiting = paragraphOf([
    text("Revenue rose. "),
    text("Costs fell. ", removes("r1")),
    text("Margins held. ", adds("r2")),
    text("Growth was "),
    mark,
    text("."),
  ]);
  const read = (...content: NodeJSON[]) => paragraphPlaces(paragraphOf(content), null);

  test("the Note keeps each change under a key of its own", () => {
    const keys = ((waiting.get(0) as Y.XmlElement).get(0) as Y.XmlText)
      .toDelta()
      .flatMap((run: { attributes?: Record<string, unknown> }) =>
        Object.keys(run.attributes ?? {}),
      );
    expect(keys).toEqual([
      markKeyOf("proposalDelete", "r1-removes"),
      markKeyOf("proposalInsert", "r2-adds"),
    ]);
  });

  test("with r1's change accepted: its words gone, the words r2 adds not there yet", () => {
    expect(paragraphPlaces(waiting, "r1")).toEqual(
      read(text("Revenue rose. Growth was "), mark, text(".")),
    );
  });

  test("with r2's change accepted: its words there, the words r1 takes out still there", () => {
    expect(paragraphPlaces(waiting, "r2")).toEqual(
      read(text("Revenue rose. Costs fell. Margins held. Growth was "), mark, text(".")),
    );
  });

  test("with the change of a request that wrote neither: the words r1 takes out stay, r2's aren't there", () => {
    expect(paragraphPlaces(waiting, "r3")).toEqual(
      read(text("Revenue rose. Costs fell. Growth was "), mark, text(".")),
    );
  });

  test("with no request: the paragraph as it holds, changes and all", () => {
    expect(paragraphPlaces(waiting, null)).toEqual(
      read(text("Revenue rose. Costs fell. Margins held. Growth was "), mark, text(".")),
    );
  });
});

const WORDS = {
  en: {
    title: "Growth",
    asked: "Delete the growth sentence.",
    part: "Harbour growth was",
    paragraph: [text("Harbour growth was "), mark, text(". Sales held.")],
    kept: "Sales held.",
    digits: "Harbour growth was 8.0%. Sales held.",
    elsewhere: [
      text("Revenue rose. "),
      text("Costs fell. ", removes("r1")),
      text("Margins held.", adds("r2")),
    ],
    elsewhereAccepted: "Revenue rose. Margins held.",
  },
  zh: {
    title: "增长",
    asked: "把增长率那句删掉。",
    part: "港湾分馆的增长率",
    paragraph: [text("港湾分馆的增长率为"), mark, text("。销量保持稳定。")],
    kept: "销量保持稳定。",
    digits: "港湾分馆的增长率为 8.0%。销量保持稳定。",
    elsewhere: [
      text("营收上升。"),
      text("成本下降。", removes("r1")),
      text("利润持平。", adds("r2")),
    ],
    elsewhereAccepted: "营收上升。利润持平。",
  },
} as const;

describe.each(["en", "zh"] as const)(
  "the assistant asked only to take text out, in %s",
  { timeout: 30_000 },
  (language) => {
    const words = WORDS[language];

    async function removing(reply: string, removesOnly: boolean, others: readonly NodeJSON[]) {
      const model = scriptedModel((call: ModelCall): ScriptedReply => {
        if (/<passage>\n/.test(call.prompt)) return { text: `¶1 ${reply}\n<why>Done.</why>` };
        return call.results.length === 0
          ? {
              calls: [
                {
                  tool: "edit_mind",
                  input: { instruction: words.asked, part: words.part, removes_only: removesOnly },
                },
              ],
            }
          : { text: "Done." };
      });
      const core = startCore(await createTempDataFolder(), {
        createChatModel: scriptedModels(model).createChatModel,
      });
      onTestFinished(() => core.close());
      await core.saveChatProvider({ kind: "ollama", modelId: "local-model" });
      const mind = await core.createMind({ title: words.title });
      const client = await connectToMind(core, mind.id);
      const beside: JSONContent[] =
        others.length > 0
          ? [{ type: "paragraph", attrs: { id: "beside" }, content: [...others] }]
          : [];
      writeMind(client, [
        heading(1, words.title),
        ...beside,
        { type: "paragraph", attrs: { id: "growth" }, content: [...words.paragraph] },
      ]);
      await client.settled();
      const answer = await askAssistant(core, { text: words.asked, mindId: mind.id });
      await client.settled();
      const [call] = answer.toolCalls.filter((each) => each.tool === "edit_mind");
      return { client, status: call?.status, problem: call?.mindProblem?.kind };
    }

    test("a change that takes the sentence holding the mark out with its words lands", async () => {
      const { client, status, problem } = await removing(words.kept, true, []);
      expect(problem).toBeUndefined();
      expect(status).toBe("done");
      await resolveChanges(client, "accept");
      expect(shownWithChanges(client)).toEqual([words.title, words.kept]);
    });

    test("it lands with other requests' changes waiting in the Note, and leaves them waiting", async () => {
      const { client, status, problem } = await removing(words.kept, true, words.elsewhere);
      expect(problem).toBeUndefined();
      expect(status).toBe("done");
      expect(new Set(pendingProposals(client.blocks).map((each) => each.request))).toEqual(
        new Set(["r1", "r2", expect.any(String)]),
      );
      await resolveChanges(client, "accept");
      expect(shownWithChanges(client)).toEqual([words.title, words.elsewhereAccepted, words.kept]);
    });

    test("one that types digits where the mark was is refused, and the mark stays", async () => {
      const { client, status, problem } = await removing(words.digits, true, words.elsewhere);
      expect(problem).toBe("missing-number");
      expect(status).toBe("failed");
      expect(shownWithChanges(client).at(-1)).toBe(
        language === "en"
          ? `Harbour growth was ${MARK}. Sales held.`
          : `港湾分馆的增长率为${MARK}。销量保持稳定。`,
      );
    });

    test("asked for any other change, one that drops the sentence with the mark is refused", async () => {
      const { client, status, problem } = await removing(words.kept, false, words.elsewhere);
      expect(problem).toBe("missing-number");
      expect(status).toBe("failed");
      expect(shownWithChanges(client).at(-1)).toContain(MARK);
    });
  },
);

describe.each([
  ["en", "[number missing]"],
  ["zh-CN", "[缺少数字]"],
] as const)(
  "Edit with AI over a stretch after changes waiting in its paragraph, interface in %s",
  (language, words) => {
    const paragraph: NodeJSON[] = [
      text("Revenue rose. "),
      text("Costs fell. ", removes("r1")),
      text("Margins held. ", adds("r2")),
      text("Growth was "),
      mark,
      text(" in 2026 and 9% in 2025."),
    ];

    async function editing(reply: (passage: string) => string) {
      const calls: EditCall[] = [];
      const set = await setUpWithDocuments(
        editingModel((call) => reply(call.passage), calls),
        [],
      );
      onTestFinished(() => set.core.close());
      if (language === "zh-CN") await set.core.updateSettings({ user: { language } });
      writeMind(set.client, [{ type: "paragraph", attrs: { id: "growth" }, content: paragraph }]);
      await set.client.settled();
      const plain = plainOf(set.client, "growth");
      const from = plain.indexOf("Growth");
      const result = await set.core.editWithAi({
        requestId: "edit-1",
        mindId: set.mind.id,
        from: { blockId: "growth", offset: from },
        to: { blockId: "growth", offset: plain.length },
        text: plain.slice(from),
        action: "shorten",
      });
      await set.client.settled();
      return { ...set, result, calls };
    }

    const unchanged = `Revenue rose. [-Costs fell. -]{+Margins held. +}Growth was ${MARK} in 2026 and 9% in 2025.`;

    test("a reply that keeps the mark lands, the changes waiting before it left alone", async () => {
      const { client, calls, result } = await editing((passage) =>
        passage.replace(" in 2026 and", ";"),
      );
      expect(calls[0]?.passage).toBe(`Growth was ${words} in 2026 and 9% in 2025.`);
      expect(result.kind).toBe("proposed");
      if (result.kind !== "proposed") return;
      const own = new Set(
        pendingProposals(client.blocks)
          .filter((each) => each.request === result.request)
          .map((each) => each.id),
      );
      await resolveChanges(client, "accept", (id) => own.has(id));
      expect(shownWithChanges(client)).toEqual([
        `Revenue rose. [-Costs fell. -]{+Margins held. +}Growth was ${MARK}; 9% in 2025.`,
      ]);
    });

    test("a reply that puts a plain number where the mark is is refused, and the mark stays", async () => {
      const { client, result } = await editing((passage) => passage.replace(words, "8.0%"));
      expect(result.kind).toBe("missing-number");
      expect(shownWithChanges(client)).toEqual([unchanged]);
    });

    test("a reply that leaves the mark out is refused too", async () => {
      const { client, result } = await editing((passage) => passage.replace(` ${words}`, ""));
      expect(result.kind).toBe("missing-number");
      expect(shownWithChanges(client)).toEqual([unchanged]);
    });
  },
);
