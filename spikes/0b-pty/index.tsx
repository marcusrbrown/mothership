// Spike 0b (U0.3): xterm 6 + portable-pty over Tauri events.
// The component only talks to the `Terminal` interface — swap
// `tauriTerminal` for another implementation and nothing else here changes.
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import React, { useEffect, useRef, useState } from "react";
import type { Terminal } from "./terminal-interface";
import { tauriTerminal } from "./tauri-terminal";

const backend: Terminal = tauriTerminal;

export default function Spike0bPty() {
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const unsubsRef = useRef<Array<() => void>>([]);

  const [renderer, setRenderer] = useState<string>("initializing…");
  const [status, setStatus] = useState<string>("not spawned");
  const [throughputResult, setThroughputResult] = useState<string>("");

  async function teardownSession() {
    for (const unsub of unsubsRef.current) unsub();
    unsubsRef.current = [];
    if (sessionIdRef.current) {
      await backend.kill(sessionIdRef.current);
      sessionIdRef.current = null;
    }
  }

  async function spawnSession() {
    await teardownSession();
    const term = xtermRef.current;
    if (!term) return;
    term.reset();
    const { cols, rows } = term;
    const sessionId = await backend.spawn(cols, rows);
    sessionIdRef.current = sessionId;
    setStatus(`running: ${sessionId}`);

    const unData = await backend.onData(sessionId, (chunk) => {
      term.write(chunk);
    });
    const unExit = await backend.onExit(sessionId, (info) => {
      setStatus(`exited (code: ${info.code ?? "unknown"})`);
      term.write(`\r\n\x1b[33m[process exited]\x1b[0m\r\n`);
    });
    unsubsRef.current = [unData, unExit];
  }

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new XTerm({
      cursorBlink: true,
      convertEol: true,
      fontFamily: "monospace",
      fontSize: 13,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);

    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        setRenderer("dom (webgl context lost)");
        webgl.dispose();
      });
      term.loadAddon(webgl);
      setRenderer("webgl");
    } catch (err) {
      console.warn("[spike-0b] WebGL addon failed, falling back to DOM renderer:", err);
      setRenderer("dom (fallback)");
    }

    fit.fit();
    xtermRef.current = term;
    fitRef.current = fit;

    term.onData((data) => {
      if (sessionIdRef.current) void backend.write(sessionIdRef.current, data);
    });

    const resizeObserver = new ResizeObserver(() => {
      fit.fit();
      if (sessionIdRef.current) {
        void backend.resize(sessionIdRef.current, term.cols, term.rows);
      }
    });
    resizeObserver.observe(containerRef.current);

    void spawnSession();

    return () => {
      resizeObserver.disconnect();
      void teardownSession();
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function runThroughputTest() {
    const sessionId = sessionIdRef.current;
    if (!sessionId) return;
    setThroughputResult("running…");
    const start = performance.now();
    await backend.write(sessionId, "time seq 1 200000 > /dev/null\n");
    // Spike-grade: poll for the shell prompt to return rather than parsing
    // `time` output structurally — good enough to eyeball wall-clock and
    // watch xterm for dropped-frame / stutter impressions.
    setTimeout(() => {
      const elapsed = ((performance.now() - start) / 1000).toFixed(2);
      setThroughputResult(
        `kicked off ~${elapsed}s ago — see terminal for shell's own \`time\` output and note whether scrolling stuttered while it ran`,
      );
    }, 3000);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", background: "#1e1e1e" }}>
      <div style={{ padding: "8px", color: "#ddd", fontFamily: "monospace", fontSize: 12, display: "flex", gap: 12, alignItems: "center" }}>
        <strong>Spike 0b: PTY</strong>
        <span>renderer: {renderer}</span>
        <span>status: {status}</span>
        <button type="button" onClick={() => void spawnSession()}>respawn</button>
        <button type="button" onClick={() => sessionIdRef.current && void backend.kill(sessionIdRef.current)}>
          kill
        </button>
        <button type="button" onClick={() => void runThroughputTest()}>throughput test (seq 1 200000)</button>
        {throughputResult && <span>{throughputResult}</span>}
      </div>
      <div ref={containerRef} style={{ flex: 1, minHeight: 0 }} />
    </div>
  );
}
