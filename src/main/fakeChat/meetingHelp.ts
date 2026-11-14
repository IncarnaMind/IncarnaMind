/**
 * Help during a call: a button's Question gets the shape it asks for. Options cite the
 * first Passage found ahead in the User's Documents, its line in the recommended option, and
 * without one, they cite nothing; readings and lines cite the transcript's newest line. In the
 * call's language: Chinese when its newest line is, or before anyone has spoken, when the button's
 * name is.
 */
import { passagesIn, recordFor, withSurroundingWords } from "./passages";
import {
  lastUserText,
  type Prompt,
  type Reply,
  type StreamPart,
  toolResults,
  USAGE,
} from "./prompt";

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

const shapeOf = (help: string) =>
  /One or two readings/.test(help)
    ? "readings"
    : /At most three short lines/.test(help)
      ? "lines"
      : "options";

function callOf(asked: string) {
  // The button's instructions follow its Question, in its message.
  const question = asked.slice(0, asked.indexOf("\n\n<help>")).split("\n\n").at(-1) ?? "";
  const heard = passagesIn(block(asked, "live-transcript"));
  const newest = heard.at(-1)?.text ?? question;
  const language: "en" | "zh" = /\p{Script=Han}/u.test(newest) ? "zh" : "en";
  return { question, heard, language };
}

export function helpReply(prompt: Prompt, tools: readonly string[]): Reply | null {
  const asked = lastUserText(prompt);
  const help = block(asked, "help");
  if (!HELP.test(help)) return null;
  const { question, heard, language } = callOf(asked);
  const found = passagesIn(block(asked, "found-in-documents"));
  const shape = shapeOf(help);
  const source = shape === "options" ? found[0] : heard.at(-1);
  const taken = source && recordFor(source, heard.at(-1)?.text ?? question, 1);
  if (source && taken && tools.includes("cite")) {
    const cited = toolResults(prompt, "cite");
    const record = cited.length === 0 ? taken.record : withSurroundingWords(cited, source, 1);
    if (record) return { tool: "cite", input: { citations: [record] } };
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

const NOTES = {
  en: "The newest lines ask about the Enterprise price, and the price sheet has it, so the record comes first.",
  zh: "最新的几句在问企业版的价格，价目表里有这一条，先记下引用。",
};

/**
 * For a model id ending "-notes-first": a help reply's records come after a paragraph of the
 * model's own notes in the same step, as Claude Sonnet 5.5 writes them (#2526); the core takes
 * the notes back once the records come. Other steps are as they were.
 */
function withNotesFirst(prompt: Prompt, parts: StreamPart[]): StreamPart[] {
  const asked = lastUserText(prompt);
  if (!HELP.test(block(asked, "help"))) return parts;
  const at = parts.findIndex((part) => part.type === "tool-call" && part.toolName === "cite");
  if (at === -1) return parts;
  const notes = NOTES[callOf(asked).language];
  return [
    ...parts.slice(0, at),
    { type: "text-start", id: "notes" },
    ...notes
      .split(/(?<=\s)|(?<=\p{Script=Han})/u)
      .map((delta): StreamPart => ({ type: "text-delta", id: "notes", delta })),
    { type: "text-end", id: "notes" },
    ...parts.slice(at),
  ];
}

const textDeltas = (id: string, text: string) =>
  text.split(/(?<=\s)/).map((delta): StreamPart => ({ type: "text-delta", id, delta }));

/**
 * For a model id ending "-moves-taken-back": a help reply whose one option or reading came without
 * its "→" line (#2767): its first alone. Other steps are as they were.
 */
function withMovesTakenBack(prompt: Prompt, parts: StreamPart[]): StreamPart[] {
  if (!HELP.test(block(lastUserText(prompt), "help"))) return parts;
  const start = parts.findIndex((part) => part.type === "text-start");
  const end = parts.findIndex((part) => part.type === "text-end");
  const opened = parts[start];
  if (opened?.type !== "text-start" || end === -1) return parts;
  const text = parts.flatMap((part) => (part.type === "text-delta" ? [part.delta] : [])).join("");
  const first = (text.split("\n\n")[0] ?? "")
    .split("\n")
    .filter((line) => !line.startsWith("→"))
    .join("\n");
  return [...parts.slice(0, start + 1), ...textDeltas(opened.id, first), ...parts.slice(end)];
}

/**
 * For a model id ending "-options-quoted": each option of a help reply wrapped in quotation marks of
 * the model's own, its Citation after them (#2925). Other steps are as they were.
 */
function withOptionsQuoted(prompt: Prompt, parts: StreamPart[]): StreamPart[] {
  const help = block(lastUserText(prompt), "help");
  if (!HELP.test(help) || shapeOf(help) !== "options") return parts;
  const start = parts.findIndex((part) => part.type === "text-start");
  const end = parts.findIndex((part) => part.type === "text-end");
  const opened = parts[start];
  if (opened?.type !== "text-start" || end === -1) return parts;
  const text = parts
    .flatMap((part) => (part.type === "text-delta" ? [part.delta] : []))
    .join("")
    .split("\n")
    .map((line) =>
      line === "" || line.startsWith("→")
        ? line
        : line.replace(/^(★ )?(.+?)((?: ?\[\^\d+\])*)$/u, '$1"$2"$3'),
    )
    .join("\n");
  return [...parts.slice(0, start + 1), ...textDeltas(opened.id, text), ...parts.slice(end)];
}

/** For a model id ending "-heading-only": a help reply of one Markdown heading, with no records. */
function headingOnly(prompt: Prompt, parts: StreamPart[]): StreamPart[] {
  const asked = lastUserText(prompt);
  if (!HELP.test(block(asked, "help"))) return parts;
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "answer" },
    ...textDeltas("answer", `## ${callOf(asked).question}`),
    { type: "text-end", id: "answer" },
    { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage: USAGE },
  ];
}

