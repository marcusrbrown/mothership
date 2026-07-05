/**
 * Stub DockviewAdapter for pure-logic executor tests — no DOM, no dockview-core.
 * Test-only module (not exported from index.ts).
 */
import type {
  AdapterPanelInfo,
  AddPanelSpec,
  DockviewAdapter,
  MovePanelSpec,
} from "./adapter";
import type { SerializedLayout } from "./commands";

interface StubPanel {
  id: string;
  panelType: string;
  title?: string;
  params?: Record<string, unknown>;
  groupId: string;
}

interface StubGroup {
  id: string;
  panelIds: string[];
}

let groupCounter = 0;

export class StubDockviewAdapter implements DockviewAdapter {
  private panelMap = new Map<string, StubPanel>();
  private groupMap = new Map<string, StubGroup>();
  private activeId: string | undefined;
  readonly calls: { method: string; args: unknown[] }[] = [];

  get panels(): AdapterPanelInfo[] {
    return [...this.panelMap.values()].map((p) => ({
      id: p.id,
      panelType: p.panelType,
    }));
  }

  get activePanel(): AdapterPanelInfo | undefined {
    if (!this.activeId) return undefined;
    const p = this.panelMap.get(this.activeId);
    return p ? { id: p.id, panelType: p.panelType } : undefined;
  }

  hasPanel(id: string): boolean {
    return this.panelMap.has(id);
  }

  addPanel(spec: AddPanelSpec): void {
    this.calls.push({ method: "addPanel", args: [spec] });
    let groupId: string;
    if (spec.position) {
      const refGroupId = this.panelMap.get(
        spec.position.referencePanelId,
      )?.groupId;
      groupId = refGroupId ?? `group-${groupCounter++}`;
      if (!this.groupMap.has(groupId)) {
        this.groupMap.set(groupId, { id: groupId, panelIds: [] });
      }
    } else {
      groupId = `group-${groupCounter++}`;
      this.groupMap.set(groupId, { id: groupId, panelIds: [] });
    }
    this.panelMap.set(spec.id, {
      id: spec.id,
      panelType: spec.panelType,
      title: spec.title,
      params: spec.params,
      groupId,
    });
    this.groupMap.get(groupId)?.panelIds.push(spec.id);
    this.activeId = spec.id;
  }

  removePanel(id: string): void {
    this.calls.push({ method: "removePanel", args: [id] });
    const panel = this.panelMap.get(id);
    if (panel) {
      const group = this.groupMap.get(panel.groupId);
      if (group) {
        group.panelIds = group.panelIds.filter((pid) => pid !== id);
        if (group.panelIds.length === 0) this.groupMap.delete(panel.groupId);
      }
    }
    this.panelMap.delete(id);
    if (this.activeId === id) this.activeId = undefined;
  }

  movePanel(spec: MovePanelSpec): void {
    this.calls.push({ method: "movePanel", args: [spec] });
    const panel = this.panelMap.get(spec.id);
    const refPanel = this.panelMap.get(spec.referencePanelId);
    if (panel && refPanel) {
      const oldGroup = this.groupMap.get(panel.groupId);
      if (oldGroup)
        oldGroup.panelIds = oldGroup.panelIds.filter((pid) => pid !== panel.id);
      panel.groupId = refPanel.groupId;
      this.groupMap.get(refPanel.groupId)?.panelIds.push(panel.id);
    }
  }

  focus(id: string): void {
    this.calls.push({ method: "focus", args: [id] });
    this.activeId = id;
  }

  toJSON(): SerializedLayout {
    return {
      panels: Object.fromEntries(
        [...this.panelMap.values()].map((p) => [
          p.id,
          {
            id: p.id,
            panelType: p.panelType,
            title: p.title,
            params: p.params,
            groupId: p.groupId,
          },
        ]),
      ),
      groups: Object.fromEntries(
        [...this.groupMap.values()].map((g) => [
          g.id,
          { id: g.id, panelIds: g.panelIds },
        ]),
      ),
      activePanel: this.activeId,
    };
  }

  fromJSON(layout: SerializedLayout): void {
    this.calls.push({ method: "fromJSON", args: [layout] });
    this.panelMap.clear();
    this.groupMap.clear();
    const panels =
      (layout as { panels?: Record<string, unknown> }).panels ?? {};
    const groups =
      (
        layout as {
          groups?: Record<string, { id: string; panelIds: string[] }>;
        }
      ).groups ?? {};
    for (const [gid, g] of Object.entries(groups)) {
      this.groupMap.set(gid, { id: gid, panelIds: [...g.panelIds] });
    }
    for (const [pid, raw] of Object.entries(panels)) {
      const p = raw as {
        id: string;
        panelType: string;
        title?: string;
        params?: Record<string, unknown>;
        groupId: string;
      };
      this.panelMap.set(pid, p);
    }
    const active = (layout as { activePanel?: string }).activePanel;
    this.activeId = active;
  }
}
