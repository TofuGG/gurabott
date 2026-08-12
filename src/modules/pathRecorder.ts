/**
 * pathRecorder.ts - Replay a recorded waypoint route saved by the companion
 * Fabric "waypoint-recorder" client mod.
 *
 * Route file format (version 1):
 *   {
 *     "name": "to-shop",
 *     "version": 1,
 *     "points": [
 *       { "x": 12.34, "y": 64.0, "z": -9.1, "yaw": 90.5, "pitch": 12.3,
 *         "sneak": false, "dts": 200 }
 *     ]
 *   }
 * The bot baritones (ashfinder) waypoint → waypoint. Points recorded while the
 * player was sneaking make the bot sneak while approaching that point, and the
 * recorded yaw/pitch is re-applied on arrival so entry-facing is preserved.
 */

import type { Bot } from 'mineflayer';
import baritonePlugin from '@miner-org/mineflayer-baritone';
import { Vec3 } from 'vec3';
import { readFileSync } from 'node:fs';
import { addLog } from '../core/store.ts';
import { safeGoto, sleep } from '../utils.ts';

const baritoneGoals = baritonePlugin.goals;

export interface Waypoint {
    x: number;
    y: number;
    z: number;
    yaw?: number;
    pitch?: number;
    sneak?: boolean;
    dts?: number;
}

export interface RecordedRoute {
    name?: string;
    version?: number;
    points: Waypoint[];
}

export interface ReplayOptions {
    /** Log lines with this tag prefix, e.g. 'auto' to distinguish automation. */
    tag?: string;
    /** Max milliseconds allowed to reach each waypoint. */
    waypointTimeoutMs?: number;
    /** Pause between waypoints respecting the recorded dts (ms), capped. */
    respectTiming?: boolean;
}

export function loadRoute(file: string): RecordedRoute {
    const raw = readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    const points = Array.isArray(parsed) ? parsed : parsed?.points;
    if (!Array.isArray(points)) throw new Error('route file has no "points" array');
    return { name: parsed?.name, version: parsed?.version, points };
}

const deg2rad = (deg: number): number => (deg * Math.PI) / 180;

export async function replayPath(bot: Bot, file: string, opts: ReplayOptions = {}): Promise<boolean> {
    const tag = opts.tag ? `[${opts.tag}path]` : '[path]';
    const timeoutMs = opts.waypointTimeoutMs ?? 30000;

    let route: RecordedRoute;
    try {
        route = loadRoute(file);
    } catch (err: any) {
        addLog('error', `${tag} could not load "${file}": ${err?.message ?? err}`);
        return false;
    }
    if (route.points.length === 0) {
        addLog('warn', `${tag} "${file}" contains no waypoints`);
        return false;
    }
    if (!bot?.entity) {
        addLog('warn', `${tag} bot not ready — route not replayed`);
        return false;
    }

    addLog('system', `${tag} replaying ${route.points.length} waypoints from "${file}"${route.name ? ` (${route.name})` : ''}`);
    try { bot.ashfinder?.stop?.(); } catch {}

    for (let i = 0; i < route.points.length; i++) {
        const p = route.points[i];
        const target = new Vec3(p.x, p.y, p.z);

        if (p.sneak) { try { bot.setControlState('sneak', true); } catch {} }
        else { try { bot.setControlState('sneak', false); } catch {} }

        const nav = await safeGoto(bot, new baritoneGoals.GoalNear(target, 1), timeoutMs);
        if (nav.status !== 'success') {
            addLog('warn', `${tag} waypoint ${i + 1}/${route.points.length} (${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.z)}) unreachable — ${nav.error?.message ?? nav.status}`);
            try { bot.setControlState('sneak', false); } catch {}
            return false;
        }

        if (p.yaw !== undefined) {
            try { await bot.look(deg2rad(p.yaw), deg2rad(p.pitch ?? 0), true); } catch {}
        }

        if (i % 10 === 0 || i === route.points.length - 1) {
            addLog('system', `${tag} waypoint ${i + 1}/${route.points.length} reached`);
        }

        if (opts.respectTiming && p.dts) {
            await sleep(Math.min(p.dts, 2000));
        }
    }

    try { bot.setControlState('sneak', false); } catch {}
    addLog('system', `${tag} route complete (${route.points.length} waypoints)`);
    return true;
}
