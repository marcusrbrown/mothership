/**
 * Configures `@tiptap/extension-mention` + its `suggestion` plugin against
 * `MentionList` (ReactRenderer-hosted popup) and `filterMentionItems` (pure
 * logic, see mention-items.ts). A factory rather than a static export
 * because `getItems` needs to read the *current* mention item list on every
 * keystroke — items are re-sourced from the live roster/session store each
 * time PromptBar re-renders.
 */
import Mention from "@tiptap/extension-mention";
import { ReactRenderer } from "@tiptap/react";
import type {
  SuggestionKeyDownProps,
  SuggestionOptions,
} from "@tiptap/suggestion";
import type { MentionListHandle } from "./MentionList";
import { MentionList } from "./MentionList";
import { type MentionItem, filterMentionItems } from "./mention-items";

/**
 * The prompt bar container is `position: fixed` at the bottom of the
 * viewport with `zIndex: 900` (see PromptBar.tsx). Tiptap's default
 * suggestion mount point sits inside the editor DOM near the caret, which
 * is at the BOTTOM of that fixed bar — there's no room below it, so the
 * popup gets clipped by the viewport edge and sits at/under the bar's
 * stacking context. Mounting to `document.body` with an explicit
 * `position: fixed` + high z-index and flipping the popup ABOVE the caret
 * (rather than relying on default below-caret placement) fixes both the
 * clipping and the stacking-order problem in one move.
 */
const MENTION_POPUP_Z_INDEX = 1200; // > PromptBar's fixed container (900)

function positionAboveCaret(
  element: HTMLElement,
  clientRect: (() => DOMRect | null) | null | undefined,
) {
  const rect = clientRect?.();
  element.style.position = "fixed";
  element.style.zIndex = String(MENTION_POPUP_Z_INDEX);
  element.style.maxHeight = "16rem";
  element.style.overflowY = "auto";
  if (rect) {
    // Anchor the popup's bottom edge just above the caret's top edge, and
    // its left edge at the caret's left edge — i.e. flip above, since the
    // caret always lives near the bottom of the fixed prompt bar and there
    // is no room to render below it.
    element.style.left = `${rect.left}px`;
    element.style.bottom = `${window.innerHeight - rect.top}px`;
    element.style.top = "";
  }
}

export function createMentionExtension(
  getItems: () => MentionItem[],
  setMentionActive?: (active: boolean) => void,
) {
  const suggestion: Partial<SuggestionOptions<MentionItem>> = {
    items: ({ query }) => filterMentionItems(getItems(), query),
    render: () => {
      let component: ReactRenderer<MentionListHandle> | undefined;
      let unmount: (() => void) | undefined;

      return {
        onStart: (props) => {
          setMentionActive?.(true);
          component = new ReactRenderer(MentionList, {
            props: { items: props.items, command: props.command },
            editor: props.editor,
          });
          // Mount to document.body (not props.mount, which attaches inside
          // the editor DOM / prompt bar's stacking context) so the popup
          // escapes the prompt bar's z-index and can be positioned above it.
          document.body.appendChild(component.element);
          positionAboveCaret(component.element, props.clientRect);
          unmount = () => {
            component?.element.remove();
          };
        },
        onUpdate: (props) => {
          component?.updateProps({
            items: props.items,
            command: props.command,
          });
          if (component)
            positionAboveCaret(component.element, props.clientRect);
        },
        onKeyDown: (props: SuggestionKeyDownProps) => {
          if (props.event.key === "Escape") {
            unmount?.();
            setMentionActive?.(false);
            return true;
          }
          return component?.ref?.onKeyDown({ event: props.event }) ?? false;
        },
        onExit: () => {
          setMentionActive?.(false);
          unmount?.();
          component?.destroy();
        },
      };
    },
    command: ({ editor, range, props }) => {
      editor
        .chain()
        .focus()
        .insertContentAt(range, [
          {
            type: "mention",
            attrs: { id: props.id, label: props.label },
          },
          { type: "text", text: " " },
        ])
        .run();
    },
  };

  return Mention.configure({
    suggestion,
  });
}
