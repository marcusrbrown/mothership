/**
 * Disclosure-boundary enforcement for `ide_*` read tools (U1.7). The
 * serialized layout can carry absolute filesystem paths in panel params
 * (project directories, workspace paths). Read tools may only surface:
 * panel types, panel titles, project names, session titles — nothing else.
 * This is a defense-in-depth string scrub, not a schema allowlist, because
 * the serialized layout shape is intentionally opaque (`SerializedLayout =
 * Record<string, unknown>`) at this layer.
 */

const ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|\/)[^\n]*$/;

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? path;
}

function redactValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "string") {
    return ABSOLUTE_PATH.test(value) ? basename(value) : value;
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactValue(v, seen));
  }
  if (value && typeof value === "object") {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      // Live handles (client/demux/store/onSelectProject) never survive
      // JSON serialization from the webview anyway, but drop them
      // defensively if they somehow arrive as non-JSON-safe markers.
      if (
        k === "client" ||
        k === "demux" ||
        k === "store" ||
        k === "onSelectProject"
      ) {
        continue;
      }
      out[k] = redactValue(v, seen);
    }
    return out;
  }
  return value;
}

/** Redacts absolute filesystem paths to basenames throughout a serialized
 * layout (or any JSON-safe value), and drops known non-serializable live
 * handle keys defensively. */
export function redactForRead<T>(value: T): T {
  return redactValue(value, new WeakSet()) as T;
}
