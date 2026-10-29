import { EXCERPT_END, EXCERPT_START } from "../../core/tags/classify";
import { fakeAbsenceAnswer } from "./checks";
import { checksChangeClaims, fakeChangeClaims } from "./claims";
import { type GenerateOptions, type Prompt, SLOWLY } from "./prompt";
import { fakeSuggestion } from "./suggestion";

/** How long tagging a Document whose text says "slowly" takes: long enough for a test to Stop it. */
export const SLOW_TAGGING_MS = 1500;

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function excerptOf(prompt: Prompt): string {
  const text = prompt
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : message.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
    )
    .join("\n");
  // The instructions name the markers too: the excerpt is between the last ones.
  return text.slice(text.lastIndexOf(EXCERPT_START), text.lastIndexOf(EXCERPT_END));
}

const taggingExcerpt = (options: GenerateOptions): string | null => {
  const format = options.responseFormat;
  const schema = format?.type === "json" ? format.schema : undefined;
  return schema?.properties?.tags && !schema.properties.groupId ? excerptOf(options.prompt) : null;
};

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
  return format?.type === "json" && !!format.schema?.properties?.groupId;
};

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

/**
 * The scripted tagger: of the Tag names offered, those that appear as a word
 * (ignoring case) in the Document's excerpt, i.e. its name or text.
 */
function fakeTags(prompt: Prompt, offered: readonly string[]): string[] {
  const excerpt = excerptOf(prompt);
  return offered.filter((name) =>
    new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(name)}(?![\\p{L}\\p{N}])`, "iu").test(excerpt),
  );
}

/** The Tag names a tagging request's structured output may choose from. */
function offeredTags(options: GenerateOptions): string[] {
  const format = options.responseFormat;
  const schema = (format?.type === "json" ? format.schema : undefined) as
    | { properties?: { tags?: { items?: { enum?: unknown[] } } } }
    | undefined;
  const names: unknown[] = schema?.properties?.tags?.items?.enum ?? [];
  return names.filter((name): name is string => typeof name === "string");
}

/** Test-only classifier: chooses a group whose name appears in the excerpt. */
export function fakeStructuredOutput(options: GenerateOptions): string {
  const absence = fakeAbsenceAnswer(options);
  if (absence !== null) return absence;
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
    return JSON.stringify({
      groupId: selected?.id ?? "__unsorted__",
      tags: (input.tags ?? [])
        .filter((tag) => document.includes(tag.name.toLowerCase()))
        .map((tag) => tag.id),
    });
  }
  return JSON.stringify({ tags: fakeTags(options.prompt, offeredTags(options)) });
}
