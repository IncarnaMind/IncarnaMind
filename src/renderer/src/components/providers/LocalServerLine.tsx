import { useCallback, useEffect, useRef, useState } from "react";
import type { LocalServerStatus } from "../../../../core/api";
import { checkApiKey } from "../../../../shared/apiKey";
import { core } from "../../core";
import { useT } from "../../i18n";
import { buttonClass, hintClass } from "../ui";

/** What runs at a preset's address on this computer: asked when it is chosen, and again on request. Null while asking. */
export function useLocalServer(catalogId: string | null) {
  const [status, setStatus] = useState<LocalServerStatus | null>(null);
  const latest = useRef(0);

  const detect = useCallback(
    async (apiKey = "", address = "") => {
      if (!catalogId) return;
      const mine = ++latest.current;
      setStatus(null);
      const { key, stray } = checkApiKey(apiKey);
      const where = address.trim();
      const found = await core
        .detectLocalServer({
          catalogId,
          ...(key && !stray && { apiKey: key }),
          ...(where && { address: where }),
        })
        .catch((): LocalServerStatus => ({ running: false, address: "" }));
      if (latest.current === mine) setStatus(found);
    },
    [catalogId],
  );

  useEffect(() => {
    void detect();
  }, [detect]);

  return { status, detect };
}

export function LocalServerLine({
  provider,
  status,
  away,
  onCheckAgain,
}: {
  provider: string;
  status: LocalServerStatus | null;
  /** The address is on another computer: nothing is said to stay here. */
  away: boolean;
  onCheckAgain(): void;
}) {
  const t = useT();
  return (
    <div data-testid="local-server" className="flex flex-wrap items-center gap-2">
      <p className={hintClass}>
        {status === null
          ? t("providers.local.checking", { provider })
          : status.running
            ? t(away ? "providers.local.runningAway" : "providers.local.running", {
                provider,
                address: status.address,
              })
            : t("providers.local.notRunning", { provider, address: status.address })}
      </p>
      {status?.running === false && (
        <button
          type="button"
          data-testid="local-server-check"
          onClick={onCheckAgain}
          className={`${buttonClass} h-7 px-2.5`}
        >
          {t("providers.ollama.checkAgain")}
        </button>
      )}
    </div>
  );
}
