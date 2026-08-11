/**
 * commands.ts - All bot command handlers
 * Handles parsing and execution of every g-prefixed command.
 */

import type { Bot } from 'mineflayer';
import baritonePlugin from '@miner-org/mineflayer-baritone';
import { Vec3 } from 'vec3';
import minecraftData from 'minecraft-data';
import { sleep, safeGoto, withTimeout, resolvePlayerTeamName, resolveSelfTeamFromSidebar } from '../utils.ts';
import { addLog } from '../core/store.ts';
import { BotState, getState, setState, clearAllControls } from './state.ts';
import { getMode, setMode, type BotMode } from './mode.ts';
import { startSurv, stopSurv, isSurvRunning } from './survival.ts';
import { suppressMovement, resumeMovement, startStare, stopStare } from '../movementAI.ts';
import { openProfile, runProfileAction, setScanMode, isScanMode, dumpCurrentWindow, getProfileNames, openAndScanBlock, dropFromSpawner } from './gui.ts';
import { BotSession } from '../session.ts';
import { RESOURCE_GROUPS, DOOR_NAMES, BLOCK_DROPS } from '../constants.ts';
import { getBestToolForBlock, waitForPickup, getBestWeapon } from './mining.ts';
import { isGuardrailsEnabled, setGuardrailsEnabled } from './guardrails.ts';
import { clearAllHistory } from './ai.ts';
import { loadJson, saveJson, loadAllowedUsers } from '../config.ts';

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

// Command results are reported to the TUI log feed only — never to Minecraft
// chat. This keeps gameplay chat clean; the operator follows every command's
// response in the terminal instead.
function reply(message: string): void {
    addLog('chat', message);
}

// Send a message to Minecraft chat AND surface it in the TUI log feed, so the
// operator sees exactly what the bot said (used by gsay / gtp).
function say(bot: Bot, message: string): void {
    addLog('chat', message);
    bot.chat(message);
}

// ── Command registry ──────────────────────────────────────────────────────────

type CommandFn = (ctx: CommandContext, username: string, args: string[], ctxAgain?: CommandContext) => Promise<void>;

