// Registered `terminal` panel type: xterm 6 + FitAddon + WebglAddon (DOM
// fallback) over the Terminal interface (see terminal-interface.ts). The
// panel is a thin shell — all spawn/write/resize/kill/exit logic lives in
// terminal-controller.ts so it's testable without a DOM.
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { IDockviewPanelProps } from "dockview-react";
import { useEffect, useRef, useState } from "react";
import { tauriTerminal } from "./tauri-terminal";
import {
  type TerminalControllerState,
  createTerminalController,
} from "./terminal-controller";

// Nerd Font stack per the spike finding (docs/solutions/best-practices/
// pty-portable-pty-xterm6-decision-2026-07-04.md) — glyphs render as boxes
// without one. Hardcoded for now; configurable via panel params later.
const FONT_FAMILY =
  "'MesloLGS NF', 'JetBrainsMono Nerd Font', Menlo, monospace";

export interface TerminalPanelParams {
  /** Reserved for future per-panel overrides (font, shell, cwd). */
  cwd?: string;
}

export function TerminalPanel(props: IDockviewPanelProps<TerminalPanelParams>) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<TerminalControllerState>({
    status: "spawning",
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: cwd is a spawn-time param captured at mount, not a live dependency — respawning on cwd change isn't the intended behavior
  useEffect(() => {
    if (!containerRef.current) return;

    const controller = createTerminalController(tauriTerminal);
    const term = new XTerm({
      cursorBlink: true,
      convertEol: true,
      fontFamily: FONT_FAMILY,
      fontSize: 13,
      theme: {
        background: "#16162d",
        foreground: "#ffffff",
        cursorAccent: "#4fd1c5",
        cursor: "#4fd1c5",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);

    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        webgl.dispose();
      });
      term.loadAddon(webgl);
    } catch (err) {
      console.warn(
        "[terminal] WebGL addon failed, falling back to DOM renderer:",
        err,
      );
    }

    fit.fit();

    const unStateSub = controller.onStateChange(setState);
    const unOutputSub = controller.onOutput((chunk) => term.write(chunk));

    const dataDisposable = term.onData((data) => {
      void controller.write(data);
    });

    void controller.spawn(term.cols, term.rows, props.params.cwd);

    const resizeObserver = new ResizeObserver(() => {
      fit.fit();
      void controller.resize(term.cols, term.rows);
    });
    resizeObserver.observe(containerRef.current);

    // Pause rendering while the panel isn't visible; resume + refit on show.
    const visibilityDisposable = props.api.onDidVisibilityChange((event) => {
      if (event.isVisible) {
        fit.fit();
        void controller.resize(term.cols, term.rows);
      }
    });

    return () => {
      unStateSub();
      unOutputSub();
      dataDisposable.dispose();
      visibilityDisposable.dispose();
      resizeObserver.disconnect();
      void controller.dispose();
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.api]);

  const overlay = renderOverlay(state);

  return (
    <div
      style={{
        position: "relative",
        display: "flex",
        flexDirection: "column",
        height: "100%",
        width: "100%",
        background: "var(--color-surface)",
      }}
    >
      {overlay}
      <div ref={containerRef} style={{ flex: 1, minHeight: 0 }} />
    </div>
  );
}

function renderOverlay(state: TerminalControllerState) {
  if (state.status === "running") return null;

  if (state.status === "spawning") {
    return <OverlayMessage tone="muted">Starting shell…</OverlayMessage>;
  }

  if (state.status === "exited") {
    return (
      <OverlayMessage tone="warning">
        Process exited (code: {state.exitInfo.code ?? "unknown"})
      </OverlayMessage>
    );
  }

  return (
    <OverlayMessage tone="error">
      Failed to spawn: {state.message}
    </OverlayMessage>
  );
}

function OverlayMessage({
  tone,
  children,
}: {
  tone: "muted" | "warning" | "error";
  children: React.ReactNode;
}) {
  const color =
    tone === "error"
      ? "var(--color-error)"
      : tone === "warning"
        ? "var(--color-warning)"
        : "var(--color-text-muted)";

  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        zIndex: 1,
        padding: "var(--space-2) var(--space-3)",
        fontFamily: "system-ui, sans-serif",
        fontSize: "var(--text-sm)",
        color,
        background: "var(--color-surface-raised)",
        borderBottom: "1px solid var(--color-border)",
      }}
    >
      {children}
    </div>
  );
}
