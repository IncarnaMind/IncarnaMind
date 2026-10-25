/**
 * What the outside harnesses are told about IncarnaMind (README.md): the MCP
 * server's own instructions and its Agent Skill, as the app ships them, with
 * what they say about the two Tools the bake-off hides taken out. `ask` runs
 * IncarnaMind's own engine, the one compared, and `show_citation` opens a
 * window the bake-off has none of.
 */
import { SERVER_INSTRUCTIONS } from "../../src/core/agents/mcp";
import { SKILL_MARKDOWN } from "../../src/core/agents/skill";
import type { AgentToolName } from "../../src/core/api";

/** The Tools every outside harness gets, from IncarnaMind's MCP server. */
export const HARNESS_TOOLS: readonly AgentToolName[] = [
  "search",
  "read_passages",
  "cite",
  "check_citations",
  "list_minds",
  "read_mind",
];

const HIDDEN: readonly AgentToolName[] = ["ask", "show_citation"];

const mentionsHidden = (text: string) => HIDDEN.some((tool) => text.includes(`\`${tool}\``));

/** The server's instructions, without its lines on the hidden Tools. */
export const HARNESS_INSTRUCTIONS = SERVER_INSTRUCTIONS.split("\n")
  .filter((line) => !mentionsHidden(line))
  .join("\n");

/**
 * The Agent Skill's text without its front matter, and without its sentences
 * on the hidden Tools: each harness is given it as instructions of its own,
 * since with its built-in Tools off it can't open a Skill's file.
 */
export const HARNESS_SKILL = SKILL_MARKDOWN.replace(/^---\n[\s\S]*?\n---\n+/, "")
  .split("\n\n")
  .map((paragraph) =>
    paragraph
      .split(/(?<=\.) (?=`)/)
      .filter((sentence) => !mentionsHidden(sentence))
      .join(" "),
  )
  .filter((paragraph) => paragraph.trim() !== "")
  .join("\n\n")
  .trim();
