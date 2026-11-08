import { kindName, TAG_KINDS } from "../../core/tags/kinds";
import { checksChangeClaims, fakeChangeClaims } from "./claims";
import { type GenerateOptions, SLOWLY } from "./prompt";
import { fakeSuggestion } from "./suggestion";

/** How long tagging a Document whose text says "slowly" takes: long enough for a test to Stop it. */
export const SLOW_TAGGING_MS = 1500;

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A tagging request (../../core/tags/classify): the kind, Tags and topic of each Document. */
const tags = (options: GenerateOptions): boolean => {
  const format = options.responseFormat;
  return format?.type === "json" && !!format.schema?.properties?.tagged;
};

/**
 * What a tagging request reads of its Documents, their names and text: the same Documents read
 * the same however the interface's language or the Tags offered change between requests.
 */
function taggingExcerpt(options: GenerateOptions): string | null {
  if (!tags(options)) return null;
  const input = JSON.parse(organizeInput(options) || "{}") as {
    documents?: { name: string; text: string }[];
  };
  return (input.documents ?? []).map((document) => `${document.name}\n${document.text}`).join("\n");
}

const organizeInput = (options: GenerateOptions): string => {
  const message = options.prompt.find((part) => part.role === "user");
  return message && typeof message.content !== "string"
    ? message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("")
    : "";
};

const organizes = (options: GenerateOptions): boolean => {
  const format = options.responseFormat;
  return format?.type === "json" && (!!format.schema?.properties?.groupId || plans(options));
};

/** Organize's whole-Library plan: its sort, its placings past the sample and its subfolders' names. */
function plans(options: GenerateOptions): boolean {
  const format = options.responseFormat;
  const properties = format?.type === "json" ? format.schema?.properties : undefined;
  return !!(
    (properties?.folders && properties.documents) ||
    properties?.placements ||
    properties?.groups
  );
}

/** Tagging, or Organize, takes a moment for a Document whose text says "slowly". */
export const tagsSlowly = (options: GenerateOptions): boolean =>
  SLOWLY.test(organizes(options) ? organizeInput(options) : (taggingExcerpt(options) ?? ""));

/** How many times each Document has found the model unreachable. */
const unreached = new Map<string, number>();

/**
 * A Document whose text says "unreachable" finds the model unreachable the first time it is
 * tagged or organized, and again on the quick retry that follows, as offline; one that says "stays
 * unreachable" every time.
 */
export function tagsUnreachable(options: GenerateOptions): boolean {
  const excerpt = taggingExcerpt(options) ?? (organizes(options) ? organizeInput(options) : null);
  if (!excerpt || !/\bunreachable\b/i.test(excerpt)) return false;
  if (/\bstays unreachable\b/i.test(excerpt)) return true;
  const times = unreached.get(excerpt) ?? 0;
  if (times >= 2) return false;
  unreached.set(excerpt, times + 1);
  return true;
}

const limitedOnce = new Set<string>();

/** A Document whose text says "rate-limited" meets the model's rate limit the first time it is tagged. */
export function tagsRateLimited(options: GenerateOptions): boolean {
  const excerpt = taggingExcerpt(options);
  if (!excerpt || !/\brate-limited\b/i.test(excerpt) || limitedOnce.has(excerpt)) return false;
  limitedOnce.add(excerpt);
  return true;
}

const creditOnce = new Set<string>();

/**
 * A Document whose text says "out of credit" meets an account with none the first time it is
 * tagged or organized: the second run sorts it, as if the credit was added.
 */
export function tagsOutOfCredit(options: GenerateOptions): boolean {
  const excerpt = taggingExcerpt(options) ?? (organizes(options) ? organizeInput(options) : null);
  if (!excerpt || !/\bout of credit\b/i.test(excerpt) || creditOnce.has(excerpt)) return false;
  creditOnce.add(excerpt);
  return true;
}

