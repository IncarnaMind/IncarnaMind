import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import type { ClaimReadDocument, EmbeddingProvider } from "../../src/core/api";
import type { Language } from "../../src/core/language";
import { embeddingProviderLabel } from "../../src/renderer/src/components/providers/shared";
import { readDocumentsText } from "../../src/renderer/src/editor/readDocumentsText";
import { withKeys, withShortcut } from "../../src/renderer/src/editor/withShortcut";
import { savedOutsideLine } from "../../src/renderer/src/fileNoticeLines";
import { type MessageKey, type MessageParams, translate } from "../../src/shared/i18n";

/*
 * A name with its place, as the interface writes them (#3074): ASCII parentheses and a space in
 * English, full-width ones with no space in Chinese (docs/agents/zh-CN.md, rule 3).
 */

const sayIn =
  (language: Language) =>
  (key: MessageKey, params?: MessageParams): string =>
    translate(language, key, params);
const en = sayIn("en");
const zh = sayIn("zh-CN");

type Places = typeof import("../../src/renderer/src/documentPlaces").placesOf;
type Store = typeof import("../../src/renderer/src/store").useAppStore;

describe("The check card's line for the Documents it read whole", () => {
  const read = (documentName: string, pages: number[]): ClaimReadDocument => ({
    documentId: documentName,
    documentName,
    contentHash: "hash",
    locations: pages.map((page) => ({ kind: "page" as const, from: page, to: page })),
  });

  test("puts each Document's places in parentheses after its name", () => {
    const documents = [read("Lease.pdf", [3]), read("租约.pdf", [3, 5]), read("Notes.docx", [])];
    expect(readDocumentsText(documents, null, en, "en")).toBe(
      "Lease.pdf (p. 3); 租约.pdf (p. 3, p. 5); Notes.docx",
    );
    expect(readDocumentsText(documents, null, zh, "zh-CN")).toBe(
      "Lease.pdf（第 3 页）；租约.pdf（第 3 页、第 5 页）；Notes.docx",
    );
  });

  test("a Document with no place is just its name", () => {
    expect(readDocumentsText([read("Notes.docx", [])], null, zh, "zh-CN")).toBe("Notes.docx");
  });
});

describe("The sidebar's line for pages saved outside the Folder", () => {
  test("puts the Folder each went to in parentheses after its name", () => {
    const saved = [
      { name: "Tides", folder: "Contracts" },
      { name: "潮汐", folder: "合同" },
      { name: "Tides", folder: "合同" },
      { name: "Weir", folder: "" },
    ];
    expect(savedOutsideLine(en, "en", saved)).toBe(
      "These pages were saved, but not into the Folder you chose: Tides (Contracts), 潮汐 (合同), Tides (合同), Weir",
    );
    expect(savedOutsideLine(zh, "zh-CN", saved)).toBe(
      "这些网页已保存，但没有存入你选择的文件夹：Tides（Contracts）、潮汐（合同）、Tides（合同）、Weir",
    );
  });
});

describe("A button's name with its shortcut", () => {
  test("puts the keys in parentheses after the name", () => {
    expect(withKeys(en, "Close tab", "⌘W")).toBe("Close tab (⌘W)");
    expect(withKeys(zh, "关闭标签页", "⌘W")).toBe("关闭标签页（⌘W）");
    expect(withKeys(zh, "Word 文档", "Ctrl+Shift+E")).toBe("Word 文档（Ctrl+Shift+E）");
  });

  test("a button with no shortcut is just its name", () => {
    expect(withKeys(zh, "关闭标签页", undefined)).toBe("关闭标签页");
    expect(withShortcut(zh, "关闭标签页", undefined)).toEqual({});
  });

  test("its tooltip and accessible name say the same", () => {
    expect(withShortcut(en, "Allow once", "⌘↵")).toEqual({
      title: "Allow once (⌘↵)",
      "aria-label": "Allow once (⌘↵)",
    });
    expect(withShortcut(zh, "允许一次", "⌘↵")).toEqual({
      title: "允许一次（⌘↵）",
      "aria-label": "允许一次（⌘↵）",
    });
  });
});

describe("The search model a status line names", () => {
  const provider = (
    kind: EmbeddingProvider["kind"],
    service: EmbeddingProvider["service"],
  ): EmbeddingProvider => ({
    kind,
    baseUrl: null,
    modelId: "nomic-embed-text",
    hasApiKey: false,
    dimensions: null,
    service,
  });
  const server = { id: "lab", name: "Lab server" } as unknown as EmbeddingProvider["service"];

  test("puts the server in parentheses after its kind", () => {
    expect(embeddingProviderLabel(provider("ollama", server), en)).toBe(
      "Ollama (Lab server) · nomic-embed-text",
    );
    expect(embeddingProviderLabel(provider("ollama", server), zh)).toBe(
      "Ollama（Lab server） · nomic-embed-text",
    );
  });

  test("a server of this computer is named as such", () => {
    expect(embeddingProviderLabel(provider("openai-compatible", null), en)).toBe(
      "OpenAI-compatible server (on this computer) · nomic-embed-text",
    );
    expect(embeddingProviderLabel(provider("openai-compatible", null), zh)).toBe(
      "OpenAI 兼容服务器（在这台电脑上） · nomic-embed-text",
    );
  });

  test("a company's own API has no server to name", () => {
    expect(embeddingProviderLabel(provider("openai", null), zh)).toBe("OpenAI · nomic-embed-text");
  });
});

describe("The place a Document shows when another has its name and its folder", () => {
  let placesOf: Places;
  let useAppStore: Store;

  beforeAll(async () => {
    const bridge = new Proxy(
      { on: () => () => undefined },
      { get: (each, name) => (name === "on" ? each.on : () => Promise.resolve(undefined)) },
    );
    vi.stubGlobal("window", { incarnamind: bridge, incarnamindFiles: bridge });
    ({ useAppStore } = await import("../../src/renderer/src/store"));
    ({ placesOf } = await import("../../src/renderer/src/documentPlaces"));
  });
  afterAll(() => vi.unstubAllGlobals());

  const twins = (folder: string) =>
    ["a", "b", "c"].map((id) => ({ id, name: "Contract", path: `/files/${folder}/Contract.pdf` }));
  const placesIn = (language: Language, folder: string) => {
    useAppStore.setState({ settings: { language, user: {} } } as never);
    return Object.fromEntries(placesOf(twins(folder) as never, []));
  };

  test("counts the twins in parentheses after the folder", () => {
    expect(placesIn("en", "Contracts")).toEqual({
      a: "Contracts",
      b: "Contracts (2)",
      c: "Contracts (3)",
    });
    expect(placesIn("zh-CN", "合同")).toEqual({ a: "合同", b: "合同（2）", c: "合同（3）" });
    expect(placesIn("zh-CN", "Contracts")).toEqual({
      a: "Contracts",
      b: "Contracts（2）",
      c: "Contracts（3）",
    });
  });

  test("changing the language changes the count's form for the same Documents", () => {
    const documents = twins("合同") as never;
    useAppStore.setState({ settings: { language: "zh-CN", user: {} } } as never);
    expect(placesOf(documents, []).get("b")).toBe("合同（2）");
    useAppStore.setState({ settings: { language: "en", user: {} } } as never);
    expect(placesOf(documents, []).get("b")).toBe("合同 (2)");
  });
});
