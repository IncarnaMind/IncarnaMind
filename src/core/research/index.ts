/**
 * Research (#130): a Task that plans, then searches the Library and the web
 * step by step, as Answers do, before it writes.
 *
 * - The plan is one request to the composer's model: the steps it proposes
 *   for the topic, which the User edits on the plan card before Start.
 * - Each step is a step of the Task's journal (`step:<n>`): an Answer kept
 *   nowhere (`answerResearch`), from the Library within the composer's
 *   Search scope and, with Web on, the web, whose pages are saved as
 *   Documents as they are read (#128). Its notes and the Documents it used
 *   are its result, read by the steps after it. Its searches and the pages it
 *   read are steps too (`call:…`), journalled as each ends, so its progress
 *   says what it did.
 * - A step comes below Answers as every Task's does (its turn), is tried
 *   again after a pause when its provider limits requests, and stops the Task
 *   at the monthly cap or a plan's limit (../runs/stop). Quit or paused, the
 *   Task goes on from the first step not done.
 * - Then it files the web pages it saved and writes its cited draft (./finish).
 */
import { randomUUID } from "node:crypto";
import { generateText } from "ai";
import { cutTitle } from "../../shared/naming";
import {
  MAX_RESEARCH_STEP,
  MAX_RESEARCH_STEPS,
  MAX_RESEARCH_TOPIC,
  RESEARCH_TASK,
} from "../../shared/research";
import type { CellAnswer } from "../answers";
import type { QuestionContext } from "../answers/context";
import type {
  AnswerToolCall,
  ChatModelChoice,
  ChatReadiness,
  PlanResearchInput,
  ResearchPlan,
  ResearchPlanResult,
  ResearchPlanView,
  ResearchSources,
  ResearchStartResult,
  ResearchTarget,
  SearchScope,
  StartResearchInput,
  Task,
} from "../api";
import {
  ChatNotReadyError,
  ConsentDeclinedError,
  type ErrorWording,
  InvalidInputError,
  isRecord,
  NotFoundError,
} from "../errors";
import type { PreparedChatModel } from "../providers/chat";
import { classifyProviderError } from "../providers/providerErrors";
import type { StepRecord } from "../runs/journal";
import { RunItemError, RunItemGaveWay, runItems } from "../runs/stop";
import type { TaskEnd, TaskKind, TaskRun } from "../runs/tasks";
import { parseSearchScope } from "../scope";
import {
  DRAFT_STEP,
  type FinishOptions,
  fileSources,
  pausedBy,
  SAVE_STEP,
  savedOf,
  writeDraft,
  writtenOf,
} from "./finish";
import { notesOf, PLAN_INSTRUCTIONS, planPrompt, readPlan, stepContext } from "./prompt";

/** A plan that takes longer than this (a local model loading) fails. */
const PLAN_TIMEOUT_MS = 120_000;

/** What a Research Task does, as its journal keeps it. */
interface ResearchInput {
  topic: string;
  plan: ResearchPlan;
  sources: ResearchSources;
  writeInto: ResearchTarget;
  /** It made its own Mind at its Start, so the draft's Folder is that Mind's too. */
  ownMind: boolean;
  scope: SearchScope | null;
  providerId: string;
  modelId: string;
  /** The request its draft's changes are made under: one draft, however often it goes on. */
  draftRequest: string;
}

/** What a step found: its notes, and the Documents it cited or read. */
interface StepFound {
  notes: string;
  documents: string[];
}

/** A search or a page read, as a step of its own. */
type CallStep =
  | { kind: "web-search" | "library-search"; query: string; found: number | null }
  | { kind: "read"; name: string }
  | { kind: "unread"; address: string };

