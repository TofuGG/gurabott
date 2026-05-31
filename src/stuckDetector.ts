import { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';

const STUCK_TICK_THRESHOLD = 60;   // ~3 seconds of not moving = stuck
const MOVE_MIN = 0.06;             // blocks/tick minimum to count as moving

export function startStuckDetector(bot: Bot) {
    let lastPos: Vec3 = bot.entity?.position.clone() ?? new Vec3(0, 0, 0);
    let stuckTicks = 0;
    let escaping = false;

    bot.on('physicsTick', () => {
        if (!bot.entity) return;

        const pos = bot.entity.position;
        const moved = pos.distanceTo(lastPos);
        lastPos = pos.clone();

        // Don't count as stuck while airborne
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

    async function unstuck(bot: Bot, stuckPos: Vec3) {
        escaping = true;
        console.log('[STUCK] Detected stuck at', stuckPos.toString(), '— escaping');

        try {
            // Step 1: jump in case it's a 1-block ledge trapping us
            bot.setControlState('jump', true);
            await sleep(400);
            bot.setControlState('jump', false);

            // Step 2: pick a random horizontal direction and sprint away for 1s
            const randomYaw = Math.random() * Math.PI * 2;
            await bot.look(randomYaw, 0, true);
            bot.setControlState('sprint', true);
            bot.setControlState('forward', true);
            await sleep(800);

            // Step 3: jump again mid-sprint to clear any 1-high obstacle
            bot.setControlState('jump', true);
            await sleep(300);
            bot.setControlState('jump', false);

            await sleep(400);
        } finally {
            bot.setControlState('forward', false);
            bot.setControlState('sprint', false);
            bot.setControlState('jump', false);

            // Step 4: if still near the stuck position, use pathfinder to reach a
            // safe block further away
            const stillNear = bot.entity?.position.distanceTo(stuckPos) ?? 0;
            if (stillNear < 3) {
                try {
                    // Find a safe destination 5+ blocks away
                    const safeSpot = findSafeSpot(bot, stuckPos, 5);
                    if (safeSpot) {
                        const { goals } = await import('mineflayer-pathfinder');
                        await bot.pathfinder.goto(new goals.GoalBlock(safeSpot.x, safeSpot.y, safeSpot.z));
                    }
                } catch (err) {
                    console.warn('[STUCK] Could not pathfind to safety:', (err as any).message);
                }
            }
        }

        escaping = false;
    }

    function findSafeSpot(bot: Bot, fromPos: Vec3, minDistance: number): Vec3 | null {
        // Try to find a safe standing block at least minDistance away
        for (let distance = minDistance; distance <= minDistance + 10; distance++) {
            for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 4) {
                const x = Math.round(fromPos.x + Math.cos(angle) * distance);
                const z = Math.round(fromPos.z + Math.sin(angle) * distance);
                const y = findGroundLevel(bot, x, z, Math.round(fromPos.y));
                if (y !== null) {
                    return new Vec3(x, y, z);
                }
            }
        }
        return null;
    }

    function findGroundLevel(bot: Bot, x: number, z: number, startY: number): number | null {
        for (let y = startY + 3; y >= startY - 3; y--) {
            const block = bot.blockAt(new Vec3(x, y, z));
            if (block && block.boundingBox === 'block') {
                return y + 1;
            }
        }
        return null;
    }
}

function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
