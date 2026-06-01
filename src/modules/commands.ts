/**
 * commands.ts - All bot command handlers
 * Handles parsing and execution of every g-prefixed command.
 */

import type { Bot } from 'mineflayer';
import pathfinderLib from 'mineflayer-pathfinder';
import minecraftData from 'minecraft-data';
import { sleep } from '../utils.ts';
import { addLog } from './tui.ts';
import { BotState, getState, setState, clearAllControls } from './state.ts';
import { startSurv, stopSurv, isSurvRunning } from './survival.ts';

const { goals } = pathfinderLib;
const { GoalBlock, GoalGetToBlock, GoalFollow } = goals;

// ── Types ─────────────────────────────────────────────────────────────────────

export type CommandContext = {
    bot: Bot;
    personality: any;
    getSafeMovements: () => any;
    intervals: NodeJS.Timeout[];
    collecting: { active: boolean; summary: Record<string, number> };
    lastPlayerJoined: () => string | null;
    HOSTILE_MOBS: Set<string>;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function getRandomDelay(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function getBestWeapon(bot: Bot): any | null {
    const priorities = [
        ['netherite_axe', 'diamond_axe', 'iron_axe', 'stone_axe', 'golden_axe', 'wooden_axe'],
        ['netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'golden_sword', 'wooden_sword'],
    ];
    for (const group of priorities) {
        for (const name of group) {
            const found = bot.inventory.items().find(i => i.name === name);
            if (found) return found;
        }
    }
    return null;
}

function formatMsg(template: string, vars: Record<string, string>): string {
    let out = template;
    for (const [k, v] of Object.entries(vars)) {
        out = out.replaceAll(`{${k}}`, v);
    }
    return out;
}

// ── Command registry ──────────────────────────────────────────────────────────

type CommandFn = (ctx: CommandContext, username: string, args: string[]) => Promise<void>;

const commands: Record<string, CommandFn> = {

    async gping({ bot }) {
        bot.chat(`Pong! ${bot.player?.ping ?? '?'}ms`);
    },

    async ghelp({ bot, personality }) {
        const helpMessages = [
            'Commands:',
            'gping, ghelp, gsay, ginv, ginvsee, geat, gjump, gdrop, gwalk, gcr, gcords, gtp',
            'gfollow <player>, gcraft <item>, gdump, gkill <mob|player>, glast, gsfollow',
            'gcollect <wood|stone|dirt> <amount>, gsleep, gopendoor, gscollect',
        ];
        for (const line of helpMessages) {
            await sleep(getRandomDelay(500, 900));
            try { bot.chat(line); } catch {}
        }
    },

    async gsay({ bot }, _username, args) {
        if (args.length === 0) { bot.chat('Usage: gsay <message>'); return; }
        bot.chat(args.join(' '));
    },

    async ginv({ bot, personality }) {
        const items = bot.inventory.items();
        bot.chat(items.length === 0 ? personality.messages.emptyInventory : `${items.length} items`);
    },

    async ginvsee({ bot, personality }) {
        const items = bot.inventory.items();
        if (!items || items.length === 0) { bot.chat(personality.messages.emptyInventory); return; }
        bot.chat(items.map((item, idx) => `${idx + 1}. ${item.name ?? 'unknown'} x${item.count ?? 0}`).join(', '));
    },

    async geat({ bot, personality }, _username, args) {
        if (getState() !== BotState.IDLE) { bot.chat(personality.messages.busy); return; }

        const eatItems = bot.inventory.items();

        if (args.length === 0) {
            if (eatItems.length === 0) { bot.chat(personality.messages.noFood); return; }
            bot.chat(eatItems.map((item, idx) => `${idx + 1}. ${item.name} x${item.count}`).join(', '));
            bot.chat('Usage: geat <food_number> <amount>');
            return;
        }

        const foodIdx = parseInt(args[0], 10) - 1;
        const amount = Math.max(1, parseInt(args[1], 10) || 1);

        if (Number.isNaN(foodIdx) || foodIdx < 0 || foodIdx >= eatItems.length) {
            bot.chat(personality.messages.invalidFoodNumber);
            return;
        }

        const food = eatItems[foodIdx];
        setState(BotState.EATING);
        let eaten = 0;

        try {
            await bot.equip(food, 'hand');
            for (let i = 0; i < amount && bot.food < 20; i++) {
                await bot.consume();
                eaten++;
                await sleep(500);
                if (bot.food >= 20) { bot.chat(personality.messages.fullStomach); break; }
            }
            bot.chat(`Ate ${eaten} ${food.name}`);
        } catch { bot.chat(personality.messages.couldntEat); }
        finally { setState(BotState.IDLE); }
    },

    async gjump({ bot }, _username, args) {
        const amount = Math.max(1, parseInt(args[0], 10) || 1);
        for (let i = 0; i < amount; i++) {
            bot.setControlState('jump', true);
            await sleep(500);
            bot.setControlState('jump', false);
            if (i < amount - 1) await sleep(250);
        }
    },

    async gdrop({ bot, personality }, _username, args) {
        const dropItems = bot.inventory.items();
        if (args.length === 0) {
            if (dropItems.length === 0) { bot.chat(personality.messages.nothingToDrop); return; }
            bot.chat(dropItems.map((item, idx) => `${idx + 1}. ${item.name} x${item.count}`).join(', '));
            bot.chat('Usage: gdrop <item_number> <amount>');
            return;
        }
        const itemIdx = parseInt(args[0], 10) - 1;
        const amount = parseInt(args[1], 10) || 1;
        if (isNaN(itemIdx) || itemIdx < 0 || itemIdx >= dropItems.length) {
            bot.chat(personality.messages.invalidItemNumber);
            return;
        }
        const item = dropItems[itemIdx];
        if (amount > item.count) {
            bot.chat(formatMsg(personality.messages.onlyHave, { count: String(item.count), item: item.name }));
            return;
        }
        bot.chat(formatMsg(personality.messages.droppingItems, { amount: String(amount), item: item.name }));
        await bot.toss(item.type, null, Math.min(amount, item.count));
    },

    async gwalk({ bot }) {
        bot.setControlState('forward', true);
        await sleep(500);
        bot.setControlState('forward', false);
    },

    async gcr({ bot }, _username, args) {
        const seconds = Math.max(1, parseInt(args[0], 10) || 1);
        bot.setControlState('sneak', true);
        await sleep(seconds * 1000);
        bot.setControlState('sneak', false);
    },

    async gcords({ bot }) {
        const pos = bot.entity?.position;
        if (!pos) { bot.chat('Unknown position'); return; }
        bot.chat(`${Math.round(pos.x)}, ${Math.round(pos.y)}, ${Math.round(pos.z)}`);
    },

    async gtp({ bot }, _username, args) {
        const [x, y, z] = args;
        if (!x || !y || !z) { bot.chat('Usage: gtp <x> <y> <z>'); return; }

        const onMessage = (jsonMsg: any) => {
            const msg = jsonMsg.toString();
            if (
                msg.includes('Unknown command') || msg.includes('no permission') ||
                msg.includes('not a valid number') || msg.includes('cannot be found')
            ) {
                bot.chat('No permission for /tp.');
                bot.removeListener('message', onMessage);
            }
        };
        bot.once('message', onMessage);
        bot.chat(`/tp ${bot.username} ${x} ${y} ${z}`);
        setTimeout(() => bot.removeListener('message', onMessage), 3000);
    },

    async gfollow({ bot, personality, getSafeMovements }, username, args) {
        let targetName = args[0];
        if (!targetName) { bot.chat('Usage: gfollow <player>'); return; }
        if (targetName.toLowerCase() === 'me') targetName = username;

        const playerEntity = bot.players[targetName]?.entity;
        if (!playerEntity) {
            bot.chat(formatMsg(personality.messages.cantSeePlayer, { player: targetName }));
            return;
        }
        setState(BotState.FOLLOWING);
        bot.chat(formatMsg(personality.messages.followingPlayer, { player: targetName }));
        bot.pathfinder.setMovements(getSafeMovements());
        bot.pathfinder.setGoal(new GoalFollow(playerEntity, 1), true);
    },

    async gsfollow({ bot, personality }) {
        if (getState() === BotState.FOLLOWING) {
            setState(BotState.IDLE);
            bot.chat(personality.messages.stoppedFollowing);
        } else {
            bot.chat(personality.messages.notFollowing);
        }
    },

    async gcraft({ bot, personality }, _username, args) {
        const itemName = args[0];
        if (!itemName) { bot.chat('Usage: gcraft <item_name>'); return; }

        const mcData = minecraftData(bot.version);
        const item = mcData.itemsByName[itemName];
        if (!item) {
            bot.chat(formatMsg(personality.messages.unknownItem, { item: itemName }));
            return;
        }
        const recipe = bot.recipesFor(item.id, null, 1, null)[0];
        if (!recipe) {
            bot.chat(formatMsg(personality.messages.unknownItem, { item: itemName }));
            return;
        }

        let craftingTable = null;
        if (recipe.requiresTable) {
            const tableId = mcData.blocksByName.crafting_table?.id;
            if (!tableId) { bot.chat(personality.messages.noCraftingTable); return; }
            craftingTable = bot.findBlock({ matching: tableId, maxDistance: 6 });
            if (!craftingTable) { bot.chat(personality.messages.noCraftingTable); return; }
        }

        try {
            await bot.craft(recipe, 1, craftingTable ?? undefined);
            bot.chat(formatMsg(personality.messages.craftedItem, { item: itemName }));
        } catch (err: any) {
            bot.chat(formatMsg(personality.messages.craftFailed, { error: err?.message ?? 'unknown' }));
        }
    },

    async gdump({ bot, personality }) {
        const items = bot.inventory.items();
        if (items.length === 0) { bot.chat(personality.messages.nothingToDrop); return; }
        bot.chat(personality.messages.droppingEverything);
        for (const item of items) {
            try {
                await bot.tossStack(item);
                await sleep(150);
            } catch {}
        }
    },

    async gkill({ bot, personality, intervals }, _username, args) {
        const killTarget = args[0]?.toLowerCase();
        if (!killTarget) { bot.chat('Usage: gkill <mob|player name>'); return; }

        const weapon = getBestWeapon(bot);

        // Check for player first
        const playerEntry = (Object.values(bot.players) as any[]).find(
            p => p.username?.toLowerCase() === killTarget
        );
        const playerEntity = playerEntry?.entity;

        if (playerEntry && !playerEntity) {
            bot.chat(formatMsg(personality.messages.cantSeePlayer, { player: playerEntry.username }));
            return;
        }

        if (playerEntity) {
            bot.chat(formatMsg(personality.messages.attackingPlayer, { player: playerEntry.username }));
            if (weapon && bot.heldItem?.name !== weapon.name) {
                try { await bot.equip(weapon, 'hand'); } catch {}
            }
            setState(BotState.ATTACKING);
            bot.pathfinder.setGoal(new GoalFollow(playerEntity, 1), true);

            const attackInterval = setInterval(() => {
                const stillExists = bot.players[playerEntry.username]?.entity;
                if (!stillExists) {
                    clearInterval(attackInterval);
                    intervals.splice(intervals.indexOf(attackInterval), 1);
                    bot.pathfinder.setGoal(null);
                    setState(BotState.IDLE);
                    bot.chat(formatMsg(personality.messages.playerGone, { player: playerEntry.username }));
                    return;
                }
                try { bot.attack(stillExists); } catch {}
            }, 600);
            intervals.push(attackInterval);
            return;
        }

        // Check for mob
        const mobEntity = (Object.values(bot.entities) as any[]).find(e =>
            e.type === 'mob' && e.name?.toLowerCase() === killTarget
        );

        if (mobEntity) {
            bot.chat(formatMsg(personality.messages.attackingMob, { mob: killTarget }));
            if (weapon && bot.heldItem?.name !== weapon.name) {
                try { await bot.equip(weapon, 'hand'); } catch {}
            }
            setState(BotState.ATTACKING);
            bot.pathfinder.setGoal(new GoalFollow(mobEntity, 1), true);

            const attackInterval = setInterval(() => {
                const stillExists = bot.entities[mobEntity.id];
                if (!stillExists) {
                    clearInterval(attackInterval);
                    intervals.splice(intervals.indexOf(attackInterval), 1);
                    bot.pathfinder.setGoal(null);
                    setState(BotState.IDLE);
                    bot.chat(formatMsg(personality.messages.mobDead, { mob: killTarget }));
                    return;
                }
                try { bot.attack(stillExists); } catch {}
            }, 600);
            intervals.push(attackInterval);
            return;
        }

        bot.chat(formatMsg(personality.messages.cantFindTarget, { target: killTarget }));
    },

    async glast({ bot, personality }, _username, _args, ctx) {
        // lastPlayerJoined is passed via ctx binding
        const last = ctx?.lastPlayerJoined();
        bot.chat(last
            ? formatMsg(personality.messages.lastPlayerJoined, { player: last })
            : personality.messages.nobodyJoined
        );
    },

    async gsleep({ bot, personality, getSafeMovements }) {
        if (getState() !== BotState.IDLE) { bot.chat(personality.messages.busy); return; }

        const bed = bot.findBlock({
            matching: (block) => block?.name?.endsWith('_bed') && block.metadata === 0,
            maxDistance: 32,
        });
        if (!bed) { bot.chat(personality.messages.noBedNearby); return; }
        if (bot.entity.position.distanceTo(bed.position) > 12) {
            bot.chat(personality.messages.bedTooFar);
            return;
        }

        setState(BotState.SLEEPING);
        try {
            bot.chat(personality.messages.goingToSleep);
            bot.pathfinder.setMovements(getSafeMovements());
            try {
                await bot.pathfinder.goto(new GoalBlock(bed.position.x, bed.position.y, bed.position.z));
            } catch {
                bot.chat(personality.messages.cantReachBed);
                setState(BotState.IDLE);
                return;
            }
            await bot.sleep(bed);
        } catch (err: any) {
            const msg = err?.message?.toLowerCase?.() ?? '';
            if (msg.includes('day'))      bot.chat(personality.messages.notNight);
            else if (msg.includes('monster')) bot.chat(personality.messages.monstersNearby);
            else if (msg.includes('obstructed')) bot.chat(personality.messages.bedBlocked);
            else bot.chat(personality.messages.cantSleep);
        } finally {
            try { bot.pathfinder.setGoal(null); } catch {}
            setState(BotState.IDLE);
        }
    },

    async gopendoor({ bot, personality, getSafeMovements }) {
        const doorNames = [
            'oak_door', 'spruce_door', 'birch_door', 'jungle_door', 'acacia_door',
            'dark_oak_door', 'mangrove_door', 'cherry_door', 'crimson_door', 'warped_door',
            'iron_door', 'oak_trapdoor', 'spruce_trapdoor', 'birch_trapdoor', 'jungle_trapdoor',
            'acacia_trapdoor', 'dark_oak_trapdoor', 'mangrove_trapdoor', 'iron_trapdoor',
        ];
        const door = bot.findBlock({
            matching: (block) => doorNames.includes(block.name),
            maxDistance: 16,
        });
        if (!door) { bot.chat(personality.messages.noDoorNearby); return; }

        try {
            bot.pathfinder.setMovements(getSafeMovements());
            await bot.pathfinder.goto(new GoalGetToBlock(door.position.x, door.position.y, door.position.z));
            const freshDoor = bot.blockAt(door.position);
            if (!freshDoor) return;
            if (freshDoor.getProperties?.()?.['open'] === 'true') {
                bot.chat(personality.messages.doorAlreadyOpen);
                return;
            }
            await bot.activateBlock(freshDoor);
            bot.chat(personality.messages.doorOpened);
        } catch { bot.chat(personality.messages.cantReachDoor); }
    },

    async gcollect({ bot, personality, getSafeMovements, collecting }, _username, args) {
        const resourceGroups: Record<string, string[]> = {
            wood: [
                'oak_log', 'acacia_log', 'birch_log', 'dark_oak_log', 'jungle_log',
                'mangrove_log', 'spruce_log', 'oak_wood', 'acacia_wood', 'birch_wood',
                'dark_oak_wood', 'jungle_wood', 'mangrove_wood', 'spruce_wood',
            ],
            stone: ['stone', 'cobblestone'],
            dirt:  ['dirt'],
        };

        const resourceType = args[0]?.toLowerCase();
        const amount = Math.max(1, parseInt(args[1], 10) || 2);

        if (!resourceType || !resourceGroups[resourceType]) {
            bot.chat('Usage: gcollect <wood|stone|dirt> <amount>');
            return;
        }

        if (getState() !== BotState.IDLE) { bot.chat(personality.messages.busy); return; }

        const mcData = minecraftData(bot.version);
        const resourceTypes = resourceGroups[resourceType];

        const getBestTool = (blockName: string): any | null => {
            const block = mcData.blocksByName[blockName];
            if (!block || !block.harvestTools) return null;
            let bestTool = null;
            let bestTier = -1;
            for (const item of bot.inventory.items()) {
                if (!item.name) continue;
                const tool = mcData.itemsByName[item.name];
                if (!tool) continue;
                if (block.harvestTools[(tool as any).id]) {
                    const tier = ['wooden', 'stone', 'iron', 'diamond', 'netherite', 'golden']
                        .findIndex(t => item.name.includes(t));
                    if (tier > bestTier) { bestTier = tier; bestTool = item; }
                }
            }
            return bestTool;
        };

        const mineBlock = async (blockName: string, amountToMine: number): Promise<number> => {
            let collected = 0;
            const blockId = mcData.blocksByName[blockName]?.id;
            if (blockId === undefined) return 0;

            while (collected < amountToMine && collecting.active) {
                let block = bot.findBlock({ matching: blockId, maxDistance: 16 });
                if (!block) block = bot.findBlock({ matching: blockId, maxDistance: 32 });
                if (!block) break;

                const tool = getBestTool(blockName);
                if (tool) {
                    try { await bot.equip(tool, 'hand'); } catch {}
                }

                try {
                    await bot.pathfinder.goto(
                        new GoalGetToBlock(block.position.x, block.position.y, block.position.z)
                    );
                } catch { break; }

                const freshBlock = bot.blockAt(block.position);
                if (!freshBlock || freshBlock.name !== blockName) continue;

                try {
                    await bot.dig(freshBlock);
                    collected++;
                    collecting.summary[blockName] = (collecting.summary[blockName] ?? 0) + 1;
                    addLog('system', `Collected ${blockName} (${collected}/${amountToMine})`);
                } catch {}
                await sleep(600);
            }
            return collected;
        };

        setState(BotState.COLLECTING);
        collecting.active = true;
        collecting.summary = {};

        bot.chat(formatMsg(personality.messages.collectingResource, {
            amount: String(amount), resource: resourceType,
        }));

        let totalCollected = 0;
        let remaining = amount;

        for (const type of resourceTypes) {
            if (remaining <= 0 || !collecting.active) break;
            const got = await mineBlock(type, remaining);
            totalCollected += got;
            remaining -= got;
        }

        if ((getState() as BotState) === BotState.COLLECTING) {
            if (totalCollected === 0) {
                bot.chat(formatMsg(personality.messages.couldntFindResource, { resource: resourceType }));
            } else {
                bot.chat(formatMsg(personality.messages.gotResource, {
                    amount: String(totalCollected), resource: resourceType,
                }));
            }
            collecting.active = false;
            collecting.summary = {};
            setState(BotState.IDLE);
        }
    },

    async gscollect({ bot, personality, collecting }) {
        if (!collecting.active) { bot.chat(personality.messages.notCollecting); return; }
        collecting.active = false;
        setState(BotState.IDLE);

        const summary = Object.entries(collecting.summary)
            .map(([type, count]) => `${count} ${type.replace(/_/g, ' ')}`)
            .join(', ');

        bot.chat(formatMsg(personality.messages.stoppedCollecting, {
            collected: summary || 'nothing',
        }));
        collecting.summary = {};
    },
    async gsurv({ bot, getSafeMovements }, _username, args) {
        const sub = args[0]?.toLowerCase();
        if (sub === 'stop') {
            stopSurv();
            bot.chat('Survival mode stopping...');
        } else {
            // accepts: gsurv  OR  gsurv start
            if (isSurvRunning()) {
                addLog('warn', '[SURV] Already running — use "gsurv stop" to stop');
                bot.chat('Survival already active! Use "gsurv stop" to stop.');
            } else {
                bot.chat('▶ Starting survival mode...');
                startSurv(bot, getSafeMovements);
            }
        }
    },
};

// ── Dispatcher ────────────────────────────────────────────────────────────────

export async function handleCommand(
    ctx: CommandContext,
    username: string,
    rawMessage: string,
): Promise<boolean> {
    if (!ctx.bot || !ctx.bot.inventory) return false;

    const args = rawMessage.trim().split(/\s+/);
    const command = args.shift()?.toLowerCase() ?? '';
    if (!command) return false;

    const handler = commands[command];
    if (!handler) return false;

    try {
        // Pass ctx as 4th arg for glast (which needs lastPlayerJoined)
        await (handler as any)(ctx, username, args, ctx);
    } catch (err: any) {
        addLog('error', `Command ${command} failed: ${err?.message ?? err}`);
    }

    return true;
}
