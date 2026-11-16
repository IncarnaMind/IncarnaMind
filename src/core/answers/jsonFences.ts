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

interface FactFrame {
  declared: number[];
  written: number[];
  body: number[];
}

/** Each fact's or overview's frame in `lines`: the markers its record declares, and its sentences' lines with theirs. */
function framesOf(lines: readonly string[]): FactFrame[] {
  const frames: FactFrame[] = [];
  let frame: (FactFrame & { read: boolean }) | null = null;
  let open: string | null = null;
  lines.forEach((line, index) => {
    if (FRAME_END.test(line)) {
      frame = null;
      open = null;
    }
    if (FRAME.test(line)) {
      frame = { declared: [], written: [], body: [], read: false };
      frames.push(frame);
      return;
    }
    if (!frame) return;
    if (open !== null) {
      if (fenceClosedBy(open, line)) open = null;
      else if (!frame.read) {
        frame.read = true;
        frame.declared = declaredIn(line);
      }
      return;
    }
    open = fenceOpened(line);
    if (open !== null) return;
    const written = [...line.matchAll(/\[\^(\d{1,4})\]/g)].map((found) => Number(found[1]));
    if (written.length === 0) return;
    frame.body.push(index);
    frame.written = [...new Set([...frame.written, ...written])];
  });
  return frames;
}

function declaredIn(json: string): number[] {
  try {
    const value: unknown = JSON.parse(json);
    const citations =
      typeof value === "object" && value !== null && "citations" in value ? value.citations : null;
    return Array.isArray(citations) && citations.every((each) => Number.isInteger(each))
      ? [...new Set(citations as number[])]
      : [];
  } catch {
    return [];
  }
}

/**
 * `text`, its fences closed, with a Meeting fact's one Citation marker written as the number its
 * record declares, where the sentence holds another. Claude Haiku 5.5 wrote [^1] after every fact,
 * as the instructions' example fact has it, under records that declared 1, 4, 5 and so on: a fact
 * is read only with the markers it declares, so seven of eight were left out (#3145).
 *
 * Only where the reply itself shows which number is the slip: the declared one is no other
 * frame's, declared or written, and the written one stands in another frame too. A reply that
 * repeats the declared number and writes the markers right is left as written: the declared
 * number's record would be another fact's quote.
 */
export function withDeclaredMarkers(text: string): string {
  const lines = text.split("\n");
  const frames = framesOf(lines);
  for (const frame of frames) {
    const [declared] = frame.declared;
    const [written] = frame.written;
    if (frame.declared.length !== 1 || frame.written.length !== 1) continue;
    if (declared === undefined || written === undefined || declared === written) continue;
    const others = frames.filter((other) => other !== frame);
    const slip =
      others.some((other) => other.written.includes(written)) &&
      !others.some(
        (other) => other.declared.includes(declared) || other.written.includes(declared),
      );
    if (!slip) continue;
    for (const index of frame.body) {
      lines[index] = (lines[index] ?? "").replaceAll(`[^${written}]`, `[^${declared}]`);
    }
  }
  return lines.join("\n");
}
