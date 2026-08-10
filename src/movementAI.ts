// src/movementAI.ts
// Lightweight movement AI - contextual idle behavior for the bot.
// Import and call startMovementAI(bot, getState, configureBaritone) after spawn.

import Mineflayer from 'mineflayer';
import baritonePlugin from '@miner-org/mineflayer-baritone';
import { Vec3 } from 'vec3';
import { sleep, safeGoto } from './utils.ts';
import { BotSession } from './session.ts';
import { addLog } from './core/store.ts';
import type { BotMode } from './modules/mode.ts';

// ── Movement suppression ───────────────────────────────────────────────────────
// Ref-counted so overlapping commands (two chat messages handled concurrently,
// or an AI action chain) can't release suppression while another command is
// still running. count > 0 means a command owns movement.
let suppressed = 0;

export function suppressMovement(bot?: Mineflayer.Bot): void {
    if (suppressed === 0) {
        // First suppress acquires control of movement: cancel any in-flight
        // baritone path. Without this, the command's own goto()/followEntity()
        // throws "Already navigating" and silently does nothing, and an active
        // idle-wander behavior keeps walking while the command runs.
        try { bot?.ashfinder?.stop(); } catch {}
    }
    suppressed++;
}
export function resumeMovement(): void {
    if (suppressed > 0) suppressed--;
}
// True while a command owns movement (used by the stuck detector to avoid
// hijacking an active collect/survival/etc.).
export function isMovementSuppressed(): boolean { return suppressed > 0; }
// Clears any suppression flag left over from a command that was interrupted
// by a disconnect. Called once per fresh connection in createBot() so a stale
// flag from the previous session can never freeze the new bot.
export function resetMovementSuppression(): void { suppressed = 0; }

const baritoneGoals = baritonePlugin.goals;

// How close (blocks) a player must be for the bot to react socially — glance,
// greet, and look/crouch behaviors. Beyond this radius the bot ignores them.
const PLAYER_DETECTION_RADIUS = 5;

// ── Types ────────────────────────────────────────────────────────────────────

type MovementContext = {
    timeOfDay: 'day' | 'dusk' | 'night' | 'dawn';
    isInWater: boolean;
    nearbyPlayers: number;
    nearbyHostiles: number;
    isHungry: boolean;
    isHurt: boolean;
    nearFire: boolean;
    onGround: boolean;
};

type WanderBehavior =
    | 'stand_look'      // stand still, slowly glance around
    | 'short_stroll'    // walk 3–8 blocks
    | 'long_walk'       // walk 8–20 blocks, sometimes sprint
    | 'distracted_walk' // start walking, stop mid-way to look at something
    | 'crouch_fidget'   // crouch briefly (fidgeting/nervous)
    | 'look_at_player'  // turn toward nearest player
    | 'look_at_sky'     // tilt head up (daydreaming)
    | 'pace_back_forth' // walk 4 blocks out and back
    | 'circle_spot';    // walk a small circle around current position

// Weight map over the wander behaviors.
type BehaviorWeightMap = Record<WanderBehavior, number>;

// ── Helpers ──────────────────────────────────────────────────────────────────

function getTimeOfDay(bot: Mineflayer.Bot): MovementContext['timeOfDay'] {
    const t = bot.time?.timeOfDay ?? 0;
    if (t < 1000 || t > 23000) return 'night';
    if (t < 3000) return 'dawn';
    if (t < 12000) return 'day';
    if (t < 14000) return 'dusk';
    return 'night';
}

function isNearFire(bot: Mineflayer.Bot): boolean {
    const pos = bot.entity.position;
    for (let x = -3; x <= 3; x++)
        for (let y = -1; y <= 2; y++)
            for (let z = -3; z <= 3; z++) {
                const b = bot.blockAt(pos.offset(x, y, z));
                if (b && (b.name === 'fire' || b.name === 'soul_fire' || b.name === 'lava')) return true;
            }
    return false;
}

