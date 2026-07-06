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

/// Outcome of a concurrent-spawn race: which side keeps its child process.
/// Deterministic policy is "whoever registered first wins" — if another
/// caller has already installed a child while we were unlocked spawning our
/// own, our newly-spawned child is the loser and must be killed to avoid an
/// orphaned double-spawn.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum RaceWinner {
    /// Keep the child that was already registered; kill the one we just
    /// spawned.
    Existing,
    /// No child was registered in the meantime; install the one we just
    /// spawned.
    New,
}

/// Pure decision for `ensure_server`'s (and any similar supervisor's)
/// post-spawn re-validation: after spawning outside the lock, re-check
/// under the lock whether another caller already won the race.
pub fn resolve_spawn_race(existing_registered: bool) -> RaceWinner {
    if existing_registered {
        RaceWinner::Existing
    } else {
        RaceWinner::New
    }
}

/// Pure respawn decision: a monitor should only respawn a dead child when
/// the supervisor isn't shutting down AND the restart cap hasn't been
/// exceeded. Shutdown always wins over the restart cap check.
pub fn should_respawn(shutting_down: bool, restart_allowed: bool) -> bool {
    !shutting_down && restart_allowed
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

    #[test]
    fn resolve_spawn_race_prefers_already_registered_existing() {
        assert_eq!(resolve_spawn_race(true), RaceWinner::Existing);
    }

    #[test]
    fn resolve_spawn_race_installs_new_when_none_registered() {
        assert_eq!(resolve_spawn_race(false), RaceWinner::New);
    }

    #[test]
    fn should_respawn_is_false_when_shutting_down_regardless_of_cap() {
        assert!(!should_respawn(true, true));
        assert!(!should_respawn(true, false));
    }

    #[test]
    fn should_respawn_follows_restart_cap_when_not_shutting_down() {
        assert!(should_respawn(false, true));
        assert!(!should_respawn(false, false));
    }
}
