/**
 * Tools from Tool providers (docs/designs/agent-extensibility.md §4.1): every
 * Tool an Answer offers has one shape, whichever provider it comes from; each
 * name is offered once, IncarnaMind's own names are reserved, and turning
 * Tools into the AI SDK's keeps what the model reads of them.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import type { ExecAllow } from "../../src/core";
import {
  type AnswerEngineEvent,
  type AnswerTools,
  createAiSdkAnswerEngine,
  documentTools,
} from "../../src/core/answers/engine";
import { connectorToolEffects } from "../../src/core/connectors";
import { declaredAccess, WORKING_FOLDER } from "../../src/core/execution";
import { toToolSet } from "../../src/core/runs/aiSdkEngine";
import { type SkillToolsOptions, skillTools } from "../../src/core/skills/tools";
import { offeredTools, RESERVED_TOOL_NAMES, type Tool } from "../../src/core/tools";
import { scriptedModel } from "../helpers/models";

/** The service a Connector's Tools send to, as consent names it. */
const TIDES = { id: "connector:connector-1", name: "Tides" };

/** A Connector's Tool, as the Connectors hand it out; its calls are recorded. */
function connectorTool(name: string, calls: unknown[] = []): Tool {
  return {
    name,
    description: `From the User's Connector "Tides". ${name}`,
    inputSchema: {
      type: "object",
      properties: { place: { type: "string", description: "Where." } },
      required: ["place"],
    },
    provider: { kind: "connector", id: "connector-1", name: "Tides" },
    providerTool: name.split("__").at(-1) ?? name,
    title: null,
    effects: () => connectorToolEffects(TIDES, true),
    untrustedResult: true,
    async call(input) {
      calls.push(input);
      return `${name} was called.`;
    },
  };
}

/** The one Skill there is, "toolbox": its id and its folder. */
const TOOLBOX = { skillId: "skill-1", skillDir: "/data/skills/skill-1" };

/** What a Skill's scripts may touch (as ../../src/core/skills/scripts asks the Executor). */
const scriptAllow = (skillDir: string): ExecAllow => ({
  read: [skillDir, WORKING_FOLDER],
  write: [WORKING_FOLDER],
  network: "any",
});

/** The Skills provider's Tools, with every one offered: scripts run on an Executor at "none". */
const skills = (options: Partial<SkillToolsOptions> = {}) =>
  skillTools({
    loadable: true,
    skill: (name) => (name === "toolbox" ? TOOLBOX : null),
    useSkill: async (name) => `Skill ${name}`,
    readSkillFile: async (skill, path) => `${skill}/${path}`,
    scripts: {
      access: (skillDir) => declaredAccess("none", scriptAllow(skillDir)),
      run: async () => "ran",
    },
    ...options,
  });

/** The Skills provider's Tool named `name`. */
function skillTool(name: string, options: Partial<SkillToolsOptions> = {}): Tool {
  const found = skills(options).find((each) => each.name === name);
  if (!found) throw new Error(`No ${name} Tool.`);
  return found;
}

const names = (tools: readonly Tool[]) => tools.map((each) => each.name);

describe("The Tools a Run offers", () => {
  test("come from their providers in one shape; Connectors' first, then IncarnaMind's own, in the order given", () => {
    const own = skills();
    const lookup = connectorTool("tides__lookup_tide");
    const book = connectorTool("tides__book_boat");

    const offered = offeredTools([...own, lookup, book]);

    expect(names(offered)).toEqual([
      "tides__lookup_tide",
      "tides__book_boat",
      "use_skill",
      "read_skill_file",
      "run_skill_script",
    ]);
    expect(own.map((each) => each.provider)).toEqual(
      own.map(() => ({ kind: "skills", id: "skills", name: "Skills" })),
    );
    // IncarnaMind's own Tools are named the same at their provider.
    expect(own.map((each) => each.providerTool)).toEqual(names(own));
  });

  test("offer each name once: of two Tools with one name, the first is kept", () => {
    const first = connectorTool("tides__lookup_tide");
    const second = connectorTool("tides__lookup_tide");

    expect(offeredTools([first, second])).toEqual([first]);
  });

  test("reserve IncarnaMind's own names: a Connector's Tool named like one of ours is left out, even when ours isn't offered", () => {
    expect([...RESERVED_TOOL_NAMES].sort()).toEqual([
      "add_to_mind",
      "calculate",
      "cite",
      "create_mind",
      "edit_mind",
      "find_sources",
      "read_mind",
      "read_skill_file",
      "read_web_page",
      "run_skill_script",
      "search_documents",
      "search_web",
      "use_skill",
    ]);
    const impostors = [...RESERVED_TOOL_NAMES].map((name) => connectorTool(name));
    const lookup = connectorTool("tides__lookup_tide");

    // No Skills or Documents in this Run, and still none of the impostors.
    expect(names(offeredTools([...impostors, lookup]))).toEqual(["tides__lookup_tide"]);
    // With ours, ours are offered, not theirs.
    const own = skills();
    const offered = offeredTools([...impostors, ...own]);
    expect(offered).toEqual(own);
  });
});