function countNearbyHostiles(bot: Mineflayer.Bot, HOSTILE_MOBS: Set<string>): number {
    return Object.values(bot.entities).filter(e =>
        e.type === 'mob' &&
        HOSTILE_MOBS.has(e.name?.toLowerCase() ?? '') &&
        e.position.distanceTo(bot.entity.position) < 16
    ).length;
}

function countNearbyPlayers(bot: Mineflayer.Bot): number {
    return Object.values(bot.players).filter(p =>
        p.username !== bot.username && p.entity &&
        p.entity.position.distanceTo(bot.entity.position) < PLAYER_DETECTION_RADIUS
    ).length;
}

// How many blocks of free-fall below a candidate spot is considered "safe".
// 3 = tolerate small steps/slopes; raise to 0 for skyblock-style paranoia.
const MAX_SAFE_DROP = 3;

function isSafeGround(bot: Mineflayer.Bot, tx: number, ty: number, tz: number): boolean {
    // The block the bot would stand on
    const floor = bot.blockAt(new Vec3(tx, ty - 1, tz));
    const s1    = bot.blockAt(new Vec3(tx, ty,     tz));
    const s2    = bot.blockAt(new Vec3(tx, ty + 1, tz));

    if (!floor || floor.boundingBox !== 'block') return false;

    const badNames = ['water', 'lava', 'void_air'];
    const isBadBlock = (b: any) => b && badNames.some((n: string) => b.name?.includes(n));

    if (isBadBlock(floor) || isBadBlock(s1) || isBadBlock(s2)) return false;
    if (s1 && s1.boundingBox !== 'empty') return false;
    if (s2 && s2.boundingBox !== 'empty') return false;

    // Check there's no dangerous drop within MAX_SAFE_DROP blocks on all 4 sides.
    // This catches cliff edges and skyblock gaps.
    const neighbors = [
        [tx + 1, tz], [tx - 1, tz],
        [tx, tz + 1], [tx, tz - 1],
    ];
    for (const [nx, nz] of neighbors) {
        // Scan downward from the candidate Y — how far until we hit something solid?
        let dropDepth = 0;
        for (let dy = 0; dy > -(MAX_SAFE_DROP + 1); dy--) {
            const nb = bot.blockAt(new Vec3(nx, ty + dy - 1, nz));
            if (!nb || nb.boundingBox === 'block') break; // solid — safe
            dropDepth++;
        }
        if (dropDepth > MAX_SAFE_DROP) return false; // too steep a drop next to this spot
    }

    return true;
}

function randomNearbyGround(bot: Mineflayer.Bot, minDist: number, maxDist: number): Vec3 | null {
    const pos = bot.entity.position;
    const botY = Math.floor(pos.y);

    for (let attempt = 0; attempt < 20; attempt++) {
        const angle = Math.random() * Math.PI * 2;
        const dist  = minDist + Math.random() * (maxDist - minDist);
        const tx    = Math.floor(pos.x + Math.cos(angle) * dist);
        const tz    = Math.floor(pos.z + Math.sin(angle) * dist);

        // Scan a wide vertical window: 4 above and 8 below the bot's current Y.
        // This handles hills above, valleys below, and tall builds.
        for (let dy = 4; dy >= -8; dy--) {
            const ty = botY + dy;
            if (ty < 0) break; // don't go below bedrock

            if (isSafeGround(bot, tx, ty, tz)) {
                return new Vec3(tx, ty, tz);
            }
        }
    }
    return null;
}

// Estimate how many blocks of safe ground exist around the bot.
// Used to scale down movement range on small islands.
function estimateSafeRadius(bot: Mineflayer.Bot): number {
    const pos = bot.entity.position;
    let maxSafe = 0;
    for (let dist = 2; dist <= 20; dist += 2) {
        let safeCount = 0;
        const checks = 8;
        for (let i = 0; i < checks; i++) {
            const angle = (i / checks) * Math.PI * 2;
            const tx = Math.floor(pos.x + Math.cos(angle) * dist);
            const tz = Math.floor(pos.z + Math.sin(angle) * dist);
            if (isSafeGround(bot, tx, Math.floor(pos.y), tz)) safeCount++;
        }
        if (safeCount < 3) break; // fewer than 3/8 directions safe = edge of island
        maxSafe = dist;
    }
    return maxSafe;
}

