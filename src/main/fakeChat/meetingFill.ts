/**
 * The smoke fixtures' framed Meeting facts (#2306), with ordinary cite records. A voice memo
 * (#1568) keeps its title and tidied-prose protocol.
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
  const memo = asked.includes("voice memo the User just");
  const at = /^\[([\d:]+)(?: [^\]]+)?\]\s*/.exec(firstLine);
  const selected =
    taken && !memo
      ? {
          ...taken.record,
          quote: String(taken.record.quote).replace(/^\[[^\]]*\]\s*/, ""),
          ...(at?.[1] && { location: at[1] }),
        }
      : taken?.record;
  if (first && taken && tools.includes("cite")) {
    const cited = toolResults(prompt, "cite");
    const record = cited.length === 0 ? selected : withSurroundingWords(cited, first, 1);
    if (record) return { tool: "cite", input: { citations: [record] } };
  }
  // A transcript line's time and speaker lead its text: "[0:04 Them] …".
  const said = String(taken?.record.quote ?? firstLine)
    .replace(/^\[[^\]]*\]\s*/, "")
    .replace(/[.?!。？！]+$/u, "");
  const cite = taken ? " [^1]" : "";
  if (memo) {
    const title = said.split(/\s+/).slice(0, 4).join(" ");
    return { text: `# ${title}\n\n${said}${cite}.` };
  }
  const notes = [...asked.matchAll(/^(L\d+): (.*)$/gm)];
  const partial = "Meeting fill fixture: partial";
  const empty = "Meeting fill fixture: empty";
  const fixture = notes.some((line) => line[2] === partial)
    ? "partial"
    : notes.some((line) => line[2] === empty)
      ? "empty"
      : null;
  const markers = notes
    .filter((line) => line[2] !== partial && line[2] !== empty)
    .flatMap((line) => line[1] ?? []);
  const headings = [...asked.matchAll(/^(H\d+) \(heading\): (.+)$/gm)];
  const chinese = /\p{Script=Han}/u.test(said);
  const definitions = [
    {
      marker: "SUMMARY",
      title: /^(?:Summary|摘要)$/i,
    },
    {
      marker: "DECISIONS",
      title: /^(?:Decisions|决定)$/i,
    },
    {
      marker: "ACTIONS",
      title: /^(?:Action items|待办|待办事项)$/i,
    },
  ];
  const routes = headings.map(
    (line) =>
      `${line[1]}=${definitions.find(({ title }) => title.test(line[2] ?? ""))?.marker ?? "NONE"}`,
  );
  const id = /Use new ids (P\d+_F)1/.exec(asked)?.[1] ?? "P1_F";
  const topic = chinese ? "通话事项" : "call detail";
  const purpose = chinese
    ? "通话讨论了工作重点和后续安排"
    : "The call reviewed priorities and follow-through";
  const frame = (suffix: number, label: string, citations: number[], body: string) => [
    `### FACT ${id}${suffix}`,
    "```json",
    JSON.stringify({
      topic: label,
      heading: label,
      citations,
      lines: markers,
      sections: ["decisions", "actions"],
      claim: false,
      supersedes: [],
    }),
    "```",
    body,
    `### END ${id}${suffix}`,
  ];
  const unrecorded = "An unrecorded meeting detail [^99].";
  return {
    text: [
      ...(routes.length > 0 ? [`HEADINGS: ${routes.join(" ")}`] : []),
      ...(fixture === "empty" ? [] : frame(1, topic, taken ? [1] : [], `${said}${cite}.`)),
      ...(fixture ? frame(2, "unrecorded detail", [99], unrecorded) : []),
      "### OVERVIEW",
      "```json",
      JSON.stringify({ citations: fixture === "empty" ? [99] : taken ? [1] : [] }),
      "```",
      fixture === "empty" ? unrecorded : `${purpose}${cite}.`,
      "### END OVERVIEW",
    ].join("\n\n"),
  };
}
