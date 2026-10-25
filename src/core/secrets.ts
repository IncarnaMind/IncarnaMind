/**
 * The only way core modules store secrets (API keys, later OAuth tokens). It
 * enforces the policy on top of the `Keychain` adapter: on Linux without a
 * keyring, safeStorage falls back to "basic_text", which encrypts with a
 * hard-coded key. Secrets are then refused until the User explicitly accepts
 * plain-text storage on this device.
 */
import type { Keychain } from "./adapters";
import type { SecretStorageStatus } from "./api";
import { SecretStorageError } from "./errors";
import type { SettingsStore } from "./settings";

/** A per-device value: accepting plain-text storage on one machine says nothing about another. */
const PLAIN_TEXT_ACCEPTED = "plainTextSecretsAccepted";

export type Secrets = ReturnType<typeof createSecrets>;

export function createSecrets(
  keychain: Keychain,
  settings: SettingsStore,
  /** Told every secret read or stored, so a log can leave it out of what it keeps. */
  remember: (secret: string) => void = () => undefined,
) {
  const plainTextAccepted = () => settings.readDeviceValue(PLAIN_TEXT_ACCEPTED) === true;

  const status = (): SecretStorageStatus => {
    const protection = keychain.protection();
    const accepted = plainTextAccepted();
    return {
      protection,
      plainTextAccepted: accepted,
      canSave: protection === "os" || (protection === "plain-text" && accepted),
    };
  };

  if (keychain.protection() === "plain-text" && plainTextAccepted()) keychain.allowPlainText();

  const read = async (name: string): Promise<string | null> => {
    const secret = await keychain.get(name);
    if (secret) remember(secret);
    return secret;
  };

  return {
    status,

    acceptPlainText(): SecretStorageStatus {
      settings.writeDeviceValue(PLAIN_TEXT_ACCEPTED, true);
      if (keychain.protection() === "plain-text") keychain.allowPlainText();
      return status();
    },

    get: read,

    /** Returns null instead of throwing when a stored secret can't be read (e.g. the keyring changed). */
    async tryGet(name: string): Promise<string | null> {
      try {
        return await read(name);
      } catch {
        return null;
      }
    },

    async set(name: string, secret: string): Promise<void> {
      const { canSave, protection } = status();
      if (!canSave) throw new SecretStorageError(protection);
      remember(secret);
      await keychain.set(name, secret);
    },

    delete: (name: string) => keychain.delete(name),
  };
}
