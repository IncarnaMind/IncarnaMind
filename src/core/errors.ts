import { type MessageKey, type MessageParams, translate } from "../shared/i18n";
import type {
  ChatReadiness,
  DataFlow,
  EmbeddingModelStatus,
  ProviderError,
  SecretProtection,
} from "./api";

/** What an error says to the User: a key of the dictionary (src/shared/i18n) and its values. */
export interface ErrorWording {
  key: MessageKey;
  values?: MessageParams;
}

/**
 * An error the window says in the interface language (#627). Given a wording, its message is the
 * wording's English, which the log and a notice's Details keep; given a sentence, the window shows
 * that sentence as it is.
 */
export class TranslatableError extends Error {
  readonly wording: ErrorWording | null;
  constructor(message: string | ErrorWording, options?: ErrorOptions) {
    super(
      typeof message === "string" ? message : translate("en", message.key, message.values),
      options,
    );
    this.wording = typeof message === "string" ? null : message;
  }
}

/** Thrown when a caller of the core's public interface passes malformed input. */
export class InvalidInputError extends TranslatableError {
  override name = "InvalidInputError";
}

/** Thrown when a caller names something that doesn't exist or has been deleted. */
export class NotFoundError extends TranslatableError {
  override name = "NotFoundError";
}

/**
 * Thrown when something would write to a Mind this version may only read: a
 * newer version wrote its content, or it is of a kind this version doesn't know.
 */
export class MindReadOnlyError extends TranslatableError {
  override name = "MindReadOnlyError";
}

/** Thrown at start-up when the data folder was written by a newer version than this one. */
export class DataFromNewerVersionError extends Error {
  override name = "DataFromNewerVersionError";
  constructor(readonly newestVersion: number) {
    super(
      `The database was written by a newer version of IncarnaMind (it has schema migration ${newestVersion}, which this version doesn't know).`,
    );
  }
}

/** Thrown when a secret can't be stored safely on this device (see `getSecretStorage`). */
export class SecretStorageError extends TranslatableError {
  override name = "SecretStorageError";
  constructor(readonly protection: SecretProtection) {
    super({
      key: protection === "plain-text" ? "error.secrets.plainText" : "error.secrets.unencrypted",
    });
  }
}

/**
 * Thrown when background work would send on a flow the User hasn't allowed
 * for this service: background work never asks (ADR-0022), so it waits.
 * Nothing was sent.
 */
export class ConsentNeededError extends TranslatableError {
  override name = "ConsentNeededError";
  constructor(readonly flow: DataFlow) {
    super({ key: "error.consent.needed", values: { service: flow.service.name } });
  }
}

/** Thrown when the User declined a data flow: nothing was sent. */
export class ConsentDeclinedError extends TranslatableError {
  override name = "ConsentDeclinedError";
  constructor(readonly flow: DataFlow) {
    super({ key: "error.consent.declined", values: { service: flow.service.name } });
  }
}

/**
 * Thrown as a request would leave on a flow the User has turned off for its
 * service since the work began: nothing was sent.
 */
export class ConsentRevokedError extends TranslatableError {
  override name = "ConsentRevokedError";
  constructor(readonly flow: DataFlow) {
    super({ key: "error.consent.revoked", values: { service: flow.service.name } });
  }
}

/** Thrown as a request would leave this computer while Local mode is on: nothing was sent. */
export class LocalModeError extends TranslatableError {
  override name = "LocalModeError";
  constructor() {
    super({ key: "error.localMode.stopped" });
  }
}

/** Thrown when the User didn't choose where new files go: nothing was saved. */
export class FileWriteCancelledError extends TranslatableError {
  override name = "FileWriteCancelledError";
  constructor() {
    super({ key: "error.files.notChosen" });
  }
}

/** Thrown when a new file would go inside a Linked folder the User said IncarnaMind may not add files to. */
export class LinkedFolderWritesDeclinedError extends TranslatableError {
  override name = "LinkedFolderWritesDeclinedError";
  constructor(
    readonly linkedFolderId: string,
    readonly linkedFolderPath: string,
  ) {
    super({ key: "error.files.linkedFolderDeclined" });
  }
}

/** Thrown when Questions can't be answered yet; `readiness` says what to configure. */
export class ChatNotReadyError extends Error {
  override name = "ChatNotReadyError";
  constructor(readonly readiness: Extract<ChatReadiness, { ready: false }>) {
    super(`Chat isn't set up: ${readiness.reason}.`);
  }
}

/**
 * Thrown when automatic tagging's model can't be used yet, e.g. Jev is set up
 * but its key can't be read on this device. Documents wait until it can.
 */
export class TaggingNotReadyError extends TranslatableError {
  override name = "TaggingNotReadyError";
}

/**
 * Thrown by a vector search while the embedding model can't be used: the
 * built-in one isn't downloaded or can't start (`status`), or the provider the
 * User chose instead can't be used, e.g. its key is missing (`error`).
 */
export class EmbeddingModelNotReadyError extends Error {
  override name = "EmbeddingModelNotReadyError";
  constructor(
    /** The built-in model's state; null when another provider is in use. */
    readonly status: EmbeddingModelStatus | null,
    /** Why the chosen provider can't be used, when it isn't the built-in model. */
    readonly error: ProviderError | null = null,
  ) {
    super(
      status === null
        ? `The embedding provider can't be used${error ? ` (${error.kind}: ${error.message})` : ""}.`
        : status.error
          ? `The embedding model isn't ready (${status.error.kind}: ${status.error.message}).`
          : `The embedding model isn't ready (${status.state}).`,
    );
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
