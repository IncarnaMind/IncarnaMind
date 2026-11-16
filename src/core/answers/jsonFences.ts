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
  /** The line of the frame's record, and the markers it declares; null when it can't be read. */
  record: number;
  declared: number[] | null;
  written: number[];
  body: number[];
}

/** Each fact's or overview's frame in `lines`: its record with the markers it declares, and its sentences' lines with theirs. */
function framesOf(lines: readonly string[]): FactFrame[] {
  const frames: FactFrame[] = [];
  let frame: FactFrame | null = null;
  let open: string | null = null;
  lines.forEach((line, index) => {
    if (FRAME_END.test(line)) {
      frame = null;
      open = null;
    }
    if (FRAME.test(line)) {
      frame = { record: -1, declared: null, written: [], body: [] };
      frames.push(frame);
      return;
    }
    if (!frame) return;
    if (open !== null) {
      if (fenceClosedBy(open, line)) open = null;
      else if (frame.record < 0) {
        frame.record = index;
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

function recordOf(json: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(json);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function declaredIn(json: string): number[] | null {
  const citations = recordOf(json)?.citations;
  return Array.isArray(citations) && citations.every((each) => Number.isInteger(each))
    ? [...new Set(citations as number[])]
    : null;
}

const sameNumbers = (one: readonly number[], other: readonly number[]) =>
  one.length === other.length && one.every((each) => other.includes(each));

/**
 * `text`, its fences closed, with each Meeting fact's record and sentences naming the same
 * Citation markers, where the reply shows which of the two is right. A fact is read only with the
 * markers its record declares, and Claude Haiku 5.5 numbers the two apart in two ways, both after
 * the instructions' example (a fact with 1, the overview with 2 and 3): a fill then left six of
 * its seven items out, another seven of eight (#3145).
 *
 * - The sentences' markers are no other frame's: a Citation's record goes by the marker in the
 *   text, so the record declares what its sentences write.
 * - Several frames write the same marker ([^1] after every fact): a frame's one marker is written
 *   as the one number its record declares, when that number is no other frame's.
 *
 * Anything else is left as written, and that fact is left out as before.
 */
export function withMarkersAgreed(text: string): string {
  const lines = text.split("\n");
  const frames = framesOf(lines);
  for (const frame of frames) {
    const { declared, written } = frame;
    if (!declared || written.length === 0 || sameNumbers(declared, written)) continue;
    const others = frames.filter((other) => other !== frame);
    if (!others.some((other) => written.some((marker) => other.written.includes(marker)))) {
      const record = recordOf(lines[frame.record] ?? "");
      if (record) lines[frame.record] = JSON.stringify({ ...record, citations: written });
      continue;
    }
    const [number] = declared;
    const [marker] = written;
    if (declared.length !== 1 || written.length !== 1) continue;
    if (number === undefined || marker === undefined) continue;
    if (others.some((other) => other.declared?.includes(number) || other.written.includes(number)))
      continue;
    for (const index of frame.body) {
      lines[index] = (lines[index] ?? "").replaceAll(`[^${marker}]`, `[^${number}]`);
    }
  }
  return lines.join("\n");
}
