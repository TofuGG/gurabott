// src/modules/debugTrace.ts
// Verbose diagnostic tracing (config: gui.verboseLogging). Logs "every little
// thing" — camera movement, GUI window open/close, item pickups, dropped-item
// spawns, and yaw drift that happens WITHOUT an explicit look call.
//
// The killer feature is caller attribution: every bot.look/lookAt call is
// wrapped and logs the first stack frame OUTSIDE this wrapper, so a mystery
// rotation (e.g. the bot glancing right while dropping bones) can be traced
// to the exact source file and line that caused it.

import type { Bot } from 'mineflayer';
import { addLog } from '../core/store.ts';

const rad2deg = (r: number): number => Math.round((r * 180) / Math.PI);

/** First frame of the stack that isn't inside this wrapper. Returns e.g.
 *  "at doIdleGreet (src/movementAI.ts:356)". */
function callerFrame(stack: string | undefined): string {
    if (!stack) return 'unknown';
    const lines = stack.split('\n');
    for (let i = 1; i < lines.length; i++) {
        const l = lines[i].trim();
        if (!l.includes('debugTrace.ts')) return l;
    }
    return 'unknown';
}

/** Attach the tracer to a freshly created bot. Idempotent per instance via a
 *  marker property so reconnects can't double-wrap. */
export function attachDebugTracer(bot: Bot, sessionEnd: (fn: () => void) => void): void {
    const marker = bot as any as { __dbgTraced?: boolean };
    if (marker.__dbgTraced) return;
    marker.__dbgTraced = true;

    let lastYaw: number | null = null;
    let explicitLookPending = false;
    let physicsHooked = false;
    let ended = false;
    sessionEnd(() => { ended = true; });

    const logLook = (kind: 'look' | 'lookAt', args: unknown[], forceIdx: number, raw: string): void => {
        // Any explicit look call explains the next yaw change — don't let the
        // drift detector flag our own rotations.
        explicitLookPending = true;
        const force = args[forceIdx];
        addLog('movement', `[DBG] ${kind}(${raw}${force === true ? ', force' : ''}) ← ${callerFrame(new Error().stack)}`);
    };

    const origLook = bot.look.bind(bot);
    (bot as any).look = ((yaw: number, pitch: number, force?: boolean, ...rest: any[]) => {
        logLook('look', [yaw, pitch, force], 2, `yaw=${rad2deg(Number(yaw))}°, pitch=${rad2deg(Number(pitch))}°`);
        return (origLook as any)(yaw, pitch, force, ...rest);
    }) as typeof bot.look;

    const origLookAt = bot.lookAt.bind(bot);
    (bot as any).lookAt = ((point: any, force?: boolean, ...rest: any[]) => {
        const p = point?.floored?.() ?? point;
        logLook('lookAt', [point, force], 1, `${p}, force=${force === true}`);
        return (origLookAt as any)(point, force, ...rest);
    }) as typeof bot.lookAt;

    // ── Yaw-drift detector: a significant yaw change on physicsTick with no
    // explicit look call since the last tick means SOMETHING ELSE turned us
    // (physics interpolation, plugin-side teleport-look, etc.).
    bot.on('physicTick', () => {
        if (ended) return;
        const yaw = bot.entity?.yaw;
        if (typeof yaw !== 'number') return;
        if (!physicsHooked) { lastYaw = yaw; physicsHooked = true; return; }
        if (lastYaw !== null) {
            let d = yaw - lastYaw;
            while (d > Math.PI) d -= Math.PI * 2;
            while (d < -Math.PI) d += Math.PI * 2;
            if (Math.abs(d) > 0.12) { // ~7°
                addLog('movement', `[DBG] yaw drifted ${rad2deg(d)}° → ${rad2deg(yaw)}°${explicitLookPending ? '' : ' ← NO explicit look call this tick!'}`);
            }
        }
        lastYaw = yaw;
        explicitLookPending = false;
    });

    // ── Chest/GUI lifecycle ──────────────────────────────────────────────────
    bot.on('windowOpen', (window: any) => {
        if (ended) return;
        const title = JSON.stringify(window?.title ?? null);
        addLog('system', `[DBG] window OPEN #${window?.id} title=${title} slots=${window?.slots?.length ?? '?'}`);
    });
    bot.on('windowClose', (window: any) => {
        if (ended) return;
        addLog('system', `[DBG] window CLOSE #${window?.id}`);
    });

    // ── Items: spawns (bones flying!) and pickups ───────────────────────────
    bot.on('entitySpawn', (entity: any) => {
        if (ended) return;
        const name = entity?.name?.toLowerCase?.();
        if (name !== 'item' && name !== 'item_stack') return;
        const p = entity.position?.floored();
        const metaName = entity?.metadata?.[8]?.itemName ?? '';
        addLog('system', `[DBG] item spawned id=${entity.id} at ${p} ${metaName ? `(${metaName})` : ''}`);
    });
    bot.on('playerCollect', (collector: any, item: any) => {
        if (ended) return;
        addLog('system', `[DBG] collect by ${collector?.username ?? collector?.displayName ?? collector?.id} ← item ${item?.metadata?.[8]?.itemName ?? item?.id}`);
    });

    // ── Our own clicks, for correlating click ↔ look ↔ spawn timelines ───────
    const origClickWindow = bot.clickWindow.bind(bot);
    (bot as any).clickWindow = ((slot: number, mouseButton: number, mode: number, ...rest: any[]) => {
        addLog('system', `[DBG] clickWindow slot=${slot} button=${mouseButton} mode=${mode} ← ${callerFrame(new Error().stack)}`);
        return (origClickWindow as any)(slot, mouseButton, mode, ...rest);
    }) as typeof bot.clickWindow;

    addLog('system', '[DBG] verbose tracer attached (gui.verboseLogging)');
}
