/**
 * Disclosure-boundary enforcement for `ide_*` read tools. Panel
 * `params` can carry arbitrary webview state — including credentials,
 * tokens, and absolute filesystem paths (project directories, workspace
 * paths) — because `params` is opaque to this layer (`SerializedLayout =
 * Record<string, unknown>`).
 *
 * This is an ALLOWLIST serializer, not a denylist scrubber: read tools may
 * only surface panel ids, panel types, panel titles, and layout
 * structure/ordering — nothing from `params` ever passes through by
 * default. A denylist backstop (`stripSecretKeys`) runs on whatever the
 * allowlist does admit, as defense-in-depth, but the allowlist above it is
 * the actual gate.
 */

const SECRET_KEY = /credential|password|token|secret|authorization/i;

/** Recursive denylist backstop: drops any key whose name looks like a
 * secret, anywhere in the structure. Defense-in-depth only — the allowlist
 * serializers below are the primary boundary. */
function stripSecretKeys(value: unknown, seen: WeakSet<object>): unknown {
  if (Array.isArray(value)) {
    return value.map((v) => stripSecretKeys(v, seen));
  }
  if (value && typeof value === "object") {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEY.test(k)) continue;
      out[k] = stripSecretKeys(v, seen);
    }
    return out;
  }
  return value;
}

interface RawPanelState {
  id?: unknown;
  contentComponent?: unknown;
  title?: unknown;
}

function rawPanels(layout: unknown): Record<string, RawPanelState> {
  const panels = (layout as { panels?: unknown } | undefined)?.panels;
  if (!panels || typeof panels !== "object") return {};
  return panels as Record<string, RawPanelState>;
}

export interface PanelSummary {
  id: string;
  panelType: string;
  title: string | undefined;
}

/** `ide_list_panels` view: id/panelType/title only, no params, no
 * layout geometry. */
export function listPanelsView(layout: unknown): PanelSummary[] {
  const panels = rawPanels(layout);
  return Object.entries(panels).map(([fallbackId, p]) => ({
    id: typeof p.id === "string" ? p.id : fallbackId,
    panelType:
      typeof p.contentComponent === "string" ? p.contentComponent : "unknown",
    title: typeof p.title === "string" ? p.title : undefined,
  }));
}

/** Allowlisted panel entry for the `ide_get_layout` structure view — every
 * field here is safe for agent consumption; `params` is never included. */
interface SafePanelEntry {
  id: string;
  panelType: string;
  title: string | undefined;
}

/** `ide_get_layout` view: the grid/group tree (ordering/positioning) plus,
 * per panel, only {id, panelType, title}. All `params` are dropped —
 * there is no safe per-field allowlist into `params` today (project
 * display name / session title are surfaced via `title`, not `params`,
 * in the current panel set). A denylist backstop still runs over the
 * result in case a future field slips through. */
export function layoutStructureView(layout: unknown): Record<string, unknown> {
  const raw = (layout ?? {}) as Record<string, unknown>;
  const panels = rawPanels(raw);

  const safePanels: Record<string, SafePanelEntry> = {};
  for (const [id, p] of Object.entries(panels)) {
    safePanels[id] = {
      id: typeof p.id === "string" ? p.id : id,
      panelType:
        typeof p.contentComponent === "string" ? p.contentComponent : "unknown",
      title: typeof p.title === "string" ? p.title : undefined,
    };
  }

  const out: Record<string, unknown> = { panels: safePanels };
  if ("grid" in raw) out.grid = raw.grid;
  if ("activeGroup" in raw) out.activeGroup = raw.activeGroup;
  if ("floatingGroups" in raw) out.floatingGroups = raw.floatingGroups;
  if ("popoutGroups" in raw) out.popoutGroups = raw.popoutGroups;
  if ("edgeGroups" in raw) out.edgeGroups = raw.edgeGroups;

  return stripSecretKeys(out, new WeakSet()) as Record<string, unknown>;
}
