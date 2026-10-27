/**
 * Filling a Meeting's notes in after Stop (#142): each of the User's lines gets the transcript's
 * first line under it, cited; with no notes, a summary and a decision, each citing it. A voice
 * memo (#1568) gets its first line's first words as its title, and that line, cited. In the
 * call's language, as its lines are said.
 */
import { passagesIn, recordFor, withSurroundingWords } from "./passages";
import { lastUserText, type Prompt, type Reply, toolResults } from "./prompt";

const FILLING = /Fill them in from the transcript|The User took no notes|voice memo the User just/;

const block = (text: string, tag: string) =>
  new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`).exec(text)?.[1] ?? "";

export function fillReply(prompt: Prompt, tools: readonly string[]): Reply | null {
  const asked = lastUserText(prompt);
  if (!FILLING.test(asked)) return null;
  const heard = passagesIn(block(asked, "live-transcript"));
  const first = heard[0];
  const firstLine = first?.text.split("\n").find((line) => line.trim() !== "") ?? "";
  const taken = first && recordFor(first, firstLine, 1);
  if (first && taken && tools.includes("cite")) {
    const cited = toolResults(prompt, "cite");
    const record = cited.length === 0 ? taken.record : withSurroundingWords(cited, first, 1);
    if (record) return { tool: "cite", input: { citations: [record] } };
  }
  // A transcript line's time and speaker lead its text: "[0:04 Them] …".
  const said = String(taken?.record.quote ?? firstLine)
    .replace(/^\[[^\]]*\]\s*/, "")
    .replace(/[.?!。？！]+$/u, "");
  const cite = taken ? " [^1]" : "";
  if (asked.includes("voice memo the User just")) {
    const title = said.split(/\s+/).slice(0, 4).join(" ");
    return { text: `# ${title}\n\n${said}${cite}.` };
  }
  const markers = [...asked.matchAll(/^(L\d+): /gm)].map((match) => match[1] as string);
  if (markers.length > 0) {
    return { text: markers.map((marker) => `### ${marker}\n${said}${cite}.`).join("\n\n") };
  }
  return { text: `### SUMMARY\n${said}${cite}.\n\n### DECISIONS\n- ${said}${cite}.` };
}
