const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FRAME = /^ {0,3}#{1,6}[ \t]+(?:FACT[ \t]+\S+|OVERVIEW)[ \t]*$/;
const FRAME_END = /^ {0,3}#{1,6}[ \t]+(?:END[ \t]+\S+|FACT[ \t]+\S+|OVERVIEW)[ \t]*$/;

/** Whether a fence closes `opener` before the frame it opened in ends, or the next frame begins. */
function closedInFrame(lines: readonly string[], from: number, opener: string): boolean {
  for (const line of lines.slice(from)) {
    if (FRAME_END.test(line)) return false;
    const fence = FENCE.exec(line);
    const delimiter = fence?.[1];
    if (
      delimiter !== undefined &&
      delimiter[0] === opener[0] &&
      delimiter.length >= opener.length &&
      fence?.[2]?.trim() === ""
    )
      return true;
  }
  return false;
}

/**
 * `text` with each Meeting fact's or overview's ```json fence closed after its one JSON line where
 * a model left it open: the paragraph after it, and every frame that follows, would otherwise read
 * as code. A fence the model closes anywhere before the frame ends is left as written. DeepSeek
 * V4.1 Flash left every fence after the first one open in 3 of 23 replies, all to Chinese calls
 * (#2306).
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
    if (
      line.trim() === "```json" &&
      FRAME.test(lines[index - 1] ?? "") &&
      json !== undefined &&
      /^\{.*\}$/.test(json.trim()) &&
      !closedInFrame(lines, index + 2, delimiter)
    ) {
      closed.push(json, "```");
      index++;
      open = null;
    }
  }
  return closed.join("\n");
}
