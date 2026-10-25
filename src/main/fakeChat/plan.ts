/**
 * Research (`fakePlan`): a plan of three steps about the topic; each step is
 * then answered as a Question that asks for the web is, and the pages it saved
 * are tagged with their names' first words (`fakeResearchTags`).
 */

import { type GenerateOptions, SLOWLY, systemOf, userText } from "./prompt";

/** Research's planner (#130, src/core/research/prompt.ts). */
const PLANNER = /^You plan research for IncarnaMind/m;

export const asksForPlan = (options: GenerateOptions) => PLANNER.test(systemOf(options.prompt));

/**
 * A Research plan (#130): three steps about the topic, "slowly" kept in
 * them so the Task takes its time too; asked to change it, the change
 * becomes a step after the others. A topic that says "no plan" gets a reply with no steps.
 */
export function fakePlan(options: GenerateOptions): string | null {
  if (!asksForPlan(options)) return null;
  const request = userText(options.prompt.find((message) => message.role === "user"));
  const topic = (/^Topic: (.*)$/m.exec(request)?.[1] ?? "").replace(/^research\s+/i, "");
  if (/\bno plan\b/i.test(topic)) return "I'd rather not plan this one.";
  const slowly = SLOWLY.test(topic) ? ", slowly" : "";
  const subject = topic.replace(/,?\s*slowly\b/i, "").replace(/[?？.。]$/, "");
  const change = /^Change it as the User asks: (.*)$/m.exec(request)?.[1];
  const steps = [
    `Search the web and the Library for ${subject}${slowly}`,
    `Read what the sources say about ${subject}${slowly}`,
    `Compare what they found${slowly}`,
    ...(change ? [change] : []),
  ];
  return [
    `TITLE: What do the sources say about ${subject}?`,
    ...steps.map((step, index) => `${index + 1}. ${step}`),
  ].join("\n");
}