/** Whether a name appears as a word (ignoring case) in the text. */
const says = (text: string, name: string) =>
  new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(name)}(?![\\p{L}\\p{N}])`, "iu").test(text);

/**
 * The scripted tagger: for each Document, the first kind whose English or Chinese name its name
 * or text says, the offered Tags whose names it says, and its "Subject: …" line as its topic.
 */
function fakeTagged(options: GenerateOptions): string {
  const input = JSON.parse(organizeInput(options) || "{}") as {
    tags?: { id: string; name: string }[];
    documents?: { ref: string; name: string; text: string; tags?: string[] }[];
  };
  return JSON.stringify({
    tagged: (input.documents ?? []).map((document) => {
      const said = `${document.name}\n${document.text}`;
      const kind = TAG_KINDS.find((each) =>
        [kindName(each, "en"), kindName(each, "zh-CN")].some((name) => says(said, name)),
      );
      const [topic] = fakeNewTags(document.text);
      return {
        ref: document.ref,
        kind: kind ?? "none",
        tags: (input.tags ?? [])
          .filter((tag) => document.tags?.includes(tag.id) && says(said, tag.name))
          .map((tag) => tag.id),
        topic: topic ?? { name: "", description: "" },
      };
    }),
  });
}

/** The new Tag a Document's text names on a line "Subject: …" ("主题：…"), as the scripted model's own. */
function fakeNewTags(text: string): { name: string; description: string }[] {
  const named = /(?:^|\n)\s*(?:Subject:|主题：)\s*([^\n]+)/u.exec(text)?.[1]?.trim();
  return named ? [{ name: named, description: `Documents about ${named}.` }] : [];
}

/**
 * The scripted Folder proposal: one Folder for each first word the Documents' names share, or a
 * Document's line "Project: …" ("项目：…"), at most six.
 */
function fakeFolders(options: GenerateOptions): string {
  const input = JSON.parse(organizeInput(options) || "{}") as {
    folders?: string[];
    documents?: { name: string; text: string }[];
  };
  const taken = new Set((input.folders ?? []).map((name) => name.toLowerCase()));
  const names: string[] = [];
  for (const document of input.documents ?? []) {
    const project = /(?:Project:|项目：)\s*([^\n]+)/u.exec(document.text)?.[1]?.trim();
    const word = document.name.split(/[\s._-]+/u)[0] ?? "";
    const name = project ?? (word && `${word.charAt(0).toUpperCase()}${word.slice(1)}`);
    if (!name || taken.has(name.toLowerCase())) continue;
    taken.add(name.toLowerCase());
    names.push(name);
  }
  return JSON.stringify({
    folders: names.slice(0, 6).map((name) => ({ name, description: `Documents about ${name}.` })),
  });
}

interface PlanDocument {
  ref: string;
  name: string;
  text?: string;
}

/** The Folder a Document is about: one there is whose name it says, else its "Project: …" or first word. */
function fakeArea(
  document: Pick<PlanDocument, "name" | "text">,
  folders: readonly { id: string; name: string }[],
): { id: string; name: string } {
  const said = `${document.name} ${document.text ?? ""}`.toLowerCase();
  const known = folders.find((folder) => folder.name && said.includes(folder.name.toLowerCase()));
  if (known) return known;
  const project = /(?:Project:|项目：)\s*([^\n]+)/u.exec(document.text ?? "")?.[1]?.trim();
  const word = document.name.split(/[\s._-]+/u)[0] ?? "";
  return { id: "", name: project ?? `${word.charAt(0).toUpperCase()}${word.slice(1)}` };
}

/**
 * The scripted plan: each Document into the Folder its name or text names, or a new one for its
 * "Project: …" line or first word; placings the same way, or none; a subfolder named after the
 * first word its first Document's name has.
 */
function fakePlanOutput(options: GenerateOptions): string {
  const input = JSON.parse(organizeInput(options) || "{}") as {
    folders?: { id: string; name: string; description?: string }[];
    documents?: PlanDocument[];
    groups?: { ref: string; documents?: { name: string }[] }[];
  };
  const format = options.responseFormat;
  const properties = format?.type === "json" ? format.schema?.properties : undefined;
  const folders = input.folders ?? [];
  if (properties?.placements) {
    return JSON.stringify({
      placements: (input.documents ?? []).map((document) => {
        const area = fakeArea(document, folders);
        return { ref: document.ref, folder: area.id || "none" };
      }),
    });
  }
  if (properties?.groups) {
    const taken = new Set<string>();
    return JSON.stringify({
      groups: (input.groups ?? []).map((group, at) => {
        const word = group.documents?.[0]?.name.split(/[\s._-]+/u)[0] ?? "";
        let name = word ? `${word.charAt(0).toUpperCase()}${word.slice(1)}` : `Part ${at + 1}`;
        if (taken.has(name.toLowerCase())) name = `${name} ${at + 1}`;
        taken.add(name.toLowerCase());
        return { ref: group.ref, name, description: `Documents about ${name}.` };
      }),
    });
  }
  const listed = new Map<string, { key: string; name: string; description: string }>();
  const placed: { ref: string; folder: string }[] = [];
  for (const document of input.documents ?? []) {
    const area = fakeArea(document, folders);
    if (!area.name) {
      placed.push({ ref: document.ref, folder: "none" });
      continue;
    }
    const known = area.id || area.name.toLowerCase();
    let folder = listed.get(known);
    if (!folder) {
      folder = {
        key:
          area.id ||
          `N${[...listed.values()].filter((each) => /^N\d+$/.test(each.key)).length + 1}`,
        name: area.name,
        description: `Documents about ${area.name}.`,
      };
      listed.set(known, folder);
    }
    placed.push({ ref: document.ref, folder: folder.key });
  }
  return JSON.stringify({ folders: [...listed.values()], documents: placed });
}

const proposesFolders = (options: GenerateOptions): boolean => {
  const format = options.responseFormat;
  return format?.type === "json" && !!format.schema?.properties?.folders;
};

/** Test-only classifier: chooses a group whose name appears in the excerpt. */
export function fakeStructuredOutput(options: GenerateOptions): string {
  if (plans(options)) return fakePlanOutput(options);
  if (proposesFolders(options)) return fakeFolders(options);
  if (checksChangeClaims(options))
    return fakeChangeClaims(options) ?? JSON.stringify({ claims: [] });
  const format = options.responseFormat;
  const schema = format?.type === "json" ? format.schema : undefined;
  if (schema?.properties?.quote && schema.properties.passage) return fakeSuggestion(options);
  if (schema?.properties?.groupId) {
    const input = JSON.parse(organizeInput(options)) as {
      groups: { id: string; name: string }[];
      tags?: { id: string; name: string }[];
      document: { name: string; text: string };
    };
    const document = `${input.document.name} ${input.document.text}`.toLowerCase();
    const selected = input.groups.find((group) => document.includes(group.name.toLowerCase()));
    const kind = (input.tags ?? []).find(
      (tag) => tag.id.startsWith("kind:") && says(document, tag.name),
    );
    return JSON.stringify({
      groupId: selected?.id ?? "__unsorted__",
      tags: (input.tags ?? [])
        .filter((tag) => (tag.id.startsWith("kind:") ? tag === kind : says(document, tag.name)))
        .map((tag) => tag.id),
    });
  }
  if (tags(options)) return fakeTagged(options);
  return JSON.stringify({});
}
