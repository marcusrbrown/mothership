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
import type { SseEvent } from "../../server/types";
import {
  type PendingQuestionView,
  type TranscriptState,
  addPendingQuestion,
  applyPartUpdate,
  fromBackfill,
  initialTranscriptState,
  removePendingQuestion,
  setAnswerError,
  setAnswerSending,
  toErrorState,
  toReadOnly,
} from "./transcript-view";

export interface TranscriptPanelParams {
  client?: OpencodeClient;
  demux?: Demux;
  directory?: string;
  sessionID?: string;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function TranscriptPanel(
  props: IDockviewPanelProps<TranscriptPanelParams>,
) {
  const { client, demux, directory, sessionID } = props.params;
  const [state, setState] = useState<TranscriptState>(initialTranscriptState());
  const stateRef = useRef(state);
  stateRef.current = state;

  const backfill = useCallback(async () => {
    if (!client || !directory || !sessionID) {
      setState(toErrorState("No session selected."));
      return;
    }
    setState(initialTranscriptState());
    const result = await client.listMessages(directory, sessionID);
    if (!result.ok) {
      setState(toErrorState(result.error.message));
      return;
    }
    setState(fromBackfill(result.value));
  }, [client, directory, sessionID]);

  useEffect(() => {
    void backfill();
  }, [backfill]);

  useEffect(() => {
    if (!demux || !sessionID) return;
    const unsubscribe = demux.subscribe(sessionID, (event: SseEvent) => {
      const props = (event.properties ?? {}) as Record<string, unknown>;

      switch (event.type) {
        case "message.part.updated": {
          const partId = str(props.partId) ?? str(props.id);
          const type = str(props.type) ?? "text";
          const role = str(props.role) ?? "assistant";
          if (!partId) return;
          setState((prev) =>
            applyPartUpdate(prev, {
              partId,
              role,
              type,
              text: str(props.text),
              delta: str(props.delta),
            }),
          );
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
          // Confirms an unblock — clearing is already handled by
          // question.replied; session.status is a secondary confirmation
          // signal for the optimistic-lock state machine (no-op here since
          // removePendingQuestion already ran on question.replied).
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
    return unsubscribe;
  }, [demux, sessionID]);

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
      // Optimistic lock clears on the confirming question.replied event
      // (demux subscription above) — no direct mutation here, matching the
      // "wait for the event" requirement.
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
      {renderBody(state, submitAnswer)}
    </div>
  );
}

function renderBody(
  state: TranscriptState,
  submitAnswer: (question: PendingQuestionView, label: string) => void,
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
