import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A local stand-in for the one-press Claude Code installer (#3638), which a test build reaches at
 * `launchApp`'s `claudeInstaller` origin: nothing is downloaded, and its sign-in is a press away.
 */

export interface StandInBehavior {
  binary: string | null;
  install: "succeed" | "fail-network" | "hold";
  signIn: "hold" | "signed-in" | "no-plan";
  auth: "signed-out" | "signed-in" | "no-plan" | "missing";
}

export interface InstallerStandIn {
  origin: string;
  behavior: StandInBehavior;
  installCalls: number;
  signInCalls: number;
  authCalls: number;
  releaseInstall(outcome?: "succeed" | "fail-network"): void;
  close(): Promise<void>;
}

export async function startInstallerStandIn(
  initial?: Partial<StandInBehavior>,
): Promise<InstallerStandIn> {
  const behavior: StandInBehavior = {
    binary: null,
    install: "succeed",
    signIn: "hold",
    auth: "signed-out",
    ...initial,
  };
  let installCalls = 0;
  let signInCalls = 0;
  let authCalls = 0;
  let pendingInstall: ((outcome: "succeed" | "fail-network") => void) | null = null;
  const openSignIns = new Set<() => void>();

  const server: Server = createServer((req, res) => {
    const url = req.url ?? "/";
    res.setHeader("Content-Type", "application/json");
    if (url === "/find") {
      res.end(JSON.stringify({ binary: behavior.binary }));
      return;
    }
    if (url === "/install") {
      installCalls += 1;
      if (behavior.install === "hold") {
        let settled = false;
        const finish = (outcome: "succeed" | "fail-network") => {
          if (settled) return;
          settled = true;
          pendingInstall = null;
          if (outcome === "succeed") {
            behavior.binary = "/tmp/fake-claude";
            res.end(
              JSON.stringify({
                kind: "installed",
                stage: "installing",
                binaryPath: behavior.binary,
              }),
            );
          } else {
            res.end(JSON.stringify({ kind: "failed", reason: "network" }));
          }
        };
        pendingInstall = finish;
        req.on("close", () => {
          settled = true;
          if (pendingInstall === finish) pendingInstall = null;
        });
        return;
      }
      if (behavior.install === "fail-network") {
        res.end(JSON.stringify({ kind: "failed", reason: "network" }));
        return;
      }
      behavior.binary = "/tmp/fake-claude";
      res.end(
        JSON.stringify({ kind: "installed", stage: "installing", binaryPath: behavior.binary }),
      );
      return;
    }
    if (url === "/sign-in") {
      signInCalls += 1;
      if (behavior.signIn === "signed-in") {
        res.end(JSON.stringify({ kind: "signed-in" }));
        return;
      }
      if (behavior.signIn === "no-plan") {
        res.end(JSON.stringify({ kind: "no-plan" }));
        return;
      }
      const closeSignIn = () => {
        if (!res.writableEnded) res.end(JSON.stringify({ kind: "cancelled" }));
      };
      openSignIns.add(closeSignIn);
      req.on("close", () => {
        openSignIns.delete(closeSignIn);
      });
      return;
    }
    if (url === "/auth") {
      authCalls += 1;
      res.end(JSON.stringify({ kind: behavior.auth }));
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    origin: `http://127.0.0.1:${port}`,
    behavior,
    get installCalls() {
      return installCalls;
    },
    get signInCalls() {
      return signInCalls;
    },
    get authCalls() {
      return authCalls;
    },
    releaseInstall(outcome = "succeed") {
      pendingInstall?.(outcome);
    },
    async close() {
      for (const end of openSignIns) end();
      openSignIns.clear();
      pendingInstall?.("fail-network");
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
