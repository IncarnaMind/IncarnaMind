import type { ClaudeCodeInstaller, Logger } from "../adapters";
import type {
  AgentClient,
  ClaudeCodeInstallAvailability,
  ClaudeCodeInstallState,
  ExternalService,
} from "../api";
import type { Consent } from "../consent";

const INSTALLER_SERVICE: ExternalService = {
  id: "anthropic-claude-code-installer",
  name: "Anthropic (claude.ai)",
};

const INSTALL_FLOW_SENDS = ["installer-request"] as const;

/** Clients whose presence means the User already has a command-line AI on this computer. */
const CLI_CLIENT_IDS = new Set(["claude-code", "opencode"]);

export interface ClaudeCodeInstallControllerOptions {
  installer: ClaudeCodeInstaller | undefined;
  consent: Consent;
  localOnly(): boolean;
  clients(): Promise<AgentClient[]> | AgentClient[];
  onChanged(state: ClaudeCodeInstallState): void;
  onClientsChanged(): void;
  lifetime: AbortSignal;
  log: Logger;
}

/**
 * Coordinates one-press installation of Anthropic's official Claude Code binary and the handoff
 * to Anthropic's own browser sign-in (#3638). Never runs in the background without an explicit
 * User press, records consent via `consent.ts` (ADR-0022), leaves an already-installed `claude`
 * untouched, honours Local mode on every path, and never handles or stores credentials.
 */
