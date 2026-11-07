/**
 * A remote Connector's sign-in waits for the keychain (#342): Sign in is held until the keychain
 * can keep what signing in saves, offers the plain-text notice where only plain text is possible,
 * and says why when the keychain couldn't be read, with Try again, which frees Sign in once a
 * read works.
 */
import { DOMParser } from "linkedom";
import { act, type ComponentType, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { RemoteConnector, SecretStorageStatus } from "../../src/core/api";
import { translate } from "../../src/shared/i18n";

const OS: SecretStorageStatus = { protection: "os", plainTextAccepted: false, canSave: true };
const PLAIN_TEXT: SecretStorageStatus = {
  protection: "plain-text",
  plainTextAccepted: false,
  canSave: false,
};
const ACCEPTED: SecretStorageStatus = {
  protection: "plain-text",
  plainTextAccepted: true,
  canSave: true,
};
const UNAVAILABLE: SecretStorageStatus = {
  protection: "unavailable",
  plainTextAccepted: false,
  canSave: false,
};

const connector = {
  id: "wiki",
  name: "Wiki",
  transport: "http",
  state: "needs-sign-in",
  signIn: { signedIn: false, expired: false, heldBack: false, error: null },
  clientId: null,
} as unknown as RemoteConnector;

/** What the bridge answers, one answer per read of the keychain, in order. */
let reads: (() => Promise<SecretStorageStatus>)[] = [];
let accepted = 0;

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLElement | null = null;

beforeAll(() => {
  const document = new DOMParser().parseFromString(
    "<!doctype html><html><head></head><body></body></html>",
    "text/html",
  );
  const window = document.defaultView;
  const bridge = new Proxy(
    {
      on: () => () => undefined,
      getSettings: async () => ({ device: {} }),
      getSecretStorage: () => {
        const next = reads.shift();
        if (!next) throw new Error("The keychain was read more often than the test expects.");
        return next();
      },
      acceptPlainTextSecretStorage: async () => {
        accepted++;
        return ACCEPTED;
      },
    },
    {
      get: (target, name) =>
        name in target
          ? (target as Record<string, unknown>)[name as string]
          : () => Promise.resolve(undefined),
    },
  );
  Object.assign(window, { incarnamind: bridge, incarnamindFiles: bridge });
  const globals: Record<string, unknown> = {
    document,
    window,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Event: window.Event,
    Node: window.Node,
    MutationObserver: window.MutationObserver,
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => undefined,
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    getComputedStyle: () => ({ fontStyle: "", fontWeight: "", fontSize: "", fontFamily: "" }),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [name, value] of Object.entries(globals)) vi.stubGlobal(name, value);
});

afterEach(async () => {
  if (root) await act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  reads = [];
  accepted = 0;
});

async function render(shown: RemoteConnector = connector) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  // Loaded by path, as the other component tests are: the node typecheck reads no JSX.
  const path = "../../src/renderer/src/components/connectors/RemoteSignIn.tsx";
  const { RemoteSignIn }: { RemoteSignIn: ComponentType<Record<string, unknown>> } = await import(
    path
  );
  await act(async () => root?.render(createElement(RemoteSignIn, { connector: shown })));
  return container;
}

const signInButton = (notice: HTMLElement) =>
  notice.querySelector('[data-testid="connector-sign-in"]') as HTMLButtonElement;

async function click(element: Element | null | undefined) {
  if (!element) throw new Error("Nothing to click.");
  await act(async () => {
    element.dispatchEvent(new window.Event("click", { bubbles: true }));
  });
}

describe.each(["en", "zh-CN"] as const)("in %s", (language) => {
  const t = (key: Parameters<typeof translate>[1]) => translate(language, key);
  beforeEach(async () => {
    const { useAppStore } = await import("../../src/renderer/src/store");
    useAppStore.setState({ settings: { language } } as never);
  });

  test("a keychain that couldn't be read says why, with Try again, and Sign in waits until a read works", async () => {
    reads = [
      () => Promise.reject(new Error("The keychain didn't answer.")),
      () => Promise.resolve(OS),
    ];
    const notice = await render();
    const problem = notice.querySelector('[data-testid="connector-sign-in-error"]');
    expect(problem?.textContent).toContain("The keychain didn't answer.");
    const again = [...(problem?.querySelectorAll("button") ?? [])];
    expect(again.map((button) => button.textContent)).toEqual([
      t("remoteConnectors.storage.tryAgain"),
    ]);
    expect(signInButton(notice).disabled).toBe(true);

    await click(again[0]);
    expect(notice.querySelector('[data-testid="connector-sign-in-error"]')).toBeNull();
    expect(signInButton(notice).disabled).toBe(false);
  });

  test("only plain text possible, the notice asks first and Sign in waits until it is accepted", async () => {
    reads = [() => Promise.resolve(PLAIN_TEXT)];
    const notice = await render();
    const plainText = notice.querySelector('[data-testid="plain-text-secrets"]');
    expect(plainText?.textContent).toContain(t("providers.secrets.plainText.title"));
    expect(notice.querySelector('[data-testid="connector-sign-in-error"]')).toBeNull();
    expect(signInButton(notice).disabled).toBe(true);

    await act(async () => {
      plainText
        ?.querySelector("input")
        ?.dispatchEvent(new window.Event("click", { bubbles: true }));
    });
    expect(accepted).toBe(1);
    expect(notice.querySelector('[data-testid="plain-text-secrets"]')).toBeNull();
    expect(signInButton(notice).disabled).toBe(false);
  });

  test("no encryption at all, the notice says so and Sign in waits", async () => {
    reads = [() => Promise.resolve(UNAVAILABLE)];
    const notice = await render();
    expect(notice.textContent).toContain(t("providers.secrets.unavailable"));
    expect(signInButton(notice).disabled).toBe(true);
  });

  test("only plain text possible, the OAuth app's form waits too, until it is accepted", async () => {
    reads = [() => Promise.resolve(PLAIN_TEXT)];
    const notice = await render({
      ...connector,
      clientId: "tide-app",
      signIn: { ...connector.signIn, error: { kind: "client-id-required", message: "" } },
    } as RemoteConnector);
    const submit = () =>
      notice.querySelector('[data-testid="connector-client-submit"]') as HTMLButtonElement;
    expect(submit().disabled).toBe(true);

    await act(async () => {
      notice
        .querySelector('[data-testid="plain-text-secrets"] input')
        ?.dispatchEvent(new window.Event("click", { bubbles: true }));
    });
    expect(submit().disabled).toBe(false);
  });

  test("a keychain that can save leaves Sign in as it was", async () => {
    reads = [() => Promise.resolve(OS)];
    const notice = await render();
    expect(notice.querySelector('[data-testid="plain-text-secrets"]')).toBeNull();
    expect(notice.querySelector('[data-testid="connector-sign-in-error"]')).toBeNull();
    expect(signInButton(notice).disabled).toBe(false);
  });
});
