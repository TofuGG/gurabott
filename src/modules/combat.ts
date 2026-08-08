/**
 * combat.ts - Hostile-mob combat & flee controller (extracted from bot.ts).
 *
 * Fight if ≤3 hostile mobs are nearby; flee if overwhelmed or low HP.
 */

import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import baritonePlugin from '@miner-org/mineflayer-baritone';
import { BotState, getState, setState } from './state.ts';
import { addLog } from '../core/store.ts';
import { HOSTILE_MOBS } from '../constants.ts';
import type { BotSession } from '../session.ts';
import { getBestWeapon } from './mining.ts';
import { safeGoto } from '../utils.ts';

const baritoneGoals = baritonePlugin.goals;

export type CombatController = {
    isHostileEntity: (e: any) => boolean;
    countNearbyHostiles: () => number;
    getNearestHostile: () => any;
    startCombat: (target: any) => void;
    stopCombat: () => void;
    doFlee: (threat: any) => void;
    /** Register entityMoved + the 2s hostile scan. Returns a cleanup fn. */
    startHostileMonitoring: () => () => void;
};

export function createCombatController(opts: {
    bot: Bot;
    session: BotSession;
    intervals: NodeJS.Timeout[];
    configureBaritone: (overrides?: Record<string, any>) => void;
}): CombatController {
    const { bot, session, intervals, configureBaritone } = opts;

    let combatActive = false;
    let combatTimer: NodeJS.Timeout | null = null;

    function isHostileEntity(e: any): boolean {
        if (!e?.position || !e.name) return false;
        // mineflayer reports baby zombies and chicken jockeys as type 'mob' with name 'zombie'
        // Some versions report jockey riders with type 'mob' or no type — check both
        const name = e.name.toLowerCase();
        const validType = e.type === 'mob' || e.type === 'hostile' || !e.type;
        return validType && HOSTILE_MOBS.has(name);
    }

    function countNearbyHostiles(): number {
        return Object.values(bot.entities as Record<string, any>).filter(e =>
            isHostileEntity(e) &&
            e.position?.distanceTo(bot.entity.position) < 10
        ).length;
    }

    function getNearestHostile(): any {
        let nearest: any = null;
        let minDist = Infinity;
        for (const e of Object.values(bot.entities as Record<string, any>)) {
            if (!isHostileEntity(e)) continue;
            const d = e.position?.distanceTo(bot.entity.position) ?? Infinity;
            if (d < minDist) { minDist = d; nearest = e; }
        }
        return nearest;
    }

    function stopCombat() {
        if (combatTimer) {
            clearInterval(combatTimer);
            const idx = intervals.indexOf(combatTimer);
            if (idx !== -1) intervals.splice(idx, 1);
            combatTimer = null;
        }
        combatActive = false;
        session.moveActive = false;
        if (getState() === BotState.ATTACKING || getState() === BotState.FLEEING) {
            setState(BotState.IDLE);
        }
    }

    function startCombat(target: any) {
        if (combatActive) return;
        combatActive = true;
        setState(BotState.ATTACKING);
        session.moveActive = true;
        // Cancel any in-flight idle-wander path so followEntity can take over —
        // baritone's goto() throws "Already navigating" if a path is still
        // active, which previously made the bot keep wandering instead of fighting.
        try { bot.ashfinder.stop(); } catch {}
        addLog('system', `[BOT] ⚔ Fighting ${target.name} at distance ${Math.round(target.position?.distanceTo(bot.entity.position) ?? 0)}`);

        // Equip best weapon
        const weapon = getBestWeapon(bot);
        if (weapon) bot.equip(weapon, 'hand').catch(() => {});

        configureBaritone();
        bot.ashfinder.followEntity(target, { distance: 1 }).catch(() => {});

        combatTimer = setInterval(() => {
            const hp = bot.health ?? 20;

            // Flee if HP critical or mob count overwhelming
            if (hp <= 5 || countNearbyHostiles() > 5) {
                stopCombat();
                doFlee(target);
                return;
            }

            // Target dead or gone
            const still = bot.entities[target.id];
            if (!still || still.position?.distanceTo(bot.entity.position) > 20) {
                // Check for other nearby mobs to chain-fight
                const next = getNearestHostile();
                if (next && next.position?.distanceTo(bot.entity.position) < 10) {
                    stopCombat();
                    startCombat(next);
                } else {
                    stopCombat();
                }
                return;
            }

            // Attack if in range
            if (still.position?.distanceTo(bot.entity.position) < 4) {
                try { bot.attack(still); } catch {}
            }
        }, 500);

        intervals.push(combatTimer);
    }

    function doFlee(threat: any) {
        if (getState() === BotState.FLEEING) return;
        setState(BotState.FLEEING);
        session.moveActive = true;
        // Same as startCombat: stop any active path so the flee goal can take
        // over instead of fighting the "Already navigating" error.
        try { bot.ashfinder.stop(); } catch {}
        addLog('system', `[BOT] 🏃 Fleeing from ${threat.name} (HP: ${Math.round(bot.health ?? 20)})`);

        configureBaritone({ allowSprinting: true });

        // Keep recalculating flee destination every 800ms so bot never stops
        let fleeNavBusy = false;
        async function updateFleeGoal() {
            if (fleeNavBusy) return;
            if (getState() !== BotState.FLEEING || !bot?.entity) return;
            const botPos    = bot.entity.position;
            const threatPos = threat.position ?? botPos;
            const dx  = botPos.x - threatPos.x;
            const dz  = botPos.z - threatPos.z;
            const len = Math.sqrt(dx * dx + dz * dz) || 1;
            const runX = botPos.x + (dx / len) * 16;
            const runZ = botPos.z + (dz / len) * 16;
            // safeGoto, never bare ashfinder.goto(): the bare call never
            // rejects and a stalled path leaves isPathing=true, freezing the
            // flee (no more goal refreshes). A short cap keeps legs fresh.
            fleeNavBusy = true;
            try {
                if (!bot.ashfinder.isPathing) {
                    await safeGoto(bot, new baritoneGoals.GoalExact(new Vec3(Math.round(runX), Math.round(botPos.y), Math.round(runZ))), 4000);
                }
            } catch {} finally {
                fleeNavBusy = false;
            }
        }

        void updateFleeGoal();
        const fleeInterval = setInterval(() => { void updateFleeGoal(); }, 800);
        intervals.push(fleeInterval as any);

        const dropInterval = () => {
            const idx = intervals.indexOf(fleeInterval as any);
            if (idx !== -1) intervals.splice(idx, 1);
        };

        // Stop fleeing after 6s or when threat is gone
        const fleeStopTimer = setTimeout(() => {
            clearInterval(fleeInterval);
            dropInterval();
            session.moveActive = false;
            if (getState() === BotState.FLEEING) {
                bot.ashfinder.stop();
                setState(BotState.IDLE);
            }
        }, 6000);
        intervals.push(fleeStopTimer as any);
    }

    function startHostileMonitoring(): () => void {
        // Trigger combat/flee whenever a mob moves into range
        const onEntityMoved = (entity: any) => {
            if (!bot?.entity) return;
            if (!isHostileEntity(entity)) return;
            if (combatActive) return;
            if (getState() === BotState.FLEEING || getState() === BotState.SLEEPING || getState() === BotState.COLLECTING) return;
            if ((bot.health ?? 20) <= 0) return;

            const dist = bot.entity.position.distanceTo(entity.position);
            if (dist >= 8) return;

            const mobCount = countNearbyHostiles();
            if (mobCount <= 3) {
                startCombat(entity);
            } else if (mobCount > 3) {
                doFlee(entity);
            }
        };
        bot.on('entityMoved', onEntityMoved);

        // Also scan for mobs every 2s even if they haven't moved (handles spawns)
        const hostileScanInterval = setInterval(() => {
            if (!bot?.entity || combatActive) return;
            if ((bot.health ?? 20) <= 0) return;
            if (getState() === BotState.FLEEING || getState() === BotState.SLEEPING || getState() === BotState.COLLECTING) return;
            const nearest = getNearestHostile();
            if (!nearest) return;
            const dist = nearest.position?.distanceTo(bot.entity.position) ?? Infinity;
            if (dist < 8) {
                const mobCount = countNearbyHostiles();
                if (mobCount <= 3) startCombat(nearest);
                else doFlee(nearest);
            }
        }, 2000);
        intervals.push(hostileScanInterval as any);

        return () => {
            bot.removeListener('entityMoved', onEntityMoved);
            clearInterval(hostileScanInterval);
            const idx = intervals.indexOf(hostileScanInterval as any);
            if (idx !== -1) intervals.splice(idx, 1);
        };
    }

    return {
        isHostileEntity,
        countNearbyHostiles,
        getNearestHostile,
        startCombat,
        stopCombat,
        doFlee,
        startHostileMonitoring,
    };
}