/**
 * For a model id ending "-cites-the-note": a help reply's option cites the Note's first Citation by
 * its id, saying the Note's words before it again (#3005). Other steps are as they were.
 */
function withNoteCited(prompt: Prompt, parts: StreamPart[]): StreamPart[] {
  const asked = lastUserText(prompt);
  const help = block(asked, "help");
  if (!HELP.test(help) || shapeOf(help) !== "options") return parts;
  const line = asked.split("\n").find((each) => /·\s*C1\]/.test(each)) ?? "";
  const quote = line
    .slice(0, line.lastIndexOf("["))
    .replace(/^[-*>\s]+/, "")
    .trim();
  if (!quote) return parts;
  if (toolResults(prompt, "cite").length === 0) {
    const input = JSON.stringify({ citations: [{ marker: 1, passage: "C1", quote }] });
    return [
      { type: "stream-start", warnings: [] },
      { type: "tool-call", toolCallId: "fake-cite", toolName: "cite", input },
      { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage: USAGE },
    ];
  }
  const { language } = callOf(asked);
  const said = quote.replace(/[.?!。？！]+$/u, "");
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "answer" },
    ...textDeltas("answer", `${OPTIONS[language].cited(said)}\n\n${OPTIONS[language].second}`),
    { type: "text-end", id: "answer" },
    { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage: USAGE },
  ];
}

/** The end of a quote after its last clause mark, or its last three words: words wholly inside it. */
function partOf(quote: string): string {
  const said = quote.replace(/[.?!。？！]+$/u, "");
  const clause = Math.max(said.lastIndexOf(", "), said.lastIndexOf("，"));
  if (clause > 0) return said.slice(clause + (said[clause] === "，" ? 1 : 2)).trim();
  return said.split(" ").slice(-3).join(" ");
}

/**
 * For a model id ending "-writes-before-it-cites": a help reply's first option is written, with
 * two numbers, before its cite call, as Claude Haiku 5.5 often writes (#2847); its second number
 * cites words inside the first's quote, of the same Passage. The rest of the reply comes after
 * the cite. Other steps are as they were.
 */
function withTextBeforeCite(prompt: Prompt, parts: StreamPart[]): StreamPart[] {
  const asked = lastUserText(prompt);
  const help = block(asked, "help");
  if (!HELP.test(help) || shapeOf(help) !== "options") return parts;
  const text = parts.flatMap((part) => (part.type === "text-delta" ? [part.delta] : [])).join("");
  if (toolResults(prompt, "cite").length > 0) {
    const rest = text.slice(text.indexOf("\n"));
    return [
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "answer" },
      ...textDeltas("answer", rest),
      { type: "text-end", id: "answer" },
      { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage: USAGE },
    ];
  }
  const call = parts.find((part) => part.type === "tool-call" && part.toolName === "cite");
  if (call?.type !== "tool-call") return parts;
  const { citations }: { citations: { marker: number; quote: string }[] } = JSON.parse(call.input);
  const [whole] = citations;
  if (!whole) return parts;
  const quote = whole.quote.replace(/^\[[^\]]*\]\s*/, "");
  // The same Passage and place, so it lies wholly inside the first's quote.
  const inner = { ...whole, marker: 2, quote: partOf(quote) };
  const { language } = callOf(asked);
  const first = OPTIONS[language].cited(quote.replace(/[.?!。？！]+$/u, "")).split("\n")[0] ?? "";
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "answer" },
    ...textDeltas("answer", first.replace("[^1]", "[^1] [^2]")),
    { type: "text-end", id: "answer" },
    {
      type: "tool-call",
      toolCallId: "fake-cite",
      toolName: "cite",
      input: JSON.stringify({ citations: [whole, inner] }),
    },
    { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage: USAGE },
  ];
}

/** For a model id ending "-help-held": a help reply writes nothing until it is stopped. */
export const holdsHelp = (modelId: string, prompt: Prompt): boolean =>
  modelId.endsWith("-help-held") && HELP.test(block(lastUserText(prompt), "help"));

/** A help reply as the fake model named by its id's ending writes it; any other reply as it is. */
export function helpModelParts(modelId: string, prompt: Prompt, parts: StreamPart[]): StreamPart[] {
  if (modelId.endsWith("-notes-first")) return withNotesFirst(prompt, parts);
  if (modelId.endsWith("-moves-taken-back")) return withMovesTakenBack(prompt, parts);
  if (modelId.endsWith("-heading-only")) return headingOnly(prompt, parts);
  if (modelId.endsWith("-options-quoted")) return withOptionsQuoted(prompt, parts);
  if (modelId.endsWith("-cites-the-note")) return withNoteCited(prompt, parts);
  if (modelId.endsWith("-writes-before-it-cites")) return withTextBeforeCite(prompt, parts);
  return parts;
}