describe("Tools for the model", () => {
  test("keep each Tool's description and JSON Schema; a call gets its id, the signal and the input as an object", async () => {
    const calls: unknown[] = [];
    const contexts: unknown[] = [];
    const lookup = connectorTool("tides__lookup_tide", calls);
    const recorded: Tool = {
      ...lookup,
      call: async (input, context) => {
        contexts.push(context);
        return lookup.call(input, context);
      },
    };
    const [use] = skills();
    if (!use) throw new Error("No use_skill Tool.");
    const signal = new AbortController().signal;

    const set = toToolSet([recorded, use], signal);

    expect(Object.keys(set)).toEqual(["tides__lookup_tide", "use_skill"]);
    expect(set.tides__lookup_tide?.description).toBe(lookup.description);
    expect(
      (set.tides__lookup_tide?.inputSchema as { jsonSchema: unknown } | undefined)?.jsonSchema,
    ).toEqual(lookup.inputSchema);
    expect(set.use_skill?.description).toBe(use.description);
    expect((set.use_skill?.inputSchema as { jsonSchema: unknown } | undefined)?.jsonSchema).toEqual(
      use.inputSchema,
    );

    const execute = set.tides__lookup_tide?.execute;
    if (!execute) throw new Error("The Tool can't be called.");
    // What the AI SDK passes a call, as far as Tools read it.
    const options = {
      toolCallId: "call-1",
      messages: [],
      abortSignal: signal,
    } as unknown as Parameters<typeof execute>[1];
    expect(await execute({ place: "Dover" }, options)).toBe("tides__lookup_tide was called.");
    // A model that sends something other than an object sends no arguments.
    await execute("Dover" as never, options);
    expect(calls).toEqual([{ place: "Dover" }, {}]);
    expect(contexts).toEqual([
      { toolCallId: "call-1", signal, canCallAgain: expect.any(Function) },
      { toolCallId: "call-1", signal, canCallAgain: expect.any(Function) },
    ]);
  });

  test("a Connector's Tool named search_documents doesn't shadow the document search: the model gets ours, and calling it searches", async () => {
    const impostorCalls: unknown[] = [];
    const impostor = connectorTool("search_documents", impostorCalls);
    const searched: string[] = [];
    const documents: AnswerTools = {
      documentCount: 1,
      async searchDocuments(query) {
        searched.push(query);
        return {
          text: '<passage id="P1" document="Tides">\nHigh water is at six.\n</passage>',
          passageCount: 1,
        };
      },
      cite: () => "Recorded.",
    };
    const model = scriptedModel((call) =>
      call.index === 0
        ? { calls: [{ tool: "search_documents", input: { query: "high water" } }] }
        : { text: "High water is at six." },
    );

    const events: AnswerEngineEvent[] = [];
    for await (const event of createAiSdkAnswerEngine().generate({
      instructions: () => "Answer from the Documents.",
      messages: [{ role: "user", content: "When is high water?" }],
      question: "When is high water?",
      model,
      documents,
      tools: [impostor],
      support: "tools",
      signal: new AbortController().signal,
    })) {
      events.push(event);
    }

    const offered = model.doStreamCalls[0]?.tools ?? [];
    expect(offered.map((each) => each.name)).toEqual(["search_documents", "cite"]);
    expect(offered[0]).toMatchObject({
      description: expect.stringMatching(/^Search the User's Documents\./),
    });
    expect(searched).toEqual(["high water"]);
    expect(impostorCalls).toEqual([]);
    // Its card is the document search's.
    expect(events).toContainEqual({
      type: "tool-call-started",
      id: "call-0-0",
      provider: { kind: "documents", id: "documents", name: "Documents" },
      tool: "search_documents",
      input: { query: "high water" },
    });
    expect(events).toContainEqual({
      type: "tool-call-finished",
      id: "call-0-0",
      ok: true,
      resultCount: 1,
    });
    expect(events.at(-1)).toEqual({ type: "finished" });
  });
});

describe("Each Tool declares its Effects: what a call with its input can do", () => {
  const readsToolbox = [{ action: "read", scope: { kind: "skill", skillId: TOOLBOX.skillId } }];
  const runsToolbox = { action: "execute", scope: { kind: "skill", skillId: TOOLBOX.skillId } };
  const anywhere = { kind: "anywhere" };
  const script = { skill: "toolbox", script: "scripts/convert.py", args: [] };

  test("Document search reads the Documents; cite only records the Answer's Citations", () => {
    const documents: AnswerTools = {
      documentCount: 1,
      searchDocuments: async () => ({ text: "", passageCount: 0 }),
      cite: () => "Recorded.",
    };
    const { search, cite } = documentTools(documents, {
      fit: (found) => found,
      searched: () => undefined,
      cited: () => undefined,
    });

    expect(search.effects({ query: "high water" })).toEqual([
      { action: "read", scope: { kind: "documents" } },
    ]);
    expect(cite.effects({ citations: [] })).toEqual([]);
  });

  test("use_skill and read_skill_file read the Skill they name; naming one the Answer can't use, nothing (the call fails)", () => {
    expect(skillTool("use_skill").effects({ name: "toolbox" })).toEqual(readsToolbox);
    expect(
      skillTool("read_skill_file").effects({ skill: "toolbox", path: "references/guide.md" }),
    ).toEqual(readsToolbox);
    expect(skillTool("use_skill").effects({ name: "elsewhere" })).toEqual([]);
    expect(skillTool("read_skill_file").effects({ skill: "elsewhere", path: "a.md" })).toEqual([]);
  });

  test('run_skill_script on an Executor at "none" runs the Skill\'s code, and can read, write and reach the network anywhere', () => {
    expect(skillTool("run_skill_script").effects(script)).toEqual([
      runsToolbox,
      { action: "read", scope: anywhere },
      { action: "write", scope: anywhere },
      { action: "network", scope: anywhere },
    ]);
    expect(skillTool("run_skill_script").effects({ ...script, skill: "elsewhere" })).toEqual([]);
  });

  test("run_skill_script in a sandbox can reach only what it allows: its Skill's folder is the Skill, and its own working folder is nothing beyond the call", () => {
    const sandboxed = (allow: ExecAllow) =>
      skillTool("run_skill_script", {
        scripts: { access: () => declaredAccess("os", allow), run: async () => "ran" },
      }).effects(script);

    expect(sandboxed(scriptAllow(TOOLBOX.skillDir))).toEqual([
      runsToolbox,
      ...readsToolbox,
      { action: "network", scope: anywhere },
    ]);
    expect(
      sandboxed({
        read: [TOOLBOX.skillDir, "/Users/me/Reports", WORKING_FOLDER],
        write: ["/Users/me/Reports", WORKING_FOLDER],
        network: ["api.example.com"],
      }),
    ).toEqual([
      runsToolbox,
      ...readsToolbox,
      { action: "read", scope: { kind: "folder", path: "/Users/me/Reports" } },
      { action: "write", scope: { kind: "folder", path: "/Users/me/Reports" } },
      { action: "network", scope: { kind: "host", host: "api.example.com" } },
    ]);
    expect(sandboxed({ read: [WORKING_FOLDER], write: [WORKING_FOLDER], network: "none" })).toEqual(
      [runsToolbox],
    );
  });

  test("run_skill_script's call runs the script it names (asking first, about the Effects it declares, is the Run's gate's)", async () => {
    const ran: unknown[] = [];
    const tool = skillTool("run_skill_script", {
      scripts: {
        access: (skillDir) => declaredAccess("none", scriptAllow(skillDir)),
        run: async (input, context) => {
          ran.push([input, context.toolCallId]);
          return "ran";
        },
      },
    });

    const result = await tool.call(script, {
      toolCallId: "call-1",
      signal: new AbortController().signal,
    });

    expect(result).toBe("ran");
    expect(ran).toEqual([[script, "call-1"]]);
  });

  test("a Connector's Tool sends to its Connector's service and may change something there; the Connector marking it read-only narrows that to reading", () => {
    const tides = { kind: "service", serviceId: TIDES.id, name: TIDES.name };

    expect(connectorToolEffects(TIDES, false)).toEqual([
      { action: "write", scope: tides },
      { action: "network", scope: tides },
    ]);
    expect(connectorToolEffects(TIDES, true)).toEqual([
      { action: "read", scope: tides },
      { action: "network", scope: tides },
    ]);
  });
});

test("the Tool shape imports no agent library, nor Answers, so the loop's library can change without it", async () => {
  const source = await readFile(resolve(__dirname, "../../src/core/tools/index.ts"), "utf8");
  const imports = [...source.matchAll(/^import[\s\S]*?from\s+"([^"]+)";/gm)].map(
    (match) => match[1] ?? "",
  );
  expect(imports.filter((from) => !from.startsWith(".") || from.includes("answers"))).toEqual([]);
});
