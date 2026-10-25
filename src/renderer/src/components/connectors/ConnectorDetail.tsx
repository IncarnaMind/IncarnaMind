import { type ReactNode, useEffect, useRef, useState } from "react";
import type {
  ApprovalPolicy,
  Connector,
  ConnectorClientInput,
  ConnectorDirectoryEntry,
  ConnectorError,
  ConnectorState,
} from "../../../../core/api";
import type { MessageKey } from "../../../../shared/i18n";
import { focusComposer } from "../../commands/assistant";
import { core } from "../../core";
import { errorMessage } from "../../errors";
import { useT } from "../../i18n";
import { useAppStore } from "../../store";
import { CheckLineIcon, PencilLineIcon, TrashLineIcon } from "../lineIcons";
import { ProblemMark } from "../ProblemLine";
import { SettingsBackLink } from "../SettingsBackLink";
import { buttonStyle, errorTextClass, iconButtonClass, primaryButtonClass } from "../ui";
import { ConnectorForm } from "./ConnectorForm";
import { ConnectorTile } from "./ConnectorTile";
import { ConnectorTools, ReviewedTools } from "./ConnectorTools";
import { commandLine } from "./commandLine";
import { ClientForm, RemoteSignIn } from "./RemoteSignIn";

/** A state's dot: working (blue), or waiting for the User (amber). Green and red are for checks only. */
const stateDot: Record<ConnectorState, string | null> = {
  off: null,
  paused: null,
  connecting: "bg-accent",
  "signing-in": "bg-accent",
  "needs-sign-in": "bg-attention",
  ready: null,
  error: "bg-attention",
};

/** A state's name: remote Connectors' own states are under `remoteConnectors.`. */
export function stateKey(state: ConnectorState): MessageKey {
  return state === "signing-in" || state === "needs-sign-in"
    ? `remoteConnectors.state.${state}`
    : `connectors.state.${state}`;
}

/** Where a Connector is: its command line, or its server's URL. */
const locationOf = (connector: Connector) =>
  connector.transport === "http" ? connector.url : commandLine(connector.command, connector.args);

/** A page's way back to the list. */
export function BackToConnectors({ onBack }: { onBack(): void }) {
  const t = useT();
  return (
    <SettingsBackLink
      label={t("connectors.directory.back")}
      testId="connectors-back"
      onBack={onBack}
    />
  );
}

/** Runs an action on a Connector; a failure shows as a notice. */
async function act(action: () => Promise<unknown>) {
  try {
    await action();
  } catch (failure) {
    useAppStore.getState().reportError(failure);
  }
}

const sectionClass = "flex flex-col gap-1";
const sectionHeadClass = "text-[13px] leading-5 font-semibold text-ink";
const sectionTextClass = "max-w-[600px] text-[13px] leading-5 text-ink-secondary";

/**
 * A Connector's page: a directory entry before the User connects it (what it
 * can do, where their data goes, how it signs in, and Connect), or a
 * Connector they have, from the directory or added themselves (its state,
 * on or off, its sign-in, and its Tools with whether each asks first).
 */
