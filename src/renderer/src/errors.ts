import type { ProviderError } from "../../core/api";
import { type ErrorWording, TranslatableError } from "../../core/errors";
import { takeWording } from "../../shared/errorWording";
import type { MessageKey, MessageParams } from "../../shared/i18n";
import { systemReason } from "../../shared/systemReasons";

/**
 * What a failure says, split between the notice's line, its "Details" in plain words
 * (`errorDetails`) and the log: the core's own sentence, its wording for the interface language,
 * plain words when the sentence is the system's code, and what was being done.
 */
export interface ErrorDescription {
  /** The sentence the error carries, without Electron's wrapping, its class name or a stack. */
  message: string;
  /** The sentence as a key of the dictionary, when the core gave one (#627). */
  wording: ErrorWording | null;
  /** Plain words, in the dictionary, for a failure of the system's (a full disk, a name too long). */
  reason: MessageKey | null;
  /**
   * The core call that failed ("renameDocument"), for saying what was tried in words
   * (`errorDoing`); null for a failure that never crossed the bridge. Never shown as it is.
   */
  call: string | null;
  /**
   * The call, the error's class, its sentence, its stack and its cause, for the log, never the
   * screen: a method's or a class's name says nothing to the User.
   */
  log: string;
  /**
   * This window's own code threw a TypeError, ReferenceError and the like: its sentence names
   * code, so the notice shows the plain Problem instead (#2823).
   */
  programError: boolean;
  /** A call to a method the core doesn't have: a restart loads the window and the main process together. */
  stale: boolean;
}

/** The failures this window's own code raises, whose sentences name code rather than what happened. */
const PROGRAM_FAILURE = /^(?:TypeError|ReferenceError|RangeError|SyntaxError)$/;

/** A call to a method that isn't there, which a restart fixes when the window and the main process differ. */
const MISSING_METHOD = /\bis not a function\b/;

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
  const taken = takeWording(named ? (named[2] ?? "") : inner);
  const { sentence } = taken;
  // One thrown in this window never crossed from the main process, so its wording is still on it.
  const wording =
    error instanceof TranslatableError && error.wording ? error.wording : taken.wording;
  const message = sentence.replace(STACK_FROM, "").trim();
  const reason = systemReason(message);
  const call = /^core:(\w+)$/.exec(wrapped?.[1] ?? "")?.[1] ?? null;
  const said = `${className || "Error"}: ${message}`;
  const programError =
    !wrapped &&
    wording === null &&
    reason === null &&
    error instanceof Error &&
    PROGRAM_FAILURE.test(error.name);
  const stale = programError && error instanceof TypeError && MISSING_METHOD.test(message);
  const cause =
    error instanceof Error && error.cause !== undefined
      ? `\nCaused by: ${error.cause instanceof Error ? error.cause.message : String(error.cause)}`
      : "";
  const stack = programError && error instanceof Error && error.stack ? `\n${error.stack}` : "";
  return {
    message,
    wording,
    reason,
    call,
    log: (wrapped?.[1] ? `${wrapped[1]}\n${said}` : said) + stack + cause,
    programError,
    stale,
  };
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
