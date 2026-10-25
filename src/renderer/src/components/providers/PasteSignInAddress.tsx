import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import type { PastedAddressProblem, PastedAddressResult } from "../../../../core/api";
import type { MessageKey } from "../../../../shared/i18n";
import { core } from "../../core";
import { useGap, useT } from "../../i18n";
import { useAppStore } from "../../store";
import { ProblemMark } from "../ProblemLine";
import { buttonStyle, errorTextClass, fieldClass } from "../ui";

export type PasteWords = {
  testId: string;
  continue: MessageKey;
  problems: Record<PastedAddressProblem, MessageKey>;
  placeholder?: string;
} & ({ question: MessageKey; open: MessageKey } | { label: MessageKey });

const CHATGPT: PasteWords = {
  testId: "chatgpt-paste",
  question: "chatgpt.paste.question",
  open: "chatgpt.paste.open",
  continue: "chatgpt.paste.continue",
  problems: {
    "not-sign-in-address": "chatgpt.paste.problem.not-sign-in-address",
    "other-sign-in": "chatgpt.paste.problem.other-sign-in",
    finished: "chatgpt.paste.problem.finished",
  },
  placeholder: "http://127.0.0.1:…",
};

/**
 * What the User pastes under a sign-in that waits for the browser: as a
 * fallback, "Didn't come back? Paste the address the browser shows", for when
 * the browser can't hand the sign-in back (a blocked port, another browser
 * profile, a proxy), opened in place and closed with Esc; or, where the
 * provider's page shows a code to copy, the field itself, open at once.
 */
export function PasteSignInAddress({
  paste = (address) => core.pasteChatGptSignInAddress(address),
  words = CHATGPT,
}: {
  paste?(address: string): Promise<PastedAddressResult>;
  words?: PasteWords;
}) {
  const t = useT();
  const gap = useGap();
  const id = useId();
  const always = "label" in words;
  const [open, setOpen] = useState(always);
  const [address, setAddress] = useState("");
  const [problem, setProblem] = useState<PastedAddressProblem | null>(null);
  const [sending, setSending] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const closedWithEsc = useRef(false);

  useEffect(() => {
    if (open) field.current?.focus();
    else if (closedWithEsc.current) {
      closedWithEsc.current = false;
      opener.current?.focus();
    }
  }, [open]);

  const question = "question" in words ? t(words.question) : "";
  const action = "open" in words ? t(words.open) : "";
  const label = "label" in words ? t(words.label) : `${question}${gap(question, action)}${action}`;

  if (!open) {
    return (
      <p className="text-[13px] leading-5 text-ink-secondary">
        {question}
        {gap(question, action)}
        <button
          ref={opener}
          type="button"
          data-testid={`${words.testId}-open`}
          onClick={() => setOpen(true)}
          className="font-semibold text-accent underline-offset-2 hover:underline"
        >
          {action}
        </button>
      </p>
    );
  }

  const empty = address.trim() === "";

  const submit = async () => {
    if (sending || empty) return;
    setSending(true);
    setProblem(null);
    try {
      const pasted = await paste(address);
      // Taken: the sign-in finishes, and this line goes with the wait it belongs to.
      if (pasted.ok) return;
      setProblem(pasted.problem);
    } catch (error) {
      useAppStore.getState().reportError(error);
    }
    setSending(false);
    field.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();
      void submit();
    } else if (event.key === "Escape" && !always) {
      // Closes the field only, not the Settings dialog or menu it sits in.
      event.preventDefault();
      event.stopPropagation();
      closedWithEsc.current = true;
      setOpen(false);
      setAddress("");
      setProblem(null);
    }
  };

  return (
    <div data-testid={words.testId} data-setup-foot className="flex w-full flex-col gap-1">
      <label htmlFor={id} className="text-[13px] leading-5 text-ink-secondary">
        {label}
      </label>
      <div className="flex w-full items-center gap-2">
        <input
          ref={field}
          id={id}
          type="text"
          data-testid={`${words.testId}-address`}
          value={address}
          readOnly={sending}
          placeholder={words.placeholder}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={problem ? true : undefined}
          aria-describedby={problem ? `${id}-problem` : undefined}
          onChange={(event) => {
            setAddress(event.target.value);
            setProblem(null);
          }}
          onKeyDown={onKeyDown}
          className={`${fieldClass} h-7 min-w-0 flex-1 py-0 font-mono text-[13px]`}
        />
        <button
          type="button"
          data-testid={`${words.testId}-continue`}
          disabled={sending || empty}
          onClick={() => void submit()}
          className={buttonStyle("secondary", "sm")}
        >
          {t(words.continue)}
        </button>
      </div>
      {problem && (
        <p
          id={`${id}-problem`}
          role="alert"
          data-testid={`${words.testId}-problem`}
          className={errorTextClass}
        >
          <ProblemMark />
          {t(words.problems[problem])}
        </p>
      )}
    </div>
  );
}
