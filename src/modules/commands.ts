/**
 * commands.ts - All bot command handlers
 * Handles parsing and execution of every g-prefixed command.
 */

import type { Bot } from 'mineflayer';
import baritonePlugin from '@miner-org/mineflayer-baritone';
import { Vec3 } from 'vec3';
import minecraftData from 'minecraft-data';
import { sleep, safeGoto, withTimeout } from '../utils.ts';
import { addLog } from '../core/store.ts';
import { BotState, getState, setState, clearAllControls } from './state.ts';
import { startSurv, stopSurv, isSurvRunning } from './survival.ts';
import { suppressMovement, resumeMovement } from '../movementAI.ts';
import { BotSession } from '../session.ts';
import { RESOURCE_GROUPS, DOOR_NAMES, BLOCK_DROPS } from '../constants.ts';
import { getBestToolForBlock, waitForPickup, getBestWeapon } from './mining.ts';

const baritoneGoals = baritonePlugin.goals;

// States where a task owns movement and a command must not hijack it. IDLE and
// FOLLOWING are deliberately excluded: following is a passive state and gfollow
// should be allowed to switch targets.
const BUSY_STATES: BotState[] = [
    BotState.COLLECTING,
    BotState.EATING,
    BotState.SLEEPING,
    BotState.ATTACKING,
    BotState.FLEEING,
];

// ── Types ─────────────────────────────────────────────────────────────────────

