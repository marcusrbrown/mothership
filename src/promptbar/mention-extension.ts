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

export function createMentionExtension(getItems: () => MentionItem[]) {
  const suggestion: Partial<SuggestionOptions<MentionItem>> = {
    items: ({ query }) => filterMentionItems(getItems(), query),
    render: () => {
      let component: ReactRenderer<MentionListHandle> | undefined;
      let unmount: (() => void) | undefined;

      return {
        onStart: (props) => {
          component = new ReactRenderer(MentionList, {
            props: { items: props.items, command: props.command },
            editor: props.editor,
          });
          unmount = props.mount(component.element);
        },
        onUpdate: (props) => {
          component?.updateProps({
            items: props.items,
            command: props.command,
          });
        },
        onKeyDown: (props: SuggestionKeyDownProps) => {
          if (props.event.key === "Escape") {
            unmount?.();
            return true;
          }
          return component?.ref?.onKeyDown({ event: props.event }) ?? false;
        },
        onExit: () => {
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