export interface ResearchOptions extends FinishOptions {
  /** Throws unless the Mind exists and this version may write to it; returns its id. */
  requireMind(mindId: unknown): string;
  chat: {
    providerExists(providerId: string): boolean;
    readiness(choice: ChatModelChoice | undefined): Promise<ChatReadiness>;
    /**
     * The model, once the User has allowed its data flow (asking them if needed). "off" skips
     * its thinking where it can, for a short request.
     */
    prepareModel(choice: ChatModelChoice, thinking?: "off"): Promise<PreparedChatModel>;
    /** Whether the model runs on this computer, which serves one request at a time. */
    runsLocally(choice: ChatModelChoice): boolean;
  };
  answers: {
    answerResearch(input: {
      mindId: string;
      context: QuestionContext;
      documentIds: string[] | null;
      web: boolean;
      model: ChatModelChoice;
      signal: AbortSignal;
      onCall(call: AnswerToolCall): void;
    }): Promise<CellAnswer>;
    answerCell(input: {
      context: QuestionContext;
      documentIds: string[];
      model: ChatModelChoice;
      signal: AbortSignal;
    }): Promise<CellAnswer>;
  };
  /** A Mind's name, as the window shows it; null once it is gone. */
  mindName(mindId: string): string | null;
  /** The ids of the live Documents a Search scope covers; null with none (every Document). */
  resolveScope(scope: SearchScope): string[] | null;
  /** What research from a Mind searches, by the one rule (`mindSearchScope`); null: every Document. */
  searchedScope(scope: SearchScope | null, mindId: string): SearchScope | null;
  tasks: {
    start(kind: string, mindId: string, input: ResearchInput): Task;
    /** A Task's record, with its input; null for none. */
    get(taskId: string): { id: string; input: unknown } | null;
    /** A Task's journal, in the order its steps first started. */
    steps(taskId: string): StepRecord[];
  };
}

/** Text on one line, not empty and at most `max` characters; else `wording` says so. */
function text(value: unknown, wording: ErrorWording["key"], max: number): string {
  const line = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (line === "" || line.length > max) {
    throw new InvalidInputError({ key: wording, values: { max } });
  }
  return line;
}

function parseModel(value: unknown): ChatModelChoice | null {
  if (value === undefined || value === null) return null;
  if (
    !isRecord(value) ||
    typeof value.providerId !== "string" ||
    typeof value.modelId !== "string" ||
    value.providerId === "" ||
    value.modelId === ""
  ) {
    throw new InvalidInputError({ key: "error.research.model" });
  }
  return { providerId: value.providerId, modelId: value.modelId };
}

function parseSources(value: unknown): ResearchSources {
  if (
    !isRecord(value) ||
    typeof value.web !== "boolean" ||
    typeof value.library !== "boolean" ||
    (!value.web && !value.library)
  ) {
    throw new InvalidInputError({ key: "error.research.sources" });
  }
  return { web: value.web, library: value.library };
}

function parseSteps(value: unknown): string[] {
  const steps = Array.isArray(value)
    ? value
        .map((step) => (typeof step === "string" ? step.replace(/\s+/g, " ").trim() : step))
        .filter((step) => step !== "")
    : [];
  if (steps.length === 0 || steps.length > MAX_RESEARCH_STEPS) {
    throw new InvalidInputError({
      key: "error.research.steps",
      values: { max: MAX_RESEARCH_STEPS },
    });
  }
  return steps.map((step) => text(step, "error.research.step", MAX_RESEARCH_STEP));
}

function parseTarget(value: unknown): ResearchTarget {
  if (isRecord(value) && value.newMind === true) return { newMind: true };
  if (isRecord(value) && typeof value.mindId === "string" && value.mindId !== "") {
    return { mindId: value.mindId };
  }
  throw new InvalidInputError({ key: "error.research.target" });
}

function inputOf(input: unknown): ResearchInput | null {
  if (!isRecord(input) || !isRecord(input.plan) || !isRecord(input.sources)) return null;
  const { topic, plan, sources, writeInto, scope, providerId, modelId, draftRequest } = input;
  if (
    typeof topic !== "string" ||
    typeof plan.title !== "string" ||
    !Array.isArray(plan.steps) ||
    !plan.steps.every((step) => typeof step === "string") ||
    typeof sources.web !== "boolean" ||
    typeof sources.library !== "boolean" ||
    typeof providerId !== "string" ||
    typeof modelId !== "string" ||
    typeof draftRequest !== "string"
  ) {
    return null;
  }
  let target: ResearchTarget;
  let within: SearchScope | null;
  try {
    target = parseTarget(writeInto);
    within = parseSearchScope(scope);
  } catch {
    return null;
  }
  return {
    topic,
    plan: { title: plan.title, steps: plan.steps as string[] },
    sources: { web: sources.web, library: sources.library },
    writeInto: target,
    ownMind: input.ownMind === true,
    scope: within,
    providerId,
    modelId,
    draftRequest,
  };
}