function isWaterAt(bot: Mineflayer.Bot, pos: Vec3): boolean {
    for (let dy = -1; dy <= 1; dy++) {
        const b = bot.blockAt(pos.offset(0, dy, 0));
        if (b?.name?.includes('water') || b?.name?.includes('lava')) return true;
    }
    return false;
}

function buildContext(bot: Mineflayer.Bot, HOSTILE_MOBS: Set<string>): MovementContext {
    const pos = bot.entity.position;
    const feetBlock = bot.blockAt(pos.offset(0, 0, 0));
    const headBlock = bot.blockAt(pos.offset(0, 1, 0));
    const isInWater = !!(
        feetBlock?.name?.includes('water') ||
        headBlock?.name?.includes('water')
    );
    return {
        timeOfDay: getTimeOfDay(bot),
        isInWater,
        nearbyPlayers: countNearbyPlayers(bot),
        nearbyHostiles: countNearbyHostiles(bot, HOSTILE_MOBS),
        isHungry: bot.food < 8,
        isHurt: bot.health < 14,
        nearFire: isNearFire(bot),
        onGround: bot.entity.onGround,
    };
}

// ── Behavior weight table ────────────────────────────────────────────────────
// Returns a weighted list of behaviors based on context.
// More weight = more likely to be chosen.

function getBehaviorWeights(ctx: MovementContext): Record<WanderBehavior, number> {
    const w: Record<WanderBehavior, number> = {
        stand_look:       10,
        short_stroll:     15,
        long_walk:        15,
        distracted_walk:  12,
        crouch_fidget:     8,
        look_at_player:    5,
        look_at_sky:      10,
        pace_back_forth:  10,
        circle_spot:       5,
    };

    // At night: stay still more, walk less
    if (ctx.timeOfDay === 'night') {
        w.stand_look += 15;
        w.look_at_sky += 10;
        w.long_walk -= 10;
        w.circle_spot += 5;
    }

    // Dawn/dusk: slow, contemplative movements
    if (ctx.timeOfDay === 'dawn' || ctx.timeOfDay === 'dusk') {
        w.stand_look += 8;
        w.look_at_sky += 12;
        w.short_stroll += 5;
    }

    // Hostile mobs nearby: fidget/crouch, stop long walks
    if (ctx.nearbyHostiles > 0) {
        w.crouch_fidget += 15;
        w.stand_look += 10;
        w.long_walk = 0;
        w.distracted_walk = 0;
    }

    // Players nearby: more social, look at them
    if (ctx.nearbyPlayers > 0) {
        w.look_at_player += 20;
        w.short_stroll += 5;
        w.long_walk -= 5;
    }

    // Hungry: pace nervously
    if (ctx.isHungry) {
        w.pace_back_forth += 15;
        w.crouch_fidget += 10;
        w.long_walk = 0;
    }

    // Hurt: stand still, crouch
    if (ctx.isHurt) {
        w.stand_look += 20;
        w.crouch_fidget += 10;
        w.long_walk = 0;
        w.short_stroll -= 5;
    }

    // Clamp negatives
    for (const k in w) (w as any)[k] = Math.max(0, (w as any)[k]);

    return w;
}

function pickWeighted(weights: Record<WanderBehavior, number>): WanderBehavior {
    const total = Object.values(weights).reduce((a, b) => a + b, 0);
    let r = Math.random() * total;
    for (const [key, weight] of Object.entries(weights)) {
        r -= weight;
        if (r <= 0) return key as WanderBehavior;
    }
    return 'stand_look';
}

// ── Behavior executors ───────────────────────────────────────────────────────

