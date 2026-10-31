import type { ChatProviderKind, ProviderErrorKind, SignInRouteProblem } from "../../core/api";
import { OLLAMA_USAGE_URL } from "../../core/providers/catalog/billing";
import {
  isSignInRoute,
  type RouteProblemWords,
  SIGN_IN_ROUTES,
  type SignInRoute,
} from "../../core/providers/signInRoutes";
import type { MessageKey } from "../../shared/i18n";
import { CHATGPT_USAGE_URL } from "./chatGptUsage";
import type { SettingsPage } from "./settingsPages";

/**
 * What a failed Answer says, and the one thing it offers (DESIGN.md,
 * Problems): its line, and either a page of Settings to fix it on, trying
 * again, a page of the provider's own, signing in again, getting a model
 * on this computer, or nothing when none would help.
 */
export type AnswerFix =
  | { kind: "settings"; page: SettingsPage; label: MessageKey }
  | { kind: "retry"; label: MessageKey }
  | { kind: "local-model"; label: MessageKey }
  /** `label` only where Ollama's app is here: `OllamaNotRunningLine` offers Get Ollama or Try again otherwise. */
  | { kind: "ollama"; label: MessageKey }
  /** A page of the provider's own, opened in the browser. */
  | { kind: "link"; url: string; label: MessageKey }
  /** Signing in with ChatGPT again, from the Answer, which is then tried again. */
  | { kind: "sign-in"; label: MessageKey }
  | { kind: "none" };

export interface AnswerProblem {
  /** The line, which names the model as `{model}` when it can. */
  line: MessageKey;
  fix: AnswerFix;
}

export const retry: AnswerFix = { kind: "retry", label: "answer.error.retry" };
const chooseModel: AnswerFix = {
  kind: "settings",
  page: "models",
  label: "answer.error.chooseModel",
};

export const ANSWER_PROBLEMS: Record<ProviderErrorKind, AnswerProblem> = {
  auth: {
    line: "answer.error.auth",
    fix: { kind: "settings", page: "models", label: "answer.error.checkKey" },
  },
  model: {
    line: "answer.error.model",
    fix: { kind: "settings", page: "models", label: "answer.error.chooseModel" },
  },
  // A declined data flow is allowed again on the Privacy page.
  "consent-declined": {
    line: "answer.error.consent-declined",
    fix: { kind: "settings", page: "privacy", label: "answer.error.allow" },
  },
  // Turned off on purpose: nothing to fix, and asking again asks for consent as usual.
  "consent-revoked": { line: "answer.error.consent-revoked", fix: { kind: "none" } },
  // Stopped by local mode: a model on this computer can write it.
  "local-mode": {
    line: "answer.error.local-mode",
    fix: { kind: "local-model", label: "answer.error.useLocal" },
  },
  "ollama-not-running": {
    line: "answer.error.ollama-not-running",
    fix: { kind: "ollama", label: "localModel.open" },
  },
  // Only the organization's own setting, or another model, helps.
  "data-retention": {
    line: "answer.error.data-retention",
    fix: { kind: "settings", page: "models", label: "answer.error.chooseModel" },
  },
  "rate-limit": { line: "answer.error.rate-limit", fix: retry },
  network: { line: "answer.error.network", fix: retry },
  provider: { line: "answer.error.provider", fix: retry },
  // Asked again, the same request is refused again: another model may take it.
  refused: { line: "answer.error.refused", fix: chooseModel },
  // Where the provider has a page to add credit, `answerProblem` offers it.
  "out-of-credit": { line: "answer.error.out-of-credit", fix: chooseModel },
  // Nothing the User changes here lifts it: another provider may serve them.
  region: { line: "answer.error.region", fix: chooseModel },
  // A local model's context window: trying again can't help, shortening the Question does.
  "too-long": { line: "answer.error.too-long", fix: { kind: "none" } },
  "no-answer": { line: "answer.error.no-answer", fix: retry },
  "cut-short": { line: "answer.error.cut-short", fix: retry },
  unknown: { line: "answer.error.unknown", fix: retry },
  // The ChatGPT plan provider.
  "not-signed-in": {
    line: "answer.error.not-signed-in",
    fix: { kind: "sign-in", label: "answer.error.signIn" },
  },
  // The plan's limit or the one the User set for IncarnaMind: ChatGPT's settings say which.
  "plan-limit": {
    line: "answer.error.plan-limit",
    fix: { kind: "link", url: CHATGPT_USAGE_URL, label: "answer.error.manageUsage" },
  },
  // The User's own monthly cap: raising it (or waiting for next month) is the way on.
  "cost-cap": {
    line: "answer.error.cost-cap",
    fix: { kind: "settings", page: "general", label: "answer.error.changeCap" },
  },
  // Only another model helps: a plan that can't be used in other apps stays so.
  blocked: {
    line: "answer.error.blocked",
    fix: { kind: "settings", page: "models", label: "answer.error.chooseModel" },
  },
};

