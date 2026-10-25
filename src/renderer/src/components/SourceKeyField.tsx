import { useId, useState } from "react";
import type { SourceProviderInfo } from "../../../core/api";
import { checkApiKey } from "../../../shared/apiKey";
import { useFindSources } from "../findSources";
import { useT } from "../i18n";
import { KeyCharacterLine } from "./KeyCharacterLine";
import { ProblemLine } from "./ProblemLine";
import { buttonStyle, inputClass } from "./ui";

/**
 * A provider's key of the User's own: optional for openFDA, needed for
 * GovInfo, with where to get one. A line under the search that opens to a
 * field, kept in the keychain by the core and never shown again. Saving an
 * empty field removes it.
 */
export function SourceKeyField({ provider }: { provider: SourceProviderInfo }) {
  const t = useT();
  const hintId = useId();
  const open = useFindSources((state) => state.keyOpen === provider.id);
  const [key, setKey] = useState("");
  const { key: text, stray } = checkApiKey(key);
  const [problem, setProblem] = useState<string | null>(null);
  const save = async (value: string | null) => {
    const failed = await useFindSources.getState().setKey(provider.id, value);
    setProblem(failed);
    if (!failed) setKey("");
  };
  const name = { provider: provider.name };
  return (
    <div data-provider={provider.id} className="mt-2 text-[13px] leading-5 text-ink-secondary">
      <button
        type="button"
        aria-expanded={open}
        data-testid="find-sources-key-open"
        onClick={() => useFindSources.getState().openKey(open ? null : provider.id)}
        className="underline decoration-rule-strong underline-offset-2 hover:text-ink"
      >
        {t("sources.key.open", name)}
      </button>
      {provider.key === "set" && (
        <span data-testid="find-sources-key-set" className="ml-2 text-ink-meta">
          {t("sources.key.set")}
        </span>
      )}
      {open && (
        <form
          className="mt-1.5 flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (text !== "" && !stray) void save(text);
          }}
        >
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            // biome-ignore lint/a11y/noAutofocus: it opens only when the User asks to add a key.
            autoFocus
            data-testid="find-sources-key"
            aria-label={t("sources.key.title", name)}
            aria-describedby={stray ? `${hintId}-stray ${hintId}` : hintId}
            placeholder={t("sources.key.placeholder")}
            aria-invalid={stray ? true : undefined}
            value={key}
            onChange={(event) => setKey(event.target.value)}
            className={`${inputClass} mt-0 min-w-48 flex-1`}
          />
          <button
            type="submit"
            data-testid="find-sources-key-save"
            disabled={text === "" || stray !== null}
            className={buttonStyle("primary")}
          >
            {t("sources.key.save")}
          </button>
          {provider.key === "set" && (
            <button
              type="button"
              data-testid="find-sources-key-remove"
              onClick={() => void save(null)}
              className={buttonStyle("ghost")}
            >
              {t("sources.key.remove")}
            </button>
          )}
          {stray && (
            <div className="basis-full">
              <KeyCharacterLine id={`${hintId}-stray`} stray={stray} />
            </div>
          )}
          <p id={hintId} className="basis-full text-ink-meta">
            {t(provider.keyNeeded ? "sources.key.hint.needed" : "sources.key.hint", name)}
            {provider.keySignUp && (
              <>
                {" "}
                <a
                  href={provider.keySignUp}
                  target="_blank"
                  rel="noreferrer"
                  data-testid="find-sources-key-sign-up"
                  className="underline decoration-rule-strong underline-offset-2 hover:text-ink"
                >
                  {t("sources.key.signUp")}
                </a>
              </>
            )}
          </p>
        </form>
      )}
      {problem && (
        <ProblemLine className="mt-1" testId="find-sources-key-problem" title={problem}>
          {t("sources.key.failed")}
        </ProblemLine>
      )}
    </div>
  );
}