const stepKey = (index: number) => `step:${index}`;

function foundOf(step: StepRecord | null): StepFound | null {
  if (step?.status !== "completed" || !isRecord(step.result)) return null;
  const { notes, documents } = step.result;
  return {
    notes: typeof notes === "string" ? notes : "",
    documents: Array.isArray(documents)
      ? documents.filter((id): id is string => typeof id === "string")
      : [],
  };
}

/** A search or a page read worth a step of its own; null for the rest (`cite`, a Skill). */
function callStepOf(call: AnswerToolCall): CallStep | null {
  const query = typeof call.input.query === "string" ? call.input.query : "";
  if (call.tool === "search_web") return { kind: "web-search", query, found: call.resultCount };
  if (call.tool === "search_documents") {
    return { kind: "library-search", query, found: call.resultCount };
  }
  if (call.tool !== "read_web_page" || !call.webPage) return null;
  return "documentId" in call.webPage
    ? { kind: "read", name: call.webPage.name }
    : { kind: "unread", address: call.webPage.address };
}

function callStepFrom(value: unknown): CallStep | null {
  if (!isRecord(value)) return null;
  if (
    (value.kind === "web-search" || value.kind === "library-search") &&
    typeof value.query === "string"
  ) {
    return {
      kind: value.kind,
      query: value.query,
      found: typeof value.found === "number" ? value.found : null,
    };
  }
  if (value.kind === "read" && typeof value.name === "string")
    return { kind: "read", name: value.name };
  if (value.kind === "unread" && typeof value.address === "string") {
    return { kind: "unread", address: value.address };
  }
  return null;
}

const hostOf = (address: string) => {
  try {
    return new URL(address).host || address;
  } catch {
    return address;
  }
};

export type Research = ReturnType<typeof createResearch>;

