import { DOMParser } from "linkedom";
import { act, type ComponentType, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

let container: HTMLElement;
let root: Root;
let AppShell: ComponentType;
let SidebarHeader: ComponentType<{ toggle?: ReactNode; children?: ReactNode }>;

beforeEach(async () => {
  const document = new DOMParser().parseFromString(
    "<html><head></head><body></body></html>",
    "text/html",
  );
  const window = document.defaultView;
  const globals: Record<string, unknown> = {
    document,
    window,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Event: window.Event,
    Node: window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [name, value] of Object.entries(globals)) vi.stubGlobal(name, value);
  container = document.createElement("div", {});
  document.body.append(container);
  root = createRoot(container);
  const appShellPath = "../../src/renderer/src/components/AppShell.tsx";
  const sidebarHeaderPath = "../../src/renderer/src/components/SidebarHeader.tsx";
  AppShell = ((await import(appShellPath)) as { AppShell: ComponentType }).AppShell;
  SidebarHeader = (
    (await import(sidebarHeaderPath)) as {
      SidebarHeader: ComponentType<{ toggle?: ReactNode; children?: ReactNode }>;
    }
  ).SidebarHeader;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("AppShell and SidebarHeader", () => {
  test("AppShell renders the static frame with header placeholder, skeleton rows, and card without interactive sidebar controls", () => {
    act(() => {
      root.render(createElement(AppShell));
    });

    const shell = container.querySelector('[data-testid="app-shell"]');
    expect(shell).not.toBeNull();
    expect(shell?.getAttribute("aria-busy")).toBe("true");
    expect(container.querySelector('[data-testid="sidebar-header"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="sidebar-toggle"]')).toBeNull();
    expect(container.querySelector('[data-testid="plus-menu"]')).toBeNull();
    expect(container.querySelectorAll('[data-testid="sidebar-skeleton"] > li')).toHaveLength(6);
    expect(container.querySelector(".app-card .tab-strip")).not.toBeNull();
  });

  test("SidebarHeader renders the optional toggle slot when provided", () => {
    act(() => {
      root.render(
        createElement(
          SidebarHeader,
          { toggle: createElement("button", { type: "button", "data-testid": "custom-toggle" }) },
          createElement("span", { "data-testid": "right-action" }),
        ),
      );
    });

    expect(container.querySelector('[data-testid="sidebar-header"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="custom-toggle"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="right-action"]')).not.toBeNull();
  });
});
