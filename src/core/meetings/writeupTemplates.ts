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
