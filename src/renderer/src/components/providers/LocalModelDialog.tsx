import { modelName } from "../../../../shared/modelName";
import { useT } from "../../i18n";
import {
  buttonClass,
  buttonStyle,
  dialogActionsClass,
  dialogBodyClass,
  dialogClass,
  dialogTextClass,
  dialogTitleClass,
} from "../ui";
import { useModal } from "../useModal";
import { GetOllamaButton } from "./GetOllama";
import {
  type Ollama,
  OllamaAction,
  OllamaProgress,
  ollamaDescription,
  useOllama,
} from "./OllamaCard";

export function LocalModelDialog({ open, onClose }: { open: boolean; onClose(): void }) {
  const dialog = useModal(open);
  return (
    <dialog
      ref={dialog}
      onClose={onClose}
      data-testid="local-model-dialog"
      aria-labelledby="local-model-title"
      className={`${dialogClass} w-[28rem]`}
    >
      {/* Mounted only while open, so it looks for Ollama each time. */}
      {open && <LocalModelChoice onClose={onClose} />}
    </dialog>
  );
}

function LocalModelChoice({ onClose }: { onClose(): void }) {
  const t = useT();
  const ollama = useOllama(onClose);
  const { status } = ollama;
  return (
    <div className={dialogBodyClass}>
      <h2 id="local-model-title" className={`${dialogTitleClass} break-words`}>
        {t("localModel.title")}
      </h2>
      <div className="flex flex-col gap-2">
        <p data-testid="local-model-status" className={dialogTextClass}>
          {status && !status.running && status.installed
            ? t("localModel.installed")
            : ollamaDescription(ollama, t)}
        </p>
        {status?.recommendedModel && (
          <p
            data-testid="local-model-recommended"
            title={status.recommendedModel}
            className={dialogTextClass}
          >
            {t("localModel.recommended", {
              model: modelName(status.recommendedModel, { kind: "ollama" }),
            })}
          </p>
        )}
        <OllamaProgress ollama={ollama} />
      </div>
      <div className={dialogActionsClass}>
        <button type="button" onClick={onClose} className={buttonClass}>
          {t("localModel.cancel")}
        </button>
        <LocalModelActions ollama={ollama} />
      </div>
    </div>
  );
}

function LocalModelActions({ ollama }: { ollama: Ollama }) {
  const t = useT();
  const { status, opening } = ollama;
  if (status?.running) return <OllamaAction ollama={ollama} />;
  return (
    <>
      <button
        type="button"
        data-testid="ollama-check-again"
        disabled={status === null || opening}
        onClick={() => void ollama.detect()}
        className={buttonClass}
      >
        {t("providers.ollama.checkAgain")}
      </button>
      {status?.installed ? (
        <button
          type="button"
          data-testid="ollama-open"
          disabled={opening}
          onClick={() => void ollama.open()}
          className={buttonStyle("primary")}
        >
          {t(opening ? "localModel.opening" : "localModel.open")}
        </button>
      ) : (
        status !== null && <GetOllamaButton />
      )}
    </>
  );
}
