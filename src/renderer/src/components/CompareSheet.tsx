import type { Editor } from "@tiptap/core";
import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import type * as Y from "yjs";
import type { RunEstimate } from "../../../core/api";
import { MAX_COMPARISON_DOCUMENTS, MAX_COMPARISON_QUESTIONS } from "../../../shared/comparisons";
import { asksFirst } from "../compareScope";
import {
  chooseCompareSource,
  closeCompareSheet,
  documentIdsIn,
  makeComparisonTable,
  type SheetSource,
  sheetDocuments,
  updateCompareSheet,
  useComparisons,
} from "../comparisons";
import { core } from "../core";
import { type EstimateLine, estimateLine, joinMeta } from "../cost";
import { RemoveIcon, TableIcon } from "../editor/icons";
import { AskBlock } from "../editor/MindCheckLine";
import { ModelChip } from "../editor/ModelChip";
import { useLanguage, useT } from "../i18n";
import { useModelInUse } from "../modelInUse";
import { useSelectedOn } from "../selection";
import { useAppStore } from "../store";
import { ChevronDownLineIcon, PlusLineIcon } from "./lineIcons";
import { ProblemLine } from "./ProblemLine";
import { ReadinessLine } from "./providers/ChatReadinessNotice";
import { NeedsModelCard } from "./providers/NeedsModelCard";
import { buttonStyle, menuClass, menuItemClass } from "./ui";
import { usePopoverMenu } from "./usePopoverMenu";