async function doStandLook(bot: Mineflayer.Bot) {
    const count = 1 + Math.floor(Math.random() * 3);
    for (let i = 0; i < count; i++) {
        const yaw = Math.random() * Math.PI * 2;
        const pitch = (Math.random() * 0.7) - 0.25;
        try { await bot.look(yaw, pitch, false); } catch {}
        await sleep(900 + Math.random() * 1400);
    }
}

async function doShortStroll(bot: Mineflayer.Bot, configureBaritone: (overrides?: Record<string, any>) => void, minDist = 3, maxDist = 8) {
    const dest = randomNearbyGround(bot, minDist, maxDist);
    if (!dest || isWaterAt(bot, dest)) return;
    configureBaritone();
    await safeGoto(bot, new baritoneGoals.GoalExact(new Vec3(dest.x, dest.y, dest.z)));
    // Look around briefly on arrival — no fixed pause, scheduler handles timing
    try { await bot.look(Math.random() * Math.PI * 2, (Math.random() * 0.3) - 0.1, false); } catch {}
}

async function doLongWalk(bot: Mineflayer.Bot, configureBaritone: (overrides?: Record<string, any>) => void, minDist = 8, maxDist = 22) {
    const dest = randomNearbyGround(bot, minDist, maxDist);
    if (!dest || isWaterAt(bot, dest)) return;
    configureBaritone({ allowSprinting: Math.random() < 0.35, parkour: false });
    await safeGoto(bot, new baritoneGoals.GoalExact(new Vec3(dest.x, dest.y, dest.z)));
}

async function doDistractedWalk(bot: Mineflayer.Bot, configureBaritone: (overrides?: Record<string, any>) => void, minDist = 5, maxDist = 15) {
    const dest = randomNearbyGround(bot, minDist, maxDist);
    if (!dest || isWaterAt(bot, dest)) return;
    configureBaritone();
    // Fire-and-forget navigation — cancel after a random delay for the "distracted" effect
    const destVec = new Vec3(dest.x, dest.y, dest.z);
    try { bot.ashfinder.goto(new baritoneGoals.GoalExact(destVec)); } catch {}
    await new Promise<void>(resolve => {
        const t = setTimeout(() => { try { bot.ashfinder.stop(); } catch {} resolve(); }, 1200 + Math.random() * 1800);
        const onReach = () => { clearTimeout(t); resolve(); };
        bot.ashfinder.once('goal-reach', onReach);
        // Also clean up the listener if the timeout fires first
        const origResolve = resolve;
        resolve = () => { try { bot.ashfinder.off('goal-reach', onReach); } catch {} origResolve(); };
    });
    try { await bot.look(Math.random() * Math.PI * 2, (Math.random() * 0.5) - 0.1, false); } catch {}
}

async function doCrouchFidget(bot: Mineflayer.Bot) {
    const reps = 1 + Math.floor(Math.random() * 2);
    for (let i = 0; i < reps; i++) {
        bot.setControlState('sneak', true);
        await sleep(350 + Math.random() * 500);
        bot.setControlState('sneak', false);
        if (i < reps - 1) await sleep(200 + Math.random() * 300);
    }
}

async function doLookAtPlayer(bot: Mineflayer.Bot) {
    const nearby = Object.values(bot.players).find(p =>
        p.username !== bot.username && p.entity &&
        p.entity.position.distanceTo(bot.entity.position) < PLAYER_DETECTION_RADIUS
    );
    if (!nearby?.entity) { await doStandLook(bot); return; }
    try { await bot.lookAt(nearby.entity.position.offset(0, 1.6, 0), false); } catch {}
    await sleep(1000 + Math.random() * 1500);
}

// gidle greet: look at the nearest player, then crouch/uncrouch a few times.
// This is the bot's signature "idle mode" reaction when a player is in range.
async function doIdleGreet(bot: Mineflayer.Bot) {
    const nearby = Object.values(bot.players).find(p =>
        p.username !== bot.username && p.entity &&
        p.entity.position.distanceTo(bot.entity.position) < PLAYER_DETECTION_RADIUS
    );
    if (nearby?.entity) {
        try { await bot.lookAt(nearby.entity.position.offset(0, 1.6, 0), false); } catch {}
    }
    // crouch/uncrouch a few times (2-4 reps)
    const reps = 2 + Math.floor(Math.random() * 3);
    for (let i = 0; i < reps; i++) {
        bot.setControlState('sneak', true);
        await sleep(300 + Math.random() * 300);
        bot.setControlState('sneak', false);
        if (i < reps - 1) await sleep(150 + Math.random() * 250);
    }
}

