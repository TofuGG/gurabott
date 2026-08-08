/**
 * water.ts - Water-survival intervals (extracted from bot.ts spawn handler).
 *
 * A 3s cadence call-for-help when the head is underwater, plus a 1s
 * self-rescue loop that swims the bot to shore when it is stuck in water.
 */

import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import baritonePlugin from '@miner-org/mineflayer-baritone';
import { BotState, getState } from './state.ts';
import { addLog } from '../core/store.ts';
import { getRandom } from '../utils.ts';

const baritoneGoals = baritonePlugin.goals;

export function startWaterSurvival(opts: {
    bot: Bot;
    intervals: NodeJS.Timeout[];
    waterHelpMessages: string[];
}): void {
    const { bot, intervals, waterHelpMessages } = opts;

    intervals.push(setInterval(() => {
        if (!bot?.entity) return;
        const headBlock = bot.blockAt(bot.entity.position.offset(0, 1, 0));
        if (headBlock?.name?.includes('water')) {
            if (waterHelpMessages.length > 0) bot.chat(getRandom(waterHelpMessages));
        }
    }, 3000));

    let waterEscaping = false;
    intervals.push(setInterval(async () => {
        try {
            if (!bot?.entity?.position || waterEscaping) return;
            // If baritone is actively pathing, let it handle swimming —
            // manually forcing jump/forward would fight the active path.
            if (bot.ashfinder?.isPathing) return;

            // Intervene whenever the bot isn't in the middle of a task that
            // owns its controls. IDLE and FOLLOWING are safe; mining,
            // combat, eating and sleeping tasks own the controls.
            const taskState = getState();
            if (taskState !== BotState.IDLE && taskState !== BotState.FOLLOWING) return;

            const headBlock = bot.blockAt(bot.entity.position.offset(0, 1, 0));
            const feetBlock = bot.blockAt(bot.entity.position.offset(0, 0, 0));
            const isInWater = headBlock?.name?.includes('water') || feetBlock?.name?.includes('water');
            if (!isInWater) {
                bot.setControlState('jump', false);
                bot.setControlState('forward', false);
                return;
            }

            const botY = Math.floor(bot.entity.position.y);
            const shore = bot.findBlock({
                matching: (block) => !!(
                    block?.name &&
                    !block.name.includes('water') &&
                    block.boundingBox === 'block' &&
                    block.position?.y >= botY
                ),
                maxDistance: 20,
            });

            if (shore) {
                await bot.lookAt(shore.position.offset(0.5, 1, 0.5));
                bot.setControlState('jump', true);
                bot.setControlState('forward', true);
            } else {
                waterEscaping = true;
                bot.setControlState('jump', false);
                bot.setControlState('forward', false);
                try {
                    const dryLand = bot.findBlock({
                        matching: (block) => !!(block?.name && !block.name.includes('water') && block.boundingBox === 'block'),
                        maxDistance: 32,
                    });
                    if (dryLand) {
                        try { await bot.ashfinder.goto(new baritoneGoals.GoalExact(new Vec3(dryLand.position.x, dryLand.position.y + 1, dryLand.position.z))); } catch {}
                    }
                } catch {
                    bot.setControlState('jump', true);
                } finally {
                    waterEscaping = false;
                }
            }
        } catch (err: any) {
            addLog('error', `[BOT] Water escape interval error: ${err?.message ?? err}`);
        }
    }, 1000));
}
