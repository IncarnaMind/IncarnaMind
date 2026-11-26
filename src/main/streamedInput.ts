/**
 * What a call of IncarnaMind's server is writing, read from its input as Claude Code streams it
 * (`input_json_delta`, JSON cut anywhere), for the line above a Note's input (#3677): the
 * paragraph a change or a new Note is writing now, and the Passage the quote it writes is from.
 */

/** Where each Tool that writes text into a Note keeps it in its input. */
const TEXT_FIELD: Readonly<Record<string, string>> = {
  propose_changes: "text",
  create_mind: "markdown",
};

/** The Tools whose input quotes a Passage by its id, one quote after another. */
const QUOTES: ReadonlySet<string> = new Set(["cite"]);

/** The text of a JSON string from just after its opening quote, as far as it has come. */
function stringSoFar(rest: string): string {
  let out = "";
  for (let at = 0; at < rest.length; at++) {
    const char = rest[at];
    if (char === '"') return out;
    if (char !== "\\") {
      out += char;
      continue;
    }
    const next = rest[at + 1];
    if (next === undefined) return out;
    if (next === "u") {
      const code = rest.slice(at + 2, at + 6);
      if (!/^[0-9a-fA-F]{4}$/.test(code)) return out;
      out += String.fromCharCode(Number.parseInt(code, 16));
      at += 5;
      continue;
    }
    out += { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f" }[next] ?? next;
    at += 1;
  }
  return out;
}

/** The value, as far as it has come, of the last `field` the JSON so far has begun; null for none. */
function lastStringField(json: string, field: string): string | null {
  // A key is a quote, its name and a closing quote: inside a string value the quotes are escaped.
  const keys = [...json.matchAll(new RegExp(`"${field}"\\s*:\\s*"`, "g"))];
  const last = keys.at(-1);
  if (!last) return null;
  return stringSoFar(json.slice(last.index + last[0].length));
}

/** The paragraph a call that writes into a Note is writing now, as far as it has come; null for none. */
export function writingNow(tool: string, json: string): string | null {
  const field = TEXT_FIELD[tool];
  if (!field) return null;
  const text = lastStringField(json, field);
  if (text === null) return null;
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .findLast((line) => line !== "") ?? null
  );
}

/** The Passage of the last quote a call that quotes has named whole so far; null for none. */
export function quotingNow(tool: string, json: string): string | null {
  if (!QUOTES.has(tool)) return null;
  const ids = [...json.matchAll(/"passageId"\s*:\s*"((?:[^"\\]|\\.)*)"/g)];
  return ids.at(-1)?.[1] ?? null;
}
