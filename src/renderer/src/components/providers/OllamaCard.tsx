import { useCallback, useEffect, useState } from "react";
import type { ChatProvider, OllamaPullProgress, OllamaStatus } from "../../../../core/api";
import { OLLAMA_DOWNLOAD_URL } from "../../../../core/providers/catalog/billing";
import { core } from "../../core";
import { errorMessage } from "../../errors";
import { useT } from "../../i18n";
import { localModeChosen } from "../../localMode";
import { useAppStore } from "../../store";
import { ProblemMark } from "../ProblemLine";
import { buttonStyle, errorTextClass } from "../ui";
import { useKeepLocal } from "./KeepLocalChoice";

/** `open` resolves null when Ollama's app couldn't be opened; that failure is already reported. */
export function useOllamaStatus() {
  const [status, setStatus] = useState<OllamaStatus | null>(null);
  const [opening, setOpening] = useState(false);

  const detect = useCallback(async () => {
    setStatus(null);
    try {
      setStatus(await core.detectOllama());
    } catch {
      setStatus({ running: false, baseUrl: "", installed: false, recommendedModel: "" });
    }
  }, []);

  useEffect(() => {
    void detect();
  }, [detect]);

  const open = async (): Promise<OllamaStatus | null> => {
    setOpening(true);
    try {
      const opened = await core.openOllama();
      setStatus(opened);
      return opened;
    } catch (failure) {
      useAppStore.getState().reportError(failure);
      return null;
    } finally {
      setOpening(false);
    }
  };

  return { status, opening, detect, open };
}

/**
 * Local mode: whether Ollama runs on its default port, and, if it does, one
 * call that pulls the recommended model (with progress) and makes it the
 * default chat model, or, with `keepDefault`, leaves a default there is.
 */
export function useOllama(
  onSaved: (provider: ChatProvider) => void,
  undoPlace?: string,
  { keepDefault = false }: { keepDefault?: boolean } = {},
) {
  const t = useT();
  const { status, opening, detect, open } = useOllamaStatus();
  const [pulling, setPulling] = useState(false);
  const [progress, setProgress] = useState<OllamaPullProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => core.on("ollama.pullProgress", setProgress), []);

  const keepLocal = useKeepLocal(status?.running === true);

  const use = async () => {
    setPulling(true);
    setProgress(null);
    setError(null);
    try {
      const wasOn = (await core.getEmbeddingSettings()).localOnly;
      const provider = await core.selectOllama({
        ...(keepLocal.setUp && { localOnly: keepLocal.checked }),
        ...(keepDefault && { keepDefault }),
      });
      await localModeChosen(wasOn, undoPlace);
      onSaved(provider);
    } catch (failure) {
      setError(errorMessage(failure, t));
    } finally {
      setPulling(false);
    }
  };

  return { status, pulling, progress, error, keepLocal, opening, detect, open, use };
}

export type Ollama = ReturnType<typeof useOllama>;

/** What Ollama's choice says about this computer: looking, found, or not found. */
export function ollamaDescription(ollama: Ollama, t: ReturnType<typeof useT>): string {
  if (ollama.status === null) return t("providers.ollama.checking");
  return ollama.status.running ? t("providers.ollama.detected") : t("providers.ollama.notDetected");
}

/** The model being pulled, with its progress, and what went wrong. */
export function OllamaProgress({ ollama }: { ollama: Ollama }) {
  const t = useT();
  const { status, pulling, progress, error } = ollama;
  const percent =
    progress?.total && progress.completed !== null
      ? Math.round((progress.completed / progress.total) * 100)
      : null;
  if (!pulling && !error) return null;
  return (
    <div data-testid="ollama" className="flex flex-col gap-1.5">
      {pulling && (
        <div className="text-[13px] leading-5 text-ink-secondary">
          <p>
            {t("providers.ollama.pulling", {
              model: progress?.model ?? (status?.running ? status.recommendedModel : ""),
            })}
          </p>
          <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-rule">
            <div
              className={`h-full bg-ink ${percent === null ? "w-1/3 motion-safe:animate-pulse" : ""}`}
              style={percent === null ? undefined : { width: `${percent}%` }}
            />
          </div>
          {progress && (
            <p className="mt-1 text-[12px] text-ink-meta">
              {progress.status}
              {percent === null ? "" : ` · ${percent}%`}
            </p>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className={errorTextClass}>
          <ProblemMark />
          {error}
        </p>
      )}
    </div>
  );
}

/** Ollama's button: use it (pulling the recommended model), or get it and look for it again. */
export function OllamaAction({ ollama, large = false }: { ollama: Ollama; large?: boolean }) {
  const t = useT();
  const { status, pulling } = ollama;
  const size = large ? "lg" : "md";
  if (status?.running) {
    return (
      <button
        type="button"
        data-testid="ollama-use"
        disabled={pulling || !ollama.keepLocal.asked}
        onClick={() => void ollama.use()}
        className={buttonStyle("primary", size)}
      >
        {t("providers.ollama.use", { model: status.recommendedModel })}
      </button>
    );
  }
  return (
    <span className="flex flex-wrap items-center gap-2">
      {status !== null && (
        // The main process opens it in the User's browser.
        <button
          type="button"
          data-testid="ollama-get"
          onClick={() => window.open(OLLAMA_DOWNLOAD_URL, "_blank", "noreferrer")}
          className={buttonStyle("primary", size)}
        >
          {t("providers.ollama.get")} ↗
        </button>
      )}
      <button
        type="button"
        data-testid="ollama-check-again"
        disabled={status === null}
        onClick={() => void ollama.detect()}
        className={buttonStyle("secondary", size)}
      >
        {t("providers.ollama.checkAgain")}
      </button>
    </span>
  );
}
