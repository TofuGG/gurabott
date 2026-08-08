/**
 * session.ts - Per-connection lifecycle management.
 *
 * Every createBot() call gets a fresh BotSession. It tracks all timers and
 * long-running async work owned by that connection so that a disconnect can
 * cancel them atomically.
 *
 * Without this, a connection that dies mid-task can leave "zombie" loops
 * running against the old bot object — re-scheduling themselves forever,
 * leaking memory, and corrupting the next connection (e.g. movementAI kept
 * wandering on a dead bot, or gsurv kept mining against a quit bot).
 */

export class BotSession {
    alive = true;
    /**
     * Set while a command/task owns movement (combat, fleeing). movementAI's
     * tick() skips while this is true so idle wandering never competes with
     * an active fight/escape. Cleared when the task ends.
     */
    moveActive = false;
    private timers = new Set<NodeJS.Timeout>();
    private endHooks = new Set<() => void>();

    /** Register a timer so it is cleared when the session ends. Returns the same timer for chaining. */
    track<T extends NodeJS.Timeout>(timer: T): T {
        this.timers.add(timer);
        return timer;
    }

    /** Unregister a timer once it has fired or was cleared manually. */
    untrack(timer: NodeJS.Timeout): void {
        this.timers.delete(timer);
    }

    /**
     * Register a callback that fires when the session ends (disconnect). Runs
     * at most once per registered callback — end() clears the hook set, so a
     * second end() call does not re-fire them. Returns an unsubscribe.
     */
    onEnd(fn: () => void): () => void {
        this.endHooks.add(fn);
        return () => { this.endHooks.delete(fn); };
    }

    /** Number of still-registered timers (useful for debugging leaks). */
    get timerCount(): number {
        return this.timers.size;
    }

    /** Clear every registered timer. Idempotent. */
    clearTimers(): void {
        for (const t of this.timers) {
            clearTimeout(t);
            clearInterval(t);
        }
        this.timers.clear();
    }

    /** Mark the session dead and clear its timers. Safe to call multiple times. */
    end(): void {
        this.alive = false;
        this.clearTimers();
        const hooks = this.endHooks;
        this.endHooks = new Set();
        for (const fn of hooks) {
            try { fn(); } catch {}
        }
    }
}