/** Compare Documents (#98; the canvas board Final-37-Compare-Start), docked at the foot of the Mind. */
export function CompareSheet({
  mindId,
  doc,
  editor,
}: {
  mindId: string;
  doc: Y.Doc;
  editor: Editor;
}) {
  const t = useT();
  const language = useLanguage();
  const sheet = useComparisons((state) => state.sheets[mindId]);
  const problem = useComparisons((state) => state.problems[mindId]);
  const allDocuments = useAppStore((state) => state.documents);
  const library = useAppStore((state) => state.library);
  const settings = useAppStore((state) => state.settings);
  const model = useModelInUse(doc);
  const region = useRef<HTMLElement>(null);
  const questionFields = useRef<(HTMLInputElement | null)[]>([]);
  const focusQuestion = useRef<number | null>(null);
  const selectAll = useRef<HTMLInputElement>(null);
  const ask = useRef<HTMLDivElement>(null);
  const hintIds = useId();
  const [estimate, setEstimate] = useState<RunEstimated | null>(null);
  const [askedFor, setAskedFor] = useState<string | null>(null);

  const source = sheet?.source ?? "all";
  const selected = sheet?.selected;
  // biome-ignore lint/correctness/useExhaustiveDependencies: listed again when the Library or its Documents change.
  const documents = useMemo(
    () =>
      sheetDocuments(source, selected).sort((a, b) =>
        a.name.localeCompare(b.name, language, { numeric: true }),
      ),
    [source, selected, allDocuments, library, settings, language],
  );
  const checked = useMemo(() => {
    const ticked = new Set(sheet?.checked ?? []);
    return documents.filter((document) => ticked.has(document.id));
  }, [documents, sheet?.checked]);
  const questions = sheet?.questions ?? [];
  const asked = questions.filter((question) => question.trim() !== "");
  const cells = checked.length * asked.length;
  const tickable = Math.min(documents.length, MAX_COMPARISON_DOCUMENTS);
  const allTicked = tickable > 0 && checked.length >= tickable;
  const someTicked = checked.length > 0;
  const documentsHint =
    documents.length === 0
      ? null
      : checked.length === 0
        ? "comparison.sheet.noneChecked"
        : checked.length > MAX_COMPARISON_DOCUMENTS
          ? "comparison.sheet.tooMany"
          : null;
  const questionsHint = asked.length === 0 ? "comparison.sheet.noQuestions" : null;
  const blocked = documents.length === 0 || documentsHint !== null || questionsHint !== null;
  // The question before a run is about these Documents, Questions and this model, and goes when any change.
  const modelKey = `${model?.providerId}|${model?.modelId}`;
  const runKey = `${checked.map((document) => document.id).join()}|${asked.length}|${modelKey}`;
  const confirming = askedFor === runKey;
  // The last estimate stays on show while the next loads, so a tick doesn't move the foot.
  const estimated = estimate?.model === modelKey ? estimate : null;
  const exact = estimated?.cells === cells ? estimated : null;

  // The first Question's field takes the focus as the sheet opens.
  const open = sheet !== undefined;
  // biome-ignore lint/correctness/useExhaustiveDependencies: only as it opens, not as Questions are typed.
  useEffect(() => {
    if (!open) return;
    if (questions.length === 0) updateCompareSheet(mindId, { questions: [""] });
    focusQuestion.current = 0;
    region.current?.scrollIntoView({ block: "nearest" });
  }, [open, mindId]);
  // Once its field is drawn: the first, as the sheet opens, has to wait for its Question.
  useEffect(() => {
    const index = focusQuestion.current;
    const field = index === null ? null : questionFields.current[index];
    if (!field) return;
    focusQuestion.current = null;
    field.focus();
  });

  useEffect(() => {
    if (!open) {
      setEstimate(null);
      return;
    }
    if (cells === 0) return;
    let current = true;
    estimateCells(cells, model).then((run) => {
      if (!current) return;
      setEstimate(run && { cells, model: modelKey, run, line: estimateLine(run, t, language) });
    });
    return () => {
      current = false;
    };
  }, [open, cells, model, modelKey, t, language]);

  // `indeterminate` is a property of the element, not an attribute.
  useEffect(() => {
    if (selectAll.current) selectAll.current.indeterminate = someTicked && !allTicked;
  }, [someTicked, allTicked]);
  useEffect(() => {
    if (confirming) ask.current?.querySelector("button")?.focus();
  }, [confirming]);

  if (!sheet) return null;

  const close = () => {
    setAskedFor(null);
    closeCompareSheet(mindId);
    editor.commands.focus();
  };
  const make = async () => {
    if (blocked) return;
    setAskedFor(null);
    const made = await makeComparisonTable(
      mindId,
      checked.map((document) => document.id),
      model,
    );
    if (made && !editor.isDestroyed) editor.commands.focus();
  };
  // The estimate may not be in yet for the Questions just typed: a run is asked about on its own.
  const requestMake = async () => {
    if (blocked || sheet.making) return;
    const run = exact ? exact.run : await estimateCells(cells, model);
    if (asksFirst(checked.length, run)) setAskedFor(runKey);
    else await make();
  };
  const chooseDocuments = () => {
    setAskedFor(null);
    selectAll.current?.focus();
  };
  const setQuestions = (next: string[]) => updateCompareSheet(mindId, { questions: next });
  const addQuestion = (at = questions.length) => {
    if (questions.length >= MAX_COMPARISON_QUESTIONS) return;
    setQuestions([...questions.slice(0, at), "", ...questions.slice(at)]);
    focusQuestion.current = at;
  };
  const toggle = (documentId: string) => {
    const ticked = new Set(sheet.checked);
    if (ticked.has(documentId)) ticked.delete(documentId);
    else ticked.add(documentId);
    updateCompareSheet(mindId, { checked: [...ticked] });
  };
  const tick = (ids: readonly string[]) => updateCompareSheet(mindId, { checked: ids });
  const tickAll = () =>
    tick(documents.slice(0, MAX_COMPARISON_DOCUMENTS).map((document) => document.id));
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape" && !event.defaultPrevented) {
      event.preventDefault();
      if (confirming) chooseDocuments();
      else close();
    } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      // A second press, or a held key, must not answer the question unread: Enter on its button does.
      if (!confirming) void requestMake();
    } else if (
      event.key.toLowerCase() === "a" &&
      (event.metaKey || event.ctrlKey) &&
      !event.shiftKey &&
      !event.altKey &&
      event.target instanceof HTMLElement &&
      event.target.matches(".compare-sheet-documents input")
    ) {
      event.preventDefault();
      tickAll();
    }
  };
  const onQuestionKey = (index: number) => (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.metaKey || event.ctrlKey) return;
    if (event.key === "Enter") {
      event.preventDefault();
      if (index === questions.length - 1) addQuestion();
      else questionFields.current[index + 1]?.focus();
    } else if (event.key === "Backspace" && questions[index] === "" && questions.length > 1) {
      event.preventDefault();
      setQuestions(questions.filter((_, at) => at !== index));
      focusQuestion.current = Math.max(0, index - 1);
    }
  };

  const folderName =
    source === "all"
      ? t("comparison.sheet.allDocuments")
      : (library?.groups.find((group) => group.id === source)?.name ??
        t("comparison.sheet.allDocuments"));
  const heading =
    source === "selected"
      ? t("comparison.sheet.documentsSelected")
      : t("comparison.sheet.documentsIn", { folder: folderName });
  const hintFor = (key: string) => `${hintIds}${key}`;
  const cellsToFill = t("comparison.sheet.ask.cells", { count: cells });

  return (
    <section
      ref={region}
      data-testid="compare-sheet"
      aria-label={t("comparison.sheet.region")}
      className="mind-measure compare-sheet"
      onKeyDown={onKeyDown}
    >
      <div className="compare-sheet-body">
        <div className="compare-sheet-questions">
          <div className="compare-sheet-heading">
            <span>{t("comparison.sheet.questions")}</span>
            <span className="compare-sheet-count">{asked.length}</span>
          </div>
          <ol className="compare-sheet-question-list">
            {questions.map((question, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a Question is its place in the list while it is typed.
              <li key={index} className="compare-sheet-question">
                <span className="compare-sheet-number">{index + 1}</span>
                <input
                  ref={(field) => {
                    questionFields.current[index] = field;
                  }}
                  data-testid="compare-sheet-question"
                  aria-label={t("comparison.addQuestion.label")}
                  placeholder={t("comparison.addQuestion.placeholder")}
                  value={question}
                  onChange={(event) =>
                    setQuestions(
                      questions.map((each, at) => (at === index ? event.target.value : each)),
                    )
                  }
                  onKeyDown={onQuestionKey(index)}
                />
                {questions.length > 1 && (
                  <button
                    type="button"
                    className="compare-sheet-remove"
                    aria-label={t("comparison.sheet.removeQuestion", {
                      question: question || String(index + 1),
                    })}
                    title={t("comparison.sheet.removeQuestion", {
                      question: question || String(index + 1),
                    })}
                    onClick={() => setQuestions(questions.filter((_, at) => at !== index))}
                  >
                    <RemoveIcon className="size-3" />
                  </button>
                )}
              </li>
            ))}
          </ol>
          {questions.length < MAX_COMPARISON_QUESTIONS && (
            <button
              type="button"
              data-testid="compare-sheet-add-question"
              className="compare-sheet-add"
              onClick={() => addQuestion()}
            >
              <PlusLineIcon className="size-3.5" />
              {t("comparison.addQuestion")}
            </button>
          )}
          {questionsHint && (
            <p
              id={hintFor("questions")}
              data-testid="compare-sheet-hint-questions"
              className="compare-sheet-hint"
            >
              {t(questionsHint)}
            </p>
          )}
        </div>
        <div className="compare-sheet-documents">
          <div className="compare-sheet-heading">
            <span className="compare-sheet-scope">
              {documents.length > 0 && (
                <input
                  ref={selectAll}
                  type="checkbox"
                  data-testid="compare-sheet-select-all"
                  className="compare-sheet-select-all"
                  aria-label={t(
                    someTicked ? "comparison.sheet.selectNone" : "comparison.sheet.selectAll",
                  )}
                  title={t(
                    someTicked ? "comparison.sheet.selectNone" : "comparison.sheet.selectAll",
                  )}
                  checked={allTicked}
                  onChange={() => (someTicked ? tick([]) : tickAll())}
                />
              )}
              <SourceMenu label={heading} onChoose={(next) => chooseCompareSource(mindId, next)} />
            </span>
            <span data-testid="compare-sheet-counted" className="compare-sheet-count">
              {t("comparison.sheet.counted", { checked: checked.length, total: documents.length })}
            </span>
          </div>
          {documents.length === 0 ? (
            <ProblemLine
              role="status"
              testId="compare-sheet-no-documents"
              action={{
                label: t("sidebar.plus.addDocuments"),
                onClick: () => void useAppStore.getState().pickDocuments(),
              }}
            >
              {t("comparison.sheet.noDocuments")}
            </ProblemLine>
          ) : (
            <ul className="compare-sheet-list">
              {documents.map((document) => (
                <li key={document.id}>
                  <label className="compare-sheet-document" title={document.name}>
                    <input
                      type="checkbox"
                      data-testid="compare-sheet-document"
                      checked={sheet.checked.includes(document.id)}
                      onChange={() => toggle(document.id)}
                    />
                    <span className="truncate">{document.name}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          {documentsHint && (
            <p
              id={hintFor("documents")}
              data-testid="compare-sheet-hint-documents"
              className="compare-sheet-hint"
            >
              {t(documentsHint, { max: MAX_COMPARISON_DOCUMENTS })}
            </p>
          )}
        </div>
      </div>
      <input
        data-testid="compare-sheet-instruction"
        className="compare-sheet-instruction"
        aria-label={t("comparison.sheet.instruction")}
        placeholder={t("comparison.sheet.instruction")}
        value={sheet.instruction}
        onChange={(event) => updateCompareSheet(mindId, { instruction: event.target.value })}
      />
      {problem &&
        (problem.reason === "not-ready" ? (
          problem.readiness.reason === "no-provider" ? (
            <NeedsModelCard
              line="needsModel.compare"
              testId="compare-sheet-needs-model"
              className="compare-sheet-problem"
              onDone={() => void requestMake()}
            />
          ) : (
            <ReadinessLine
              readiness={problem.readiness}
              testId="compare-sheet-not-ready"
              className="compare-sheet-problem"
              setUpLabel={t("question.setUp")}
            />
          )
        ) : (
          <ProblemLine testId="compare-sheet-not-sent" className="compare-sheet-problem">
            {t("answer.error.consent-declined")}
          </ProblemLine>
        ))}
      {confirming ? (
        <div ref={ask} className="compare-sheet-ask">
          <AskBlock
            testId="compare-sheet-ask"
            question={t(
              checked.length === 1 ? "comparison.sheet.ask.one" : "comparison.sheet.ask",
              {
                count: checked.length,
              },
            )}
            estimate={exact?.line ?? { parts: [cellsToFill], title: cellsToFill }}
            check={{
              label: t("comparison.sheet.make"),
              testId: "compare-sheet-ask-make",
              onClick: () => void make(),
            }}
            notNow={{
              label: t("comparison.sheet.ask.choose"),
              testId: "compare-sheet-ask-choose",
              onClick: chooseDocuments,
            }}
          />
        </div>
      ) : (
        <>
          {estimated?.line && (
            <p
              data-testid="compare-sheet-estimate"
              className="compare-sheet-estimate"
              title={estimated.line.title}
              aria-hidden={blocked}
            >
              {joinMeta(estimated.line.parts)}
            </p>
          )}
          <div className="compare-sheet-foot">
            <span className="compare-sheet-chip">
              <TableIcon className="size-3.5" />
              {t("comparison.sheet.region")}
              <button
                type="button"
                data-testid="compare-sheet-close"
                aria-label={t("comparison.sheet.close")}
                title={t("comparison.sheet.close")}
                onClick={close}
              >
                <RemoveIcon className="size-3" />
              </button>
            </span>
            <ModelChip doc={doc} onChosen={() => region.current?.focus()} />
            <button
              type="button"
              data-testid="compare-sheet-make"
              className={buttonStyle("primary", "sm")}
              disabled={blocked || sheet.making}
              aria-describedby={
                [documentsHint && hintFor("documents"), questionsHint && hintFor("questions")]
                  .filter(Boolean)
                  .join(" ") || undefined
              }
              onClick={() => void requestMake()}
            >
              {t("comparison.sheet.make")}
            </button>
          </div>
        </>
      )}
    </section>
  );
}

function SourceMenu({ label, onChoose }: { label: string; onChoose(source: SheetSource): void }) {
  const t = useT();
  const groups = useAppStore((state) => state.library?.groups) ?? [];
  const inLibrary = useSelectedOn("library");
  const menu = usePopoverMenu();
  const selectedCount = menu.open ? sheetDocuments("selected", documentIdsIn(inLibrary)).length : 0;
  return (
    <>
      <button
        {...menu.buttonProps}
        type="button"
        data-testid="compare-sheet-source"
        className="compare-sheet-source"
        title={t("comparison.sheet.chooseFolder")}
      >
        <span className="truncate">{label}</span>
        <ChevronDownLineIcon className="size-3 shrink-0" />
      </button>
      <div
        {...menu.menuProps}
        role="menu"
        aria-label={t("comparison.sheet.chooseFolder")}
        className={menuClass}
      >
        {menu.open && (
          <>
            {selectedCount > 0 && (
              <button
                type="button"
                role="menuitem"
                data-testid="compare-sheet-source-selected"
                className={menuItemClass}
                onClick={() => {
                  onChoose("selected");
                  menu.close();
                }}
              >
                {t("comparison.sheet.selectedInLibrary", { count: selectedCount })}
              </button>
            )}
            {groups.map((group) => (
              <button
                key={group.id}
                type="button"
                role="menuitem"
                className={menuItemClass}
                onClick={() => {
                  onChoose(group.id);
                  menu.close();
                }}
              >
                {group.name}
              </button>
            ))}
            <button
              type="button"
              role="menuitem"
              className={menuItemClass}
              onClick={() => {
                onChoose("all");
                menu.close();
              }}
            >
              {t("comparison.sheet.allDocuments")}
            </button>
          </>
        )}
      </div>
    </>
  );
}

interface RunEstimated {
  cells: number;
  model: string;
  run: RunEstimate;
  line: EstimateLine | null;
}

function estimateCells(
  cells: number,
  model: { providerId: string; modelId: string } | null,
): Promise<RunEstimate | null> {
  return core.estimateRun({ items: cells, ...(model && { model }) }).catch((error: unknown) => {
    console.warn(`Couldn't estimate comparing ${cells} cells; it goes on without one.`, error);
    return null;
  });
}
