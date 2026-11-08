import type { TAGGING_FLOW_SENDS } from "./tagger";

/**
 * What a field can hold: what the tagging flow says it sends (`TAGGING_FLOW_SENDS`), or the app's
 * own, which says nothing of the User's: a reference such as "d1", an id, the kinds' fixed words.
 */
export type TaggingFieldKind = (typeof TAGGING_FLOW_SENDS)[number] | "app";

/**
 * Every field each tagging request carries, by request and path ("[]" for each item of a list,
 * "*" for each key of a record), with the kinds of data it holds (#2339, ADR-0022). Each request
 * is checked field by field against it in tests/core/taggingFields.test.ts, so a request that
 * starts carrying something new fails there until it is listed here and the tagging flow's words
 * name it. The fixed instructions aren't fields.
 */
export const TAGGING_FIELDS: Readonly<Record<string, readonly TaggingFieldKind[]>> = {
  // A chat model, for one Document or several (./classify, `tagRequest`).
  "chat.language": ["app"],
  "chat.kinds[].code": ["app"],
  "chat.kinds[].is": ["app"],
  // The User's own Tags the Documents are about (./about).
  "chat.tags[].id": ["app"],
  "chat.tags[].name": ["tags"],
  "chat.tags[].description": ["tags"],
  "chat.documents[].ref": ["app"],
  "chat.documents[].name": ["document-excerpts"],
  "chat.documents[].type": ["document-excerpts"],
  "chat.documents[].text": ["document-excerpts"],
  "chat.documents[].tags[]": ["app"],
  // Jev or a decision model: a question for each kind and Tag (./jev).
  "decision.model": ["app"],
  "decision.state.name": ["document-excerpts"],
  "decision.state.type": ["document-excerpts"],
  "decision.state.excerpt": ["document-excerpts"],
  "decision.questions.*.type": ["app"],
  "decision.questions.*.instructions": ["app", "tags"],
  "decision.questions.*.criteria.true": ["app", "tags"],
  // What a no means, for a host that takes a question only with both (./jev, `tagQuestions`).
  "decision.questions.*.criteria.false": ["app"],
};
