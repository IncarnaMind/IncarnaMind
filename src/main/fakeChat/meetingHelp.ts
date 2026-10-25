/**
 * Help during a call: a button's Question gets the shape it asks for. Options cite the
 * first Passage found ahead in the User's Documents, its line in the recommended option, and
 * without one, they cite nothing; readings and lines cite the transcript's newest line. In the
 * call's language: Chinese when its newest line is, or before anyone has spoken, when the button's
 * name is.
 */
import { passagesIn, recordFor } from "./passages";
import { lastUserText, type Prompt, type Reply, toolResults } from "./prompt";

const HELP = /pressed a button for help/;

const block = (text: string, tag: string) =>
  new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`).exec(text)?.[1] ?? "";

const OPTIONS = {
  en: {
    cited: (line: string) => `★ Yes: ${line} [^1]\n→ answers at once; keeps the call moving`,
    first:
      "★ That's fair; let me check with the team and confirm by Friday.\n→ keeps the deal moving; buys time",
    second:
      "Could you tell me what matters most to you here?\n→ learns their priority; slows the pace",
  },
  zh: {
    cited: (line: string) => `★ 是的：${line}[^1]\n→ 直接回答，推进通话`,
    first: "★ 这个问题很好，我跟团队确认后周五前回复你。\n→ 推进成交，争取时间",
    second: "能多说说你最看重哪一点吗？\n→ 了解对方重点，放慢节奏",
  },
};

const READINGS = {
  en: {
    first: (moment: string) =>
      `★ They want a firm date for the launch\n${moment}\n→ give the date you can commit to, then ask what depends on it`,
    second:
      "They may be worried about the payment provider's review\n→ ask what would make them confident",
  },
  zh: {
    first: (moment: string) =>
      `★ 对方想要一个确定的上线日期\n${moment}\n→ 先给能承诺的日期，再问哪些事取决于它`,
    second: "对方可能担心支付服务商的审核\n→ 问问怎样才能让对方放心",
  },
};

const LINES = {
  en: (cite: string) =>
    `- The launch moves to the eighteenth of November${cite}\n- The partner preview stays on the twenty-eighth of October\n- Marketing waits for the new date`,
  zh: (cite: string) =>
    `- 上线推迟到 11 月 18 日${cite}\n- 合作伙伴预览仍在 10 月 28 日\n- 市场部等新日期确定后再公布`,
};

export function helpReply(prompt: Prompt, tools: readonly string[]): Reply | null {
  const asked = lastUserText(prompt);
  // The button's instructions follow its Question, in its message.
  const help = block(asked, "help");
  if (!HELP.test(help)) return null;
  const question = asked.slice(0, asked.indexOf("\n\n<help>")).split("\n\n").at(-1) ?? "";
  const found = passagesIn(block(asked, "found-in-documents"));
  const heard = passagesIn(block(asked, "live-transcript"));
  const newest = heard.at(-1)?.text ?? question;
  const language = /\p{Script=Han}/u.test(newest) ? "zh" : "en";
  const shape = /One or two readings/.test(help)
    ? "readings"
    : /At most three short lines/.test(help)
      ? "lines"
      : "options";
  const source = shape === "options" ? found[0] : heard.at(-1);
  const taken = source && recordFor(source, heard.at(-1)?.text ?? question, 1);
  if (taken && tools.includes("cite") && toolResults(prompt, "cite").length === 0) {
    return { tool: "cite", input: { citations: [taken.record] } };
  }
  // A transcript line's time and speaker lead its text: "[0:04 Them] …".
  const quote = taken
    ? String(taken.record.quote)
        .replace(/^\[[^\]]*\]\s*/, "")
        .replace(/[.?!。？！]+$/u, "")
    : null;
  if (shape === "readings") {
    const moment = quote
      ? `${source?.location ?? ""} “${quote}” [^1]`.trim()
      : language === "zh"
        ? "（转写稿中还没有）"
        : "(nothing in the transcript yet)";
    return { text: `${READINGS[language].first(moment)}\n\n${READINGS[language].second}` };
  }
  if (shape === "lines") return { text: LINES[language](quote ? " [^1]" : "") };
  const first = quote ? OPTIONS[language].cited(quote) : OPTIONS[language].first;
  return { text: `${first}\n\n${OPTIONS[language].second}` };
}
