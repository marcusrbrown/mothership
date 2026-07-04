/**
 * U1.5 prompt bar: plain baseline (textarea) proving the F2 dispatch loop
 * end-to-end. Floats over the dockview shell (mounted by DockviewShell,
 * bottom-center, `position: fixed`) rather than living as a dockview panel
 * per the plan. U1.6 swaps the textarea for Tiptap behind the same
 * `dispatchPrompt`/controller seam — this component's job ends at "submit a
 * string, surface the result."
 *
 * Enter submits; Shift+Enter inserts a newline. On success the input clears
 * and the returned sessionId is retained for follow-up submits (steering
 * into the same control session). On failure the input is preserved for
 * retry and a token-styled error is shown.
 */
import { type KeyboardEvent, useState } from "react";
import type { BusContext } from "../server/types";
import { initialPromptBarState, submitPrompt } from "./controller";

export interface PromptBarProps {
  context?: BusContext;
  /** Fired with the dispatched sessionId after a successful submit — the
   * mount site can use this to select the session in the transcript panel.
   * Kept optional/one-directional so wiring auto-select stays a documented
   * follow-up rather than sprawling this component's scope. */
  onDispatched?: (sessionId: string) => void;
}

export function PromptBar({ context, onDispatched }: PromptBarProps) {
  const [state, setState] = useState(initialPromptBarState());
  const [prompt, setPrompt] = useState("");

  const disabled = state.sending || !context;

  const handleSubmit = async () => {
    if (!context || disabled) return;
    const toSend = prompt;
    const next = await submitPrompt(state, context, toSend);
    setState(next);
    if (!next.error) {
      setPrompt("");
      if (next.sessionId) onDispatched?.(next.sessionId);
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSubmit();
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        bottom: "var(--space-6)",
        left: "50%",
        transform: "translateX(-50%)",
        width: "min(640px, 90vw)",
        zIndex: 900,
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-1)",
      }}
    >
      {state.error && (
        <div
          style={{
            padding: "var(--space-1) var(--space-3)",
            borderRadius: "var(--radius-sm)",
            background: "var(--color-surface-raised)",
            border: "1px solid var(--color-error)",
            color: "var(--color-error)",
            fontSize: "var(--text-xs)",
          }}
        >
          {state.error}
        </div>
      )}
      <div
        style={{
          display: "flex",
          alignItems: "flex-end",
          gap: "var(--space-2)",
          padding: "var(--space-2)",
          borderRadius: "var(--radius-md)",
          background: "var(--color-surface-raised)",
          border: `1px solid ${state.sending ? "var(--color-accent)" : "var(--color-border)"}`,
          boxShadow: state.sending ? "0 0 12px var(--color-accent)" : "none",
        }}
      >
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          placeholder={
            context
              ? "Delegate a task… (Enter to send, Shift+Enter for newline)"
              : "Connecting to workspace…"
          }
          rows={1}
          style={{
            flex: 1,
            resize: "none",
            background: "transparent",
            border: "none",
            outline: "none",
            color: "var(--color-text)",
            fontFamily: "system-ui, sans-serif",
            fontSize: "var(--text-sm)",
            maxHeight: "8rem",
          }}
        />
        <button
          type="button"
          onClick={() => void handleSubmit()}
          disabled={disabled || !prompt.trim()}
          style={{
            color: "var(--color-bg)",
            background: "var(--color-accent)",
            border: "none",
            borderRadius: "var(--radius-sm)",
            padding: "var(--space-2) var(--space-3)",
            fontSize: "var(--text-sm)",
            cursor: disabled || !prompt.trim() ? "default" : "pointer",
            opacity: disabled || !prompt.trim() ? 0.5 : 1,
          }}
        >
          {state.sending ? "Sending…" : "Send"}
        </button>
      </div>
    </div>
  );
}