export function createClaudeCodeInstallController(options: ClaudeCodeInstallControllerOptions) {
  const { installer, consent, log } = options;

  if (installer) {
    consent.registry.register({
      id: "agent-install",
      sends: INSTALL_FLOW_SENDS,
      services: async () => [],
    });
  }

  let state: ClaudeCodeInstallState = { kind: "idle" };
  let activeInstall: { stop: AbortController; done: Promise<void> } | null = null;
  let activeSignIn: { stop: AbortController; done: Promise<void> } | null = null;

  const setState = (next: ClaudeCodeInstallState): ClaudeCodeInstallState => {
    state = next;
    options.onChanged(next);
    return next;
  };

  const stopSignIn = async () => {
    const running = activeSignIn;
    if (!running) return;
    activeSignIn = null;
    running.stop.abort();
    await running.done.catch(() => undefined);
  };

  const beginSignIn = (adapter: ClaudeCodeInstaller): ClaudeCodeInstallState => {
    if (options.localOnly()) {
      return setState({ kind: "failed", reason: "local-mode" });
    }
    if (activeSignIn) {
      activeSignIn.stop.abort();
      activeSignIn = null;
    }
    const stop = new AbortController();
    const signal = AbortSignal.any([options.lifetime, stop.signal]);
    const current = setState({ kind: "awaiting-sign-in" });
    const entry: { stop: AbortController; done: Promise<void> } = {
      stop,
      done: Promise.resolve(),
    };
    activeSignIn = entry;
    entry.done = (async () => {
      try {
        const outcome = await adapter.startSignIn({ signal });
        if (activeSignIn !== entry || signal.aborted) return;
        activeSignIn = null;
        if (outcome.kind === "signed-in") {
          const auth = await adapter.checkAuth();
          if (signal.aborted) return;
          if (auth.kind === "signed-in") {
            options.onClientsChanged();
            setState({ kind: "signed-in" });
          } else if (auth.kind === "no-plan") {
            setState({ kind: "no-plan" });
          } else {
            setState({ kind: "failed", reason: "sign-in-failed" });
          }
          return;
        }
        if (outcome.kind === "no-plan") {
          setState({ kind: "no-plan" });
          return;
        }
        if (outcome.kind === "failed") {
          log.warn("agents.claudeCodeSignInFailed", {
            detail: outcome.detail ?? "unknown",
          });
          setState({ kind: "failed", reason: "sign-in-failed" });
        }
      } catch (error: unknown) {
        if (activeSignIn === entry) activeSignIn = null;
        if (!signal.aborted) {
          log.warn("agents.claudeCodeSignInError", {
            error: error instanceof Error ? error.name : "unknown",
          });
          setState({ kind: "failed", reason: "sign-in-failed" });
        }
      } finally {
        if (activeSignIn === entry) activeSignIn = null;
      }
    })();
    return current;
  };

  const handOffAfterInstalled = async (
    adapter: ClaudeCodeInstaller,
  ): Promise<ClaudeCodeInstallState> => {
    options.onClientsChanged();
    const auth = await adapter.checkAuth();
    if (auth.kind === "signed-in") return setState({ kind: "signed-in" });
    if (auth.kind === "no-plan") return setState({ kind: "no-plan" });
    if (options.localOnly()) return setState({ kind: "failed", reason: "local-mode" });
    return beginSignIn(adapter);
  };

  return {
    async availability(): Promise<ClaudeCodeInstallAvailability> {
      const clients = await options.clients();
      if (!installer) {
        return {
          supported: false,
          installed: false,
          cliAgentPresent: clients.some((c) => CLI_CLIENT_IDS.has(c.id) && c.installed),
          directory: "~/.local/bin",
        };
      }
      const binary = await installer.findBinary();
      const installed = binary !== null;
      const cliAgentPresent =
        installed || clients.some((c) => CLI_CLIENT_IDS.has(c.id) && c.installed);
      return {
        supported: true,
        installed,
        cliAgentPresent,
        directory: installer.installDirectoryDisplay,
      };
    },

    state(): ClaudeCodeInstallState {
      return state;
    },

    async install(): Promise<ClaudeCodeInstallState> {
      if (!installer) {
        return setState({ kind: "failed", reason: "unsupported" });
      }
      if (activeInstall) return state;

      // Claim the install slot synchronously before any await so rapid double presses can never
      // start two concurrent installs or race on partial-download cleanup.
      const stop = new AbortController();
      const signal = AbortSignal.any([options.lifetime, stop.signal]);
      const { promise: done, resolve: finishDone } = Promise.withResolvers<void>();
      const entry = { stop, done };
      activeInstall = entry;

      const release = () => {
        if (activeInstall === entry) activeInstall = null;
        finishDone();
      };

      const existing = await installer.findBinary();
      if (activeInstall !== entry || signal.aborted) {
        release();
        return state;
      }
      if (existing !== null) {
        release();
        return handOffAfterInstalled(installer);
      }

      if (options.localOnly()) {
        release();
        return setState({ kind: "failed", reason: "local-mode" });
      }
      if (installer.isRoot?.()) {
        release();
        return setState({ kind: "failed", reason: "root" });
      }

      await stopSignIn();
      if (activeInstall !== entry || signal.aborted) {
        release();
        return state;
      }
      if (options.localOnly()) {
        release();
        return setState({ kind: "failed", reason: "local-mode" });
      }

      // The explicit User press is the consent for downloading Anthropic's installer (ADR-0022).
      consent.choose(["agent-install"], INSTALLER_SERVICE);

      const directory = installer.installDirectoryDisplay;
      const started = setState({ kind: "installing", stage: "downloading", directory });

      void (async () => {
        try {
          const result = await installer.install({
            signal,
            onStage: (stage) => {
              if (activeInstall === entry && !signal.aborted) {
                setState({ kind: "installing", stage, directory });
              }
            },
          });
          if (activeInstall !== entry) return;
          activeInstall = null;
          if (signal.aborted || result.kind === "cancelled") {
            setState(
              options.localOnly() ? { kind: "failed", reason: "local-mode" } : { kind: "idle" },
            );
            return;
          }
          if (result.kind === "failed") {
            log.warn("agents.claudeCodeInstallFailed", { reason: result.reason });
            setState({
              kind: "failed",
              reason: result.reason,
              ...(result.detail ? { detail: result.detail } : {}),
            });
            return;
          }
          await handOffAfterInstalled(installer);
        } catch (error: unknown) {
          if (activeInstall === entry) activeInstall = null;
          if (signal.aborted) {
            setState(
              options.localOnly() ? { kind: "failed", reason: "local-mode" } : { kind: "idle" },
            );
            return;
          }
          log.warn("agents.claudeCodeInstallError", {
            error: error instanceof Error ? error.name : "unknown",
          });
          setState({ kind: "failed", reason: "failed" });
        } finally {
          finishDone();
        }
      })();
      return started;
    },

    async openSignIn(): Promise<ClaudeCodeInstallState> {
      if (!installer) return setState({ kind: "failed", reason: "unsupported" });
      if (activeInstall) return state;
      if (options.localOnly()) return setState({ kind: "failed", reason: "local-mode" });
      const existing = await installer.findBinary();
      if (existing === null) {
        return setState({ kind: "failed", reason: "failed" });
      }
      if (options.localOnly()) return setState({ kind: "failed", reason: "local-mode" });
      return beginSignIn(installer);
    },

    async checkAuth(): Promise<ClaudeCodeInstallState> {
      if (!installer) return setState({ kind: "failed", reason: "unsupported" });
      if (activeInstall) return state;
      const auth = await installer.checkAuth();
      if (auth.kind === "signed-in") {
        await stopSignIn();
        options.onClientsChanged();
        return setState({ kind: "signed-in" });
      }
      if (auth.kind === "no-plan") {
        await stopSignIn();
        return setState({ kind: "no-plan" });
      }
      if (auth.kind === "missing") {
        await stopSignIn();
        return setState({ kind: "failed", reason: "failed" });
      }
      return setState({ kind: "awaiting-sign-in", notYet: true });
    },

    async cancel(): Promise<ClaudeCodeInstallState> {
      const installing = activeInstall;
      activeInstall = null;
      if (installing) {
        installing.stop.abort();
        await installing.done.catch(() => undefined);
      }
      await stopSignIn();
      return setState({ kind: "idle" });
    },

    async onLocalOnlyChanged(): Promise<void> {
      if (!options.localOnly()) return;
      const hadActive =
        activeInstall !== null ||
        activeSignIn !== null ||
        state.kind === "installing" ||
        state.kind === "awaiting-sign-in";
      if (!hadActive) return;
      const installing = activeInstall;
      activeInstall = null;
      if (installing) {
        installing.stop.abort();
        await installing.done.catch(() => undefined);
      }
      await stopSignIn();
      setState({ kind: "failed", reason: "local-mode" });
    },

    async reset(): Promise<ClaudeCodeInstallState> {
      if (activeInstall) return state;
      await stopSignIn();
      return setState({ kind: "idle" });
    },
  };
}
