/**
 * Suggest as I write (#282), the window's side: what a pause asks the core
 * (`suggestNext`, with the composer's Search scope), the words a suggestion
 * shows, and the offer to turn suggestions on, which shows where the User
 * writes, at most twice on this device, never again in a Mind where they
 * chose "Not now" (docs/agents/interaction.md, rule 14).
 */
import type * as Y from "yjs";
import { create } from "zustand";
import { MIND_SETTINGS_FIELD, type Suggestion } from "../../core/api";
import { withShownName } from "../../shared/citations";
import { type MessageKey, type MessageParams, translate } from "../../shared/i18n";
import { citationLocation, formatLocation } from "../../shared/locations";
import { composerScope, useComposer } from "./composer";
import { core } from "./core";
import { sentencesIn } from "./editor/suggestionPlace";
import { laterPromptsAllowedNow } from "./laterPrompts";
import { chooseNudge } from "./nudges";
import { useAppStore } from "./store";

/** How many times the offer shows on a device, at most. */
export const MAX_OFFERS = 2;

/** Where a Mind keeps the User's "Not now" to the offer: its own settings, so it goes where it goes. */
const OFFER_KEY = "suggestionOffer";

export const offerDeclined = (doc: Y.Doc) =>
  doc.getMap(MIND_SETTINGS_FIELD).get(OFFER_KEY) === "not-now";

export const declineOffer = (doc: Y.Doc) =>
  doc.getMap(MIND_SETTINGS_FIELD).set(OFFER_KEY, "not-now");

/** The line the offer shows in a Mind: the offer itself, or, once taken, that suggestions are on. */
export const useSuggestionOffer = create<{
  shown: { mindId: string; line: "offer" | "on" } | null;
}>(() => ({ shown: null }));

const t = (key: MessageKey, params?: MessageParams) =>
  translate(useAppStore.getState().settings?.language ?? "en", key, params);

/** The words a suggestion shows: its label for screen readers, its marker's tooltip, its key. */
export function describeSuggestion(suggestion: Suggestion) {
  const { documentName, quote } = withShownName(
    suggestion.citation,
    useAppStore.getState().documents,
  );
  const location = citationLocation(suggestion.citation);
  return {
    label: t("suggestion.label", { text: suggestion.text }),
    citation: location
      ? t("suggestion.citation", {
          document: documentName,
          location: formatLocation(location, t),
          quote,
        })
      : t("suggestion.citationNoLocation", { document: documentName, quote }),
    key: t("suggestion.key"),
  };
}

/**
 * At a pause at the end of a paragraph in a Mind: a suggestion, or null.
 * With suggestions off, the core only says whether the Mind's Search scope
 * has Documents, and the offer shows if it may (a few sentences written).
 */
export async function askForSuggestion(
  mindId: string,
  doc: Y.Doc,
  request: { requestId: string; paragraph: string },
): Promise<Suggestion | null> {
  const { settings, minds } = useAppStore.getState();
  if (!settings) return null;
  const on = settings.user.suggestWhileWriting;
  const offer = useSuggestionOffer.getState().shown;
  // Once the User writes on, the line saying suggestions are on has done its job.
  if (offer?.line === "on") useSuggestionOffer.setState({ shown: null });
  const mayOffer =
    !on &&
    laterPromptsAllowedNow() &&
    chooseNudge(useAppStore.getState()) === null &&
    offer === null &&
    settings.device.suggestionOffers < MAX_OFFERS &&
    sentencesIn(request.paragraph) >= 2 &&
    !offerDeclined(doc);
  if (!on && !mayOffer) return null;
  const folderId = minds.find((mind) => mind.id === mindId)?.folderId ?? null;
  const scope = composerScope(useComposer.getState().draft(mindId), folderId);
  const outcome = await core.suggestNext({ ...request, mindId, scope });
  // As they are now, after the reply: another Mind may have offered, or this one said Not now.
  const stillMayOffer =
    mayOffer &&
    laterPromptsAllowedNow() &&
    chooseNudge(useAppStore.getState()) === null &&
    useSuggestionOffer.getState().shown === null &&
    !offerDeclined(doc);
  if (outcome.kind === "off" && outcome.scopeHasDocuments && stillMayOffer) {
    useSuggestionOffer.setState({ shown: { mindId, line: "offer" } });
    const offers = useAppStore.getState().settings?.device.suggestionOffers ?? 0;
    await useAppStore.getState().updateSettings({ device: { suggestionOffers: offers + 1 } });
  }
  return outcome.kind === "suggestion" ? outcome.suggestion : null;
}
