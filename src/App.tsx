import "./layout/bootstrap";
import { StartupHandshake } from "./app/StartupHandshake";
import { DockviewShell } from "./layout";

const spikes = import.meta.env.DEV
  ? [
      { id: "0a", label: "0a — iframe stress" },
      { id: "0b", label: "0b — PTY" },
      { id: "0c", label: "0c — server connectivity" },
    ]
  : [];

function App() {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        background: "var(--color-bg)",
      }}
    >
      {spikes.length > 0 && (
        <header
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-2)",
            padding: "var(--space-1) var(--space-2)",
            borderBottom: "1px solid var(--color-border)",
            background: "var(--color-surface-raised)",
          }}
        >
          <strong
            style={{
              color: "var(--color-text-secondary)",
              fontFamily: "system-ui, sans-serif",
              fontSize: "var(--text-sm)",
              marginRight: "var(--space-2)",
            }}
          >
            Mothership
          </strong>
          <nav style={{ display: "flex", gap: "var(--space-2)" }}>
            {spikes.map((s) => (
              <a
                key={s.id}
                href={`/?spike=${s.id}`}
                style={{
                  color: "var(--color-accent)",
                  border: "1px solid var(--color-border)",
                  borderRadius: "var(--radius-sm)",
                  padding: "var(--space-1) var(--space-2)",
                  textDecoration: "none",
                  fontSize: "var(--text-xs)",
                  fontFamily: "system-ui, sans-serif",
                }}
              >
                {s.label}
              </a>
            ))}
          </nav>
        </header>
      )}
      <div style={{ flex: 1, minHeight: 0 }}>
        <StartupHandshake>
          {(context, workspacePath) => (
            <DockviewShell workspacePath={workspacePath} context={context} />
          )}
        </StartupHandshake>
      </div>
    </div>
  );
}

export default App;
