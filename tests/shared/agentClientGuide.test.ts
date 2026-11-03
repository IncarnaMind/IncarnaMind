import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { expect, test, vi } from "vitest";
import { cursorLaunch, cursorSettingsFromGuide } from "../helpers/agentClients";

vi.mock("node:fs/promises", () => ({ readFile: vi.fn() }));

const guide = readFileSync("docs/cursor.md", "utf8");

test.each(["\n", "\r\n"])(
  "the Cursor guide works with %j line endings and Windows paths",
  async (newline) => {
    vi.mocked(readFile).mockResolvedValue(guide.replace(/\r?\n/g, newline));
    const launch = {
      command: "C:\\Program Files\\IncarnaMind\\IncarnaMind.exe",
      args: ["C:\\Program Files\\IncarnaMind\\resources\\app.asar\\out\\main\\agentShim.js"],
      env: {
        ELECTRON_RUN_AS_NODE: "1",
        INCARNAMIND_AGENT_SOCKET: "\\\\.\\pipe\\incarnamind-guide-test",
        INCARNAMIND_AGENT_TOKEN: "not-a-real-pairing",
      },
    };
    expect(cursorLaunch(JSON.parse(await cursorSettingsFromGuide(launch)))).toEqual(launch);
  },
);
