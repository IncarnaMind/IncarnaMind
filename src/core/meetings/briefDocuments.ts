import type { Document } from "../api";

function namedIn(title: string, name: string) {
  const value = name.trim();
  if (!value) return false;
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Latin names have word boundaries. Chinese titles are commonly embedded in a sentence.
  const word = "[\\p{Script=Latin}\\p{Number}_]";
  return new RegExp(
    (/^[\p{Script=Latin}\p{Number}_]/u.test(value) ? `(?<!${word})` : "") +
      escaped +
      (/[\p{Script=Latin}\p{Number}_]$/u.test(value) ? `(?!${word})` : ""),
    "iu",
  ).test(title);
}

/** Only matches titles and links among Documents already explicitly in scope. */
export function briefDocuments(documents: readonly Document[], title: string) {
  const links = new Set(
    (title.match(/https?:\/\/[^\s<>"']+/giu) ?? []).map(
      (link) => link.replace(/[).,，。；;]+$/u, "").split("#")[0],
    ),
  );
  const eligible = documents.filter(
    (doc) =>
      !doc.notCited &&
      doc.kind !== "transcript" &&
      !doc.yourNote &&
      doc.fileStatus === "available" &&
      doc.status !== "failed" &&
      doc.status !== "no-text" &&
      doc.contentHash,
  );
  const counts = new Map<string, number>();
  for (const doc of eligible) {
    const name = doc.name.trim().toLowerCase();
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return eligible.map((doc) => ({
    doc,
    invited:
      !!(doc.web && links.has(doc.web.address)) ||
      (counts.get(doc.name.trim().toLowerCase()) === 1 && namedIn(title, doc.name)),
  }));
}