async function doLookAtSky(bot: Mineflayer.Bot) {
    const yaw = Math.random() * Math.PI * 2;
    const pitch = -(0.6 + Math.random() * 0.8);
    try { await bot.look(yaw, pitch, false); } catch {}
    await sleep(1200 + Math.random() * 2000);
    try { await bot.look(yaw + (Math.random() * 0.4 - 0.2), -0.1, false); } catch {}
    await sleep(600);
}

async function doPaceBackForth(bot: Mineflayer.Bot, configureBaritone: (overrides?: Record<string, any>) => void, minDist = 3, maxDist = 6) {
    const dest   = randomNearbyGround(bot, minDist, maxDist);
    if (!dest || isWaterAt(bot, dest)) return;
    const origin = randomNearbyGround(bot, 0, 1) ?? bot.entity.position.clone().floored();
    configureBaritone();
    await safeGoto(bot, new baritoneGoals.GoalExact(new Vec3(dest.x, dest.y, dest.z)));
    await safeGoto(bot, new baritoneGoals.GoalExact(new Vec3(Math.round(origin.x), Math.round(origin.y), Math.round(origin.z))));
}

async function doCircleSpot(bot: Mineflayer.Bot, configureBaritone: (overrides?: Record<string, any>) => void) {
    const pos = bot.entity.position;
    const radius = 3 + Math.floor(Math.random() * 3);
    const steps = 4 + Math.floor(Math.random() * 3);
    const startAngle = Math.random() * Math.PI * 2;
    configureBaritone();
    for (let i = 0; i < steps; i++) {
        if (!bot.ashfinder.isPathing && i > 0) break;
        const angle = startAngle + (i / steps) * Math.PI * 2;
        const tx = Math.round(pos.x + Math.cos(angle) * radius);
        const tz = Math.round(pos.z + Math.sin(angle) * radius);
        const fallback = new Vec3(tx, Math.round(pos.y), tz);
        const validated = randomNearbyGround(bot, 0, 1);
        const target = validated ?? fallback;
        try { await safeGoto(bot, new baritoneGoals.GoalExact(new Vec3(target.x, target.y, target.z))); } catch {}
    }
}

// ── Main export ──────────────────────────────────────────────────────────────

/**
 * Start the movement AI. Call this once after bot spawn.
 *
 * @param bot            The mineflayer Bot instance
 * @param getState       Callback returning the current BotState string
 * @param configureBaritone  Callback to configure baritone pathfinding options
 * @param HOSTILE_MOBS   Set of hostile mob names (lowercase)
 * @param session        The owning BotSession — schedule timers are tracked here
 *                       so a disconnect cancels them and the loop stops
 *                       rescheduling against a dead bot
 */
