/** Web page addresses (#261), as the User types, pastes or drops them: the core and the renderer read them alike. */

const SCHEME = /^[a-z][a-z\d+.-]*:\/\//i;

/**
 * An address as a page is saved under: http or https, without its fragment.
 * One typed without a scheme ("example.com/page") is read as https, if its
 * host has a dot. Null if it isn't a web address.
 */
export function normaliseAddress(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  const typed = !SCHEME.test(trimmed);
  const url = URL.parse(typed ? `https://${trimmed}` : trimmed);
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:") || !url.hostname) {
    return null;
  }
  if (typed && !url.hostname.includes(".")) return null;
  url.hash = "";
  return url.href;
}

/**
 * The addresses in text that is only addresses, one per line (or separated
 * by spaces), each with its http or https scheme: what a paste or a drop of
 * links gives. Empty for text that is anything else.
 */
export function pastedAddresses(text: string): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const addresses: string[] = [];
  for (const word of words) {
    const address = /^https?:\/\//i.test(word) ? normaliseAddress(word) : null;
    if (!address) return [];
    if (!addresses.includes(address)) addresses.push(address);
  }
  return addresses;
}

/** The addresses typed in a list, one per line: each line's, or null for a line that isn't one. */
export function typedAddresses(text: string): { line: string; address: string | null }[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => ({ line, address: normaliseAddress(line) }));
}

/**
 * The host an address names, without "www.": what a web page is called where it must not be
 * believed by its own title, as on an approval card (#2240).
 */
export function webHostOf(address: string): string {
  try {
    return new URL(address).hostname.replace(/^www\./, "");
  } catch {
    return address;
  }
}
