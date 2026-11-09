import type {
  ChatModelChoice,
  ChatProvider,
  EmbeddingProvider,
  ModelRoles,
  RerankSettings,
  TaggingClassifier,
  TranscriptionRoute,
  TranscriptionServiceStatus,
} from "../../../../core/api";
import { DECISION_HOST_ENTRIES } from "../../../../core/providers/catalog/decisions";

/** A job an account or key does today, in the order a row lists them. */
export type AccountJob =
  | "answers"
  | "quick"
  | "images"
  | "organize"
  | "hints"
  | "transcription"
  | "search"
  | "rerank";

const ORDER: readonly AccountJob[] = [
  "answers",
  "quick",
  "images",
  "organize",
  "hints",
  "transcription",
  "search",
  "rerank",
];

/** One row of Accounts and keys: a saved provider, a key kept for one job, or the built-in models. */
export type AccountRowKey =
  | `provider:${string}`
  | `transcription:${string}`
  | `sorting:${string}`
  | "jev"
  | `rerank:${string}`
  | `search:${string}`
  | "built-in";

const catalogOf = (provider: ChatProvider) => provider.catalogId ?? provider.kind;

/** The saved provider whose key a company's other service uses: the first, as the core reads it. */
const accountRow = (
  providers: readonly ChatProvider[],
  catalogId: string,
): AccountRowKey | null => {
  const saved = providers.find(
    (each) => catalogOf(each) === catalogId && each.baseUrl === null && each.hasApiKey,
  );
  return saved ? `provider:${saved.id}` : null;
};

/**
 * What each account or key does today, by row: the jobs whose model it answers, sorts, transcribes
 * or searches with. A company's key is one row whatever it is for (a transcription route or a
 * decision host on a chat provider's key is that provider's row); a key kept for one job only is
 * its own row; what runs built in is the built-in models' row.
 */
export function accountUses({
  providers,
  chatModel,
  roles,
  sorting,
  transcriptionRoute,
  services,
  embedding,
  rerank,
}: {
  providers: readonly ChatProvider[];
  chatModel: ChatModelChoice | null;
  roles: ModelRoles | null;
  /** What sorts now: the saved choice, or Automatic's pick; null for none. */
  sorting: TaggingClassifier | null;
  transcriptionRoute: TranscriptionRoute | null;
  services: readonly TranscriptionServiceStatus[];
  embedding: EmbeddingProvider | null;
  rerank: RerankSettings | null;
}): Map<AccountRowKey, AccountJob[]> {
  const uses = new Map<AccountRowKey, Set<AccountJob>>();
  const add = (row: AccountRowKey | null, ...jobs: AccountJob[]) => {
    if (!row) return;
    const set = uses.get(row) ?? new Set<AccountJob>();
    for (const job of jobs) set.add(job);
    uses.set(row, set);
  };
  const saved = (choice: ChatModelChoice | null | undefined): AccountRowKey | null =>
    choice && providers.some((each) => each.id === choice.providerId)
      ? `provider:${choice.providerId}`
      : null;
  // The Ollama at that address, when one is given: one on another computer is never this
  // computer's row.
  const ollama = (baseUrl?: string | null) => {
    const found = providers.find(
      (each) =>
        each.kind === "ollama" && (baseUrl === undefined || (each.baseUrl ?? null) === baseUrl),
    );
    return found ? (`provider:${found.id}` as const) : null;
  };

  add(saved(chatModel), "answers");
  add(saved(roles?.quickTasks), "quick");
  add(saved(roles?.images), "images");

  switch (sorting?.kind) {
    case "chat":
      add(saved(sorting.choice), "organize");
      break;
    case "decision": {
      const host = DECISION_HOST_ENTRIES[sorting.host];
      add(
        host.key === "provider" && host.provider
          ? accountRow(providers, host.provider)
          : `sorting:${sorting.host}`,
        "organize",
        "hints",
      );
      break;
    }
    case "jev":
      add("jev", "organize", "hints");
      break;
    case "ollama":
    case "auto":
      add(ollama(), "organize", "hints");
      break;
  }

  if (transcriptionRoute === null || transcriptionRoute === "local") {
    add("built-in", "transcription");
  } else {
    const service = services.find((each) => each.route === transcriptionRoute);
    if (service?.key === "provider") {
      add(service.providerId ? `provider:${service.providerId}` : null, "transcription");
    } else if (service) {
      add(`transcription:${service.route}`, "transcription");
    }
  }

  switch (embedding?.kind) {
    case "built-in":
      add("built-in", "search");
      break;
    case "openai":
    case "google":
      add(accountRow(providers, embedding.kind) ?? `search:${embedding.kind}`, "search");
      break;
    case "ollama":
      add(ollama(embedding.baseUrl ?? null), "search");
      break;
  }

  if (rerank?.enabled && rerank.kind) {
    add(
      rerank.kind === "built-in"
        ? "built-in"
        : (accountRow(providers, rerank.kind) ?? `rerank:${rerank.kind}`),
      "rerank",
    );
  }

  return new Map(
    [...uses].map(([row, jobs]) => [row, ORDER.filter((job) => jobs.has(job))] as const),
  );
}