export function startMovementAI(
    bot: Mineflayer.Bot,
    getState: () => string,
    configureBaritone: (overrides?: Record<string, any>) => void,
    HOSTILE_MOBS: Set<string>,
    session: BotSession,
    isEscaping?: () => boolean,
    getMode?: () => BotMode
) {
    let active = false;

    // Glance at players who walk close — feels reactive and aware
    let lastGlanceTime = 0;
    bot.on('entityMoved', (entity: any) => {
        if (suppressed) return;
        if (active) return; // don't interrupt a behavior
        if (getState() !== 'idle') return;
        if (isEscaping?.()) return;
        if (entity.type !== 'player') return;
        if (entity.username === bot.username) return;

        const dist = entity.position?.distanceTo(bot.entity?.position);
        if (!dist || dist < 0.5) return;

        const now = Date.now();

        // Very close (0–2 blocks): lock gaze on them continuously, only when idle
        if (dist <= 2) {
            if (getState() !== 'idle') return;
            if (isEscaping?.()) return;
            if (now - lastGlanceTime < 200) return;
            lastGlanceTime = now;
            const target = entity.position.offset(0, 1.6, 0);
            bot.lookAt(target, false).catch(() => {});
            return;
        }

        // Medium range (2–5 blocks): brief glance then look away
        if (dist > PLAYER_DETECTION_RADIUS) return;
        if (now - lastGlanceTime < 4000) return;
        lastGlanceTime = now;

        const target = entity.position.offset(0, 1.6, 0);
        bot.lookAt(target, false).catch(() => {});
        // Session-track the drift-back timer and guard against a null entity:
        // the timer can outlive a disconnect and deref bot.entity.yaw
        // unguarded (TypeError in an uncaught timer callback).
        const driftTimer = setTimeout(() => {
            session.untrack(driftTimer);
            if (!session.alive || !bot.entity) return;
            if (active || getState() !== 'idle') return;
            const driftYaw = (bot.entity.yaw ?? 0) + (Math.random() * 0.6 - 0.3);
            const driftPitch = (Math.random() * 0.3) - 0.1;
            bot.look(driftYaw, driftPitch, false).catch(() => {});
        }, 1200 + Math.random() * 800);
        session.track(driftTimer);
    });

    function clearControls() {
        const controls = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'] as const;
        for (const c of controls) try { bot.setControlState(c, false); } catch {}
    }

    async function tick(): Promise<WanderBehavior | null> {
        // Only run when bot is idle — and never while dead
        if (suppressed > 0 || !session.alive || session.moveActive || getState() !== 'idle' || active || !bot.entity?.onGround || (bot.health ?? 0) <= 0 || isEscaping?.()) return null;
        active = true;

        try {
            const ctx = buildContext(bot, HOSTILE_MOBS);
            const mode = getMode?.() ?? 'free';

            // gattack: no idle wandering — combat owns movement
            if (mode === 'attack') return null;

            // Don't wander if in water or if baritone is already pathing
            if (ctx.isInWater) return null;
            if (bot.ashfinder.isPathing) return null;

            // gidle: never walk. Just stand and, when a player is in range,
            // look at them and crouch/uncrouch a few times.
            if (mode === 'idle') {
                const label = ctx.nearbyPlayers > 0 ? 'idle greet (look + crouch)' : 'idle stand';
                if (ctx.nearbyPlayers > 0) {
                    await doIdleGreet(bot);
                } else {
                    await doStandLook(bot);
                }
                if (lastLoggedBehavior !== label) {
                    lastLoggedBehavior = label;
                    addLog('movement', `[MOV] ${label}`);
                }
                return 'stand_look';
            }

            // Static context weights drive behavior choice
            const merged: BehaviorWeightMap = { ...getBehaviorWeights(ctx) };
            const safeRadius = estimateSafeRadius(bot);
            // On a tiny island (< 4 blocks usable), only do stationary behaviors
            if (safeRadius < 4) {
                const stationaryOnly: BehaviorWeightMap = {
                    stand_look: 30, look_at_sky: 25, crouch_fidget: 20,
                    look_at_player: 15, short_stroll: 5, long_walk: 0,
                    distracted_walk: 0, pace_back_forth: 5, circle_spot: 0,
                };
                const behavior = pickWeighted(stationaryOnly);
                addLog('movement', `[MOV] ${behavior} (tiny island, safeRadius=${safeRadius})`);

                switch (behavior) {
                    case 'stand_look':    await doStandLook(bot); break;
                    case 'look_at_sky':   await doLookAtSky(bot); break;
                    case 'crouch_fidget': await doCrouchFidget(bot); break;
                    case 'look_at_player': await doLookAtPlayer(bot); break;
                    default:              await doStandLook(bot); break;
                }
                return behavior as WanderBehavior;
            }

            // Scale movement ranges to available space
            const clampDist = (min: number, max: number): [number, number] => {
                const cap = Math.max(2, safeRadius - 1);
                return [Math.min(min, cap), Math.min(max, cap)];
            };

            const behavior = pickWeighted(merged);
            if (lastLoggedBehavior !== behavior) {
                lastLoggedBehavior = behavior;
                addLog('movement', `[MOV] ${behavior} (${ctx.timeOfDay}, players=${ctx.nearbyPlayers}, hostiles=${ctx.nearbyHostiles}, safeRadius=${safeRadius})`);
            }

            switch (behavior) {
                case 'stand_look':      await doStandLook(bot); break;
                case 'short_stroll':    await doShortStroll(bot, configureBaritone, ...clampDist(3, 8)); break;
                case 'long_walk':       await doLongWalk(bot, configureBaritone, ...clampDist(8, 22)); break;
                case 'distracted_walk': await doDistractedWalk(bot, configureBaritone, ...clampDist(5, 15)); break;
                case 'crouch_fidget':   await doCrouchFidget(bot); break;
                case 'look_at_player':  await doLookAtPlayer(bot); break;
                case 'look_at_sky':     await doLookAtSky(bot); break;
                case 'pace_back_forth': await doPaceBackForth(bot, configureBaritone, ...clampDist(3, 6)); break;
                case 'circle_spot':     await doCircleSpot(bot, configureBaritone); break;
            }

            return behavior;
        } catch (err) {
            addLog('warn', `[MOV] tick error: ${(err as any).message}`);
            return null;
        } finally {
            // If the session died mid-behavior (disconnect), don't fight over
            // the dead bot's controls or reset pathfinder config.
            if (session.alive) {
                clearControls();
                // Only restore default baritone config when no command owns
                // movement — otherwise this would clobber a command's
                // breakBlocks/allowSprinting settings mid-task.
                if (suppressed === 0) configureBaritone();
            }
            active = false;
        }
        return null;
    }

    // Schedule ticks with variable delay (5–12s between each behavior)
    let lastBehavior: WanderBehavior | null = null;
    // Consecutive identical behaviors are logged only once — otherwise gidle
    // mode floods the log with the same "[MOV] idle stand" line every few sec.
    let lastLoggedBehavior: string | null = null;

    // Returns a natural next-tick delay based on what just happened.
    // Chains similar behaviors quickly; switches context more slowly.
    function nextDelay(behavior: WanderBehavior | null): number {
        if (!behavior) return 2000 + Math.random() * 3000;

        // After stationary behaviors: short pause, ready to move again soon
        if (behavior === 'stand_look' || behavior === 'look_at_sky') {
            return 1500 + Math.random() * 3500;
        }
        // After a walk: natural rest — longer if it was a long walk
        if (behavior === 'long_walk') {
            return 3000 + Math.random() * 5000;
        }
        if (behavior === 'short_stroll' || behavior === 'pace_back_forth') {
            return 1000 + Math.random() * 4000;
        }
        // After distracted walk: already paused mid-way, resume quickly
        if (behavior === 'distracted_walk') {
            return 800 + Math.random() * 2500;
        }
        // After social behaviors: linger near player a moment
        if (behavior === 'look_at_player') {
            return 2000 + Math.random() * 3000;
        }
        return 1500 + Math.random() * 4000;
    }

    function schedule() {
        if (!session.alive || !bot.entity) return;
        const delay = nextDelay(lastBehavior);
        let timer: NodeJS.Timeout;
        timer = session.track(setTimeout(async () => {
            // The fired timer must be released from the session's registry,
            // otherwise the registry grows forever (one stale handle per tick).
            session.untrack(timer);
            if (!session.alive || !bot.entity) return;
            const behaviorRan = await tick();
            // After the (potentially long) behavior, re-check the session — a
            // disconnect may have happened while we were walking/digging. If so,
            // stop rescheduling so no zombie loop survives on the old bot.
            if (!session.alive) return;
            if (behaviorRan) lastBehavior = behaviorRan;
            schedule();
        }, delay));
    }

    schedule();
}