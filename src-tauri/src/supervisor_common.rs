//! Shared pure restart-cap helpers used by both `server_supervisor` and
//! `ide_sidecar` — extracted so the identical policy (and its unit tests)
//! live in exactly one place.

use std::time::{Duration, Instant};

/// Pure restart-cap decision, extracted so it's unit-testable without
/// spawning a real process. `count` is restarts already used within the
/// current window; returns whether one more restart is allowed.
pub fn should_restart(count: u32, max: u32) -> bool {
    count < max
}

/// Pure window-reset decision: has enough time passed since `window_start`
/// that the restart counter should reset to zero?
pub fn window_expired(window_start: Instant, now: Instant, window: Duration) -> bool {
    now.duration_since(window_start) >= window
}

#[cfg(test)]
mod tests {
    use super::*;

    const MAX_RESTARTS: u32 = 3;
    const RESTART_WINDOW: Duration = Duration::from_secs(60);

    #[test]
    fn should_restart_allows_up_to_cap() {
        assert!(should_restart(0, MAX_RESTARTS));
        assert!(should_restart(1, MAX_RESTARTS));
        assert!(should_restart(2, MAX_RESTARTS));
        assert!(!should_restart(3, MAX_RESTARTS));
        assert!(!should_restart(4, MAX_RESTARTS));
    }

    #[test]
    fn window_expired_is_pure_and_monotonic() {
        let start = Instant::now();
        assert!(!window_expired(start, start, RESTART_WINDOW));
        let mid = start + Duration::from_secs(30);
        assert!(!window_expired(start, mid, RESTART_WINDOW));
        let after = start + Duration::from_secs(61);
        assert!(window_expired(start, after, RESTART_WINDOW));
    }
}
