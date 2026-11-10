import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test } from "vitest";
import { type Area, byArea } from "../../eval/organize/lib/areas";
import {
  ask,
  documentAreasRequest,
  type FolderReading,
  folderRequest,
  lookHereRequest,
  majority,
  parseDocumentAreas,
  parseFolderReading,
  parseLookHere,
  QUESTION_VERSION,
  READ_ORDERS,
  READER,
} from "../../eval/organize/lib/folderReader";

const all = (cover: "yes" | "part" | "no") => byArea(() => cover);

/** A scripted model that answers every request with `reply` and keeps what it was sent. */
function scripted(reply: unknown) {
  const calls: LanguageModelV4CallOptions[] = [];
  const model = new MockLanguageModelV4({
    doGenerate: async (call) => {
      calls.push(call);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(reply) }],
        finishReason: { unified: "stop" as const, raw: undefined },
        warnings: [],
        usage: {
          inputTokens: { total: 600, noCache: 600, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 80, text: 80, reasoning: undefined },
        },
      };
    },
  });
  return { model, calls };
}

const textOf = (call: LanguageModelV4CallOptions, role: "system" | "user") =>
  call.prompt
    .filter((message) => message.role === role)
    .flatMap((message) =>
      typeof message.content === "string"
        ? [message.content]
        : message.content.flatMap((part) => ("text" in part ? [part.text] : [])),
    )
    .join("\n");

describe("the reader's questions", () => {
  test("are frozen: the model, its effort and the questions' text", () => {
    expect(READER).toEqual({ modelId: "claude-opus-5-5", effort: "low" });
    expect(QUESTION_VERSION).toBe("a4dbe3fc7933");
  });

  test("a Folder's request holds its name, description and language, and the areas in the app's words", () => {
    const request = folderRequest(
      { name: "Personal & Home", description: "Personal notes, journals, recipes." },
      "en",
    );
    expect(JSON.parse(request.prompt)).toEqual({
      language: "English",
      folder: { name: "Personal & Home", description: "Personal notes, journals, recipes." },
    });
    expect(request.instructions).toContain(
      "- research: Academic papers, experiments and research methods.",
    );
    expect(request.instructions).toContain(
      "- personal: A person's own papers outside work: a diary, recipes, to-do notes, notes on books they read, manuals for things at home.",
    );
    expect(request.instructions).toContain(
      'A Folder whose name says nothing of what it holds, such as "Other", covers no area.',
    );
    expect(request.instructions).toContain("it never adds an area the name gives no sign of");
  });

  test("in Chinese, the question and the areas are Chinese", () => {
    const request = folderRequest({ name: "财务与合同", description: "合同、发票。" }, "zh-CN");
    expect(JSON.parse(request.prompt).language).toBe("Simplified Chinese");
    expect(request.instructions).toContain("- finance: 发票、预算、账目和财务报表。");
    expect(request.instructions).toContain("名称看不出内容的文件夹（如“其他”）不涵盖任何类别。");
  });

  test("the three reads list the areas in three orders", () => {
    expect(READ_ORDERS.map((order) => order.join(" "))).toEqual([
      "research reports contracts finance meetings personal",
      "personal meetings finance contracts reports research",
      "finance meetings personal research reports contracts",
    ]);
    const lines = (order: readonly Area[]) =>
      folderRequest({ name: "x", description: "" }, "en", order)
        .instructions.split("\n")
        .filter((line) => /^- [a-z]+: /.test(line))
        .map((line) => line.slice(2, line.indexOf(":")));
    expect(lines(READ_ORDERS[1] ?? [])).toEqual([
      "personal",
      "meetings",
      "finance",
      "contracts",
      "reports",
      "research",
    ]);
  });

  test("a Folder's reply must say yes, part or no for every area", () => {
    expect(parseFolderReading({ areas: all("no"), arrangedBy: " a client " })).toEqual({
      areas: all("no"),
      arrangedBy: "a client",
    });
    expect(() => parseFolderReading({ areas: { ...all("no"), personal: "maybe" } })).toThrow(
      "covers personal",
    );
    const { finance: _, ...missing } = all("yes");
    expect(() => parseFolderReading({ areas: missing, arrangedBy: "" })).toThrow("covers finance");
  });

  test("two reads of three decide each area; three different answers read as part", () => {
    const read = (finance: "yes" | "part" | "no", arrangedBy = ""): FolderReading => ({
      areas: { ...all("no"), finance },
      arrangedBy,
    });
    expect(majority([read("yes"), read("yes"), read("no")])).toEqual({
      areas: { ...all("no"), finance: "yes" },
      arrangedBy: "",
      unsure: [],
    });
    expect(majority([read("yes"), read("part"), read("no", "a client")])).toEqual({
      areas: { ...all("no"), finance: "part" },
      arrangedBy: "",
      unsure: ["finance"],
    });
    expect(
      majority([read("no", "a client"), read("no", "the client"), read("no")]).arrangedBy,
    ).toBe("a client");
    expect(() => majority([read("no")])).toThrow("read 3 times");
  });

  test("the per-Document question carries one Folder and one Document, and a yes or a no", () => {
    const request = lookHereRequest(
      { name: "工作与项目", description: "项目周报、会议纪要。" },
      { name: "劳动合同", text: "甲方：……乙方：……" },
      "zh-CN",
    );
    expect(Object.keys(JSON.parse(request.prompt))).toEqual(["language", "folder", "document"]);
    expect(request.instructions).toContain("描述可以解释或收窄名称，但不能放宽。");
    expect(parseLookHere({ lookHere: "no" })).toBe(false);
    expect(parseLookHere({ lookHere: "yes" })).toBe(true);
    expect(() => parseLookHere({ lookHere: "maybe" })).toThrow("neither yes nor no");
  });

  test("a Document's areas: one, a second only when given and different, or none", () => {
    const request = documentAreasRequest({ name: "Diary", text: "Dear diary," }, "en");
    expect(JSON.parse(request.prompt)).toEqual({
      language: "English",
      document: { name: "Diary", text: "Dear diary," },
    });
    expect(parseDocumentAreas({ area: "personal", second: "" })).toEqual({ area: "personal" });
    expect(parseDocumentAreas({ area: "reports", second: "meetings" })).toEqual({
      area: "reports",
      second: "meetings",
    });
    expect(parseDocumentAreas({ area: "finance", second: "finance" })).toEqual({ area: "finance" });
    expect(parseDocumentAreas({ area: "none", second: "" })).toEqual({ area: null });
    expect(() => parseDocumentAreas({ area: "books", second: "" })).toThrow("names no area");
  });

  test("a scripted reply comes back parsed, from a request with only the question and the item", async () => {
    const reply = { areas: { ...all("no"), personal: "yes" }, arrangedBy: "" };
    const { model, calls } = scripted(reply);
    const request = folderRequest(
      { name: "Personal & Home", description: "Personal notes and recipes." },
      "en",
    );
    const answer = await ask(model, request);
    expect(answer).toEqual({ value: reply, inputTokens: 600, outputTokens: 80 });
    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (!call) throw new Error("No request was sent.");
    expect(textOf(call, "system")).toBe(request.instructions);
    expect(textOf(call, "user")).toBe(request.prompt);
    expect(call.responseFormat).toMatchObject({ type: "json", name: "folder_areas" });
  });
});
