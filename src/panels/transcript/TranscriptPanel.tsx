/**
 * Registered `transcript` panel type: streams message parts for the
 * selected session. Backfills via `listMessages` on open/select, then live-
 * appends via the shared demux subscription. Blocked-on-question renders a
 * needs-attention badge + inline answer box; reply posts through the
 * client and optimistically locks until a confirming `question.replied`/
 * `session.status` event (routed through the store) clears it. `session
 * .deleted` for the open session flips the panel read-only.
 */
import type { IDockviewPanelProps } from "dockview-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { OpencodeClient } from "../../server/client";
import type { Demux } from "../../server/demux";
import type { SessionStore } from "../../server/session-store";
import type { SseEvent } from "../../server/types";
import {
  type PendingQuestionView,
  type TranscriptState,
  addPendingQuestion,
  applyPartUpdate,
  checkSessionStillTracked,
  initialTranscriptState,
  partUpdateFromEventProperties,
  removePendingQuestion,
  resolveBackfill,
  setAnswerError,
  setAnswerSending,
  shouldAutoScroll,
  toErrorState,
  toReadOnly,
} from "./transcript-view";

/** Issue 4: scroll-position tolerance in px — mirrors
 * `shouldAutoScroll`'s default threshold so the DOM measurement and the
 * pure decision agree on what counts as "already at the bottom". */
const AUTO_SCROLL_THRESHOLD_PX = 48;

