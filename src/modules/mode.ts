/**
 * mode.ts - Behavior mode controller (gidle / gattack / gfree)
 *
 * Gates autonomous behaviors:
 *   - 'idle':   purely social/stationary — look at players in range, crouch/
 *               uncrouch a few times. No wandering, no auto-combat.
 *   - 'attack': aggressive combat — hunt and fight hostiles on sight.
 *   - 'free':   context-dependent (default) — wander, socialize, fight ≤3
 *               hostiles, flee when overwhelmed or low HP.
 */

export type BotMode = 'idle' | 'attack' | 'free';

let _mode: BotMode = 'free';
const _listeners = new Set<(mode: BotMode) => void>();

export function getMode(): BotMode {
    return _mode;
}

export function setMode(mode: BotMode): void {
    if (_mode === mode) return;
    _mode = mode;
    for (const fn of _listeners) {
        try { fn(mode); } catch {}
    }
}

/** Subscribe to mode changes. Returns an unsubscribe function. */
export function onModeChange(fn: (mode: BotMode) => void): () => void {
    _listeners.add(fn);
    return () => { _listeners.delete(fn); };
}

/** Reset to the default mode and drop listeners (call on fresh connection). */
export function resetMode(): void {
    _mode = 'free';
    _listeners.clear();
}