/** The ChatGPT plan's own problems, whose lines name ChatGPT and whose fixes are OpenAI's. */
const CHATGPT_ONLY: ReadonlySet<ProviderErrorKind> = new Set([
  "not-signed-in",
  "plan-limit",
  "blocked",
]);

/** What the line needs to know of the model's provider beyond its kind. */
export interface FailureWhere {
  /** Where credit is added, when the provider's catalog entry has a page for it. */
  billingUrl?: string;
  /** Whether the model runs on this computer; left out until its provider is known. */
  local?: boolean;
}

/**
 * A failed Answer's problem, for the provider that wrote it: an Ollama Cloud allowance is Ollama's
 * to manage, credit is added on the provider's `billingUrl` when it has one, a model on this
 * computer has no credit nor region to refuse it, and an Answer of a sign-in route without its own
 * words never gets ChatGPT's.
 */
export function answerProblem(
  kind: ProviderErrorKind,
  provider: ChatProviderKind | undefined,
  onSignInRoute = isSignInRoute(provider),
  where: FailureWhere = {},
): AnswerProblem {
  if (where.local && (kind === "out-of-credit" || kind === "region")) {
    return ANSWER_PROBLEMS.refused;
  }
  // A hosted model's window is filled by more than the Question (its context, the Passages), so
  // shortening the Question is not what helps.
  if (kind === "too-long" && where.local === false) {
    return { line: "answer.error.too-long.hosted", fix: chooseModel };
  }
  if (onSignInRoute && CHATGPT_ONLY.has(kind)) {
    return {
      line: "answer.error.provider",
      fix: { kind: "settings", page: "models", label: "answer.error.chooseModel" },
    };
  }
  if (kind === "plan-limit" && provider === "ollama") {
    return {
      line: "answer.error.plan-limit.ollama",
      fix: { kind: "link", url: OLLAMA_USAGE_URL, label: "answer.error.manageUsage" },
    };
  }
  if (kind === "out-of-credit" && where.billingUrl) {
    return {
      line: "answer.error.out-of-credit",
      fix: { kind: "link", url: where.billingUrl, label: "answer.error.addCredit" },
    };
  }
  return ANSWER_PROBLEMS[kind];
}

export type FailedAnswerLine =
  | { kind: "route"; route: SignInRoute; words: RouteProblemWords }
  | { kind: "plain"; problem: AnswerProblem };

/**
 * A failed Answer's line: its sign-in route's own, where `offered` (this build signs in with the
 * route), else the plain one. A route's problem with no provider known, removed or not loaded
 * yet, still keeps ChatGPT's words off it.
 */
export function failedAnswerLine(
  kind: ProviderErrorKind,
  provider: ChatProviderKind | undefined,
  signInRoute: SignInRouteProblem | null,
  offered: boolean,
  where?: FailureWhere,
): FailedAnswerLine {
  const route = isSignInRoute(provider) ? provider : null;
  const words = route && signInRoute ? SIGN_IN_ROUTES[route].problems[signInRoute] : undefined;
  if (route && words && offered) return { kind: "route", route, words };
  return {
    kind: "plain",
    problem: answerProblem(kind, provider, route !== null || !!signInRoute, where),
  };
}
