/**
 * The command an outside agent starts to reach IncarnaMind (#351): an MCP
 * server over stdio that hands everything to the running app through its
 * socket (src/core/agents/socket.ts), after one opening line naming the
 * pairing by its token. The app's own binary runs it as plain Node
 * (`ELECTRON_RUN_AS_NODE`), so nothing is downloaded when an agent starts it,
 * and the app it talks to already has its index loaded. It imports nothing
 * but Node and the shared protocol, so it starts in a few tens of milliseconds.
 *
 * Before opening the endpoint or sending the pairing token, it verifies that
 * the endpoint belongs to the current OS account and is private to it (#2049),
 * so another account cannot impersonate the app or receive the pairing key.
 * When the app isn't open, or connecting agents is off in it, the shim
 * answers each request with an error saying so in plain words, rather than
 * leaving the agent waiting. It never writes the token anywhere.
 *
 * It imports nothing at all but Node, so its build is one file: Claude's
 * install bundle carries a copy and runs it on Claude's own Node. The
 * protocol is src/shared/agentSocket.ts's, written out again here; the
 * tests run this shim against the core, so the two can't drift apart.
 */
import { execFileSync } from "node:child_process";
import { lstatSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { basename, dirname, join } from "node:path";

const AGENT_TOKEN_ENV = "INCARNAMIND_AGENT_TOKEN";
const AGENT_SOCKET_ENV = "INCARNAMIND_AGENT_SOCKET";
const PER_USER_DIR_RE = /^im-(\d+)$/;
const WINDOWS_PIPE_RE = /^\\\\\.\\pipe\\[A-Za-z0-9._-]+$/;
const SID_RE = /^S-1-\d+(?:-\d+)+$/i;
const DACL_SDDL_RE = /^D:([A-Z]*)((?:\([^)]*\))*)$/;
const WINDOWS_PIPE_HELPER_TIMEOUT_MS = 10_000;

const handshakeLine = (token: string) => `${JSON.stringify({ incarnamind: 1, token })}\n`;

/** The shim doesn't know the interface language, so it says these in both. */
const NOT_OPEN =
  "IncarnaMind isn't open, or connecting agents is turned off in it. Open IncarnaMind, check Settings → AI, then reconnect this agent to it. / IncarnaMind 没有打开，或已关闭智能体连接。打开 IncarnaMind，检查“设置 → AI”，然后让这个智能体重新连接。";
const NOT_SET_UP =
  "This agent's IncarnaMind settings are incomplete. Connect it again in IncarnaMind, in Settings → AI. / 这个智能体的 IncarnaMind 设置不完整。在 IncarnaMind 的“设置 → AI”中重新连接它。";
const UNTRUSTED_ENDPOINT =
  "Refused to connect to IncarnaMind: its local connection belongs to another account or isn't private to yours, so no pairing key was sent. Check Settings → AI in IncarnaMind and reconnect this agent. / 已拒绝连接到 IncarnaMind：这个本地连接属于其他账号或并非仅限当前账号使用，未发送配对密钥。请在 IncarnaMind 的“设置 → AI”中检查并重新连接这个智能体。";

type EndpointVerdict = "ok" | "not-open" | "untrusted";

const isWindowsPipe = (path: string): boolean => path.startsWith("\\\\.\\pipe\\");

function isOwnerOnlyWindowsDacl(daclSddl: string, ownerSid: string): boolean {
  if (!SID_RE.test(ownerSid)) return false;
  const match = DACL_SDDL_RE.exec(daclSddl.trim());
  if (!match) return false;
  const flags = match[1] ?? "";
  const acesRaw = match[2] ?? "";
  if (!flags.includes("P")) return false;
  const aces = acesRaw.match(/\([^)]*\)/g);
  if (!aces || aces.length === 0) return false;
  let allowCount = 0;
  const expected = ownerSid.toUpperCase();
  for (const ace of aces) {
    const parts = ace.slice(1, -1).split(";");
    if (parts.length !== 6) return false;
    const type = (parts[0] ?? "").toUpperCase();
    const trustee = (parts[5] ?? "").toUpperCase();
    if (type === "A") {
      if (trustee !== expected) return false;
      allowCount += 1;
    }
  }
  return allowCount > 0;
}

