/**
 * Compact ask bar under a PowerPoint deck (#149 part 2): sends a request carrying the User's
 * selected shape or current slide (documentId, slide, shapeId, shapeName, and current text) to
 * their connected AI so it edits only what was named through `read_deck` + `propose_deck_changes`.
 */
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentPairing, Document } from "../../../../core/api";
import { useViewerHandle } from "../../commands/handles";
import { core } from "../../core";
import { errorMessage } from "../../errors";
import { useT } from "../../i18n";

export interface SelectedDeckShape {
  slide: number;
  shapeId: string;
  shapeName: string;
  text: string;
}

export function DeckAskBox({
  document,
  slide,
  selection,
  externalTrigger,
}: {
  document: Document;
  slide: number;
  selection: SelectedDeckShape | null;
  /** Optional imperative ask request (e.g. "Ask AI to shorten" from an overflowing Proposal). */
  externalTrigger?: {
    id: number;
    slide: number;
    shapeId?: string;
    shapeName?: string;
    text?: string;
    instruction: string;
  } | null;
}) {
  const t = useT();
  const [agents, setAgents] = useState<AgentPairing[]>([]);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let live = true;
    const load = () => {
      void core
        .listAgentsToAsk(null, document.id)
        .then((list) => {
          if (live) setAgents(list);
        })
        .catch(() => {
          if (live) setAgents([]);
        });
    };
    load();
    const off = core.on("agents.changed", load);
    return () => {
      live = false;
      off();
    };
  }, [document.id]);

  const primary = agents[0] ?? null;

  const askHandle = useMemo(
    () =>
      primary
        ? {
            focus: () => {
              inputRef.current?.focus();
            },
          }
        : null,
    [primary],
  );
  useViewerHandle("deckAsk", askHandle);

  const send = useCallback(
    async (
      instruction: string,
      target: { slide: number; shapeId?: string; shapeName?: string; text?: string },
    ) => {
      if (!primary || instruction.trim() === "") return;
      setBusy(true);
      setStatus(null);
      try {
        const result = await core.askAgent({
          pairingId: primary.id,
          mindId: null,
          ask: {
            kind: "deck-edit",
            documentId: document.id,
            slide: target.slide,
            ...(target.shapeId && { shapeId: target.shapeId }),
            ...(target.shapeName && { shapeName: target.shapeName }),
            ...(target.text && { text: target.text }),
            instruction: instruction.trim(),
          },
        });
        if (result.kind === "copy") {
          await navigator.clipboard?.writeText(result.text).catch(() => undefined);
          setStatus(t("viewer.deck.ask.copied", { agent: primary.name }));
        } else {
          setStatus(t("viewer.deck.ask.opened", { agent: primary.name }));
        }
        setInput("");
      } catch (err) {
        setStatus(errorMessage(err, t));
      } finally {
        setBusy(false);
      }
    },
    [document.id, primary, t],
  );

  useEffect(() => {
    if (!externalTrigger || !primary) return;
    void send(externalTrigger.instruction, {
      slide: externalTrigger.slide,
      shapeId: externalTrigger.shapeId,
      shapeName: externalTrigger.shapeName,
      text: externalTrigger.text,
    });
  }, [externalTrigger, primary, send]);

  if (!primary) return null;

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    void send(input, {
      slide: selection?.slide ?? slide,
      shapeId: selection?.shapeId,
      shapeName: selection?.shapeName,
      text: selection?.text,
    });
  };

  const placeholder = selection
    ? t("viewer.deck.ask.shapePlaceholder", {
        shape: selection.shapeName || `#${selection.shapeId}`,
        slide: selection.slide,
      })
    : t("viewer.deck.ask.placeholder", { slide });

  return (
    <div className="viewer-deck-ask" data-testid="viewer-deck-ask" data-quote-skip="">
      <form className="viewer-deck-ask-form" onSubmit={onSubmit}>
        <input
          ref={inputRef}
          type="text"
          className="viewer-deck-ask-input"
          data-testid="viewer-deck-ask-input"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder={placeholder}
          aria-label={placeholder}
          disabled={busy}
        />
        <button
          type="submit"
          className="viewer-deck-proposal-btn viewer-deck-proposal-btn--primary"
          data-testid="viewer-deck-ask-send"
          disabled={busy || input.trim() === ""}
        >
          {t("viewer.deck.ask.send")}
        </button>
      </form>
      {status && (
        <div className="viewer-deck-ask-status" data-testid="viewer-deck-ask-status" role="status">
          {status}
        </div>
      )}
    </div>
  );
}
