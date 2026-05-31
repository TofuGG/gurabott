import { Bot } from 'mineflayer';
import pathfinderLib from 'mineflayer-pathfinder';
const { goals } = pathfinderLib;
import { Vec3 } from 'vec3';
import { sleep } from './utils.ts';

const STUCK_TICK_THRESHOLD = 60;
const MOVE_MIN = 0.06;

export function startStuckDetector(bot: Bot, setEscaping?: (v: boolean) => void) {
    let lastPos: Vec3 = bot.entity?.position.clone() ?? new Vec3(0, 0, 0);
    let stuckTicks = 0;
    let escaping = false;

    bot.on('physicsTick', () => {
        if (!bot.entity) return;

        const pos = bot.entity.position;
        const moved = pos.distanceTo(lastPos);
        lastPos = pos.clone();

        const onGround = bot.entity.onGround;
        if (!onGround) {
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
            unstuck(bot, pos.clone());
        }
    });

    let recentStucks = 0;
    let stuckResetTimer: NodeJS.Timeout | null = null;

    async function unstuck(bot: Bot, stuckPos: Vec3) {
        recentStucks++;
        if (stuckResetTimer) clearTimeout(stuckResetTimer);
        stuckResetTimer = setTimeout(() => { recentStucks = 0; }, 30000);

        // If stuck more than 4 times in 30s, just wait it out — pathfinding isn't helping
        if (recentStucks > 4) {
            console.log(`[STUCK] Firing too frequently (${recentStucks}x) — pausing movement for 10s`);
            escaping = true;
            setEscaping?.(true);
            await sleep(10000);
            escaping = false;
            setEscaping?.(false);
            recentStucks = 0;
            return;
        }

        escaping = true;
        setEscaping?.(true);
        console.log('[STUCK] Detected stuck at', stuckPos.toString(), '— escaping');

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
            bot.setControlState('forward', false);
            bot.setControlState('sprint', false);
            bot.setControlState('jump', false);

            const stillNear = (bot.entity?.position.distanceTo(stuckPos) ?? 0) < 3;
            if (stillNear) {
                try {
                    const safeSpot = findSafeSpot(bot, stuckPos, 5);
                    if (safeSpot) {
                        await bot.pathfinder.goto(new goals.GoalBlock(safeSpot.x, safeSpot.y, safeSpot.z));
                    }
                } catch (err) {
                    console.warn('[STUCK] Could not pathfind to safety:', (err as any).message);
                }
            }

            escaping = false;
            setEscaping?.(false);
            console.log('[STUCK] Escape complete');
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
        for (let y = startY + 3; y >= startY - 3; y--) {
            const block = bot.blockAt(new Vec3(x, y, z));
            if (block && block.boundingBox === 'block') return y + 1;
        }
        return null;
    }
}