/**
 * Suggestion popup rendered by the mention extension's `render()` hooks
 * (see `mention-extension.ts`). Tokens-only styling — cyan
 * `--color-accent`/`--color-border-active` for the selected row, no ad-hoc
 * hex (the design-gate risk this unit calls out). Keyboard nav (up/down/
 * enter) is exposed via `useImperativeHandle` so the ReactRenderer-hosted
 * instance can forward ProseMirror keydown events into this component.
 */
import { forwardRef, useEffect, useImperativeHandle, useState } from "react";
import type { MentionItem } from "./mention-items";

export interface MentionListProps {
  items: MentionItem[];
  command: (item: MentionItem) => void;
}

export interface MentionListHandle {
  onKeyDown: (props: { event: KeyboardEvent }) => boolean;
}

export const MentionList = forwardRef<MentionListHandle, MentionListProps>(
  ({ items, command }, ref) => {
    const [selected, setSelected] = useState(0);

    // biome-ignore lint/correctness/useExhaustiveDependencies: reset selection whenever the item list identity changes (new query results)
    useEffect(() => {
      setSelected(0);
    }, [items]);

    useImperativeHandle(ref, () => ({
      onKeyDown({ event }) {
        if (event.key === "ArrowUp") {
          setSelected(
            (prev) => (prev + items.length - 1) % Math.max(items.length, 1),
          );
          return true;
        }
        if (event.key === "ArrowDown") {
          setSelected((prev) => (prev + 1) % Math.max(items.length, 1));
          return true;
        }
        if (event.key === "Enter") {
          const item = items[selected];
          if (item) command(item);
          return true;
        }
        return false;
      },
    }));

    if (items.length === 0) {
      return (
        <div
          style={{
            padding: "var(--space-2) var(--space-3)",
            background: "var(--color-surface-raised)",
            border: "1px solid var(--color-border)",
            borderRadius: "var(--radius-sm)",
            color: "var(--color-text-muted)",
            fontSize: "var(--text-xs)",
          }}
        >
          No matches
        </div>
      );
    }

    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          background: "var(--color-surface-raised)",
          border: "1px solid var(--color-border)",
          borderRadius: "var(--radius-sm)",
          overflow: "hidden",
          minWidth: "12rem",
        }}
      >
        {items.map((item, index) => (
          <button
            type="button"
            key={item.id}
            onClick={() => command(item)}
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: "var(--space-2)",
              padding: "var(--space-1) var(--space-3)",
              border: "none",
              textAlign: "left",
              cursor: "pointer",
              fontSize: "var(--text-sm)",
              fontFamily: "system-ui, sans-serif",
              background:
                index === selected ? "var(--color-element)" : "transparent",
              color:
                index === selected
                  ? "var(--color-accent-light)"
                  : "var(--color-text)",
              borderLeft:
                index === selected
                  ? "2px solid var(--color-accent)"
                  : "2px solid transparent",
            }}
          >
            <span>{item.label}</span>
            <span
              style={{
                color: "var(--color-text-dim)",
                fontSize: "var(--text-xs)",
              }}
            >
              {item.kind}
            </span>
          </button>
        ))}
      </div>
    );
  },
);
MentionList.displayName = "MentionList";
