import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles/tokens.css";

// Spike harness: `bun run dev` + ?spike=<id> mounts spikes/<id>-*/index.tsx
// in the real shell (HANDOFF Phase 0). No spike code ships in the app path.
const spikeId = new URLSearchParams(window.location.search).get("spike");

// Tauri ships no reload accelerator; dev-only Cmd+R so spike hopping
// doesn't require quit/relaunch.
if (import.meta.env.DEV) {
  window.addEventListener("keydown", (e) => {
    // assign(href) instead of reload(): WKWebView reload drops the query
    // string (returns to the launcher instead of the active spike).
    if (e.metaKey && e.key === "r")
      window.location.assign(window.location.href);
    // Cmd+Shift+H: back to the launcher from any spike.
    if (e.metaKey && e.shiftKey && e.key === "h") window.location.href = "/";
  });
}
const spikes = import.meta.glob<{ default: React.ComponentType }>(
  "../spikes/*/index.tsx",
);

async function mount() {
  const root = ReactDOM.createRoot(
    document.getElementById("root") as HTMLElement,
  );
  if (spikeId) {
    const key = Object.keys(spikes).find((path) =>
      path.includes(`/spikes/${spikeId}-`),
    );
    if (key) {
      const { default: Spike } = await spikes[key]();
      root.render(<Spike />);
      return;
    }
    console.error(`spike "${spikeId}" not found; available:`, spikes);
  }
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

void mount();
