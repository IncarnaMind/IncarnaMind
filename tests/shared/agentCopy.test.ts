import { describe, expect, it } from "vitest";
import { AGENT_CLIENT_DEFINITIONS } from "../../src/core/agents/clients";
import { clientInSentence } from "../../src/shared/agentNames";
import { type MessageKey, translate } from "../../src/shared/i18n";
import { en } from "../../src/shared/i18n/en";

const LANGUAGES = ["en", "zh-CN"] as const;
const KEYS = (Object.keys(en) as MessageKey[]).filter(
  (key) => key.startsWith("agents.") && en[key].includes("{agent}"),
);

describe("the agent strings in a sentence", () => {
  it("has strings to check", () => {
    expect(KEYS.length).toBeGreaterThan(8);
  });

  describe.each(LANGUAGES)("in %s", (language) => {
    const sentenceNames = AGENT_CLIENT_DEFINITIONS.map((client) =>
      clientInSentence(client, (key, params) => translate(language, key, params)),
    );

    it.each(KEYS)("%s reads with every agent's name", (key) => {
      for (const agent of sentenceNames) {
        const text = translate(language, key, { agent, path: "~/x.json", count: 2 });
        expect(text).not.toContain("{");
        expect(text).not.toContain("Other agent");
        expect(text).not.toContain("其他智能体");
        expect(text).not.toMatch(/Codex(’|')s/);
      }
    });
  });

  it("names the ChatGPT app and Codex, and Other agent, as a sentence can hold them", () => {
    const names = (language: "en" | "zh-CN") =>
      ["codex", "other"].map((id) =>
        clientInSentence({ id, name: "" }, (key, params) => translate(language, key, params)),
      );
    expect(names("en")).toEqual(["the ChatGPT app or Codex", "your agent"]);
    expect(names("zh-CN")).toEqual(["ChatGPT 应用或 Codex", "你的智能体"]);
  });

  it("has no space between Chinese text and a Chinese name, and one next to a Latin name", () => {
    const say = (agent: string, key: MessageKey) => translate("zh-CN", key, { agent });
    expect(say("你的智能体", "agents.connect.title")).toBe("允许你的智能体读取你的文档？");
    expect(say("Cursor", "agents.connect.title")).toBe("允许 Cursor 读取你的文档？");
    expect(say("ChatGPT 应用或 Codex", "agents.done.wrote")).toBe(
      "已添加到 ChatGPT 应用或 Codex 的设置中。在 ChatGPT 应用或 Codex 中开始一个新会话即可使用。",
    );
    expect(say("你的智能体", "agents.pairing.skill")).toBe(
      "已安装技能：你的智能体知道何时使用 IncarnaMind",
    );
    expect(say("Cursor", "agents.pairing.skill")).toBe(
      "已安装技能：Cursor 知道何时使用 IncarnaMind",
    );
  });

  it("reads in English with the sentence names", () => {
    expect(translate("en", "agents.connect.title", { agent: "your agent" })).toBe(
      "Let your agent read your Documents?",
    );
    expect(translate("en", "agents.done.wrote", { agent: "the ChatGPT app or Codex" })).toBe(
      "Added to the settings of the ChatGPT app or Codex. Start a new session in the ChatGPT app or Codex to use it.",
    );
  });
});
