import { DockviewReact, type DockviewReadyEvent } from "dockview-react";
/**
 * DockviewReact wrapper: components sourced from the panel registry,
 * onReady constructs the real adapter + wires the executor, themed via
 * mothership-dockview (dockview-theme.css, tokens only). Seeds the default
 * first-open layout (roster left / sessions+transcript tabbed center /
 * terminal bottom / audit-log drawer) with placeholders — saved layout wins.
 */
import { useCallback, useRef } from "react";
import "./dockview-theme.css";
import type { DockviewAdapter } from "./adapter";
import { createDockviewAdapter } from "./dockview-adapter";
import { executeCommand } from "./executor";
import { loadLayout, saveLayout } from "./persistence";
import { panelComponents } from "./registry";

export interface DockviewShellProps {
  /** Absolute workspace path — the persistence key. */
  workspacePath: string;
}

function seedDefaultLayout(adapter: DockviewAdapter): void {
  executeCommand(
    {
      type: "open_panel",
      panelId: "roster",
      panelType: "placeholder",
      params: { panelType: "roster" },
    },
    adapter,
  );
  executeCommand(
    {
      type: "split",
      panelId: "sessions",
      panelType: "placeholder",
      referencePanelId: "roster",
      direction: "right",
      params: { panelType: "sessions" },
    },
    adapter,
  );
  executeCommand(
    {
      type: "split",
      panelId: "transcript",
      panelType: "placeholder",
      referencePanelId: "sessions",
      direction: "right",
      params: { panelType: "transcript" },
    },
    adapter,
  );
  executeCommand(
    {
      type: "split",
      panelId: "terminal",
      panelType: "terminal",
      referencePanelId: "sessions",
      direction: "down",
      params: {},
    },
    adapter,
  );
  executeCommand(
    {
      type: "split",
      panelId: "audit-log",
      panelType: "placeholder",
      referencePanelId: "transcript",
      direction: "down",
      params: { panelType: "audit-log" },
    },
    adapter,
  );
}

export function DockviewShell({ workspacePath }: DockviewShellProps) {
  const adapterRef = useRef<DockviewAdapter | undefined>(undefined);

  const handleReady = useCallback(
    (event: DockviewReadyEvent) => {
      const adapter = createDockviewAdapter(event.api);
      adapterRef.current = adapter;

      const saved = loadLayout(workspacePath);
      if (saved) {
        executeCommand({ type: "set_layout", layout: saved }, adapter);
      } else {
        seedDefaultLayout(adapter);
      }

      event.api.onDidLayoutChange(() => {
        saveLayout(workspacePath, adapter.toJSON());
      });
    },
    [workspacePath],
  );

  return (
    <DockviewReact
      className="mothership-dockview"
      components={panelComponents()}
      onReady={handleReady}
    />
  );
}
