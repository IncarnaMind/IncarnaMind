import type { CloudTranscriptionRoute, RerankServiceKind } from "../../../../core/api";
import type { Language } from "../../../../core/language";
import type { CatalogProvider } from "../../../../core/providers/catalog";
import {
  DECISION_HOST_ENTRIES,
  type DecisionHost,
} from "../../../../core/providers/catalog/decisions";
import { CATALOG_PROVIDERS } from "../../../../core/providers/catalog/providers";
import { TRANSCRIPTION_SERVICES } from "../../../../core/providers/catalog/transcription";

/** A plan the User signs in to rather than giving a key. */
export type PlanId = "chatgpt" | "claude-account" | "copilot";

/** What one entry of "Add an account or key" sets up, and so the page it opens. */
export type ServiceEntry =
  | { kind: "plan"; plan: PlanId }
  | { kind: "provider"; provider: CatalogProvider }
  | { kind: "transcription"; route: CloudTranscriptionRoute }
  | { kind: "decision"; host: DecisionHost }
  | { kind: "jev" }
  | { kind: "rerank"; service: RerankServiceKind };

/** The jobs a service can do, as its entry is tagged. */
export type ServiceJob = "answers" | "transcription" | "search" | "organize" | "hints";

export type DirectoryGroup = "plans" | "popular" | "local" | "meetings" | "organize" | "more";

export const DIRECTORY_GROUPS: readonly DirectoryGroup[] = [
  "plans",
  "popular",
  "local",
  "meetings",
  "organize",
  "more",
];

/** What most Users of the language set up first (#179). */
const POPULAR: Record<Language, readonly string[]> = {
  en: ["anthropic", "openai", "google", "openrouter", "deepseek", "qwen"],
  "zh-CN": ["deepseek", "qwen", "kimi", "glm", "siliconflow", "openrouter"],
};

const PLANS: readonly PlanId[] = ["chatgpt", "claude-account", "copilot"];

const ROUTES = Object.values(TRANSCRIPTION_SERVICES);

/** The chat provider whose key a transcription route or decision host uses, by its catalog id. */
const transcribes = (catalogId: string) =>
  ROUTES.some((each) => each.key === "provider" && (each.provider ?? each.route) === catalogId);
const sortsWith = (catalogId: string) =>
  Object.values(DECISION_HOST_ENTRIES).some(
    (each) => each.key === "provider" && each.provider === catalogId,
  );
/**
 * The companies whose own API searches Documents with the User's account's key: by meaning, or
 * putting the best results first (Cohere).
 */
const SEARCHES: ReadonlySet<string> = new Set(["openai", "google", "ollama", "cohere"]);

export function jobsOf(entry: ServiceEntry): ServiceJob[] {
  switch (entry.kind) {
    case "plan":
      return ["answers"];
    case "transcription":
      return ["transcription"];
    case "decision":
    case "jev":
      return ["organize", "hints"];
    case "rerank":
      return ["search"];
    case "provider": {
      const id = entry.provider.id;
      return [
        "answers",
        ...(transcribes(id) ? (["transcription"] as const) : []),
        ...(SEARCHES.has(id) ? (["search"] as const) : []),
        ...(sortsWith(id) || id === "ollama" ? (["organize"] as const) : []),
      ];
    }
  }
}

/** One key per entry, the same wherever the directory is shown. */
export function entryKey(entry: ServiceEntry): string {
  switch (entry.kind) {
    case "plan":
      return `plan:${entry.plan}`;
    case "provider":
      return `provider:${entry.provider.id}`;
    case "transcription":
      return `transcription:${entry.route}`;
    case "decision":
      return `decision:${entry.host}`;
    case "jev":
      return "jev";
    case "rerank":
      return `rerank:${entry.service}`;
  }
}

/** The name an entry goes by, in both languages; a plan's comes from the interface's words. */
export function entryName(entry: ServiceEntry, language: Language): string | null {
  const words = language === "zh-CN" ? "zh" : "en";
  switch (entry.kind) {
    case "plan":
      return null;
    case "provider":
      return entry.provider.name[words];
    case "transcription":
      return TRANSCRIPTION_SERVICES[entry.route].name;
    case "decision":
      return DECISION_HOST_ENTRIES[entry.host].name[words];
    case "jev":
      return "TypeSafe Jev";
    case "rerank":
      return entry.service === "cohere" ? "Cohere" : "Voyage AI";
  }
}

const OWN_KEY_ROUTES = ROUTES.filter((each) => each.key === "own").map((each) => each.route);
const OWN_KEY_HOSTS = Object.values(DECISION_HOST_ENTRIES)
  .filter((each) => each.key === "own")
  .map((each) => each.host);
/** The reranking services that are no company of the catalog's: their key is for reranking alone. */
const RERANK: readonly RerankServiceKind[] = (["cohere", "voyage"] as const).filter(
  (service) => !CATALOG_PROVIDERS.some((each) => each.id === service),
);

/**
 * Every service the User can set up, each once, in the directory's groups: the plans they sign in
 * to, the keys most Users of the language add, what runs on this computer, the services for
 * meetings only and for Organize only, then the rest. `offered` leaves out a plan this copy can't
 * set up. `matches` filters by name: a group with nothing left is left out.
 */
export function serviceDirectory(
  language: Language,
  {
    offered = () => true,
    name,
    query = "",
  }: {
    offered?(plan: PlanId): boolean;
    /** An entry's shown name, which the search matches. */
    name(entry: ServiceEntry): string;
    query?: string;
  },
): { group: DirectoryGroup; entries: ServiceEntry[] }[] {
  const popular = POPULAR[language];
  const provider = (each: CatalogProvider): ServiceEntry => ({ kind: "provider", provider: each });
  const words = query.trim().toLocaleLowerCase();
  const matches = (entry: ServiceEntry) =>
    words === "" ||
    name(entry).toLocaleLowerCase().includes(words) ||
    (entry.kind === "provider" && entry.provider.id.includes(words));
  const groups: Record<DirectoryGroup, ServiceEntry[]> = {
    plans: PLANS.filter(offered).map((plan) => ({ kind: "plan", plan })),
    popular: popular.flatMap((id) =>
      CATALOG_PROVIDERS.filter((each) => each.id === id).map(provider),
    ),
    local: CATALOG_PROVIDERS.filter((each) => each.group === "local").map(provider),
    meetings: OWN_KEY_ROUTES.map((route) => ({ kind: "transcription", route })),
    organize: [
      ...OWN_KEY_HOSTS.map((host): ServiceEntry => ({ kind: "decision", host })),
      { kind: "jev" },
    ],
    more: [
      ...CATALOG_PROVIDERS.filter(
        (each) => each.group !== "local" && !popular.includes(each.id),
      ).map(provider),
      ...RERANK.map((service): ServiceEntry => ({ kind: "rerank", service })),
    ],
  };
  return DIRECTORY_GROUPS.map((group) => ({
    group,
    entries: groups[group].filter(matches),
  })).filter((each) => each.entries.length > 0);
}
