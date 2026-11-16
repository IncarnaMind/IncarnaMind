/** A part of a model's reply, as its provider returns it. */
export interface ReplyPart {
  type: string;
  text?: unknown;
  input?: unknown;
}

/** A reply's text: its text parts, and a Tool call's input, as a provider without JSON output returns it. */
export const replyTextOf = (content: readonly ReplyPart[]): string =>
  content
    .map((part) => {
      if (part.type === "text" && typeof part.text === "string") return part.text;
      if (part.type === "tool-call" && typeof part.input === "string") return part.input;
      return "";
    })
    .join("");
