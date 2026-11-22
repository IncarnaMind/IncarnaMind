import { lastUserText, type Prompt, type Reply, toolResults } from "./prompt";
import { wordsAndPairs } from "./suggestion";

const ABOUT_THE_SCREEN = /\b(?:screen|slide)\b|屏幕|幻灯片/i;

/**
 * The scripted Answer to a Question about the shared screen, given one: it
 * cites the newest screen's line that shares the most with the Question, then
 * says the screen shows it, in the Question's language.
 */
export function screenReply(
  prompt: Prompt,
  question: string,
  tools: readonly string[],
): Reply | null {
  if (!ABOUT_THE_SCREEN.test(question) || !tools.includes("cite")) return null;
  const screens = [
    ...lastUserText(prompt).matchAll(
      /<shared-screen id="(S\d+)"[^>]*>\n([\s\S]*?)\n<\/shared-screen>/g,
    ),
  ];
  const screen = screens.at(-1);
  if (!screen) return null;
  if (toolResults(prompt, "cite").length > 0) {
    return {
      text: /\p{Script=Han}/u.test(question)
        ? "屏幕上写着这个 [^1]。"
        : "The shared screen shows it [^1].",
    };
  }
  const asked = new Set(wordsAndPairs(question));
  const lines = (screen[2] ?? "").split("\n").filter((line) => line.trim() !== "");
  let quote = lines[0] ?? "";
  let best = 0;
  for (const line of lines) {
    const shared = wordsAndPairs(line).filter((word) => asked.has(word)).length;
    if (shared > best) {
      best = shared;
      quote = line;
    }
  }
  return { tool: "cite", input: { citations: [{ marker: 1, passage: screen[1], quote }] } };
}
