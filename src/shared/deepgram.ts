/** Deepgram's own servers, its regions' (api.eu.deepgram.com) among them. */
export const isDeepgramHost = (hostname: string) =>
  hostname === "deepgram.com" || hostname.endsWith(".deepgram.com");

/**
 * Whether saving a Deepgram key with this server typed sends the key to Deepgram to check it: an
 * empty field is Deepgram's own. An address that can't be read counts as Deepgram's, so the line
 * never says less than is sent; saving refuses it before anything goes out.
 */
export function typedServerChecksKey(typed: string): boolean {
  const address = typed.trim();
  if (address === "" || !URL.canParse(address)) return true;
  return isDeepgramHost(new URL(address).hostname);
}
