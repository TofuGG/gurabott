// src/core/gazeLock.ts
// Gaze enforcement: while a stare is active (glook, gsdrop, gidledrop), ANY
// bot.look/bot.lookAt whose aim deviates too far from the stare target is
// silently rewritten to aim at it instead.
//
// Why this exists: baritone's PathExecutor resurrects itself after every
// stop() (handleStuck/_onPathEnd await their own internal replan, which lands
// AFTER the stop and calls setPath again — executor.js:290/321), and its
// _walkTo force-looks at the last walk waypoint every physics tick. That fight
// rotated Miku's head ~151° off the spawner mid-drop, so the server saw the
// wrong yaw at click time and bones flew backward. External stops can never win
// that race, so enforcement lives one layer down: mineflayer sends look packets
// ONLY from bot.look (physics.js), which every possible turner must pass
// through. Rewriting there pins the head regardless of who is fighting us.
//
// Layering: this module imports nothing but the store — engine modules
// (movementAI) arm/disarm it; nothing in core may import modules/UI.

import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { addLog } from './store.ts';

let lockCenter: Vec3 | null = null;

/** Arm the lock: every look is forced toward `center` until cleared. */
export function setGazeLock(center: Vec3): void {
    lockCenter = center.clone();
}

/** Release the lock (stare ended, disconnect, glook cleared). */
export function clearGazeLock(): void {
    lockCenter = null;
}

export function isGazeLocked(): boolean {
    return lockCenter !== null;
}

/**
 * Cosine of the angle between two vectors (does not need to be normalized).
 * Pure — unit-tested. Rewrite threshold: cos(30°) ≈ 0.866, i.e. aims within a
 * 30° cone of the stare target pass through untouched (small drift, pitch
 * tweaks); anything wider is a hijack and gets rewritten.
 */
export function cosineBetween(
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
): number {
    const la = Math.sqrt(ax * ax + ay * ay + az * az);
    const lb = Math.sqrt(bx * bx + by * by + bz * bz);
    if (la === 0 || lb === 0) return 1; // degenerate — treat as aligned
    return (ax * bx + ay * by + az * bz) / (la * lb);
}

const REWRITE_COS = Math.cos((30 * Math.PI) / 180);

/** First stack frame outside this module (and outside debugTrace's wrappers)
 *  so rewrite logs attribute the would-be hijacker, e.g. "PathExecutor._walkTo". */
function callerFrame(stack: string | undefined): string {
    if (!stack) return 'unknown';
    for (const line of stack.split('\n')) {
        const l = line.trim();
        if (!l.includes('gazeLock.ts') && !l.includes('debugTrace.ts')) return l;
    }
    return 'unknown';
}

/**
 * Wrap bot.look/bot.lookAt with gaze enforcement. MUST run before
 * attachDebugTracer so the tracer logs caller intent and this module logs what
 * was actually sent. Idempotent per bot instance (reconnects create fresh bots,
 * but double-install stays impossible).
 */
export function installGazeEnforcer(bot: Bot, sessionEnd: (fn: () => void) => void): void {
    const marker = bot as any as { __gazeEnforced?: boolean };
    if (marker.__gazeEnforced) return;
    marker.__gazeEnforced = true;

    let insideEnforcedCall = false;
    let rewritesSinceLog = 0;
    let lastRewriteLog = 0;

    const noteRewrite = (): void => {
        rewritesSinceLog++;
        const now = Date.now();
        if (now - lastRewriteLog < 2000) return; // _walkTo fires every ~25ms — throttle hard
        const frame = callerFrame(new Error().stack);
        addLog('movement', `[GAZE] rewrote ${rewritesSinceLog} hijacked look(s) to the stare target ← ${frame}`);
        rewritesSinceLog = 0;
        lastRewriteLog = now;
    };

    /** Aim point the lock wants, or null when unlocked / not enforceable. */
    const enforcePoint = (requested: any): Vec3 | null => {
        if (!lockCenter || insideEnforcedCall || !bot.entity?.position) return null;
        try {
            const eye = bot.entity.position.offset(0, (bot.entity as any).eyeHeight ?? 1.62, 0);
            const want = requested instanceof Vec3 ? requested : new Vec3(requested.x, requested.y, requested.z);
            const dWant = want.minus(eye);
            const dLock = lockCenter.minus(eye);
            if (cosineBetween(dWant.x, dWant.y, dWant.z, dLock.x, dLock.y, dLock.z) >= REWRITE_COS) return null;
            return lockCenter;
        } catch {
            return null; // never let enforcement itself break a look call
        }
    };

    const origLookAt = bot.lookAt.bind(bot);
    (bot as any).lookAt = ((point: any, force?: boolean, ...rest: any[]) => {
        const enforced = enforcePoint(point);
        if (enforced) noteRewrite();
        const target = enforced ?? point;
        // Guard EVERY delegation: mineflayer's own lookAt calls bot.look
        // internally, which resolves our wrapped look — without the flag each
        // legit lookAt would re-enter the redirect path below.
        if (lockCenter && !insideEnforcedCall && bot.entity) {
            insideEnforcedCall = true;
            try { return (origLookAt as any)(target, force, ...rest); }
            finally { insideEnforcedCall = false; }
        }
        return (origLookAt as any)(target, force, ...rest);
    }) as typeof bot.lookAt;

    // Raw yaw/pitch look: redirecting through origLookAt delegates the angle
    // math (and mineflayer's conventions) to mineflayer itself. Its internal
    // bot.look resolves our WRAPPED look, so the guard flag lets that nested
    // call pass straight through — exactly one level deep.
    const origLook = bot.look.bind(bot);
    (bot as any).look = ((yaw: number, pitch: number, force?: boolean, ...rest: any[]) => {
        if (lockCenter && !insideEnforcedCall && bot.entity) {
            noteRewrite();
            insideEnforcedCall = true;
            try { return (origLookAt as any)(lockCenter.clone(), force, ...rest); }
            finally { insideEnforcedCall = false; }
        }
        return (origLook as any)(yaw, pitch, force, ...rest);
    }) as typeof bot.look;

    sessionEnd(() => { clearGazeLock(); });
    addLog('system', '[GAZE] enforcer installed');
}
