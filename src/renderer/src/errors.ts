import type { ProviderError } from "../../core/api";
import type { ErrorWording } from "../../core/errors";
import { takeWording } from "../../shared/errorWording";
import type { MessageKey, MessageParams } from "../../shared/i18n";
import { systemReason } from "../../shared/systemReasons";

/**
 * What a failure says, split four ways: the core's own sentence, its wording for the interface
 * language, plain words when the sentence is the system's code, and the technical text for a
 * "Details" disclosure.
 */
export interface ErrorDescription {
  /** The sentence the error carries, without Electron's wrapping, its class name or a stack. */
  message: string;
  /** The sentence as a key of the dictionary, when the core gave one (#627). */
  wording: ErrorWording | null;
  /** Plain words, in the dictionary, for a failure of the system's (a full disk, a name too long). */
  reason: MessageKey | null;
  /**
   * The core method that failed, the error's class and its sentence, for the Details of a notice.
   * Never Electron's wrapping or a stack: they say nothing the User or a bug report can use.
   */
  detail: string;
}

/**
 * Electron rejects a call to the main process with the error written out:
 * "Error invoking remote method 'core:x': InvalidInputError: …".
 */
const IPC_WRAPPING = /^Error invoking remote method '([^']*)': ([\s\S]*)$/;
const CLASS_NAME = /^(\w*Error): ([\s\S]*)$/;
/** A line of a stack, which a message may carry when someone wrote the stack into it. */
const STACK_FROM = /\r?\n\s+at\s[\s\S]*$/;

/**
 * Takes a failure apart. This is the one place the wrapping Electron puts around an error from the
 * core is taken off, so no notice or line shows it.
 */
export function describeError(error: unknown): ErrorDescription {
  const text = error instanceof Error ? error.message : String(error);
  const wrapped = IPC_WRAPPING.exec(text);
  const inner = wrapped ? (wrapped[2] ?? "") : text;
  const named = CLASS_NAME.exec(inner);
  const className = named ? named[1] : error instanceof Error ? error.name : null;
  const { sentence, wording } = takeWording(named ? (named[2] ?? "") : inner);
  const message = sentence.replace(STACK_FROM, "").trim();
  const reason = systemReason(message);
  const said = `${className || "Error"}: ${message}`;
  return { message, wording, reason, detail: wrapped?.[1] ? `${wrapped[1]}\n${said}` : said };
}

/** What an error from the core says, in the interface language, for a line that has no room for more. */
export function errorMessage(
  error: unknown,
  t: (key: MessageKey, params?: MessageParams) => string,
): string {
  const { message, wording } = describeError(error);
  return wording ? t(wording.key, wording.values) : message;
}

/** What a provider's error says, in the interface language when the core worded it. */
export function providerErrorText(
  error: ProviderError,
  t: (key: MessageKey, params?: MessageParams) => string,
): string {
  return error.wording ? t(error.wording.key, error.wording.values) : error.message;
}
