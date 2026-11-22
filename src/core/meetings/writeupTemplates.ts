import type { MeetingHelpTemplate, NoteEvent } from "../api";

const calendarTitles = [
  [/\binterview\b|面试|访谈/iu, "meeting-interview"],
  [/\bboard\b|董事会/iu, "meeting-board"],
  [/\b(?:stand[ -]?up|sync|weekly)\b|站会|例会|周会/iu, "meeting-team"],
  [/\b(?:1\s*:\s*1|one[ -]on[ -]one)\b|一对一/iu, "meeting-one-on-one"],
  [/\b(?:sales|demo|pricing|discovery)\b|销售|演示|报价|需求/iu, "meeting-sales"],
  [/\bclient\b|客户/iu, "meeting-client"],
  [/\blegal consultation\b|法律咨询/iu, "meeting-legal"],
] as const;

function domain(email: string | null): string | null {
  const at = email?.lastIndexOf("@") ?? -1;
  return at < 1
    ? null
    : email
        ?.slice(at + 1)
        .trim()
        .toLowerCase() || null;
}

export function calendarTemplate(event: Pick<NoteEvent, "title" | "attendees">): string | null {
  const title = event.title.normalize("NFKC");
  const named = calendarTitles.find(([pattern]) => pattern.test(title));
  if (named) return named[1];
  const guests = event.attendees.filter((person) => !person.self);
  const self = event.attendees.find((person) => person.self);
  if (!self) return null;
  if (guests.length === 1) return "meeting-one-on-one";
  const workplace = domain(self.email);
  return workplace &&
    guests.some((guest) => {
      const address = domain(guest.email);
      return address !== null && address !== workplace;
    })
    ? "meeting-client"
    : null;
}

export function helpTemplateForWriteup(name: string | null): MeetingHelpTemplate | null {
  switch (name) {
    case "meeting-sales":
      return "sales";
    case "meeting-interview":
      return "interview";
    case "meeting-team":
      return "team";
    default:
      return null;
  }
}

export interface WriteupTemplate {
  steps: string;
  fillUncovered: boolean;
}

export interface WriteupPlan extends WriteupTemplate {
  sections: readonly string[];
}

export function writeupPlan(template: WriteupTemplate, language: string): WriteupPlan {
  const sections = new Set<string>();
  let inSections = false;
  for (const line of template.steps.split(/\r?\n/u)) {
    const heading = /^#{2,6}\s+(.+)$/u.exec(line.trim())?.[1];
    if (heading) inSections = /^(?:sections|小节|章节)$/iu.test(heading.trim());
    const item = /^(?:[-*+]\s+|\d+[.)]\s+)(.+)$/u.exec(line.trim())?.[1]?.trim();
    if (!item) continue;
    const strong = /^\*\*(.+)\*\*$/u.exec(item)?.[1]?.trim();
    const title = strong ?? (inSections ? item : null);
    if (title && title.length <= 100) sections.add(title);
  }
  const written = [...sections];
  const rightLanguage = written.filter(
    (title) => /\p{Script=Han}/u.test(title) === language.startsWith("zh"),
  );
  return {
    ...template,
    sections: (rightLanguage.length > 0 ? rightLanguage : written).slice(0, 12),
  };
}

export function writeupInstructions(plan: WriteupPlan): string {
  return [
    "A Meeting template was chosen. Use its outline and writing guidance below subject to every requirement above, especially the reply format, transcript evidence and the user's own words.",
    ...(plan.sections.length
      ? [
          `Use these section titles in order, when supported by the Transcript: ${JSON.stringify(plan.sections)}. Use the exact title in a fact's heading unless an existing user heading already names the subject; in that case, use the exact words of the user's heading.`,
        ]
      : ["Follow the order described by the template when using your own short fact headings."]),
    plan.fillUncovered
      ? "Fill the user's lines and headings first. For a remaining relevant fact, use the template heading that fits. Omit unsupported sections; never invent material to fill them."
      : "Only fill the user's own lines and headings. Leave out facts that do not answer a line or belong under a heading the user wrote. Use the exact text of an applicable user heading.",
    "The template does not change which sources, tools, or data you can use. Do not insert its instructions into the Note.",
    `Template guidance (quoted Markdown): ${JSON.stringify(plan.steps)}`,
  ].join("\n");
}
