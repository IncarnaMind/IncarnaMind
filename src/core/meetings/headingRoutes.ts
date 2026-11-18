import { type FillLine, type FillSection, headingOf, sectionOf } from "./fillPrompt";

function unwrapped(value: string): string {
  let text = value.trim();
  for (;;) {
    const match = /^(`+|\*\*)(.*?)\1$/.exec(text);
    const wrapper = match?.[1];
    const inner = match?.[2];
    if (!wrapper || inner === undefined || inner.includes(wrapper)) return text;
    text = inner.trim();
  }
}

/** What each `name:` control line before the reply's first frame declares. */
function declared(markdown: string, name: string): string[] {
  const preamble = markdown.split(/^ {0,3}#{1,6}(?:[ \t]|$)/m, 1)[0] ?? "";
  const line = new RegExp(
    `^(?:${name}[ \\t]*[:：]|(\`+|\\*\\*)${name}(?:[ \\t]*[:：]\\1|\\1[ \\t]*[:：]))[ \\t]*(.*)$`,
    "i",
  );
  return preamble.split(/\r?\n/).flatMap((each) => {
    const match = line.exec(unwrapped(unwrapped(each).replace(/^-[ \t]+/, "")));
    return match ? [match[2] ?? ""] : [];
  });
}

const entriesOf = (declaration: string): string[] =>
  declaration.trim()
    ? unwrapped(unwrapped(declaration).replace(/[.。]$/, ""))
        .replace(/\s*[=＝]\s*/g, "=")
        .split(/\s*[,，、|]\s*|\s+/)
        .map(unwrapped)
    : [];

/**
 * The ordinary lines a reply says its transcript doesn't answer. Null when the reply doesn't say,
 * or says it in a way that can't be read: then nothing is known of any line.
 */
export function unansweredLines(
  markdown: string,
  lines: readonly FillLine[],
): ReadonlySet<string> | null {
  const declarations = declared(markdown, "UNANSWERED");
  const [declaration] = declarations;
  if (declaration === undefined || declarations.length > 1) return null;
  const ordinary = new Set(lines.filter((line) => !line.heading).map((line) => line.marker));
  const entries = entriesOf(declaration).map((entry) => entry.toUpperCase());
  if (entries.length === 0) return null;
  if (entries.length === 1 && entries[0] === "NONE") return new Set();
  return entries.every((entry) => ordinary.has(entry)) ? new Set(entries) : null;
}

/** Whether a reply says its transcript holds little to note: its one QUIET control line, YES. */
export function saysQuiet(markdown: string): boolean {
  const declarations = declared(markdown, "QUIET");
  const [declaration] = declarations;
  if (declaration === undefined || declarations.length > 1) return false;
  const entries = entriesOf(declaration);
  return entries.length === 1 && entries[0]?.toUpperCase() === "YES";
}

/** Null rejects invalid or incomplete routing; an empty map keeps default section placement. */
export function headingRoutes(
  markdown: string,
  markers: readonly string[],
  lines: readonly FillLine[],
): Map<FillSection, string> | null {
  const headings = new Set(lines.filter((line) => line.heading).map((line) => line.marker));
  const choices = new Map<string, FillSection | null>();
  const declarations = declared(markdown, "HEADINGS");
  if (declarations.length > 1) return null;
  const declaration = declarations[0];
  if (declaration !== undefined) {
    for (const entry of entriesOf(declaration)) {
      const match = /^(H\d+)=(SUMMARY|DECISIONS|ACTIONS|QUESTIONS|CLAIMS|NONE)$/i.exec(entry);
      const heading = match?.[1]?.toUpperCase();
      const value = match?.[2]?.toUpperCase();
      if (!heading || !value || !headings.has(heading) || choices.has(heading)) return null;
      choices.set(heading, value === "NONE" ? null : sectionOf(value));
    }
  }
  let hasSections = false;
  for (const marker of markers) {
    const section = sectionOf(marker);
    if (!section) continue;
    hasSections = true;
    const heading = headingOf(marker);
    if (!heading) continue;
    if (!headings.has(heading)) {
      if (headings.size > 0) return null;
      continue;
    }
    if (choices.has(heading) && choices.get(heading) !== section) return null;
    choices.set(heading, section);
  }
  if (hasSections && [...headings].some((heading) => !choices.has(heading))) return null;
  const routes = new Map<FillSection, string>();
  for (const [heading, section] of choices) {
    if (section === null) continue;
    if (routes.has(section)) return null;
    routes.set(section, heading);
  }
  return routes;
}
