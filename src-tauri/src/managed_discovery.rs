//! Resolves a space-bus v0.6.0 MANAGED server's discovery file so the
//! webview can attach to an already-running `harness serve` daemon instead
//! of spawning its own (the managed daemon is started/supervised entirely
//! by space-bus — mothership only reads its discovery file).
//!
//! Discovery path: `${XDG_STATE_HOME:-$HOME/.local/state}/space-bus/<HASH>/discovery.json`
//! where `HASH` is the first 16 hex chars of `sha256(realpath(<roster_dir>/spacebus.json))`.
//! This mirrors space-bus's own roster-path canonicalization + hashing scheme
//! (verified live against a running fixture) without importing the Node-only
//! package.
//!
//! Deps: added `sha2 = "0.10"` — the minimal crate needed to hash the
//! canonicalized roster path the same way space-bus does. No `libc`/pid
//! liveness check is done here (deliberately, to keep deps minimal); the
//! real liveness gate is the caller's subsequent `roster()` HTTP probe
//! against the discovered `baseUrl`, which is sufficient for a
//! single-operator tracer.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::Path;

#[derive(Debug, Deserialize)]
struct DiscoveryFile {
    #[allow(dead_code)]
    port: Option<i64>,
    #[allow(dead_code)]
    pid: Option<i64>,
    #[allow(dead_code)]
    identity: Option<String>,
    password: String,
    #[serde(rename = "baseUrl")]
    base_url: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedServer {
    pub base_url: String,
    pub username: String,
    pub password: String,
}

const ALLOWED_HOSTS: &[&str] = &["127.0.0.1", "::1", "localhost"];

fn state_dir() -> std::path::PathBuf {
    if let Ok(xdg) = std::env::var("XDG_STATE_HOME") {
        if !xdg.is_empty() {
            return std::path::PathBuf::from(xdg);
        }
    }
    let home = std::env::var("HOME").unwrap_or_default();
    std::path::PathBuf::from(home).join(".local/state")
}

/// Minimal hostname extraction from a `scheme://host[:port][/...]` URL
/// string — avoids pulling in the `url` crate for a single loopback check.
fn extract_hostname(u: &str) -> Option<String> {
    let after_scheme = u.split_once("://").map(|(_, rest)| rest).unwrap_or(u);
    let host_port = after_scheme
        .split(['/', '?', '#'])
        .next()
        .unwrap_or(after_scheme);
    // IPv6 literal like [::1]:port
    if let Some(rest) = host_port.strip_prefix('[') {
        return rest.split(']').next().map(str::to_string);
    }
    Some(host_port.split(':').next().unwrap_or(host_port).to_string())
}

fn hash_roster_path(canonical: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(canonical.as_bytes());
    let digest = hasher.finalize();
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    hex[..16].to_string()
}

/// Resolves the managed space-bus server's discovery info for the roster at
/// `<roster_dir>/spacebus.json`. Returns `Err` with an actionable message
/// when the roster file is missing, the daemon isn't running (no discovery
/// file), the discovery file is malformed, or the discovered `baseUrl` is
/// not loopback.
#[tauri::command]
pub fn resolve_managed_server(roster_dir: String) -> Result<ManagedServer, String> {
    let roster_path = Path::new(&roster_dir).join("spacebus.json");
    let canonical = std::fs::canonicalize(&roster_path)
        .map_err(|e| format!("no spacebus.json at {}: {e}", roster_path.display()))?;
    let canonical_str = canonical.to_string_lossy().to_string();

    let hash = hash_roster_path(&canonical_str);
    let discovery_path = state_dir()
        .join("space-bus")
        .join(&hash)
        .join("discovery.json");

    let raw = std::fs::read_to_string(&discovery_path).map_err(|_| {
        "managed space-bus server is not running for this workspace (no discovery file) — start it first"
            .to_string()
    })?;

    let discovery: DiscoveryFile = serde_json::from_str(&raw)
        .map_err(|e| format!("discovery file at {} is malformed: {e}", discovery_path.display()))?;

    let hostname = extract_hostname(&discovery.base_url)
        .ok_or_else(|| format!("managed server baseUrl is not a valid URL: {}", discovery.base_url))?;
    if !ALLOWED_HOSTS.contains(&hostname.as_str()) {
        return Err(format!(
            "managed server baseUrl is not loopback (got {hostname})"
        ));
    }

    Ok(ManagedServer {
        base_url: discovery.base_url,
        username: "opencode".to_string(),
        password: discovery.password,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_hostname_from_various_urls() {
        assert_eq!(extract_hostname("http://127.0.0.1:62910"), Some("127.0.0.1".to_string()));
        assert_eq!(extract_hostname("http://localhost:4096/foo"), Some("localhost".to_string()));
        assert_eq!(extract_hostname("http://[::1]:8080"), Some("::1".to_string()));
        assert_eq!(extract_hostname("https://evil.example.com"), Some("evil.example.com".to_string()));
    }

    #[test]
    fn hash_is_first_16_hex_chars_of_sha256() {
        let hash = hash_roster_path("/home/user/workspace/spacebus.json");
        assert_eq!(hash.len(), 16);
        assert!(hash.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn missing_roster_file_returns_actionable_error() {
        let result = resolve_managed_server("/nonexistent/dir/for/test".to_string());
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("no spacebus.json"));
    }
}
