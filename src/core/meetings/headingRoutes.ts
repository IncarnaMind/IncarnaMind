import { type FillLine, type FillSection, headingOf, sectionOf } from "./fillPrompt";

export function headingRoutes(
  markdown: string,
  markers: readonly string[],
  lines: readonly FillLine[],
): Map<FillSection, string> | null {
  const headings = new Set(lines.filter((line) => line.heading).map((line) => line.marker));
  const choices = new Map<string, FillSection | null>();
  const preamble = markdown.split(/^ {0,3}#{1,6}(?:[ \t]|$)/m, 1)[0] ?? "";
  const declarations = [...preamble.matchAll(/^HEADINGS:[ \t]*(.*)$/gm)];
  if (declarations.length > 1) return null;
  const declaration = declarations[0];
  if (declaration) {
    for (const entry of (declaration[1] ?? "").trim().split(/\s+/).filter(Boolean)) {
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
