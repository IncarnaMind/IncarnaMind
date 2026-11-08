const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FRAME = /^ {0,3}#{1,6}[ \t]+(?:FACT[ \t]+\S+|OVERVIEW)[ \t]*$/;

/**
 * `text` with each Meeting fact's or overview's ```json fence closed where a model left it open
 * after its one JSON line: the paragraph after it, and every frame that follows, would otherwise
 * read as code. DeepSeek V4.1 Flash left every fence after the first one open in 3 of 23 replies,
 * all to Chinese calls (#2306).
 */
export function withJsonFencesClosed(text: string): string {
  const lines = text.split("\n");
  const closed: string[] = [];
  let open: string | null = null;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    closed.push(line);
    const fence = FENCE.exec(line);
    const delimiter = fence?.[1];
    if (open !== null) {
      if (
        delimiter !== undefined &&
        delimiter[0] === open[0] &&
        delimiter.length >= open.length &&
        fence?.[2]?.trim() === ""
      )
        open = null;
      continue;
    }
    if (!delimiter) continue;
    open = delimiter;
    const json = lines[index + 1];
    const after = lines[index + 2];
    if (
      line.trim() === "```json" &&
      FRAME.test(lines[index - 1] ?? "") &&
      json !== undefined &&
      /^\{.*\}$/.test(json.trim()) &&
      after !== undefined &&
      !FENCE.test(after)
    ) {
      closed.push(json, "```");
      index++;
      open = null;
    }
  }
  return closed.join("\n");
}
