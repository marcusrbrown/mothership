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
}

const registry = new Map<string, PanelRegistration>();

export function registerPanelType(
  type: string,
  registration: PanelRegistration,
): void {
  registry.set(type, registration);
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
