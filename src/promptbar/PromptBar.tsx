import { EditorContent, useEditor } from "@tiptap/react";
/**
 * Prompt bar: Tiptap editor (starter-kit + mention) over the
 * `submitPrompt`/`dispatchPrompt` seam — this component's job is still
 * "produce a string, surface the result."
 * Floats over the dockview shell (mounted by DockviewShell, bottom-center,
 * `position: fixed`).
 *
 * Enter submits; Shift+Enter (or Mod/Ctrl+Enter) inserts a newline — see
 * `keymap.ts` for the pure decision logic this wires into a ProseMirror
 * keyboard shortcut. Submit reads `editor.getJSON()` and serializes it to
 * plain text via `serializeDocToText` (mention nodes → `@label`); on
 * success the editor clears and the returned sessionId is retained for
 * follow-ups. On failure the doc is preserved for retry and a token-styled
 * error is shown.
 *
 * @-mentions source from the workspace roster (`context.roster.projects`)
 * always, and from the live session store when `store`/`directory` are
 * threaded in from the mount site (DockviewShell) — see mention-items.ts.
 * A mention of a project/session that has since disappeared from the
 * roster/store degrades to plain `@label` text (the mention node keeps
 * whatever label it was given at insertion time); it never blocks dispatch.
 */
import StarterKit from "@tiptap/starter-kit";
import { useEffect, useMemo, useRef, useState } from "react";
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
  /** Fired with the dispatched sessionId (and the DIRECTORY of the project
   * it was dispatched to) after a successful submit — the mount site uses
   * both to point the transcript panel at the right session AND the right
   * directory (bug 4: without directory, backfill targets whatever
   * directory the transcript panel already had, which may not be the
   * dispatched project's). */
  onDispatched?: (sessionId: string, directory: string) => void;
}

/** Finds the first mention node in the doc whose id/label matches a roster
 * project name (bug-2 fix routing seam). Returns undefined if there's no
 * mention or none of them name a real project — `dispatchPrompt` falls
 * back to the default project in that case. */
function firstMentionedProject(
  doc: JSONDoc,
  context: BusContext,
): string | undefined {
  const projectNames = new Set(context.roster.projects.map((p) => p.name));

  function walk(nodes: JSONDoc["content"]): string | undefined {
    for (const node of nodes ?? []) {
      if (node.type === "mention") {
        const candidate = node.attrs?.id ?? node.attrs?.label;
        if (candidate && projectNames.has(candidate)) return candidate;
      }
      const found = walk(node.content);
      if (found) return found;
    }
    return undefined;
  }

  return walk(doc.content);
}

export function PromptBar({
  context,
  store,
  directory,
  onDispatched,
}: PromptBarProps) {
  const [state, setState] = useState(initialPromptBarState());

  const disabled = state.sending || !context;

  // `useEditor`'s `editorProps.handleKeyDown` is created once at editor init
  // (when `editor` is still null), so it must never call `handleSubmit`
  // directly — that would capture a stale closure where `editor` is always
  // null and every submit is silently swallowed. Route through a ref that
  // is updated on every render so the keydown handler always invokes the
  // CURRENT submit closure (current `editor`/`context`/`state`).
  const submitRef = useRef<() => void>(() => {});

  // While the @mention suggestion popup is open, Enter must
  // pick the highlighted item, not submit the prompt. `handleKeyDown`
  // below is a single ProseMirror-level interceptor that runs for every
  // keystroke, so it needs to know "is the popup currently open" to defer
  // to the suggestion's own Enter/Arrow/Escape handling instead of
  // hijacking Enter for submit. Threaded into the mention extension's
  // onStart/onExit (mention-extension.ts) via `setMentionActive`, mirroring
  // how `getItems` is already threaded through the factory.
  const mentionActiveRef = useRef(false);

  const mentionExtension = useMemo(
    () =>
      createMentionExtension(
        () => buildMentionItems(context, store, directory),
        (active) => {
          mentionActiveRef.current = active;
        },
      ),
    [context, store, directory],
  );

  const editor = useEditor({
    // StarterKit's hardBreak node is required for Shift+Enter to insert a
    // newline; disabling it (as the previous code did) left Shift+Enter
    // with nothing to insert, so it fell through to the stale submit path.
    extensions: [StarterKit, mentionExtension],
    editorProps: {
      handleKeyDown: (_view, event) => {
        // The mention suggestion plugin needs first crack at
        // Enter/Arrows/Escape while its popup is open — returning `false`
        // here lets ProseMirror fall through to the suggestion plugin's own
        // keydown handler (mention-extension.ts's onKeyDown) instead of
        // this handler submitting the raw "@d" text.
        if (mentionActiveRef.current) return false;
        const action = decideEnterAction({
          key: event.key,
          shiftKey: event.shiftKey,
          metaKey: event.metaKey,
          ctrlKey: event.ctrlKey,
          altKey: event.altKey,
        });
        if (action === "submit") {
          event.preventDefault();
          submitRef.current();
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
    // Route a new-session dispatch to the prompt's first
    // @-project mention when present (and it names a real roster
    // project — dispatchPrompt falls back to the default otherwise). The
    // full prompt text (including the leading "@label") is still sent to
    // the agent; the mention here is used ONLY for routing.
    const project = firstMentionedProject(doc, context);
    const next = await submitPrompt(state, context, toSend, {}, project);
    setState(next);
    if (!next.error) {
      editor.commands.clearContent();
      editor.commands.focus();
      if (next.sessionId) {
        // Resolve the DIRECTORY of the project this actually
        // dispatched to (the @-mentioned project when present and valid,
        // else the workspace's default first project — mirrors
        // dispatchPrompt's own fallback in dispatch.ts) so the mount site
        // can point the transcript panel at both the right session AND the
        // right directory, not just the session id.
        const targetProjectName = project ?? context.roster.projects[0]?.name;
        const targetDirectory = context.roster.projects.find(
          (p) => p.name === targetProjectName,
        )?.expandedPath;
        if (targetDirectory) {
          onDispatched?.(next.sessionId, targetDirectory);
        }
      }
    }
  };

  // Keep the ref pointing at the latest closure every render — this is what
  // makes the editorProps.handleKeyDown (created once, at init) call live
  // code instead of the first-render closure it was created with.
  useEffect(() => {
    submitRef.current = () => {
      void handleSubmit();
    };
  });

  // Tiptap editor content changes do NOT trigger React
  // re-renders on their own — `editor?.isEmpty` read during render stays
  // stuck at whatever it was on first mount (true), so the Send button
  // never enabled after typing. Subscribing to the editor's `update` event
  // and mirroring emptiness into React state makes it reactive.
  const [isEmpty, setIsEmpty] = useState(true);
  useEffect(() => {
    if (!editor) return;
    setIsEmpty(editor.isEmpty);
    const onUpdate = () => setIsEmpty(editor.isEmpty);
    editor.on("update", onUpdate);
    return () => {
      editor.off("update", onUpdate);
    };
  }, [editor]);

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
