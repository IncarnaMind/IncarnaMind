/**
 * A fence's opening line: its run of backticks or tildes, else null. What follows the run holds no
 * backtick.
 */
export const fenceOpened = (line: string): string | null =>
  /^ {0,3}(`{3,}|~{3,})[^`]*$/.exec(line)?.[1] ?? null;

/** Whether `line` closes the fence `opened` began: its character, as long a run or longer, blanks after. */
export function fenceClosedBy(opened: string, line: string): boolean {
  const run = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line)?.[1];
  return run !== undefined && run[0] === opened[0] && run.length >= opened.length;
}

// A fact's opening line may hold more after its id, such as a title, which is not read (#3106).
const FRAME = /^ {0,3}#{1,6}[ \t]+(?:FACT[ \t]+\S+(?:[ \t].*)?|OVERVIEW[ \t]*)$/;
const FRAME_END =
  /^ {0,3}#{1,6}[ \t]+(?:END[ \t]+\S+[ \t]*|FACT[ \t]+\S+(?:[ \t].*)?|OVERVIEW[ \t]*)$/;

/** Whether a fence closes `opener` before the frame it opened in ends, or the next frame begins. */
function closedInFrame(lines: readonly string[], from: number, opener: string): boolean {
  for (const line of lines.slice(from)) {
    if (FRAME_END.test(line)) return false;
    if (fenceClosedBy(opener, line)) return true;
  }
  return false;
}

/**
 * `text` with each Meeting fact's or overview's ```json fence closed after its one JSON line where
 * a model left it open: the paragraph after it, and every frame that follows, would otherwise read
 * as code. A fence the model closes anywhere before the frame ends is left as written. DeepSeek
 * V4.1 Flash left every fence after the first one open in 3 of 23 replies, all to Chinese calls
 * (#2306).
 *
 * Any other fence still open at a frame's line is closed before it. Claude Haiku 5.5 wrote a fence
 * line after a fact's end line, and the ten facts after it read as code: none was kept or counted
 * (#3145).
 */
export function withJsonFencesClosed(text: string): string {
  const lines = text.split("\n");
  const closed: string[] = [];
  let open: string | null = null;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (open !== null && FRAME_END.test(line)) {
      closed.push(open);
      open = null;
    }
    closed.push(line);
    if (open !== null) {
      if (fenceClosedBy(open, line)) open = null;
      continue;
    }
    const delimiter = fenceOpened(line);
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
