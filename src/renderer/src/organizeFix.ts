/**
 * The one action a group of Organize failures offers (#2308): add credit, check
 * the key, or choose another model, in the words the Answer's problems already
 * use. Once the User is back from adding credit, every Document that still has
 * that failure tries once by itself (#2308).
 */

import { core } from "./core";
import { billingUrlOfProvider, useKeyRefusals } from "./keyRefusals";
import { organizeDocuments } from "./organizeDocuments";
import { type ReviewProblemKind, unsettledProblemsOf } from "./reviewProblems";
import { allExamples, isOwnDocument, useAppStore } from "./store";

/** Settings › Models › Advanced › Tagging: the one model choice for tagging and Organize. */
const organizeModelSettings = () => useAppStore.getState().openSettings("models", "tagging");

/** The Documents whose latest failure is this cause now, the list To review and ⌘K act on (#2308). */
export function documentsOfCause(kind: ReviewProblemKind): readonly string[] {
  const state = useAppStore.getState();
  const own = state.documents.filter((document) => isOwnDocument(document, allExamples(state)));
  return (
    unsettledProblemsOf(own, state.library?.assignments ?? []).find(
      (problem) => problem.kind === kind,
    )?.documentIds ?? []
  );
}

let retryPending = false;
let watchingReturns = false;
/** How many times the window came back: a press that began before one has nothing left to wait for. */
let returns = 0;

/**
 * The one retry a press arms runs only while Organize still sends where its billing page was
 * opened. A model changed elsewhere while the page was away is another destination, and the
 * return sends nothing to it without a new choice (#2308, ADR-0022).
 */
async function retryOnReturn(openedFor: string): Promise<void> {
  try {
    const route = await core.getTaggingRoute("classification");
    if (route.where !== "cloud" || route.service.id !== openedFor) return;
    const ids = documentsOfCause("credit");
    if (ids.length === 0) return;
    await organizeDocuments([...ids], undefined, openedFor);
  } catch (error) {
    useAppStore.getState().reportError(error);
  }
}

/**
 * The User came back after adding credit: every Document that still has the credit failure tries
 * once, with no press. Only an Add credit press arms this, so a plain return spends nothing, and
 * the list is read on return rather than kept from the press (#2308).
 */
function retryWhenBack(pressedAfter: number, openedFor: string): void {
  if (!watchingReturns) {
    watchingReturns = true;
    window.addEventListener("focus", () => {
      returns += 1;
    });
  }
  // The return this press was waiting for already happened: a late second press arms nothing.
  if (pressedAfter !== returns || retryPending) return;
  retryPending = true;
  window.addEventListener(
    "focus",
    () => {
      retryPending = false;
      void retryOnReturn(openedFor);
    },
    { once: true },
  );
}

export async function fixOrganizeProblem(kind: ReviewProblemKind): Promise<void> {
  const { reportError } = useAppStore.getState();
  const pressedAfter = returns;
  try {
    if (kind === "rateLimit") return;
    if (kind === "planLimit") {
      organizeModelSettings();
      return;
    }
    const route = await core.getTaggingRoute("classification");
    if (route.where !== "cloud") {
      organizeModelSettings();
      return;
    }
    if (kind === "keyRefused") {
      await useKeyRefusals.getState().checkService(route.service.id);
      return;
    }
    const providers = await core.listChatProviders();
    const provider = providers.find((each) => each.service?.id === route.service.id);
    const url = billingUrlOfProvider(provider);
    if (provider && url) {
      useKeyRefusals.getState().openBilling(provider.id, url);
      retryWhenBack(pressedAfter, route.service.id);
    } else {
      organizeModelSettings();
    }
  } catch (error) {
    reportError(error);
  }
}