export function createResearch(options: ResearchOptions) {
  type Readied =
    | { model: ChatModelChoice; prepared: PreparedChatModel }
    | Exclude<ResearchStartResult, { started: true }>;

  /** The model, ready and allowed; or why it can't be. */
  async function readyModel(picked: ChatModelChoice | null, thinking?: "off"): Promise<Readied> {
    const choice = picked && options.chat.providerExists(picked.providerId) ? picked : undefined;
    const readiness = await options.chat.readiness(choice);
    if (!readiness.ready) return { started: false, reason: "not-ready", readiness };
    const model = { providerId: readiness.provider.id, modelId: readiness.modelId };
    try {
      return { model, prepared: await options.chat.prepareModel(model, thinking) };
    } catch (error) {
      if (error instanceof ChatNotReadyError) {
        return { started: false, reason: "not-ready", readiness: error.readiness };
      }
      if (error instanceof ConsentDeclinedError)
        return { started: false, reason: "consent-declined" };
      throw error;
    }
  }

  function describe(
    step: StepRecord | undefined,
    key: string,
    input: ResearchInput | null,
  ): string {
    if (key.startsWith("step:")) {
      return input?.plan.steps[Number(key.slice("step:".length))] ?? key;
    }
    if (key === SAVE_STEP) {
      const saved = step?.status === "completed" ? savedOf(step.result) : null;
      if (!saved) return options.say("research.step.saving");
      if (saved.declined) return options.say("research.step.notFiled");
      if (saved.documents === 0) return options.say("research.step.savedNone");
      return options.say(
        saved.documents === 1 ? "research.step.saved.one" : "research.step.saved.other",
        { count: saved.documents, folder: saved.folder },
      );
    }
    if (key === DRAFT_STEP) {
      const written = step?.status === "completed" ? writtenOf(step.result) : null;
      if (!written) return options.say("research.step.writing");
      return options.say(
        written.changes === 1 ? "research.step.wrote.one" : "research.step.wrote.other",
        {
          count: written.changes,
          mind: options.mindName(written.mindId) ?? options.say("mind.untitled"),
        },
      );
    }
    const call = callStepFrom(step?.result);
    if (!call) return key;
    switch (call.kind) {
      case "web-search":
        return options.say("research.step.searchedWeb", { query: call.query });
      case "library-search":
        return options.say("research.step.searchedLibrary", { query: call.query });
      case "read":
        return options.say("research.step.read", { name: call.name });
      case "unread":
        return options.say("research.step.unread", { host: hostOf(call.address) });
    }
  }

  /**
   * Runs an Answer of the Task's in its turn, below Answers, giving way to
   * one when its model is on this computer, tried again after a provider's
   * rate limit: its Answer, why it failed, or how the Task ends (the monthly
   * cap or a plan's limit pauses it; a stop stops it).
   */
  const answering =
    (task: TaskRun, local: boolean) =>
    async (
      run: (signal: AbortSignal) => Promise<CellAnswer>,
    ): Promise<{ answer: CellAnswer } | { failed: string } | { end: TaskEnd }> => {
      const { outcomes, stop } = await runItems(
        [run],
        async () => {
          const turn = await task.turn(local);
          try {
            const answer = await run(AbortSignal.any([task.signal, turn.signal]));
            if (turn.signal.aborted && !task.signal.aborted) throw new RunItemGaveWay();
            if (answer.status === "stopped") throw new DOMException("Stopped.", "AbortError");
            if (answer.status === "failed" && answer.error) throw new RunItemError(answer.error);
            return answer;
          } catch (error) {
            if (turn.signal.aborted && !task.signal.aborted) throw new RunItemGaveWay();
            throw error;
          } finally {
            turn.end();
          }
        },
        { signal: task.signal },
      );
      if (stop) return { end: pausedBy(stop) };
      const outcome = outcomes[0];
      if (!outcome || outcome.status === "stopped" || outcome.status === "not-checked") {
        return { end: { status: "stopped" } };
      }
      if (outcome.status === "failed") return { failed: outcome.error.kind };
      return { answer: outcome.value };
    };

  /** Does one step, from where the journal is: its Answer, and a step for each search and page read. */
  async function doStep(
    task: TaskRun,
    input: ResearchInput,
    index: number,
    model: ChatModelChoice,
    local: boolean,
  ): Promise<{ found: StepFound } | { failed: string } | { end: TaskEnd }> {
    const key = stepKey(index);
    const notes = Array.from(
      { length: index },
      (_, at) => foundOf(task.step(stepKey(at)))?.notes ?? "",
    );
    task.takeMessages();
    const context = stepContext({
      topic: input.topic,
      plan: input.plan,
      index,
      sources: input.sources,
      notes,
      said: task.messages(),
    });
    const documentIds = input.sources.library
      ? input.scope
        ? options.resolveScope(input.scope)
        : null
      : [];
    task.started(key);
    const attempt = task.step(key)?.attempts ?? 1;
    const read = new Set<string>();
    let calls = 0;
    const onCall = (call: AnswerToolCall) => {
      if (call.webPage && "documentId" in call.webPage) read.add(call.webPage.documentId);
      const shown = callStepOf(call);
      if (!shown) return;
      calls += 1;
      const callKey = `call:${index}:${attempt}:${calls}`;
      task.started(callKey);
      task.settled(
        callKey,
        call.status === "done" && shown.kind !== "unread" ? "completed" : "failed",
        shown,
      );
    };
    const result = await answering(
      task,
      local,
    )((signal) =>
      options.answers.answerResearch({
        mindId: task.mindId ?? "",
        context,
        documentIds,
        web: input.sources.web,
        model,
        signal,
        onCall,
      }),
    );
    if (!("answer" in result)) {
      if ("failed" in result) task.settled(key, "failed", { problem: result.failed });
      return result;
    }
    const { answer } = result;
    const found: StepFound = {
      notes: notesOf(answer.markdown),
      documents: [...new Set([...answer.citations.map((each) => each.documentId), ...read])],
    };
    task.settled(key, "completed", found);
    return { found };
  }

  async function runTask(task: TaskRun): Promise<TaskEnd> {
    const input = inputOf(task.input);
    if (!input || !task.mindId) return { status: "failed", problem: "unknown" };
    const ready = await readyModel({ providerId: input.providerId, modelId: input.modelId });
    if (!("model" in ready)) return { status: "paused", reason: "not-ready" };
    if (task.signal.aborted) return { status: "stopped" };
    const local = options.chat.runsLocally(ready.model);
    const keys = stepKeys(input);
    const done = (key: string) => task.step(key)?.status === "completed";
    const report = () => task.progress({ done: keys.filter(done).length, total: keys.length });
    report();
    let problem: string | null = null;
    for (const [index] of input.plan.steps.entries()) {
      if (task.signal.aborted) return { status: "stopped" };
      if (done(stepKey(index))) continue;
      const result = await doStep(task, input, index, ready.model, local);
      if ("end" in result) return result.end;
      if ("failed" in result) problem = result.failed;
      report();
    }
    const found = input.plan.steps
      .map((_, index) => foundOf(task.step(stepKey(index))))
      .filter((each): each is StepFound => each !== null);
    if (found.length === 0) return { status: "failed", problem: problem ?? "unknown" };
    const documents = [...new Set(found.flatMap((each) => each.documents))];
    if (task.signal.aborted) return { status: "stopped" };
    let saved = savedOf(task.step(SAVE_STEP)?.result);
    if (input.sources.web && !done(SAVE_STEP)) {
      const filed = await fileSources(options, task, input, documents, ready.prepared);
      if ("end" in filed) return filed.end;
      saved = filed;
      report();
    }
    if (task.signal.aborted) return { status: "stopped" };
    if (!done(DRAFT_STEP)) {
      const drafted = await writeDraft(
        options,
        task,
        input,
        {
          notes: found.map((each) => each.notes),
          documents,
          folderId: saved?.folderId || null,
        },
        ready.model,
        answering(task, local),
        options.answers.answerCell,
      );
      if ("end" in drafted) return drafted.end;
      if ("failed" in drafted) return { status: "failed", problem: drafted.failed };
      report();
    }
    return { status: "done" };
  }

  /** The keys of a Task's steps, in order: its plan's, then filing its pages (with Web on), then the draft. */
  const stepKeys = (input: ResearchInput) => [
    ...input.plan.steps.map((_, index) => stepKey(index)),
    ...(input.sources.web ? [SAVE_STEP] : []),
    DRAFT_STEP,
  ];

  const journalOf = (taskId: string) =>
    new Map(options.tasks.steps(taskId).map((step) => [step.key, step]));

  const taskKind: TaskKind = {
    kind: RESEARCH_TASK,
    run: runTask,
    actions: ["plan", "tell", "pause", "stop"],
    remainingOf(task) {
      const input = inputOf(task.input);
      if (!input) return [];
      const steps = journalOf(task.id);
      return stepKeys(input)
        .filter((key) => steps.get(key)?.status !== "completed")
        .map((key) => describe(undefined, key, input));
    },
    summaryOf(task) {
      const steps = journalOf(task.id);
      const saved = savedOf(steps.get(SAVE_STEP)?.result);
      const written = writtenOf(steps.get(DRAFT_STEP)?.result);
      const parts = [
        ...(saved && saved.documents > 0
          ? [
              options.say(
                saved.documents === 1
                  ? "research.summary.saved.one"
                  : "research.summary.saved.other",
                { count: saved.documents },
              ),
            ]
          : []),
        ...(written
          ? [
              options.say(
                written.changes === 1
                  ? "research.summary.changes.one"
                  : "research.summary.changes.other",
                { count: written.changes },
              ),
            ]
          : []),
      ];
      return parts.length > 0 ? parts.join(" · ") : null;
    },
    questionOf: (input) => inputOf(input)?.topic ?? null,
    reviewOf(task) {
      const step = options.tasks.steps(task.id).find((each) => each.key === DRAFT_STEP);
      const written = step?.status === "completed" ? writtenOf(step.result) : null;
      return written ? { mindId: written.mindId, proposalId: written.proposalId || null } : null;
    },
    describeSteps(task, keys) {
      const input = inputOf(task.input);
      const steps = new Map(options.tasks.steps(task.id).map((step) => [step.key, step]));
      return keys.map((key) => describe(steps.get(key), key, input));
    },
  };

  return {
    taskKind,

    /** A Research Task's plan, each step with how far it is. */
    planView(taskId: unknown): ResearchPlanView {
      const task = typeof taskId === "string" ? options.tasks.get(taskId) : null;
      const input = task ? inputOf(task.input) : null;
      if (!task || !input) throw new NotFoundError({ key: "error.research.notFound" });
      const steps = journalOf(task.id);
      const statusOf = (key: string): ResearchPlanView["steps"][number]["status"] => {
        const step = steps.get(key);
        if (!step) return "waiting";
        if (step.status === "completed") return "done";
        if (step.status === "started") return "running";
        return "failed";
      };
      return {
        title: input.plan.title,
        steps: stepKeys(input).map((key) => ({
          text: key.startsWith("step:")
            ? describe(undefined, key, input)
            : describe(steps.get(key), key, input),
          status: statusOf(key),
        })),
        sources: input.sources,
        writeInto: "mindId" in input.writeInto ? input.writeInto.mindId : null,
      };
    },

    async plan(given: PlanResearchInput): Promise<ResearchPlanResult> {
      if (!isRecord(given)) throw new InvalidInputError({ key: "error.research.plan" });
      // With no Mind in focus there is no Mind to plan into; the plan lives on the card until Start.
      if (given.mindId !== null) options.requireMind(given.mindId);
      const topic = text(given.topic, "error.research.topic", MAX_RESEARCH_TOPIC);
      const sources = parseSources(given.sources);
      const model = parseModel(given.model);
      const change = isRecord(given.change)
        ? {
            steps: parseSteps(given.change.steps),
            text: text(given.change.text, "error.research.change", MAX_RESEARCH_TOPIC),
          }
        : null;
      // Kimi K2.6 thinks by default, and its thinking took the whole reply: none was left for the plan (#1369).
      const ready = await readyModel(model, "off");
      if (!("model" in ready)) {
        return ready.reason === "not-ready"
          ? { planned: false, reason: "not-ready", readiness: ready.readiness }
          : { planned: false, reason: "consent-declined" };
      }
      let reply: string;
      let thoughtOnly = false;
      try {
        const result = await generateText({
          model: ready.prepared.model,
          instructions: PLAN_INSTRUCTIONS,
          prompt: planPrompt(topic, sources, change),
          // Room for a model that thinks whatever it is asked, before its plan.
          maxOutputTokens: 4_096,
          maxRetries: 1,
          abortSignal: AbortSignal.timeout(PLAN_TIMEOUT_MS),
        });
        reply = result.text;
        thoughtOnly = result.finishReason === "length" && reply.trim() === "";
      } catch (error) {
        return { planned: false, reason: "failed", error: classifyProviderError(error) };
      }
      const plan = readPlan(reply, topic);
      if (!plan) {
        return {
          planned: false,
          reason: "failed",
          error: {
            kind: "no-answer",
            message: thoughtOnly
              ? "The model spent its whole reply thinking."
              : "The model's reply had no steps.",
            wording: {
              key: thoughtOnly ? "error.research.plan.thoughtOnly" : "error.research.plan.noSteps",
            },
          },
        };
      }
      return { planned: true, plan };
    },

    async start(given: StartResearchInput): Promise<ResearchStartResult> {
      if (!isRecord(given) || !isRecord(given.plan)) {
        throw new InvalidInputError({ key: "error.research.plan" });
      }
      const asked = given.mindId === null ? null : options.requireMind(given.mindId);
      const topic = text(given.topic, "error.research.topic", MAX_RESEARCH_TOPIC);
      const plan: ResearchPlan = {
        title: text(given.plan.title, "error.research.step", MAX_RESEARCH_STEP),
        steps: parseSteps(given.plan.steps),
      };
      const sources = parseSources(given.sources);
      const chosen = parseTarget(given.writeInto);
      const chosenMind = "mindId" in chosen ? options.requireMind(chosen.mindId) : null;
      // Read before anything is made: a scope that can't be read makes no Mind to leave behind.
      const within = parseSearchScope(given.scope);
      const ready = await readyModel(parseModel(given.model));
      if (!("model" in ready)) return ready;
      // With no Mind in focus, the new Mind its draft goes into is the Task's own, made first so
      // its progress shows there from the start; a Mind chosen to write into is that Mind.
      const ownMind = asked === null && !("mindId" in chosen);
      const mindId = asked ?? chosenMind ?? options.createMind(cutTitle(plan.title), null);
      const writeInto: ResearchTarget = asked === null ? { mindId } : chosen;
      const scope = options.searchedScope(within, mindId);
      const task = options.tasks.start(RESEARCH_TASK, mindId, {
        topic,
        plan,
        sources,
        writeInto,
        ownMind,
        scope,
        providerId: ready.model.providerId,
        modelId: ready.model.modelId,
        draftRequest: randomUUID(),
      });
      return { started: true, task };
    },
  };
}
