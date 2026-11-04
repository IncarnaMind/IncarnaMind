import type { SecretProtection } from "../../src/core";
import type { SecretCipher } from "../../src/main/secretsFile";

const xor = (bytes: Buffer) => Buffer.from(bytes.map((byte) => byte ^ 0x5a));

/**
 * A stand-in for Electron's safeStorage: XORs with a fixed key, so the
 * ciphertext never contains the secret. Like safeStorage on Linux's
 * "basic_text" backend, it refuses to encrypt until plain text is allowed.
 */
function fakeCipher(protection: SecretProtection) {
  let plainTextAllowed = false;
  return {
    get plainTextAllowed() {
      return plainTextAllowed;
    },
    protection: (): SecretProtection => protection,
    allowPlainText: () => {
      plainTextAllowed = true;
    },
    encryptBytes(plainText: string): Buffer {
      if (protection === "unavailable" || (protection === "plain-text" && !plainTextAllowed)) {
        throw new Error("Encryption is not available.");
      }
      return xor(Buffer.from(plainText, "utf8"));
    },
    decryptBytes: (cipherText: Buffer) => xor(cipherText).toString("utf8"),
  };
}

export function createFakeCipher(protection: SecretProtection = "os") {
  const parts = fakeCipher(protection);
  const cipher: SecretCipher & { readonly plainTextAllowed: boolean } = {
    get plainTextAllowed() {
      return parts.plainTextAllowed;
    },
    protection: parts.protection,
    allowPlainText: parts.allowPlainText,
    encrypt: async (plainText) => parts.encryptBytes(plainText),
    decrypt: async (cipherText) => parts.decryptBytes(cipherText),
  };
  return cipher;
}

/**
 * The cipher as it was before safeStorage's asynchronous API: synchronous, so
 * a test can write what the previous version stored.
 */
export function createLegacyCipher(protection: SecretProtection = "os") {
  const parts = fakeCipher(protection);
  return {
    protection: parts.protection,
    allowPlainText: parts.allowPlainText,
    encrypt: (plainText: string) => parts.encryptBytes(plainText),
    decrypt: (cipherText: Buffer) => parts.decryptBytes(cipherText),
  };
}