export interface TranscriptPanelParams {
  client?: OpencodeClient;
  demux?: Demux;
  /** Session store: lets this panel detect a session pruned out-of-band
   * by the reconcile poller (e.g. deleted via the TUI) and flip read-only
   * even without a `session.deleted` SSE event. Absent -> detection is
   * skipped. */
  store?: SessionStore;
  directory?: string;
  sessionID?: string;
  /** Bumped on every SSE (re)connect to re-run the backfill, recovering
   * message-part deltas missed during the stream teardown/reopen gap. */
  reconnectNonce?: number;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function TranscriptPanel(
  props: IDockviewPanelProps<TranscriptPanelParams>,
) {
  const { client, demux, store, directory, sessionID, reconnectNonce } =
    props.params;
  const [state, setState] = useState<TranscriptState>(initialTranscriptState());
  const stateRef = useRef(state);
  stateRef.current = state;

  // Incremented at the start of every backfill; `resolveBackfill` discards
  // a resolved result whose generation is stale (superseded by a faster
  // session switch).
  const generationRef = useRef(0);

  const backfill = useCallback(async () => {
    if (!client || !directory || !sessionID) {
      setState(toErrorState("No session selected."));
      return;
    }
    const generation = ++generationRef.current;
    setState(initialTranscriptState());
    const nextState = await resolveBackfill(
      () => client.listMessages(directory, sessionID),
      generation,
      (gen) => gen === generationRef.current,
    );
    if (nextState !== undefined) setState(nextState);
  }, [client, directory, sessionID]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reconnectNonce drives a deliberate re-run, not read in the body
  useEffect(() => {
    void backfill();
  }, [backfill, reconnectNonce]);

  useEffect(() => {
    // Guard against a stale persisted `Demux` (JSON.stringify reduces it to
    // `{}`, which is truthy but has no methods) until live re-injection runs.
    if (!demux || typeof demux.subscribe !== "function" || !sessionID) return;
    const unsubscribe = demux.subscribe(sessionID, (event: SseEvent) => {
      const props = (event.properties ?? {}) as Record<string, unknown>;

      switch (event.type) {
        case "message.part.updated": {
          const update = partUpdateFromEventProperties(props);
          if (!update) return;
          setState((prev) => applyPartUpdate(prev, update));
          return;
        }

        case "question.asked": {
          const requestID = str(props.id);
          if (!requestID) return;
          const questions = props.questions as
            | { question?: string; options?: { label?: string }[] }[]
            | undefined;
          const first = questions?.[0];
          setState((prev) =>
            addPendingQuestion(prev, {
              requestID,
              question: first?.question,
              options:
                first?.options
                  ?.map((o) => o.label)
                  .filter((l): l is string => typeof l === "string") ?? [],
            }),
          );
          return;
        }

        case "question.replied":
        case "question.rejected": {
          const requestID = str(props.requestID) ?? str(props.id);
          if (!requestID) return;
          setState((prev) => removePendingQuestion(prev, requestID));
          return;
        }

        case "session.status": {
          // Secondary confirmation signal; clearing already happens on question.replied.
          return;
        }

        case "session.deleted": {
          setState((prev) => toReadOnly(prev));
          return;
        }

        default:
          return;
      }
    });

    // Defer unsubscribe to a microtask so the new session's subscribe
    // (next effect body) runs before the old one is removed — no tick
    // where switching sessions leaves neither listener registered.
    return () => {
      queueMicrotask(unsubscribe);
    };
  }, [demux, sessionID]);

  // React to the store pruning a session deleted out-of-band, even when no
  // SSE event reaches this panel's own demux subscription.
  useEffect(() => {
    if (!store || typeof store.subscribe !== "function" || !directory) return;
    const check = () => {
      setState((prev) =>
        checkSessionStillTracked(prev, store.getSessions(directory), sessionID),
      );
    };
    check();
    return store.subscribe(check);
  }, [store, directory, sessionID]);

  // Ref-based (not state): scroll position is DOM-owned, transient UI
  // state that shouldn't trigger re-renders.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Cheap signature of rendered content, not `state` wholesale — avoids
  // re-measuring on pendingQuestions-only changes.
  const lastPart = state.parts[state.parts.length - 1];
  const contentSignature = `${state.status}:${state.parts.length}:${lastPart?.text.length ?? 0}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: contentSignature deliberately drives a re-run (like reconnectNonce elsewhere in this file), not read in the body
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (shouldAutoScroll(distanceFromBottom, AUTO_SCROLL_THRESHOLD_PX)) {
      el.scrollTop = el.scrollHeight;
    }
  }, [contentSignature]);

  const submitAnswer = useCallback(
    async (question: PendingQuestionView, label: string) => {
      if (!client || !directory) return;
      setState((prev) => setAnswerSending(prev, question.requestID, label));
      const result = await client.replyQuestion(directory, question.requestID, [
        [label],
      ]);
      if (!result.ok) {
        setState((prev) =>
          setAnswerError(prev, question.requestID, result.error.message),
        );
        return;
      }
      // Optimistic lock clears on the confirming question.replied event above.
    },
    [client, directory],
  );

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        width: "100%",
        background: "var(--color-surface)",
        color: "var(--color-text)",
        fontFamily: "system-ui, sans-serif",
        overflow: "auto",
      }}
    >
      {renderBody(state, submitAnswer, scrollRef)}
    </div>
  );
}

function renderBody(
  state: TranscriptState,
  submitAnswer: (question: PendingQuestionView, label: string) => void,
  scrollRef: React.RefObject<HTMLDivElement | null>,
) {
  if (state.status === "loading") {
    return <StatusMessage tone="muted">Loading transcript…</StatusMessage>;
  }
  if (state.status === "error") {
    return (
      <StatusMessage tone="error">
        {state.message ?? "Failed to load transcript."}
      </StatusMessage>
    );
  }
  if (state.status === "empty") {
    return <StatusMessage tone="muted">No messages yet.</StatusMessage>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1 }}>
      {state.status === "read-only" && (
        <div
          style={{
            padding: "var(--space-1) var(--space-2)",
            background: "var(--color-surface-raised)",
            color: "var(--color-text-muted)",
            fontSize: "var(--text-xs)",
            borderBottom: "1px solid var(--color-border)",
          }}
        >
          Session deleted — showing historical transcript (read-only).
        </div>
      )}
      <div
        ref={scrollRef}
        style={{
          flex: 1,
          overflow: "auto",
          padding: "var(--space-2)",
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-2)",
        }}
      >
        {state.parts.map((part) => (
          <div
            key={part.id}
            style={{
              padding: "var(--space-2)",
              borderRadius: "var(--radius-sm)",
              background: "var(--color-surface-raised)",
              border: "1px solid var(--color-border)",
            }}
          >
            <div
              style={{
                color: "var(--color-text-dim)",
                fontSize: "var(--text-xs)",
                marginBottom: "var(--space-1)",
              }}
            >
              {part.role}
            </div>
            <div
              style={{
                color: "var(--color-text)",
                fontSize: "var(--text-sm)",
                whiteSpace: "pre-wrap",
              }}
            >
              {part.text}
            </div>
          </div>
        ))}
      </div>
      {state.pendingQuestions.length > 0 && state.status !== "read-only" && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "var(--space-2)",
            padding: "var(--space-2)",
            borderTop: "1px solid var(--color-cta)",
          }}
        >
          {state.pendingQuestions.map((q) => (
            <AnswerBox key={q.requestID} question={q} onSubmit={submitAnswer} />
          ))}
        </div>
      )}
    </div>
  );
}

function AnswerBox({
  question,
  onSubmit,
}: {
  question: PendingQuestionView;
  onSubmit: (question: PendingQuestionView, label: string) => void;
}) {
  const sending = question.answerState.status === "sending";

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-1)",
        padding: "var(--space-2)",
        borderRadius: "var(--radius-sm)",
        background: "var(--color-surface-raised)",
        border: "1px solid var(--color-cta)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-1)",
        }}
      >
        <span
          aria-label="needs attention"
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: "var(--color-cta)",
            boxShadow: "0 0 6px var(--color-cta)",
          }}
        />
        <strong
          style={{ color: "var(--color-text)", fontSize: "var(--text-sm)" }}
        >
          {question.question ?? "Blocked on a question"}
        </strong>
      </div>
      <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap" }}>
        {question.options.map((label) => (
          <button
            key={label}
            type="button"
            disabled={sending}
            onClick={() => onSubmit(question, label)}
            style={{
              color: "var(--color-bg)",
              background: "var(--color-accent)",
              border: "none",
              borderRadius: "var(--radius-sm)",
              padding: "var(--space-1) var(--space-3)",
              fontSize: "var(--text-sm)",
              cursor: sending ? "default" : "pointer",
              opacity: sending ? 0.6 : 1,
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {question.answerState.status === "error" && (
        <span
          style={{ color: "var(--color-error)", fontSize: "var(--text-xs)" }}
        >
          {question.answerState.message}
        </span>
      )}
    </div>
  );
}

function StatusMessage({
  tone,
  children,
}: {
  tone: "muted" | "error";
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "var(--space-4)",
        textAlign: "center",
        color:
          tone === "error" ? "var(--color-error)" : "var(--color-text-muted)",
        fontSize: "var(--text-sm)",
      }}
    >
      {children}
    </div>
  );
}
