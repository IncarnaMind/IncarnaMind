import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  type ApprovalPolicy,
  type Connector,
  type ConnectorDirectoryEntry,
  type ConnectorRegistrySearch,
  type ConnectorRegistryServer,
  connectorDirectoryGroups,
} from "../../../../core/api";
import type { Language } from "../../../../core/language";
import { core } from "../../core";
import { useLanguage, useT } from "../../i18n";
import { useAppStore } from "../../store";
import { PlusLineIcon, SearchLineIcon } from "../lineIcons";
import {
  SettingsGroup,
  SettingsRow,
  SettingsRowAction,
  SettingsSection,
} from "../settings/SettingsGroup";
import { buttonStyle, pageIntroClass } from "../ui";
import { AddCustomConnector } from "./AddCustomConnector";
import { ConnectorDetail, stateKey } from "./ConnectorDetail";
import { ConnectorTile } from "./ConnectorTile";
import { RegistryDetail } from "./RegistryDetail";
import { RegistryResults } from "./RegistryResults";

/** Which page of Settings › Connectors shows: the list, a Connector's page, or adding one. */
type View =
  | { page: "list" }
  | { page: "entry"; entryId: string; signIn?: boolean }
  | { page: "connector"; connectorId: string; signIn?: boolean }
  | { page: "registry"; server: ConnectorRegistryServer }
  | { page: "custom"; from?: ConnectorRegistryServer };

/** How long typing pauses before the MCP Registry is asked. */
const REGISTRY_PAUSE_MS = 400;

/** The directory entry a Connector is: the one at its server's URL. */
const entryOf = (directory: readonly ConnectorDirectoryEntry[], connector: Connector) =>
  connector.transport === "http"
    ? directory.find((entry) => entry.url === connector.url)
    : undefined;

const matches = (query: string, ...texts: string[]) => {
  const words = query.trim().toLocaleLowerCase();
  return words === "" || texts.some((text) => text.toLocaleLowerCase().includes(words));
};

const shownIn = (entry: ConnectorDirectoryEntry, language: Language) =>
  !entry.languages || entry.languages.includes(language);

/**
 * Settings › Connectors (#148): a search field; the Connectors the User has,
 * each with its state; then Browse, the reviewed directory grouped by use; and
 * Add custom connector…. A card or a row opens the Connector's page, where it
 * is connected and managed.
 */
