import type { Language } from "../../../../core/language";
import type { MessageKey, MessageParams } from "../../../../shared/i18n";
import { unitsOf } from "../../../../shared/i18n/join";

type Translate = (key: MessageKey, params?: MessageParams) => string;

/** The environment variables a Connector keeps, under its form's field: their names, never their values. */
export const envKeptLine = (names: readonly string[], t: Translate, language: Language): string =>
  t("connectors.form.envKeep", { names: unitsOf(names, language) });

/** The environment variables an imported Connector brings, before the User adds it. */
export const importEnvLine = (names: readonly string[], t: Translate, language: Language): string =>
  t("connectors.import.env", { names: unitsOf(names, language) });

/** The headers an imported remote Connector brings. */
export const importHeadersLine = (
  names: readonly string[],
  t: Translate,
  language: Language,
): string => t("remoteConnectors.import.headers", { names: unitsOf(names, language) });

/** A signed-in remote Connector's key: the headers that hold it, and the value masked. */
export const keyMaskLine = (headers: readonly string[], language: Language): string =>
  `${unitsOf(headers, language)} · ••••••••`;
