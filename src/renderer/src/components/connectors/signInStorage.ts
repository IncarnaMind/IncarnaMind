import type { SecretStorageStatus } from "../../../../core/api";

/**
 * Whether the keychain can keep what signing in saves: false until its answer arrives, and when
 * reading it failed, so the sign-in is held rather than offered and then refused (#2025).
 */
export const storageReady = (status: SecretStorageStatus | null, failed: boolean): boolean =>
  !failed && status?.canSave === true;