export function ConnectorsSettings() {
  const t = useT();
  const language = useLanguage();
  const [connectors, setConnectors] = useState<Connector[] | null>(null);
  const [policies, setPolicies] = useState<ApprovalPolicy[]>([]);
  const [directory, setDirectory] = useState<ConnectorDirectoryEntry[]>([]);
  const [view, setView] = useState<View>({ page: "list" });
  const [query, setQuery] = useState("");
  /** The MCP Registry's answer to the words searched; null while it is being asked. */
  const [registry, setRegistry] = useState<{
    words: string;
    search: ConnectorRegistrySearch | null;
  } | null>(null);
  /** Asking again after a failure, with the same words. */
  const [attempt, setAttempt] = useState(0);
  const section = useRef<HTMLElement>(null);
  /** What opened the page now showing, to give the focus back to on the way back. */
  const opener = useRef<string | null>(null);

  useEffect(() => {
    core.listConnectors().then(setConnectors, () => undefined);
    core.listApprovalPolicies().then(setPolicies, () => undefined);
    core.listConnectorDirectory().then(setDirectory, () => undefined);
    const stops = [
      core.on("connectors.changed", setConnectors),
      core.on("approvals.changed", setPolicies),
    ];
    return () => {
      for (const stop of stops) stop();
    };
  }, []);

  // The MCP Registry is asked only once the User types, after a pause, and never for one letter.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Try again asks once more with the same words.
  useEffect(() => {
    const words = query.trim();
    if (words.length < 2) {
      setRegistry(null);
      return;
    }
    let current = true;
    const timer = setTimeout(() => {
      setRegistry({ words, search: null });
      core.searchConnectorRegistry(words).then(
        (search) => {
          if (current) setRegistry({ words, search });
        },
        (failure: unknown) => {
          if (!current) return;
          useAppStore.getState().reportError(failure);
          setRegistry({ words, search: { outcome: "failed", reason: "service-error" } });
        },
      );
    }, REGISTRY_PAUSE_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [query, attempt]);

  // Each page starts at its top; back on the list, the focus is where it was.
  useLayoutEffect(() => {
    section.current?.closest("[data-testid^='settings-page-']")?.scrollTo({ top: 0 });
    if (view.page === "list" && opener.current) {
      section.current
        ?.querySelector<HTMLElement>(`[data-opens="${CSS.escape(opener.current)}"]`)
        ?.focus();
    }
  }, [view.page]);

  if (!connectors) return null;

  const open = (next: View, from: string) => {
    opener.current = from;
    setView(next);
  };
  const back = () => setView({ page: "list" });

  if (view.page === "entry") {
    const entry = directory.find((each) => each.id === view.entryId);
    if (entry) {
      return (
        <section ref={section}>
          <ConnectorDetail
            key={entry.id}
            entry={entry}
            connector={connectors.find((each) => entryOf(directory, each) === entry)}
            policies={policies}
            signInOnOpen={view.signIn}
            onBack={back}
          />
        </section>
      );
    }
  }
  if (view.page === "connector") {
    const connector = connectors.find((each) => each.id === view.connectorId);
    if (connector) {
      return (
        <section ref={section}>
          <ConnectorDetail
            key={connector.id}
            connector={connector}
            policies={policies}
            signInOnOpen={view.signIn}
            onBack={back}
          />
        </section>
      );
    }
  }
  if (view.page === "registry") {
    return (
      <section ref={section}>
        <RegistryDetail
          server={view.server}
          onBack={back}
          onAdded={(connector) => setView({ page: "connector", connectorId: connector.id })}
          onSetUp={(server) => setView({ page: "custom", from: server })}
        />
      </section>
    );
  }
  if (view.page === "custom") {
    const { from } = view;
    return (
      <section ref={section}>
        <AddCustomConnector
          prefill={from?.command ? { name: from.name, ...from.command } : undefined}
          onBack={back}
          onAdded={(connector) => {
            const entry = entryOf(directory, connector);
            setView(
              entry
                ? { page: "entry", entryId: entry.id }
                : { page: "connector", connectorId: connector.id },
            );
          }}
        />
      </section>
    );
  }

  const pageOf = (connector: Connector, signIn = false): View => {
    const entry = entryOf(directory, connector);
    return entry
      ? { page: "entry", entryId: entry.id, signIn }
      : { page: "connector", connectorId: connector.id, signIn };
  };
  const connected = connectors.filter((connector) =>
    matches(query, connector.name, connector.transport === "http" ? connector.url : ""),
  );
  const browsed = directory.filter(
    (entry) =>
      shownIn(entry, language) &&
      matches(query, entry.name, entry.publisher, entry.summary[language]),
  );
  const searching = query.trim() !== "";

  return (
    <section ref={section} data-testid="connectors-settings" className="flex flex-col gap-6">
      <div className="flex flex-col gap-4">
        <p className={pageIntroClass}>{t("connectors.directory.intro")}</p>
        <label className="flex h-[34px] items-center gap-2 rounded-lg bg-sheet px-2.5 text-ink-meta shadow-[inset_0_0_0_1px_var(--color-rule-strong)] focus-within:shadow-[inset_0_0_0_1px_var(--color-accent)]">
          <SearchLineIcon className="size-3.5 shrink-0" />
          <input
            type="search"
            data-testid="connectors-search"
            value={query}
            placeholder={t("connectors.directory.search")}
            aria-label={t("connectors.directory.search")}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              // Esc empties the field first; with it empty, Esc closes Settings.
              if (event.key === "Escape" && query !== "") {
                event.preventDefault();
                setQuery("");
              }
            }}
            className="h-full min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-placeholder"
          />
        </label>
      </div>

      {connected.length > 0 && (
        <SettingsSection title={t("connectors.directory.connected")}>
          <SettingsGroup data-testid="connectors-connected">
            {connected.map((connector) => (
              <ConnectedRow
                key={connector.id}
                connector={connector}
                onOpen={(signIn) => open(pageOf(connector, signIn), `connector:${connector.id}`)}
              />
            ))}
          </SettingsGroup>
        </SettingsSection>
      )}

      {searching ? (
        <SettingsSection title={t("connectors.directory.browse")}>
          {browsed.length === 0 ? (
            <p className="px-4 text-[13px] leading-5 text-ink-meta">
              {t("connectors.directory.noMatch", { query: query.trim() })}
            </p>
          ) : (
            <EntryGroup
              entries={browsed}
              language={language}
              onOpen={(entry) => open({ page: "entry", entryId: entry.id }, `entry:${entry.id}`)}
            />
          )}
        </SettingsSection>
      ) : (
        connectorDirectoryGroups.map((group) => {
          const entries = browsed.filter((entry) => entry.group === group);
          if (entries.length === 0) return null;
          return (
            <div key={group} data-testid="connectors-group" data-group={group}>
              <SettingsSection title={t(`connectors.directory.group.${group}`)}>
                <EntryGroup
                  entries={entries}
                  language={language}
                  onOpen={(entry) =>
                    open({ page: "entry", entryId: entry.id }, `entry:${entry.id}`)
                  }
                />
              </SettingsSection>
            </div>
          );
        })
      )}

      {registry && (
        <RegistryResults
          words={registry.words}
          search={registry.search}
          onOpen={(server) => open({ page: "registry", server }, `registry:${server.id}`)}
          onRetry={() => setAttempt((count) => count + 1)}
        />
      )}

      <div>
        <button
          type="button"
          data-testid="connector-add-custom"
          data-opens="custom"
          onClick={() => open({ page: "custom" }, "custom")}
          className={buttonStyle("secondary", "sm")}
        >
          <PlusLineIcon className="size-3.5" />
          {t("connectors.directory.addCustom")}
        </button>
      </div>
    </section>
  );
}

