/**
 * Escapes what Markdown would read as formatting: emphasis, code, links, math,
 * HTML, entities, and the "==" of a highlight. A "=" is escaped only where it
 * could make one: before another, or at either end of the text, which a
 * highlight's "==" may be written next to. In a table, "|" too.
 */
export function escapeMarkdownText(text: string, table = false): string {
  const escaped = text
    .replace(/[\\`*_~[\]$<]/g, "\\$&")
    .replace(/&(?=#?\w+;)/g, "\\&")
    .replace(/^=|=(?==|[ \t]*$)/g, "\\=");
  return table ? escaped.replace(/\|/g, "\\|") : escaped;
}