const WINDOWS_VERIFY_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$pipe = $env:INCARNAMIND_PIPE_PATH",
  "$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
  `Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class IncarnaMindShimPipeAcl {
  public const int SE_FILE_OBJECT = 1;
  public const uint OWNER_SECURITY_INFORMATION = 0x00000001;
  public const uint DACL_SECURITY_INFORMATION = 0x00000004;
  public const uint SDDL_REVISION_1 = 1;

  [DllImport("advapi32.dll", CharSet = CharSet.Unicode)]
  public static extern uint GetNamedSecurityInfoW(
    string objectName,
    int objectType,
    uint securityInfo,
    out IntPtr owner,
    out IntPtr group,
    out IntPtr dacl,
    out IntPtr sacl,
    out IntPtr securityDescriptor
  );

  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool ConvertSidToStringSidW(IntPtr sid, out IntPtr stringSid);

  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool ConvertSecurityDescriptorToStringSecurityDescriptorW(
    IntPtr securityDescriptor,
    uint revision,
    uint securityInfo,
    out IntPtr stringSd,
    out uint stringSdLen
  );

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern IntPtr LocalFree(IntPtr mem);

  public static string[] Probe(string pipePath) {
    IntPtr owner = IntPtr.Zero;
    IntPtr group = IntPtr.Zero;
    IntPtr dacl = IntPtr.Zero;
    IntPtr sacl = IntPtr.Zero;
    IntPtr sd = IntPtr.Zero;
    uint rc = GetNamedSecurityInfoW(
      pipePath,
      SE_FILE_OBJECT,
      OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
      out owner,
      out group,
      out dacl,
      out sacl,
      out sd
    );
    if (rc != 0) {
      return new string[] { rc.ToString(), "", "" };
    }
    IntPtr ownerStrPtr = IntPtr.Zero;
    IntPtr daclStrPtr = IntPtr.Zero;
    try {
      string ownerStr = "";
      if (owner != IntPtr.Zero && ConvertSidToStringSidW(owner, out ownerStrPtr)) {
        ownerStr = Marshal.PtrToStringUni(ownerStrPtr) ?? "";
      }
      string daclStr = "";
      uint daclLen;
      if (ConvertSecurityDescriptorToStringSecurityDescriptorW(sd, SDDL_REVISION_1, DACL_SECURITY_INFORMATION, out daclStrPtr, out daclLen)) {
        daclStr = Marshal.PtrToStringUni(daclStrPtr) ?? "";
      }
      return new string[] { "0", ownerStr, daclStr };
    } finally {
      if (ownerStrPtr != IntPtr.Zero) LocalFree(ownerStrPtr);
      if (daclStrPtr != IntPtr.Zero) LocalFree(daclStrPtr);
      if (sd != IntPtr.Zero) LocalFree(sd);
    }
  }
}
'@`,
  "$p = [IncarnaMindShimPipeAcl]::Probe($pipe)",
  "$rc = [int]$p[0]",
  "if ($rc -eq 2) { @{ status = 'not-open'; code = 2 } | ConvertTo-Json -Compress; exit 0 }",
  "if ($rc -ne 0) { @{ status = 'untrusted'; code = $rc } | ConvertTo-Json -Compress; exit 0 }",
  "@{ status = 'ok'; code = 0; currentSid = $sid; ownerSid = $p[1]; dacl = $p[2] } | ConvertTo-Json -Compress",
].join("\n");

function verifyWindowsPipeEndpoint(pipePath: string): EndpointVerdict {
  if (!WINDOWS_PIPE_RE.test(pipePath)) return "untrusted";
  const ps = process.env.SystemRoot
    ? join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "powershell.exe";
  const env: NodeJS.ProcessEnv = { ...process.env, INCARNAMIND_PIPE_PATH: pipePath };
  delete env[AGENT_TOKEN_ENV];
  try {
    const encoded = Buffer.from(WINDOWS_VERIFY_SCRIPT, "utf16le").toString("base64");
    const stdout = execFileSync(
      ps,
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
      {
        env,
        encoding: "utf8",
        timeout: WINDOWS_PIPE_HELPER_TIMEOUT_MS,
        windowsHide: true,
      },
    );
    const parsed: unknown = JSON.parse(stdout.trim());
    if (typeof parsed !== "object" || parsed === null) return "untrusted";
    const record = parsed as Record<string, unknown>;
    if (record.status === "not-open") return "not-open";
    if (record.status !== "ok") return "untrusted";
    if (
      typeof record.currentSid !== "string" ||
      typeof record.ownerSid !== "string" ||
      typeof record.dacl !== "string"
    ) {
      return "untrusted";
    }
    if (record.ownerSid.toUpperCase() !== record.currentSid.toUpperCase()) return "untrusted";
    return isOwnerOnlyWindowsDacl(record.dacl, record.currentSid) ? "ok" : "untrusted";
  } catch {
    return "untrusted";
  }
}