/** A Connector the User has: its tile, name and state, then Manage, or Sign in again once its sign-in expired. */
function ConnectedRow({
  connector,
  onOpen,
}: {
  connector: Connector;
  onOpen(signIn: boolean): void;
}) {
  const t = useT();
  const expired =
    connector.transport === "http" &&
    connector.state === "needs-sign-in" &&
    connector.signIn.expired &&
    !connector.signIn.heldBack;
  const heldBack = connector.transport === "http" && connector.signIn.heldBack;
  const tools = connector.tools ?? [];
  const status = heldBack
    ? t("connectors.state.paused")
    : expired
      ? t("connectors.directory.status.expired")
      : connector.state === "ready"
        ? tools.length > 0 && tools.every((tool) => tool.readOnly)
          ? t("connectors.directory.status.readsOnly")
          : t("connectors.directory.status.ready")
        : t(stateKey(connector.state));
  const warning =
    !heldBack && (expired || connector.state === "error" || connector.state === "needs-sign-in");
  return (
    <SettingsRow
      data-testid="connected-connector"
      data-connector-id={connector.id}
      data-state={connector.state}
      leading={<ConnectorTile name={connector.name} />}
      label={connector.name}
      detail={
        <span data-testid="connected-connector-state" className={warning ? "text-warning" : ""}>
          {status}
        </span>
      }
      control={
        <button
          type="button"
          data-testid={expired ? "connector-sign-in-again" : "connector-manage"}
          data-opens={`connector:${connector.id}`}
          onClick={() => onOpen(expired)}
          className={buttonStyle("secondary", "sm")}
        >
          {expired ? t("remoteConnectors.signInAgain") : t("connectors.directory.manage")}
        </button>
      }
    />
  );
}

/** Directory entries as rows of a group: the tile, the name, what it does, and what it needs. */
function EntryGroup({
  entries,
  language,
  onOpen,
}: {
  entries: ConnectorDirectoryEntry[];
  language: Language;
  onOpen(entry: ConnectorDirectoryEntry): void;
}) {
  const t = useT();
  return (
    <SettingsGroup>
      {entries.map((entry) => {
        const { subscription } = entry;
        return (
          <SettingsRowAction
            key={entry.id}
            testId="connector-entry"
            data-entry-id={entry.id}
            data-opens={`entry:${entry.id}`}
            onClick={() => onOpen(entry)}
            leading={<ConnectorTile name={entry.name} />}
            label={entry.name}
            detail={
              <>
                {entry.summary[language]}
                {subscription && (
                  <span className="block">
                    {subscription === "free"
                      ? t("connectors.directory.free")
                      : t("connectors.directory.subscription", { product: subscription.product })}
                  </span>
                )}
              </>
            }
          />
        );
      })}
    </SettingsGroup>
  );
}