export function ConnectorDetail({
  entry,
  connector,
  policies,
  signInOnOpen = false,
  onBack,
}: {
  entry?: ConnectorDirectoryEntry;
  connector?: Connector;
  policies: ApprovalPolicy[];
  /** Opened by "Sign in again": the sign-in starts at once. */
  signInOnOpen?: boolean;
  onBack(): void;
}) {
  const t = useT();
  const name = entry?.name ?? connector?.name ?? "";
  const [connecting, setConnecting] = useState(false);
  const [justConnected, setJustConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const startedSignIn = useRef(false);

  useEffect(() => {
    if (!signInOnOpen || startedSignIn.current || connector?.transport !== "http") return;
    startedSignIn.current = true;
    void act(() => core.signInToConnector(connector.id));
  }, [signInOnOpen, connector]);

  const connect = async (client?: ConnectorClientInput) => {
    if (!entry) return;
    setConnecting(true);
    setError(null);
    try {
      const added = await core.addConnectorFromDirectory(entry.id, client);
      if (entry.signIn === "none") {
        setJustConnected(true);
        return;
      }
      const result = await core.signInToConnector(added.id);
      // A sign-in that didn't work says why under the Connector's state.
      if (result.ok) setJustConnected(true);
    } catch (failure) {
      setError(errorMessage(failure, t));
    } finally {
      setConnecting(false);
    }
  };

  const subscription = entry?.subscription;
  const meta = entry
    ? [
        t("connectors.directory.by", { publisher: entry.publisher }),
        t("connectors.directory.reviewed"),
        ...(subscription === "free"
          ? [t("connectors.directory.free")]
          : subscription
            ? [t("connectors.directory.subscription", { product: subscription.product })]
            : []),
      ].join(" · ")
    : t("connectors.directory.custom");
  const ownApp = entry?.signIn === "own-app";

  let action: ReactNode = null;
  if (connector?.state === "signing-in") {
    action = (
      <span
        data-testid="connector-signing-in"
        className="flex shrink-0 items-center gap-2 text-[13px] leading-5 text-ink-secondary"
      >
        <span aria-hidden="true" className="size-1.5 rounded-full bg-accent" />
        {t("remoteConnectors.signingIn")}
        <button
          type="button"
          data-testid="connector-sign-in-cancel"
          onClick={() => void act(() => core.cancelConnectorSignIn(connector.id))}
          className={buttonStyle("ghost", "sm")}
        >
          {t("remoteConnectors.cancel")}
        </button>
      </span>
    );
  } else if (entry && !connector && !ownApp) {
    action = (
      <button
        type="button"
        data-testid="connector-connect"
        disabled={connecting}
        onClick={() => void connect()}
        className={`${primaryButtonClass} shrink-0`}
      >
        {connecting ? t("connectors.directory.connecting") : t("connectors.directory.connect")}
      </button>
    );
  }

  const how = !entry
    ? null
    : entry.signIn === "none"
      ? t("connectors.directory.how.none")
      : entry.signIn === "own-app"
        ? t("connectors.directory.how.own-app", { name })
        : subscription && subscription !== "free"
          ? t("connectors.directory.how.browser.subscription", {
              name,
              product: subscription.product,
            })
          : t("connectors.directory.how.browser", { name });

  return (
    <section
      data-testid="connector-detail"
      data-entry-id={entry?.id}
      data-connector-id={connector?.id}
      className="flex flex-col gap-4"
    >
      <BackToConnectors onBack={onBack} />
      <div className="flex flex-wrap items-center gap-3">
        <ConnectorTile name={name} large />
        <div className="flex min-w-[200px] flex-1 flex-col">
          <h4
            data-testid="connector-name"
            className="text-[17px] leading-6 font-semibold break-words text-ink"
          >
            {name}
          </h4>
          <p className="text-[12px] leading-[18px] text-ink-meta">{meta}</p>
        </div>
        {action}
      </div>
      {error && (
        <p role="alert" className={errorTextClass}>
          <ProblemMark />
          {error}
        </p>
      )}
      {justConnected && connector?.state === "ready" && (
        <div
          role="status"
          data-testid="connector-connected"
          className="flex flex-wrap items-center gap-2.5 rounded-lg bg-frame px-3 py-2.5 text-[13px] leading-5 text-ink"
        >
          <CheckLineIcon className="size-3.5 shrink-0 text-ink-secondary" />
          <span className="flex-1">{t("connectors.directory.done", { name })}</span>
          <button
            type="button"
            data-testid="connector-try"
            onClick={(event) => {
              // The window is inert until Settings has closed: the composer can take the focus then.
              event.currentTarget
                .closest("dialog")
                ?.addEventListener("close", () => focusComposer(), { once: true });
              useAppStore.getState().closeSettings();
            }}
            className={buttonStyle("secondary", "sm")}
          >
            {t("connectors.directory.try")}
          </button>
        </div>
      )}
      {entry && !connector && ownApp && (
        <ClientForm
          submitLabel={t("connectors.directory.connect")}
          onSubmit={(client) => connect(client)}
        />
      )}
      {connector && <ConnectorControls connector={connector} />}

      <div className={sectionClass}>
        <h5 className={sectionHeadClass}>{t("connectors.directory.what")}</h5>
        {connector?.state === "ready" && connector.tools ? (
          <ConnectorTools connectorId={connector.id} tools={connector.tools} policies={policies} />
        ) : entry?.tools ? (
          <ReviewedTools tools={entry.tools} />
        ) : (
          <p className={sectionTextClass}>{t("connectors.directory.what.before")}</p>
        )}
      </div>
      {entry && (
        <>
          <div className={sectionClass}>
            <h5 className={sectionHeadClass}>{t("connectors.directory.where")}</h5>
            <p className={sectionTextClass}>{t("connectors.directory.where.body", { name })}</p>
          </div>
          <div className={sectionClass}>
            <h5 className={sectionHeadClass}>{t("connectors.directory.how")}</h5>
            <p className={sectionTextClass}>{how}</p>
          </div>
        </>
      )}
    </section>
  );
}

/**
 * A Connector the User has: its state, a switch to turn it on or off, Change
 * (a local one) and Remove, what went wrong, and a remote one's sign-in.
 */
function ConnectorControls({ connector }: { connector: Connector }) {
  const t = useT();
  const { id, name } = connector;
  const heldBack = connector.transport === "http" && connector.signIn.heldBack;
  const dot = heldBack ? null : stateDot[connector.state];
  const [editing, setEditing] = useState(false);
  return (
    <div
      data-testid="connector"
      data-connector-id={id}
      data-state={connector.state}
      className="flex flex-col gap-1 border-y border-rule py-3"
    >
      <div className="flex items-center gap-3">
        <span className="flex min-w-0 flex-1 items-center gap-1.5 text-[13px] leading-5 text-ink-meta">
          {dot && <span aria-hidden="true" className={`size-1.5 rounded-full ${dot}`} />}
          <span data-testid="connector-state">
            {t(heldBack ? "connectors.state.paused" : stateKey(connector.state))}
          </span>
        </span>
        <input
          type="checkbox"
          role="switch"
          aria-checked={connector.enabled}
          data-testid="connector-toggle"
          aria-label={t("connectors.toggle", { name })}
          checked={connector.enabled}
          onChange={(event) => void act(() => core.setConnectorEnabled(id, event.target.checked))}
          className="switch"
        />
        {connector.transport === "stdio" && (
          <button
            type="button"
            data-testid="connector-edit"
            aria-label={t("connectors.edit", { name })}
            title={t("connectors.edit", { name })}
            aria-expanded={editing}
            onClick={() => setEditing((open) => !open)}
            className={iconButtonClass}
          >
            <PencilLineIcon className="size-4" />
          </button>
        )}
        <button
          type="button"
          data-testid="connector-remove"
          aria-label={t("connectors.remove", { name })}
          title={t("connectors.remove", { name })}
          onClick={() => void act(() => core.deleteConnector(id))}
          className={iconButtonClass}
        >
          <TrashLineIcon className="size-4" />
        </button>
      </div>
      <p
        data-testid="connector-location"
        className="truncate font-mono text-[12px] leading-[18px] text-ink-meta"
        title={locationOf(connector)}
      >
        {locationOf(connector)}
      </p>
      {editing && connector.transport === "stdio" && (
        <ConnectorForm editing={connector} onDone={() => setEditing(false)} />
      )}
      {connector.state === "error" && connector.error && (
        <ErrorNotice
          error={connector.error}
          onRetry={() => void act(() => core.restartConnector(id))}
        />
      )}
      {connector.transport === "http" && connector.enabled && connector.state !== "paused" && (
        <RemoteSignIn connector={connector} />
      )}
    </div>
  );
}

/** What went wrong, in plain words, and what the User can do. */
function ErrorNotice({ error, onRetry }: { error: ConnectorError; onRetry(): void }) {
  const t = useT();
  const message =
    error.kind === "missing-command"
      ? error.install
        ? t("connectors.error.missing-command.install", {
            command: error.command ?? "",
            install: error.install,
          })
        : t("connectors.error.missing-command", { command: error.command ?? "" })
      : error.kind === "unreachable"
        ? t("remoteConnectors.error.unreachable")
        : t(`connectors.error.${error.kind}`);
  return (
    <div
      role="alert"
      data-testid="connector-error"
      data-error-kind={error.kind}
      className="mt-1 flex flex-col gap-1.5 text-[13px] leading-5 text-ink"
    >
      <p className="break-words">
        <ProblemMark />
        {message}
      </p>
      <div className="flex flex-wrap items-center gap-2 text-[12px]">
        {error.retrying ? (
          <span className="text-ink-meta">{t("connectors.restarting")}</span>
        ) : (
          <button type="button" onClick={onRetry} className={buttonStyle("secondary", "sm")}>
            {t("connectors.retry")}
          </button>
        )}
        {error.kind !== "missing-command" && error.message && (
          <details className="min-w-0 text-ink-meta">
            <summary className="cursor-pointer">{t("connectors.details")}</summary>
            <pre className="mt-1 max-h-32 overflow-auto font-mono whitespace-pre-wrap break-words">
              {error.message}
            </pre>
          </details>
        )}
      </div>
    </div>
  );
}
