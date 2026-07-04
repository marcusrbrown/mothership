import type { IDockviewPanelProps } from "dockview-react";
/**
 * Panel registry: panel-type key → {component, title, defaults}. One directory
 * per panel type, deletable in one commit (design-for-deletion). Every panel
 * must define loading/empty/error states styled from tokens — enforced by
 * convention here; real panels wire theirs in per-type.
 */
import type { FunctionComponent } from "react";

export interface PanelRegistration {
  /** React component rendered as the panel body. */
  component: FunctionComponent<IDockviewPanelProps>;
  /** Default tab title when a command omits one. */
  title: string;
  /**
   * Whether an `mcp_tool`-origin command may open this panel type. Defaults
   * to `true` when omitted — panel types must opt OUT explicitly (e.g.
   * terminal, which mounts a real shell via pty_spawn). UI-origin commands
   * are never gated by this flag. Enforced in `executor.ts`.
   */
  mcpOpenable?: boolean;
}

const registry = new Map<string, PanelRegistration>();

export function registerPanelType(
  type: string,
  registration: PanelRegistration,
): void {
  registry.set(type, registration);
}

/** Whether `type` may be opened by an `mcp_tool`-origin command. Unknown
 * types are treated as not openable (fails closed); registered types
 * default to openable unless `mcpOpenable: false` is set explicitly. */
export function isMcpOpenable(type: string): boolean {
  const reg = registry.get(type);
  if (!reg) return false;
  return reg.mcpOpenable ?? true;
}

export function getPanelType(type: string): PanelRegistration | undefined {
  return registry.get(type);
}

export function hasPanelType(type: string): boolean {
  return registry.has(type);
}

export function listPanelTypes(): string[] {
  return [...registry.keys()];
}

/** Components map shape DockviewReact expects — derived from the registry. */
export function panelComponents(): Record<
  string,
  FunctionComponent<IDockviewPanelProps>
> {
  const out: Record<string, FunctionComponent<IDockviewPanelProps>> = {};
  for (const [type, reg] of registry) {
    out[type] = reg.component;
  }
  return out;
}

/** Test/dev helper — registries are process-wide singletons otherwise. */
export function __resetRegistryForTests(): void {
  registry.clear();
}
