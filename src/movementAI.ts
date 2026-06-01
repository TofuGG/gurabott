// src/movementAI.ts
// Lightweight movement AI - contextual idle behavior for the bot.
// Import and call startMovementAI(bot, getState, getSafeMovements) after spawn.

import Mineflayer from 'mineflayer';
import pathfinderLib from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { sleep } from './utils.ts';
import { MapMemory, BehaviorName, BehaviorWeightMap } from './mapMemory.ts';

const { goals } = pathfinderLib;
import pathfinderLibMod from 'mineflayer-pathfinder';
const { Movements } = pathfinderLibMod;

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
        p.entity.position.distanceTo(bot.entity.position) < 20
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

function randomNearbyGround(bot: Mineflayer.Bot, minDist: number, maxDist: number, memory?: MapMemory): Vec3 | null {
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
                const candidate = new Vec3(tx, ty, tz);
                if (memory?.isNearBadSpot(candidate)) continue;
                if (memory?.isNearDeathXZ(candidate)) continue;
                return candidate;
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

async function doShortStroll(bot: Mineflayer.Bot, getSafeMovements: () => any, memory?: MapMemory, minDist = 3, maxDist = 8) {
    const dest = randomNearbyGround(bot, minDist, maxDist, memory);
    if (!dest || isWaterAt(bot, dest)) return;
    bot.pathfinder.setMovements(getSafeMovements());
    try { await bot.pathfinder.goto(new goals.GoalBlock(dest.x, dest.y, dest.z)); } catch {}
    // Look around briefly on arrival — no fixed pause, scheduler handles timing
    try { await bot.look(Math.random() * Math.PI * 2, (Math.random() * 0.3) - 0.1, false); } catch {}
}

async function doLongWalk(bot: Mineflayer.Bot, getSafeMovements: () => any, memory?: MapMemory, minDist = 8, maxDist = 22) {
    const dest = randomNearbyGround(bot, minDist, maxDist, memory);
    if (!dest || isWaterAt(bot, dest)) return;
    const mv = getSafeMovements();
    mv.allowSprinting = Math.random() < 0.35;
    mv.allowParkour = false; // don't jump into water gaps
    bot.pathfinder.setMovements(mv);
    try { await bot.pathfinder.goto(new goals.GoalBlock(dest.x, dest.y, dest.z)); } catch {}
}

async function doDistractedWalk(bot: Mineflayer.Bot, getSafeMovements: () => any, memory?: MapMemory, minDist = 5, maxDist = 15) {
    const dest = randomNearbyGround(bot, minDist, maxDist, memory);
    if (!dest || isWaterAt(bot, dest)) return;
    bot.pathfinder.setMovements(getSafeMovements());
    // Walk then stop partway — no artificial delay, just cancel goal mid-walk
    bot.pathfinder.setGoal(new goals.GoalBlock(dest.x, dest.y, dest.z));
    await new Promise<void>(resolve => {
        const t = setTimeout(() => { bot.pathfinder.setGoal(null); resolve(); }, 1200 + Math.random() * 1800);
        bot.once('goal_reached', () => { clearTimeout(t); resolve(); });
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
        p.entity.position.distanceTo(bot.entity.position) < 20
    );
    if (!nearby?.entity) { await doStandLook(bot); return; }
    try { await bot.lookAt(nearby.entity.position.offset(0, 1.6, 0), false); } catch {}
    await sleep(1000 + Math.random() * 1500);
}

async function doLookAtSky(bot: Mineflayer.Bot) {
    const yaw = Math.random() * Math.PI * 2;
    const pitch = -(0.6 + Math.random() * 0.8);
    try { await bot.look(yaw, pitch, false); } catch {}
    await sleep(1200 + Math.random() * 2000);
    try { await bot.look(yaw + (Math.random() * 0.4 - 0.2), -0.1, false); } catch {}
    await sleep(600);
}

async function doPaceBackForth(bot: Mineflayer.Bot, getSafeMovements: () => any, memory?: MapMemory, minDist = 3, maxDist = 6) {
    const dest   = randomNearbyGround(bot, minDist, maxDist, memory);
    if (!dest || isWaterAt(bot, dest)) return;
    const origin = randomNearbyGround(bot, 0, 1) ?? bot.entity.position.clone().floored();
    bot.pathfinder.setMovements(getSafeMovements());
    try { await bot.pathfinder.goto(new goals.GoalBlock(dest.x, dest.y, dest.z)); } catch {}
    try { await bot.pathfinder.goto(new goals.GoalBlock(Math.round(origin.x), Math.round(origin.y), Math.round(origin.z))); } catch {}
}

async function doCircleSpot(bot: Mineflayer.Bot, getSafeMovements: () => any, memory?: MapMemory) {
    const pos = bot.entity.position;
    const radius = 3 + Math.floor(Math.random() * 3);
    const steps = 4 + Math.floor(Math.random() * 3);
    const startAngle = Math.random() * Math.PI * 2;
    bot.pathfinder.setMovements(getSafeMovements());
    for (let i = 0; i < steps; i++) {
        if (bot.pathfinder.isMoving?.() === false && i > 0) break;
        const angle = startAngle + (i / steps) * Math.PI * 2;
        const tx = Math.round(pos.x + Math.cos(angle) * radius);
        const tz = Math.round(pos.z + Math.sin(angle) * radius);
        const dest = randomNearbyGround(bot, 0, 1) ?? new Vec3(tx, Math.round(pos.y), tz);
        const target = new Vec3(tx, Math.round(pos.y), tz);
        try { await bot.pathfinder.goto(new goals.GoalBlock(target.x, target.y, target.z)); } catch {}
    }
}

// ── Main export ──────────────────────────────────────────────────────────────

/**
 * Start the movement AI. Call this once after bot spawn.
 *
 * @param bot            The mineflayer Bot instance
 * @param getState       Callback returning the current BotState string
 * @param getSafeMovements  Callback returning a configured Movements object
 * @param HOSTILE_MOBS   Set of hostile mob names (lowercase)
 * @param intervals      Shared intervals array (for cleanup on disconnect)
 */
export function startMovementAI(
    bot: Mineflayer.Bot,
    getState: () => string,
    getSafeMovements: () => any,
    HOSTILE_MOBS: Set<string>,
    intervals: NodeJS.Timeout[],
    isEscaping?: () => boolean,
    memory?: MapMemory,
    onStuckRegister?: (cb: () => void) => void
) {
    let active = false;
    let stuckDuringBehavior = false;
    // Register so stuck detector can notify us mid-behavior
    onStuckRegister?.(() => { stuckDuringBehavior = true; });

    // Glance at players who walk close — feels reactive and aware
    let lastGlanceTime = 0;
    bot.on('entityMoved', (entity: any) => {
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

        // Medium range (2–5.5 blocks): brief glance then look away
        if (dist > 5.5) return;
        if (now - lastGlanceTime < 4000) return;
        lastGlanceTime = now;

        const target = entity.position.offset(0, 1.6, 0);
        bot.lookAt(target, false).catch(() => {});
        setTimeout(() => {
            if (active || getState() !== 'idle') return;
            const driftYaw = (bot.entity.yaw ?? 0) + (Math.random() * 0.6 - 0.3);
            const driftPitch = (Math.random() * 0.3) - 0.1;
            bot.look(driftYaw, driftPitch, false).catch(() => {});
        }, 1200 + Math.random() * 800);
    });

    function clearControls() {
        const controls = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'] as const;
        for (const c of controls) try { bot.setControlState(c, false); } catch {}
    }

    async function tick(): Promise<WanderBehavior | null> {
        // Only run when bot is idle
        if (getState() !== 'idle' || active || !bot.entity?.onGround || isEscaping?.()) return null;
        active = true;

        let trackFall: (() => void) | null = null;
        try {
            const ctx = buildContext(bot, HOSTILE_MOBS);
            // Don't wander if in water or if pathfinder is already doing something
            if (ctx.isInWater) return null;
            if ((bot.pathfinder as any).isMoving?.()) return null;

            // Merge static context weights with learned weights from memory
            const contextWeights = getBehaviorWeights(ctx);
            const learnedWeights = memory?.getWeights();
            const merged: BehaviorWeightMap = { ...contextWeights };
            if (learnedWeights) {
                for (const key of Object.keys(merged) as BehaviorName[]) {
                    merged[key] = Math.max(1, contextWeights[key] * (learnedWeights[key] / 10));
                }
            }
            const safeRadius = estimateSafeRadius(bot);
            // On a tiny island (< 4 blocks usable), only do stationary behaviors
            if (safeRadius < 4) {
                const stationaryOnly: BehaviorWeightMap = {
                    stand_look: 30, look_at_sky: 25, crouch_fidget: 20,
                    look_at_player: 15, short_stroll: 5, long_walk: 0,
                    distracted_walk: 0, pace_back_forth: 5, circle_spot: 0,
                };
                const behavior = pickWeighted(stationaryOnly);
                // console.log(`[MovementAI] ${behavior} (tiny island, safeRadius=${safeRadius})`);

                stuckDuringBehavior = false;
                const startPos = bot.entity.position.clone();
                let lowestY = startPos.y;
                trackFall = () => { if (bot.entity) lowestY = Math.min(lowestY, bot.entity.position.y); };
                bot.on('physicsTick', trackFall);

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
            // console.log(`[MovementAI] ${behavior} (${ctx.timeOfDay}, players=${ctx.nearbyPlayers}, hostiles=${ctx.nearbyHostiles}, safeRadius=${safeRadius})`);

            stuckDuringBehavior = false;
            const startPos = bot.entity.position.clone();
            let lowestY = startPos.y;
            trackFall = () => {
                if (!bot.entity) return;
                lowestY = Math.min(lowestY, bot.entity.position.y);
            };
            bot.on('physicsTick', trackFall);

            switch (behavior) {
                case 'stand_look':      await doStandLook(bot); break;
                case 'short_stroll':    await doShortStroll(bot, getSafeMovements, memory, ...clampDist(3, 8)); break;
                case 'long_walk':       await doLongWalk(bot, getSafeMovements, memory, ...clampDist(8, 22)); break;
                case 'distracted_walk': await doDistractedWalk(bot, getSafeMovements, memory, ...clampDist(5, 15)); break;
                case 'crouch_fidget':   await doCrouchFidget(bot); break;
                case 'look_at_player':  await doLookAtPlayer(bot); break;
                case 'look_at_sky':     await doLookAtSky(bot); break;
                case 'pace_back_forth': await doPaceBackForth(bot, getSafeMovements, memory, ...clampDist(3, 6)); break;
                case 'circle_spot':     await doCircleSpot(bot, getSafeMovements, memory); break;
            }

            if (memory) {
                const endPos = bot.entity.position;
                const feetBlock = bot.blockAt(endPos.offset(0, 0, 0));
                const inWater = feetBlock?.name?.includes('water');
                const fell = (startPos.y - lowestY) > 4;
                const stuckFired = stuckDuringBehavior;
                const isStationaryBehavior = (
                    behavior === 'stand_look' ||
                    behavior === 'crouch_fidget' ||
                    behavior === 'look_at_player' ||
                    behavior === 'look_at_sky'
                );
                const stuck = !isStationaryBehavior && (
                    stuckFired ||
                    endPos.distanceTo(startPos) < 0.5
                );

                if (inWater) {
                    memory.penalize(behavior, 'water');
                    memory.addBadSpot(endPos, 'water');
                } else if (fell) {
                    memory.penalize(behavior, 'fell');
                    memory.addBadSpot(startPos, 'fell');
                } else if (stuck) {
                    memory.penalize(behavior, 'stuck');
                    memory.addBadSpot(endPos, 'stuck');
                } else {
                    memory.reward(behavior);
                }
            }

            return behavior;
        } catch (err) {
            // console.warn('[MovementAI] tick error:', (err as any).message);
            return null;
        } finally {
            if (trackFall) bot.off('physicsTick', trackFall);
            clearControls();
            active = false;
        }
        return null;
    }

    // Schedule ticks with variable delay (5–12s between each behavior)
    let ticksSinceObservation = 0;
    let lastBehavior: WanderBehavior | null = null;

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
        if (!bot.entity) return;
        const delay = nextDelay(lastBehavior);
        const t = setTimeout(async () => {
            const behaviorRan = await tick();
            if (behaviorRan) lastBehavior = behaviorRan;
            ticksSinceObservation++;
            if (memory && ticksSinceObservation >= 6) {
                ticksSinceObservation = 0;
                memory.updateBlockObservations(bot);
            }
            schedule();
        }, delay);
        intervals.push(t as any);
    }

    schedule();
}