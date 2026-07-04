/**
 * Pure doc → plain-text serialization for the Tiptap editor (U1.6). Operates
 * on Tiptap's plain-JSON `JSONContent` shape (from `editor.getJSON()`) so it
 * needs no DOM and is directly unit-testable.
 *
 * Mention nodes serialize to `@label` regardless of whether the mentioned
 * project/session still exists — degradation to plain `@text` is the mention
 * node's job at insertion time (see `toMentionAttrs`), not this function's;
 * by the time a doc reaches here every mention node already carries the
 * label it should render.
 */

export interface MentionNodeAttrs {
  id?: string | null;
  label?: string | null;
}

export interface JSONNode {
  type?: string;
  text?: string;
  attrs?: MentionNodeAttrs;
  content?: JSONNode[];
}

export interface JSONDoc {
  type?: string;
  content?: JSONNode[];
}

function serializeNode(node: JSONNode): string {
  if (node.type === "text") return node.text ?? "";
  if (node.type === "mention") {
    const label = node.attrs?.label ?? node.attrs?.id ?? "";
    return `@${label}`;
  }
  if (node.type === "hardBreak") return "\n";
  return (node.content ?? []).map(serializeNode).join("");
}

/**
 * Serializes a Tiptap doc to plain text. Block nodes (paragraphs, etc.) are
 * joined with newlines; inline content within a block is concatenated.
 * Trailing/leading blank blocks are trimmed from the result (mirrors the
 * plain-textarea's `.trim()` submit behavior).
 */
export function serializeDocToText(doc: JSONDoc): string {
  const blocks = doc.content ?? [];
  const lines = blocks.map(serializeNode);
  return lines.join("\n").replace(/\n+$/, "").replace(/^\n+/, "");
}