function verifyUnixEndpoint(socketPath: string): EndpointVerdict {
  const currentUid = process.getuid?.();
  const currentGid = process.getgid?.();
  const parentDir = dirname(socketPath);
  const parentName = basename(parentDir);
  const perUserMatch = PER_USER_DIR_RE.exec(parentName);
  const isPerUserDir = perUserMatch !== null;
  if (isPerUserDir && currentUid !== undefined && Number(perUserMatch[1]) !== currentUid) {
    return "untrusted";
  }
  let parentStat: ReturnType<typeof lstatSync>;
  try {
    parentStat = lstatSync(parentDir);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "not-open" : "untrusted";
  }
  if (!parentStat.isDirectory()) {
    if (!isPerUserDir && parentStat.isSymbolicLink() && parentStat.uid === 0) {
      try {
        const target = statSync(parentDir);
        if (!target.isDirectory() || target.uid !== 0 || (target.mode & 0o1000) === 0) {
          return "untrusted";
        }
      } catch {
        return "untrusted";
      }
    } else {
      return "untrusted";
    }
  } else if (currentUid !== undefined) {
    if (parentStat.uid !== currentUid) {
      if (isPerUserDir || parentStat.uid !== 0 || (parentStat.mode & 0o1000) === 0) {
        return "untrusted";
      }
    } else if (isPerUserDir) {
      if ((parentStat.mode & 0o077) !== 0) return "untrusted";
    } else {
      if ((parentStat.mode & 0o002) !== 0) return "untrusted";
      if (
        (parentStat.mode & 0o020) !== 0 &&
        currentGid !== undefined &&
        parentStat.gid !== currentGid
      ) {
        return "untrusted";
      }
    }
  }
  let socketStat: ReturnType<typeof lstatSync>;
  try {
    socketStat = lstatSync(socketPath);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "not-open" : "untrusted";
  }
  if (!socketStat.isSocket()) return "untrusted";
  if (currentUid !== undefined) {
    if (socketStat.uid !== currentUid) return "untrusted";
    if ((socketStat.mode & 0o077) !== 0) return "untrusted";
  }
  return "ok";
}

function verifyEndpoint(socketPath: string): EndpointVerdict {
  return isWindowsPipe(socketPath)
    ? verifyWindowsPipeEndpoint(socketPath)
    : verifyUnixEndpoint(socketPath);
}

/** Answers every request on stdin with an error saying `message`, until stdin ends. */
function refuseEverything(message: string): void {
  let pending = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    pending += chunk;
    for (let end = pending.indexOf("\n"); end !== -1; end = pending.indexOf("\n")) {
      const line = pending.slice(0, end).trim();
      pending = pending.slice(end + 1);
      let request: unknown;
      try {
        request = JSON.parse(line);
      } catch {
        continue;
      }
      // Only requests are answered; notifications have no id.
      if (typeof request !== "object" || request === null || !("id" in request)) continue;
      const reply = { jsonrpc: "2.0", id: request.id, error: { code: -32000, message } };
      process.stdout.write(`${JSON.stringify(reply)}\n`);
    }
  });
  process.stdin.on("end", () => process.exit(0));
}

const token = process.env[AGENT_TOKEN_ENV];
const socketPath = process.env[AGENT_SOCKET_ENV];

if (!token || !socketPath) {
  refuseEverything(NOT_SET_UP);
} else {
  const verdict = verifyEndpoint(socketPath);
  if (verdict === "not-open") {
    refuseEverything(NOT_OPEN);
  } else if (verdict === "untrusted") {
    refuseEverything(UNTRUSTED_ENDPOINT);
  } else {
    const socket = createConnection(socketPath);
    let connected = false;
    socket.once("connect", () => {
      connected = true;
      socket.write(handshakeLine(token));
      process.stdin.pipe(socket);
      socket.pipe(process.stdout);
    });
    socket.on("error", () => {
      if (!connected) refuseEverything(NOT_OPEN);
    });
    // The app closed the connection: it quit, or the agent was disconnected.
    socket.on("close", () => {
      if (connected) process.exit(0);
    });
  }
}
