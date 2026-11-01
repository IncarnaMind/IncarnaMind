/** How an outside agent writes a Citation IncarnaMind minted for it (./citations): "[cite:k3x9a2b7]". */

/** A Citation token as an agent writes it; the capture is the token itself. */
export const CITATION_TOKEN = /\[cite:([a-z0-9]{1,32})\]/g;

/** How a token is written in text. */
export const citeTag = (token: string) => `[cite:${token}]`;
