import { Bot } from 'mineflayer';
import baritonePlugin from '@miner-org/mineflayer-baritone';
const baritoneGoals = baritonePlugin.goals;
import { Vec3 } from 'vec3';
import { sleep, safeGoto } from './utils.ts';
import { BotSession } from './session.ts';
import { BotState, getState } from './modules/state.ts';
import { addLog } from './core/store.ts';
import { isMovementSuppressed } from './movementAI.ts';

const STUCK_TICK_THRESHOLD = 80;
const MOVE_MIN = 0.06;

export function startStuckDetector(bot: Bot, setEscaping?: (v: boolean) => void, session?: BotSession) {
    let lastPos: Vec3 = bot.entity?.position.clone() ?? new Vec3(0, 0, 0);
    let stuckTicks = 0;
    let escaping = false;

    bot.on('physicsTick', () => {
        if (session && !session.alive) return;
        if (!bot.entity) return;
        if ((bot.health ?? 0) <= 0) return;

        const pos = bot.entity.position;
        const moved = pos.distanceTo(lastPos);
        lastPos = pos.clone();

        // A command (gcollect/gsurv/...) or a combat/flee task owns movement
        // right now — its pauses are digging/mining, not getting stuck. Never
        // hijack the task with an escape sequence.
        if (isMovementSuppressed() || session?.moveActive) {
            stuckTicks = 0;
            return;
        }

        const onGround = bot.entity.onGround;
        if (!onGround) {
            stuckTicks = 0;
            return;
        }

        // Ignore deliberate idle pauses: movementAI's stand_look / scheduling
        // gaps are SUPPOSED to keep the bot still. Only treat it as stuck when
        // the bot is actively pathing or a task/command owns movement.
        if (getState() === BotState.IDLE && !bot.ashfinder?.isPathing) {
            stuckTicks = 0;
            return;
        }

        // A command/task owns movement (collect, survival, combat, flee): the
        // pause is deliberate (digging, looting, strafing). Don't hijack it —
        // those tasks have their own failure handling, and the escape would
        // fight their active baritone path.
        if (isMovementSuppressed() || session?.moveActive) {
            stuckTicks = 0;
            return;
        }

        if (moved < MOVE_MIN) {
            stuckTicks++;
        } else {
            stuckTicks = 0;
        }

        if (stuckTicks >= STUCK_TICK_THRESHOLD && !escaping) {
            stuckTicks = 0;
            unstuck(bot, pos.clone()).catch(err => {
                addLog('error', `[STUCK] Unstuck handler error: ${(err as any)?.message ?? err}`);
            });
        }
    });

    let recentStucks = 0;
    let stuckResetTimer: NodeJS.Timeout | null = null;

    async function unstuck(bot: Bot, stuckPos: Vec3) {
        if (session && !session.alive) return;
        recentStucks++;
        if (stuckResetTimer) clearTimeout(stuckResetTimer);
        stuckResetTimer = setTimeout(() => { recentStucks = 0; }, 30000);

        // If stuck more than 4 times in 30s, just wait it out — pathfinding isn't helping
        if (recentStucks > 4) {
            addLog('warn', `[STUCK] Firing too frequently (${recentStucks}x) — pausing movement for 10s`);
            escaping = true;
            setEscaping?.(true);
            await sleep(10000);
            if (session && !session.alive) return;
            escaping = false;
            setEscaping?.(false);
            recentStucks = 0;
            return;
        }

        escaping = true;
        setEscaping?.(true);
        addLog('warn', `[STUCK] Detected stuck at ${stuckPos.floored()} — escaping`);

        // Drop any active baritone path BEFORE jiggling controls, otherwise the
        // task that got us stuck keeps re-asserting its own control states and
        // the manual escape is fought (and the safety goto throws
        // "Already navigating").
        try { bot.ashfinder?.stop(); } catch {}

        try {
            bot.setControlState('jump', true);
            await sleep(400);
            bot.setControlState('jump', false);

            const randomYaw = Math.random() * Math.PI * 2;
            await bot.look(randomYaw, 0, true);
            bot.setControlState('sprint', true);
            bot.setControlState('forward', true);
            await sleep(800);

            bot.setControlState('jump', true);
            await sleep(300);
            bot.setControlState('jump', false);

            await sleep(400);
        } finally {
            // If the session died mid-escape, skip touching the dead bot's
            // controls or issuing any new pathfinding.
            if (!session || session.alive) {
                bot.setControlState('forward', false);
                bot.setControlState('sprint', false);
                bot.setControlState('jump', false);

                const stillNear = (bot.entity?.position.distanceTo(stuckPos) ?? 0) < 3;
                if (stillNear) {
                    try {
                        const safeSpot = findSafeSpot(bot, stuckPos, 5);
                        if (safeSpot) {
                            if (bot.ashfinder?.config) {
                                bot.ashfinder.config.breakBlocks = true;
                            }
                            // safeGoto, never bare ashfinder.goto(): the bare
                            // call never rejects and can hold the "Already
                            // navigating" lock forever on an unreachable spot.
                            await safeGoto(bot, new baritoneGoals.GoalExact(new Vec3(safeSpot.x, safeSpot.y, safeSpot.z)));
                        }
                    } catch (err) {
                        addLog('warn', `[STUCK] Could not pathfind to safety: ${(err as any).message}`);
                    }
                }
            }

            escaping = false;
            setEscaping?.(false);
            addLog('system', `[STUCK] Escape complete`);
        }
    }

    function findSafeSpot(bot: Bot, fromPos: Vec3, minDistance: number): Vec3 | null {
        for (let distance = minDistance; distance <= minDistance + 10; distance++) {
            for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 4) {
                const x = Math.round(fromPos.x + Math.cos(angle) * distance);
                const z = Math.round(fromPos.z + Math.sin(angle) * distance);
                const y = findGroundLevel(bot, x, z, Math.round(fromPos.y));
                if (y !== null) return new Vec3(x, y, z);
            }
        }
        return null;
    }

    function findGroundLevel(bot: Bot, x: number, z: number, startY: number): number | null {
        for (let y = startY - 3; y <= startY + 3; y++) {
            const block = bot.blockAt(new Vec3(x, y, z));
            if (block && block.boundingBox === 'block') return y + 1;
        }
        return null;
    }
}