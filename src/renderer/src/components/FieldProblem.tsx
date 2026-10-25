import { type FormEvent, type ReactNode, useId, useState } from "react";
import { ProblemMark } from "./ProblemLine";
import { errorTextClass } from "./ui";

/** Why a field fails the browser's checks: `required` and empty, or not fitting its `type`. */
type FieldFault = "missing" | "invalid";

type Control = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

function namedControl(target: EventTarget): Control | null {
  const control =
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
      ? target
      : null;
  return control?.name ? control : null;
}

/**
 * The browser's checks of a form's named fields, said on a line under each field that fails, in
 * the interface's language: Chromium's own bubble speaks the system's language and closes by
 * itself (#1456). Submitting marks every field that fails and moves the focus to the first; a
 * field's line then follows its value until it passes.
 */
export function useFieldProblems() {
  const id = useId();
  const [faults, setFaults] = useState<ReadonlyMap<string, FieldFault>>(new Map());
  const lineId = (name: string) => `${id}-${name}`;
  const note = ({ name, validity }: Control) => {
    const fault = validity.valid ? null : validity.valueMissing ? "missing" : "invalid";
    setFaults((current) => {
      const next = new Map(current);
      if (fault) next.set(name, fault);
      else next.delete(name);
      return next;
    });
  };
  return {
    form: {
      onInvalidCapture(event: FormEvent<HTMLFormElement>) {
        const control = namedControl(event.target);
        if (!control) return;
        event.preventDefault();
        note(control);
        if (control === event.currentTarget.querySelector(":is(input, textarea, select):invalid")) {
          control.focus();
        }
      },
      onChangeCapture(event: FormEvent<HTMLFormElement>) {
        const control = namedControl(event.target);
        if (control && faults.has(control.name)) note(control);
      },
    },
    field: (name: string) => ({
      name,
      "aria-invalid": faults.has(name) ? true : undefined,
      "aria-describedby": faults.has(name) ? lineId(name) : undefined,
    }),
    fault: (name: string) => faults.get(name) ?? null,
    lineId,
  };
}

export type FieldProblems = ReturnType<typeof useFieldProblems>;

/** What is wrong with a field, on a line under it: the amber mark, then the words in ink. */
export function FieldProblem({
  id,
  testId,
  children,
}: {
  id: string;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <span id={id} role="alert" data-testid={testId} className={`${errorTextClass} mt-1 block`}>
      <ProblemMark />
      {children}
    </span>
  );
}