const commands: Record<string, CommandFn> = {

    async gping({ bot }) {
        reply(`Pong! ${bot.player?.ping ?? '?'}ms`);
    },

    async ghelp({ bot, personality }) {
        const helpMessages = [
            'Commands:',
            'gping, ghelp, gsay, ginv, ginvsee, geat, gjump, gdrop, gwalk, gcr, gcords, gtp',
            'gfollow <player>, gcraft <item>, gdump, gkill <mob|player>, glast, gsfollow',
            'gcollect <wood|stone|dirt> <amount>, gsleep, gopendoor, gscollect, gtab, gfilter, greset',
            'gscan, gopen <profile>, grun <profile> <action>, gsell, gspawner (open+scan spawner GUI), gsdrop (spawner → chest → drop all)',
            'gotocord <x> <y> <z>, glook <x> <y> <z> (stare until gidle)',
        ];
        for (const line of helpMessages) {
            await sleep(getRandomDelay(500, 900));
            try { reply(line); } catch {}
        }
    },

    async gsay({ bot }, _username, args) {
        if (args.length === 0) { reply('Usage: gsay <message>'); return; }
        const message = args.join(' ');
        addLog('chat', message);
        // gsay is the operator's channel: it may send /tpa commands (the chat
        // guard blocks them everywhere else). Fall back to bot.chat if the
        // bypass isn't installed yet.
        const chatTui = (bot as any).chatTui;
        if (typeof chatTui === 'function') chatTui(message);
        else bot.chat(message);
    },

    async ginv({ bot, personality }) {
        const items = bot.inventory.items();
        if (items.length === 0) { reply(personality.messages.emptyInventory); return; }
        reply(items.map((item, idx) => `${idx + 1}. ${item.name} x${item.count}`).join('\n'));
    },

    async ginvsee({ bot, personality }) {
        const items = bot.inventory.items();
        if (!items || items.length === 0) { reply(personality.messages.emptyInventory); return; }
        // TUI-only output — no Minecraft 256-char limit, so every item gets its
        // own line.
        reply(items.map((item, idx) => `${idx + 1}. ${item.name ?? 'unknown'} x${item.count ?? 0}`).join('\n'));
    },

    async geat({ bot, personality }, _username, args) {
        if (getState() !== BotState.IDLE) { reply(personality.messages.busy); return; }

        const eatItems = bot.inventory.items();

        if (args.length === 0) {
            if (eatItems.length === 0) { reply(personality.messages.noFood); return; }
            reply(eatItems.map((item, idx) => `${idx + 1}. ${item.name} x${item.count}`).join('\n'));
            reply('Usage: geat <food_number> <amount>');
            return;
        }

        const foodIdx = parseInt(args[0], 10) - 1;
        const amount = Math.max(1, parseInt(args[1], 10) || 1);

        if (Number.isNaN(foodIdx) || foodIdx < 0 || foodIdx >= eatItems.length) {
            reply(personality.messages.invalidFoodNumber);
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
                if (bot.food >= 20) { reply(personality.messages.fullStomach); break; }
            }
            reply(`Ate ${eaten} ${food.name}`);
        } catch { reply(personality.messages.couldntEat); }
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
            if (dropItems.length === 0) { reply(personality.messages.nothingToDrop); return; }
            reply(dropItems.map((item, idx) => `${idx + 1}. ${item.name} x${item.count}`).join(', '));
            reply('Usage: gdrop <item_number> <amount>');
            return;
        }
        const itemIdx = parseInt(args[0], 10) - 1;
        const amount = parseInt(args[1], 10) || 1;
        if (isNaN(itemIdx) || itemIdx < 0 || itemIdx >= dropItems.length) {
            reply(personality.messages.invalidItemNumber);
            return;
        }
        const item = dropItems[itemIdx];
        if (amount > item.count) {
            reply(formatMsg(personality.messages.onlyHave, { count: String(item.count), item: item.name }));
            return;
        }
        reply(formatMsg(personality.messages.droppingItems, { amount: String(amount), item: item.name }));
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
        if (!pos) { reply('Unknown position'); return; }
        reply(`${Math.round(pos.x)}, ${Math.round(pos.y)}, ${Math.round(pos.z)}`);
    },

    async gtp({ bot }, _username, args) {
        const [x, y, z] = args;
        if (!x || !y || !z) { reply('Usage: gtp <x> <y> <z>'); return; }

        const onMessage = (jsonMsg: any) => {
            const msg = jsonMsg.toString();
            if (
                msg.includes('Unknown command') || msg.includes('no permission') ||
                msg.includes('not a valid number') || msg.includes('cannot be found')
            ) {
                reply('No permission for /tp.');
                bot.removeListener('message', onMessage);
            }
        };
        bot.once('message', onMessage);
        say(bot, `/tp ${bot.username} ${x} ${y} ${z}`);
        setTimeout(() => bot.removeListener('message', onMessage), 3000);
    },

    async gfollow({ bot, personality, configureBaritone }, username, args) {
        let targetName = args[0];
        if (!targetName) { reply('Usage: gfollow <player>'); return; }
        if (targetName.toLowerCase() === 'me') targetName = username;

        // Never hijack a task that owns movement (combat/collect/eat/sleep/
        // flee): stopping combat's follow path mid-fight and taking over the
        // state leaves the combat attack interval running against the wrong
        // target. FOLLOWING is allowed so you can switch follow targets.
        if (BUSY_STATES.includes(getState())) {
            reply(personality.messages.busy);
            return;
        }

        const playerEntity = bot.players[targetName]?.entity;
        if (!playerEntity) {
            reply(formatMsg(personality.messages.cantSeePlayer, { player: targetName }));
            return;
        }
        // Stop any existing navigation before starting follow
        try { bot.ashfinder.stop(); } catch {}
        setState(BotState.FOLLOWING);
        reply(formatMsg(personality.messages.followingPlayer, { player: targetName }));
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
                reply(personality.messages.stoppedFollowing);
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
            reply(personality.messages.stoppedFollowing);
        } else {
            reply(personality.messages.notFollowing);
        }
    },

    async gcraft({ bot, personality }, _username, args) {
        const itemName = args[0];
        if (!itemName) { reply('Usage: gcraft <item_name>'); return; }

        const mcData = minecraftData(bot.version);
        const item = mcData.itemsByName[itemName];
        if (!item) {
            reply(formatMsg(personality.messages.unknownItem, { item: itemName }));
            return;
        }
        const recipe = bot.recipesFor(item.id, null, 1, null)[0];
        if (!recipe) {
            reply(formatMsg(personality.messages.unknownItem, { item: itemName }));
            return;
        }

        let craftingTable = null;
        if (recipe.requiresTable) {
            const tableId = mcData.blocksByName.crafting_table?.id;
            if (!tableId) { reply(personality.messages.noCraftingTable); return; }
            craftingTable = bot.findBlock({ matching: tableId, maxDistance: 6 });
            if (!craftingTable) { reply(personality.messages.noCraftingTable); return; }
        }

        try {
            await bot.craft(recipe, 1, craftingTable ?? undefined);
            reply(formatMsg(personality.messages.craftedItem, { item: itemName }));
        } catch (err: any) {
            reply(formatMsg(personality.messages.craftFailed, { error: err?.message ?? 'unknown' }));
        }
    },

    async gdump({ bot, personality }) {
        const items = bot.inventory.items();
        if (items.length === 0) { reply(personality.messages.nothingToDrop); return; }
        reply(personality.messages.droppingEverything);
        for (const item of items) {
            try {
                await bot.tossStack(item);
                await sleep(150);
            } catch {}
        }
    },

    async gkill({ bot, personality, intervals }, _username, args) {
        const killTarget = args[0]?.toLowerCase();
        if (!killTarget) { reply('Usage: gkill <mob|player name>'); return; }

        // Same gate as gfollow: don't stomp a task that owns movement. A gkill
        // issued during auto-combat would stop combat's follow path and spin up
        // a second attack interval fighting for the same target.
        if (BUSY_STATES.includes(getState())) {
            reply(personality.messages.busy);
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
            reply(formatMsg(personality.messages.cantSeePlayer, { player: playerEntry.username }));
            return;
        }

        if (playerEntity) {
            reply(formatMsg(personality.messages.attackingPlayer, { player: playerEntry.username }));
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
                    reply(formatMsg(personality.messages.playerGone, { player: playerEntry.username }));
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
            reply(formatMsg(personality.messages.attackingMob, { mob: killTarget }));
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
                    reply(formatMsg(personality.messages.mobDead, { mob: killTarget }));
                    return;
                }
                try { bot.attack(stillExists); } catch {}
            }, 600);
            intervals.push(attackInterval);
            return;
        }

        reply(formatMsg(personality.messages.cantFindTarget, { target: killTarget }));
    },

    async glast({ bot, personality }, _username, _args, ctx) {
        // lastPlayerJoined is passed via ctx binding
        const last = ctx?.lastPlayerJoined();
        reply(last
            ? formatMsg(personality.messages.lastPlayerJoined, { player: last })
            : personality.messages.nobodyJoined
        );
    },

    async gsleep({ bot, personality, configureBaritone }) {
        if (getState() !== BotState.IDLE) { reply(personality.messages.busy); return; }

        const bed = bot.findBlock({
            matching: (block) => block?.name?.endsWith('_bed') && block.metadata === 0,
            maxDistance: 32,
        });
        if (!bed) { reply(personality.messages.noBedNearby); return; }
        const bedDist = bot.entity.position.distanceTo(bed.position);
        addLog('system', `[CMD] gsleep — bed at ${bed.position.floored()} (${Math.round(bedDist)} blocks)`);
        if (bot.entity.position.distanceTo(bed.position) > 12) {
            reply(personality.messages.bedTooFar);
            return;
        }

        setState(BotState.SLEEPING);
        try {
            reply(personality.messages.goingToSleep);
            configureBaritone();
            try {
                await safeGoto(
                    bot,
                    new baritoneGoals.GoalExact(new Vec3(bed.position.x, bed.position.y, bed.position.z)),
                    12000,
                );
            } catch {
                reply(personality.messages.cantReachBed);
                setState(BotState.IDLE);
                return;
            }
            await bot.sleep(bed);
        } catch (err: any) {
            const msg = err?.message?.toLowerCase?.() ?? '';
            if (msg.includes('day'))      reply(personality.messages.notNight);
            else if (msg.includes('monster')) reply(personality.messages.monstersNearby);
            else if (msg.includes('obstructed')) reply(personality.messages.bedBlocked);
            else reply(personality.messages.cantSleep);
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
        if (!door) { reply(personality.messages.noDoorNearby); return; }
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
                reply(personality.messages.doorAlreadyOpen);
                return;
            }
            await bot.activateBlock(freshDoor);
            reply(personality.messages.doorOpened);
        } catch { reply(personality.messages.cantReachDoor); }
    },

    async gcollect({ bot, personality, configureBaritone, collecting }, _username, args) {
        const resourceType = args[0]?.toLowerCase();
        const amount = Math.max(1, parseInt(args[1], 10) || 2);

        if (!resourceType || !RESOURCE_GROUPS[resourceType]) {
            reply('Usage: gcollect <wood|stone|dirt> <amount>');
            return;
        }

        if (getState() !== BotState.IDLE) { reply(personality.messages.busy); return; }

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

        reply(formatMsg(personality.messages.collectingResource, {
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
                reply(formatMsg(personality.messages.couldntFindResource, { resource: resourceType }));
            } else {
                reply(formatMsg(personality.messages.gotResource, {
                    amount: String(totalCollected), resource: resourceType,
                }));
            }
            collecting.active = false;
            collecting.summary = {};
            setState(BotState.IDLE);
        }
    },

    async gscollect({ bot, personality, collecting }) {
        if (!collecting.active) { reply(personality.messages.notCollecting); return; }
        collecting.active = false;
        setState(BotState.IDLE);

        const summary = Object.entries(collecting.summary)
            .map(([type, count]) => `${count} ${type.replace(/_/g, ' ')}`)
            .join(', ');

        reply(formatMsg(personality.messages.stoppedCollecting, {
            collected: summary || 'nothing',
        }));
        collecting.summary = {};
    },
    async gsurv({ bot, configureBaritone, session }, _username, args) {
        const sub = args[0]?.toLowerCase();
        if (sub === 'stop') {
            stopSurv();
            reply('Survival mode stopping...');
        } else {
            // accepts: gsurv  OR  gsurv start
            if (isSurvRunning()) {
                addLog('warn', '[SURV] Already running — use "gsurv stop" to stop');
                reply('Survival already active! Use "gsurv stop" to stop.');
            } else {
                reply('▶ Starting survival mode...');
                startSurv(bot, configureBaritone, session);
            }
        }
    },

    async gidle({ bot }) {
        stopStare(bot);
        setMode('idle');
        setState(BotState.IDLE);
        clearAllControls(bot);
        try { bot.ashfinder?.stop?.(); } catch {}
    },

    async gattack({ bot }) {
        setMode('attack');
        setState(BotState.IDLE);
        clearAllControls(bot);
        try { bot.ashfinder?.stop?.(); } catch {}
    },

    async gfree({ bot }) {
        setMode('free');
        setState(BotState.IDLE);
        clearAllControls(bot);
        try { bot.ashfinder?.stop?.(); } catch {}
    },

    async gmode({ bot }) {
        const m = getMode();
        const labels: Record<BotMode, string> = {
            idle: 'IDLE (stand still, greet players)',
            attack: 'ATTACK (hunt hostiles)',
            free: 'FREE (decide based on the situation)',
        };
        reply(`Mode: ${labels[m]}`);
    },

    async greset({ bot }, username) {
        // Clearing every player's AI context is a TUI-shell action — a player
        // must never be able to wipe other people's conversation history.
        if (username !== 'Shell') {
            addLog('warn', '[RESET] TUI-only — use the TUI shell to reset AI context');
            return;
        }
        clearAllHistory();
        addLog('system', '[RESET] Cleared all AI conversation context');
        try { reply('Context wiped! What were we talking about? Popipo~'); } catch {}
    },

    async gfilter(_ctx, username, args) {
        // Guardrails are controlled ONLY from the TUI shell — never from MCP
        // (and never from chat, which the dispatcher already blocks).
        if (username !== 'Shell') {
            addLog('warn', '[GUARDRAILS] TUI-only — use the TUI shell to toggle guardrails');
            return;
        }
        const sub = args[0]?.toLowerCase();
        if (sub === 'on' || sub === 'off') {
            const enabled = sub === 'on';
            setGuardrailsEnabled(enabled);
            try {
                const cfg = loadJson<Record<string, unknown>>('config.json');
                cfg.guardrails = enabled;
                saveJson('config.json', cfg);
            } catch (err: any) {
                addLog('error', `[GUARDRAILS] Failed to persist toggle: ${err?.message ?? err}`);
            }
            addLog('system', `[GUARDRAILS] ${enabled ? 'ON' : 'OFF'} — blocks prompt-injection line rewrites`);
        } else {
            addLog('system', `[GUARDRAILS] Currently ${isGuardrailsEnabled() ? 'ON' : 'OFF'} — usage: gfilter on|off`);
        }
    },

    async gtab({ bot }) {
        const players = Object.values(bot.players) as any[];
        if (players.length === 0) { addLog('system', '[TAB] No players online'); return; }

        const teams = (bot as any).teams ?? {};
        const selfTeamFallback = resolveSelfTeamFromSidebar(teams);
        const rows = players.map((p) => {
            const teamName = resolvePlayerTeamName(teams, p.username)
                ?? (p.username === bot.username ? selfTeamFallback : null);
            const ping = (p.ping !== undefined && p.ping !== null) ? `${p.ping}ms` : '?';
            const name = p.username || 'unknown';
            return teamName ? `${name} [${teamName}] ${ping}` : `${name} ${ping}`;
        }).sort((a, b) => a.localeCompare(b));

        addLog('system', `[TAB] ${players.length} player${players.length === 1 ? '' : 's'} online`);
        for (const row of rows) addLog('system', `[TAB] ${row}`);
    },

    // ── Chest-GUI automation (/shop, /sell, spawner menus) ──────────────────

    async gscan(_ctx, _username, args) {
        const sub = args[0]?.toLowerCase();
        const enabled = sub === 'on' ? true : sub === 'off' ? false : !isScanMode();
        setScanMode(enabled);
        // Persist so the next launch starts in the same mode.
        try {
            const cfg = loadJson<Record<string, unknown>>('config.json');
            if (cfg.gui && typeof cfg.gui === 'object') {
                (cfg.gui as { debugWindows: boolean }).debugWindows = enabled;
                saveJson('config.json', cfg);
            }
        } catch (err: any) {
            addLog('error', `[GUI] Failed to persist scan mode: ${err?.message ?? err}`);
        }
        addLog('system', `[GUI] window-slot scanning ${enabled ? 'ON' : 'OFF'}`);
        if (enabled) dumpCurrentWindow();
    },

    async gopen(_ctx, _username, args) {
        const profile = args[0];
        if (!profile) {
            addLog('system', `[GUI] usage: gopen <profile> — profiles: ${getProfileNames().join(', ') || '(none configured)'}`);
            return;
        }
        const ok = await openProfile(profile);
        addLog('system', `[GUI] gopen ${profile} — ${ok ? 'window open' : 'could not open (see log)'}`);
    },

    async grun(_ctx, _username, args) {
        const [profile, action] = args;
        if (!profile || !action) {
            addLog('system', '[GUI] usage: grun <profile> <action>');
            return;
        }
        const ok = await runProfileAction(profile, action);
        addLog('system', `[GUI] grun ${profile} ${action} — ${ok ? 'done' : 'failed (see log)'}`);
    },

    async gsell(_ctx, _username, args) {
        const profile = args[0] ?? 'shop';
        const action = args[1] ?? 'sell';
        const ok = await runProfileAction(profile, action);
        addLog('system', `[GUI] gsell — ${ok ? 'items sold' : 'sell failed (see log)'}`);
    },

    async gspawner(_ctx, _username, args) {
        const block = args[0] ?? 'spawner';
        addLog('system', `[GUI] gspawner — opening nearest ${block} to scan its window`);
        const ok = await openAndScanBlock(block);
        addLog('system', `[GUI] gspawner — ${ok ? `scanned ${block} window (slots logged above)` : 'failed (see log)'}`);
    },

    async gsdrop(_ctx, _username, _args) {
        addLog('system', '[GUI] gsdrop — spawner GUI → chest → drop all');
        const ok = await dropFromSpawner();
        addLog('system', `[GUI] gsdrop — ${ok ? 'drop clicked (verify items dropped in-game)' : 'failed (see log)'}`);
    },

    async gotocord({ bot, personality, configureBaritone }, _username, args) {
        if (BUSY_STATES.includes(getState())) { reply(personality.messages.busy); return; }

        const coords = args.map(Number);
        if (args.length < 3 || coords.slice(0, 3).some(n => Number.isNaN(n))) {
            reply('Usage: gotocord <x> <y> <z>');
            return;
        }
        const [x, y, z] = coords;
        addLog('system', `[CMD] gotocord — walking to ${x}, ${y}, ${z}`);

        try { bot.ashfinder.stop(); } catch {}
        configureBaritone();
        const nav = await safeGoto(bot, new baritoneGoals.GoalNear(new Vec3(x, y, z), 1), 30000);

        if (nav.status === 'success') {
            const p = bot.entity?.position;
            reply(`Arrived at ${x}, ${y}, ${z} (now at ${p ? `${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.z)}` : 'unknown position'})`);
        } else {
            reply(`Could not reach ${x}, ${y}, ${z} — ${nav.error?.message ?? nav.status}`);
        }
    },

    async glook({ bot, personality, session }, _username, args) {
        if (BUSY_STATES.includes(getState())) { reply(personality.messages.busy); return; }

        const coords = args.map(Number);
        if (args.length < 3 || coords.slice(0, 3).some(n => Number.isNaN(n))) {
            reply('Usage: glook <x> <y> <z>');
            return;
        }
        const [x, y, z] = coords;
        addLog('system', `[CMD] glook — staring at ${x}, ${y}, ${z}`);

        try { bot.ashfinder.stop(); } catch {}
        setState(BotState.IDLE);
        startStare(bot, new Vec3(x, y, z), session);
        reply(`Staring at ${x}, ${y}, ${z} — use gidle to stop`);
    },
};

// ── Dispatcher ────────────────────────────────────────────────────────────────

// The TUI shell and MCP (external control surface) may always dispatch
// commands. In-game players may only dispatch if their name is listed in
// allowedUser.json (hot-reloaded on every command, case-insensitive). This
// blocks random players — both by typing a g-command in chat and by steering
// the AI into emitting an action (the AI dispatch passes the requester's real
// username, so gating by caller identity covers both).
const ALLOWED_COMMAND_CALLERS = new Set(['Shell', 'MCP']);

export async function handleCommand(
    ctx: CommandContext,
    username: string,
    rawMessage: string,
): Promise<boolean> {
    if (!ctx.bot || !ctx.bot.inventory || !ctx.bot.entity) return false;

    const key = username.toLowerCase();
    if (!ALLOWED_COMMAND_CALLERS.has(username) && !loadAllowedUsers().includes(key)) {
        addLog('warn', `[CMD] Blocked command from ${username}: ${rawMessage.slice(0, 60)}`);
        return false;
    }

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