export type CommandContext = {
    bot: Bot;
    personality: any;
    configureBaritone: (overrides?: Record<string, any>) => void;
    intervals: NodeJS.Timeout[];
    session: BotSession;
    collecting: { active: boolean; summary: Record<string, number> };
    lastPlayerJoined: () => string | null;
    HOSTILE_MOBS: Set<string>;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function getRandomDelay(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function formatMsg(template: string, vars: Record<string, string>): string {
    let out = template;
    for (const [k, v] of Object.entries(vars)) {
        out = out.replaceAll(`{${k}}`, v);
    }
    return out;
}

// ── Command registry ──────────────────────────────────────────────────────────

type CommandFn = (ctx: CommandContext, username: string, args: string[], ctxAgain?: CommandContext) => Promise<void>;

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
        // Truncate to avoid exceeding Minecraft's 256-char chat limit
        const lines = items.map((item, idx) => `${idx + 1}. ${item.name ?? 'unknown'} x${item.count ?? 0}`);
        let msg = lines[0] ?? '';
        for (let i = 1; i < lines.length; i++) {
            const next = msg + ', ' + lines[i];
            if (next.length > 240) { msg += `... +${lines.length - i} more`; break; }
            msg = next;
        }
        bot.chat(msg);
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

    async gfollow({ bot, personality, configureBaritone }, username, args) {
        let targetName = args[0];
        if (!targetName) { bot.chat('Usage: gfollow <player>'); return; }
        if (targetName.toLowerCase() === 'me') targetName = username;

        // Never hijack a task that owns movement (combat/collect/eat/sleep/
        // flee): stopping combat's follow path mid-fight and taking over the
        // state leaves the combat attack interval running against the wrong
        // target. FOLLOWING is allowed so you can switch follow targets.
        if (BUSY_STATES.includes(getState())) {
            bot.chat(personality.messages.busy);
            return;
        }

        const playerEntity = bot.players[targetName]?.entity;
        if (!playerEntity) {
            bot.chat(formatMsg(personality.messages.cantSeePlayer, { player: targetName }));
            return;
        }
        // Stop any existing navigation before starting follow
        try { bot.ashfinder.stop(); } catch {}
        setState(BotState.FOLLOWING);
        bot.chat(formatMsg(personality.messages.followingPlayer, { player: targetName }));
        configureBaritone();

        // baritone's followEntity never resolves or rejects when the followed
        // player leaves — without this the bot keeps walking to the last known
        // position and stays in FOLLOWING forever.
        const onTargetLeft = (p: any) => {
            if (p?.username !== targetName) return;
            bot.removeListener('playerLeft', onTargetLeft);
            try { bot.ashfinder.stop(); } catch {}
            if (getState() === BotState.FOLLOWING) {
                setState(BotState.IDLE);
                bot.chat(personality.messages.stoppedFollowing);
            }
        };
        bot.on('playerLeft', onTargetLeft);

        bot.ashfinder.followEntity(playerEntity, { distance: 1 }).catch((err: any) => {
            addLog('error', `[CMD] gfollow followEntity failed: ${err?.message ?? err}`);
        });
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

        // Same gate as gfollow: don't stomp a task that owns movement. A gkill
        // issued during auto-combat would stop combat's follow path and spin up
        // a second attack interval fighting for the same target.
        if (BUSY_STATES.includes(getState())) {
            bot.chat(personality.messages.busy);
            return;
        }

        const weapon = getBestWeapon(bot);
        addLog('system', `[CMD] gkill target="${killTarget}" weapon=${weapon?.name ?? 'fist'}`);

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
            bot.ashfinder.followEntity(playerEntity, { distance: 1 }).catch(() => {});

            const attackInterval = setInterval(() => {
                const stillExists = bot.players[playerEntry.username]?.entity;
                if (!stillExists) {
                    clearInterval(attackInterval);
                    const idx = intervals.indexOf(attackInterval);
                    if (idx !== -1) intervals.splice(idx, 1);
                    bot.ashfinder.stop();
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
            bot.ashfinder.followEntity(mobEntity, { distance: 1 }).catch(() => {});

            const attackInterval = setInterval(() => {
                const stillExists = bot.entities[mobEntity.id];
                if (!stillExists) {
                    clearInterval(attackInterval);
                    const idx = intervals.indexOf(attackInterval);
                    if (idx !== -1) intervals.splice(idx, 1);
                    bot.ashfinder.stop();
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

    async gsleep({ bot, personality, configureBaritone }) {
        if (getState() !== BotState.IDLE) { bot.chat(personality.messages.busy); return; }

        const bed = bot.findBlock({
            matching: (block) => block?.name?.endsWith('_bed') && block.metadata === 0,
            maxDistance: 32,
        });
        if (!bed) { bot.chat(personality.messages.noBedNearby); return; }
        const bedDist = bot.entity.position.distanceTo(bed.position);
        addLog('system', `[CMD] gsleep — bed at ${bed.position.floored()} (${Math.round(bedDist)} blocks)`);
        if (bot.entity.position.distanceTo(bed.position) > 12) {
            bot.chat(personality.messages.bedTooFar);
            return;
        }

        setState(BotState.SLEEPING);
        try {
            bot.chat(personality.messages.goingToSleep);
            configureBaritone();
            try {
                await safeGoto(
                    bot,
                    new baritoneGoals.GoalExact(new Vec3(bed.position.x, bed.position.y, bed.position.z)),
                    12000,
                );
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
            try { bot.ashfinder.stop(); } catch {}
            setState(BotState.IDLE);
        }
    },

    async gopendoor({ bot, personality, configureBaritone }) {
        const door = bot.findBlock({
            matching: (block) => DOOR_NAMES.includes(block.name),
            maxDistance: 16,
        });
        if (!door) { bot.chat(personality.messages.noDoorNearby); return; }
        addLog('system', `[CMD] gopendoor — found ${door.name} at ${door.position.floored()}`);

        try {
            configureBaritone();
            await safeGoto(
                bot,
                new baritoneGoals.GoalNear(new Vec3(door.position.x, door.position.y, door.position.z), 2),
                12000,
            );
            const freshDoor = bot.blockAt(door.position);
            if (!freshDoor) return;
            const openVal = freshDoor.getProperties?.()?.['open'];
            if (openVal === 'true' || openVal === true) {
                bot.chat(personality.messages.doorAlreadyOpen);
                return;
            }
            await bot.activateBlock(freshDoor);
            bot.chat(personality.messages.doorOpened);
        } catch { bot.chat(personality.messages.cantReachDoor); }
    },

    async gcollect({ bot, personality, configureBaritone, collecting }, _username, args) {
        const resourceType = args[0]?.toLowerCase();
        const amount = Math.max(1, parseInt(args[1], 10) || 2);

        if (!resourceType || !RESOURCE_GROUPS[resourceType]) {
            bot.chat('Usage: gcollect <wood|stone|dirt> <amount>');
            return;
        }

        if (getState() !== BotState.IDLE) { bot.chat(personality.messages.busy); return; }

        addLog('system', `[CMD] gcollect resource="${resourceType}" amount=${amount}`);

        const resourceTypes = RESOURCE_GROUPS[resourceType];

        const mineBlock = async (blockName: string, dropNames: string[], amountToMine: number): Promise<number> => {
            let collected = 0;

            const walkToDroppedItem = async (): Promise<boolean> => {
                const itemEntity = Object.values(bot.entities).find((e: any) => e?.name === 'item');
                if (!itemEntity || !itemEntity.position) return false;
                try {
                    configureBaritone({ breakBlocks: true });
                    await safeGoto(
                        bot,
                        new baritoneGoals.GoalNear(new Vec3(itemEntity.position.x, itemEntity.position.y, itemEntity.position.z), 1),
                        12000,
                    );
                    await sleep(1500);
                } catch {}
                return true;
            };

            const isMatchingBlock = (block: any, name: string): boolean => {
                return block?.name === name;
            };

            // True when the inventory has an empty slot or an existing stack of
            // `name` that can still absorb more. Stops collection once full.
            const canPickUpMore = (name: string): boolean => {
                const slots = bot.inventory.slots;
                // Main inventory = slots 9..44 (27 main + 9 hotbar = 36)
                for (let i = 9; i < 45; i++) {
                    if (slots[i] === null) return true;
                }
                return bot.inventory.items().some(i => i.name === name && i.count < 64);
            };

            // Breaks a block but fails to gain it (lava, despawn, full inv).
            // A few in a row means collection is stuck — bail instead of
            // looping forever.
            let brokenWithoutPickup = 0;
            // Can't path to / never arrives at the block (tiny island, water
            // gap, unreachable ledge). A few in a row → give up.
            let unreachableTries = 0;

            while (collected < amountToMine && collecting.active) {
                if (!canPickUpMore(dropNames[0])) {
                    addLog('warn', `[CMD] Inventory full — cannot collect more ${blockName}`);
                    break;
                }

                let block = bot.findBlock({ matching: (b: any) => isMatchingBlock(b, blockName), maxDistance: 32 });
                if (!block) {
                    addLog('system', `[CMD] No ${blockName} found within 32 blocks, skipping`);
                    break;
                }

                const tool = getBestToolForBlock(bot, blockName);
                if (tool) {
                    try { await withTimeout(bot.equip(tool, 'hand'), 5000); } catch {}
                }

                try {
                    configureBaritone({ breakBlocks: true });
                    const nav = await safeGoto(
                        bot,
                        new baritoneGoals.GoalNear(new Vec3(block.position.x, block.position.y, block.position.z), 2),
                        12000,
                    );
                    // baritone's goto NEVER rejects — it resolves with a status.
                    // A failed path (island gap, unreachable ledge, water) must
                    // be treated like an error or we'd dig a block we can't
                    // reach and hang in bot.dig() forever.
                    if (nav.status === 'failed') throw new Error(`navigation failed: ${nav.error?.message ?? nav.error ?? ''}`);
                } catch {
                    unreachableTries++;
                    addLog('warn', `[CMD] Could not reach ${blockName} (${unreachableTries}/3)`);
                    if (unreachableTries >= 3) {
                        addLog('warn', `[CMD] ${unreachableTries} unreachable blocks in a row — giving up`);
                        break;
                    }
                    await sleep(600);
                    continue;
                }

                const freshBlock = bot.blockAt(block.position);
                if (!freshBlock || freshBlock.name !== blockName) continue;

                const countBefore = bot.inventory.items().filter(i => dropNames.includes(i.name)).reduce((s, i) => s + i.count, 0);

                configureBaritone({ breakBlocks: true });
                try {
                    await withTimeout(bot.dig(freshBlock), 12000);
                } catch {
                    addLog('warn', `[CMD] Dig of ${blockName} failed or timed out`);
                    await sleep(600);
                    continue;
                }

                const pickedUp = await waitForPickup(bot, dropNames);

                if (!pickedUp) {
                    await walkToDroppedItem();
                }

                const countAfter = bot.inventory.items().filter(i => dropNames.includes(i.name)).reduce((s, i) => s + i.count, 0);
                if (countAfter > countBefore) {
                    const got = countAfter - countBefore;
                    collected += got;
                    brokenWithoutPickup = 0;
                    collecting.summary[blockName] = (collecting.summary[blockName] ?? 0) + got;
                    addLog('system', `[CMD] Collected ${blockName} (${collected}/${amountToMine})`);
                } else {
                    brokenWithoutPickup++;
                    addLog('warn', `[CMD] Block broken but item not picked up (${brokenWithoutPickup}/5)`);
                    if (brokenWithoutPickup >= 5) {
                        addLog('warn', `[CMD] ${brokenWithoutPickup} broken blocks yielded nothing — inventory full or items lost, stopping`);
                        break;
                    }
                }

                await sleep(400);
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

        while (remaining > 0 && collecting.active) {
            const block = bot.findBlock({
                matching: (b: any) => resourceTypes.includes(b?.name),
                maxDistance: 32,
            });
            if (!block) break;

            const blockName = block.name;
            const dropNames = BLOCK_DROPS[blockName] ?? [blockName];
            const got = await mineBlock(blockName, dropNames, remaining);
            totalCollected += got;
            if (got === 0) {
                // No progress on this block (not found, inventory full, or items
                // lost) — stop rather than retry the same block forever.
                addLog('warn', '[CMD] No progress collecting — stopping');
                break;
            }
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
    async gsurv({ bot, configureBaritone, session }, _username, args) {
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
                startSurv(bot, configureBaritone, session);
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
    if (!ctx.bot || !ctx.bot.inventory || !ctx.bot.entity) return false;

    const args = rawMessage.trim().split(/\s+/);
    const command = args.shift()?.toLowerCase() ?? '';
    if (!command) return false;

    const handler = commands[command];
    if (!handler) return false;

    suppressMovement(ctx.bot);
    try {
        // Pass ctx as 4th arg for glast (which needs lastPlayerJoined)
        await (handler as any)(ctx, username, args, ctx);
    } catch (err: any) {
        addLog('error', `[CMD] Command ${command} failed: ${err?.message ?? err}`);
    } finally {
        resumeMovement();
    }

    return true;
}