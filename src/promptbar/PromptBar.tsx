import { EditorContent, useEditor } from "@tiptap/react";
/**
 * U1.6 prompt bar: Tiptap editor (starter-kit + mention) replacing U1.5's
 * plain textarea, behind the SAME `submitPrompt`/`dispatchPrompt` seam —
 * this component's job is still "produce a string, surface the result."
 * Floats over the dockview shell (mounted by DockviewShell, bottom-center,
 * `position: fixed`).
 *
 * Enter submits; Shift+Enter (or Mod/Ctrl+Enter) inserts a newline — see
 * `keymap.ts` for the pure decision logic this wires into a ProseMirror
 * keyboard shortcut. Submit reads `editor.getJSON()` and serializes it to
 * plain text via `serializeDocToText` (mention nodes → `@label`); on
 * success the editor clears and the returned sessionId is retained for
 * follow-ups. On failure the doc is preserved for retry and a token-styled
 * error is shown, matching U1.5 exactly.
 *
 * @-mentions source from the workspace roster (`context.roster.projects`)
 * always, and from the live session store when `store`/`directory` are
 * threaded in from the mount site (DockviewShell) — see mention-items.ts.
 * A mention of a project/session that has since disappeared from the
 * roster/store degrades to plain `@label` text (the mention node keeps
 * whatever label it was given at insertion time); it never blocks dispatch.
 */
import StarterKit from "@tiptap/starter-kit";
import { useMemo, useState } from "react";
import type { SessionStore } from "../server/session-store";
import type { BusContext } from "../server/types";
import { initialPromptBarState, submitPrompt } from "./controller";
import { decideEnterAction } from "./keymap";
import { createMentionExtension } from "./mention-extension";
import { buildMentionItems } from "./mention-items";
import type { JSONDoc } from "./serialize";
import { serializeDocToText } from "./serialize";

export interface PromptBarProps {
  context?: BusContext;
  /** Optional live session store + directory — sources @-session mentions
   * alongside @-project mentions. Absent → @-project mentions only (no
   * error, documented degradation). */
  store?: SessionStore;
  directory?: string;
  /** Fired with the dispatched sessionId after a successful submit — the
   * mount site can use this to select the session in the transcript panel. */
  onDispatched?: (sessionId: string) => void;
}

export function PromptBar({
  context,
  store,
  directory,
  onDispatched,
}: PromptBarProps) {
  const [state, setState] = useState(initialPromptBarState());

  const disabled = state.sending || !context;

  const mentionExtension = useMemo(
    () =>
      createMentionExtension(() =>
        buildMentionItems(context, store, directory),
      ),
    [context, store, directory],
  );

  const editor = useEditor({
    extensions: [StarterKit.configure({ hardBreak: false }), mentionExtension],
    editorProps: {
      handleKeyDown: (_view, event) => {
        const action = decideEnterAction({
          key: event.key,
          shiftKey: event.shiftKey,
          metaKey: event.metaKey,
          ctrlKey: event.ctrlKey,
          altKey: event.altKey,
        });
        if (action === "submit") {
          event.preventDefault();
          void handleSubmit();
          return true;
        }
        if (action === "newline") {
          return false; // let the default hard-break/newline behavior run
        }
        return false;
      },
    },
    editable: !disabled,
  });

  const handleSubmit = async () => {
    if (!context || !editor || disabled) return;
    const doc = editor.getJSON() as JSONDoc;
    const toSend = serializeDocToText(doc);
    if (!toSend.trim()) return;
    const next = await submitPrompt(state, context, toSend);
    setState(next);
    if (!next.error) {
      editor.commands.clearContent();
      if (next.sessionId) onDispatched?.(next.sessionId);
    }
  };

  const isEmpty = editor?.isEmpty ?? true;

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
        <div
          style={{
            position: "relative",
            flex: 1,
            color: "var(--color-text)",
            fontFamily: "system-ui, sans-serif",
            fontSize: "var(--text-sm)",
            maxHeight: "8rem",
            overflowY: "auto",
          }}
        >
          <EditorContent editor={editor} />
          {isEmpty && (
            <div
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                color: "var(--color-text-dim)",
                pointerEvents: "none",
              }}
            >
              {context
                ? "Delegate a task… (@ to mention, Enter to send, Shift+Enter for newline)"
                : "Connecting to workspace…"}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={() => void handleSubmit()}
          disabled={disabled || isEmpty}
          style={{
            color: "var(--color-bg)",
            background: "var(--color-accent)",
            border: "none",
            borderRadius: "var(--radius-sm)",
            padding: "var(--space-2) var(--space-3)",
            fontSize: "var(--text-sm)",
            cursor: disabled || isEmpty ? "default" : "pointer",
            opacity: disabled || isEmpty ? 0.5 : 1,
          }}
        >
          {state.sending ? "Sending…" : "Send"}
        </button>
      </div>
    </div>
  );
}
