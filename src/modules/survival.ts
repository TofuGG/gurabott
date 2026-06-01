/**
 * survival.ts - gsurv: autonomous survival progression loop
 *
 * Activate:  gsurv  (or gsurv start)
 * Stop:      gsurv stop
 *
 * Phases:
 *  0. Eat if hungry / heal
 *  1. Collect logs → craft planks → crafting table
 *  2. Wooden pickaxe, axe, shovel
 *  3. Mine stone → stone tools + sword
 *  4. Mine iron ore → smelt → iron tools + sword
 *  5. Mine diamonds → diamond pickaxe, axe, sword
 *  → loops back to phase 0 health check
 */

import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import pathfinderLib from 'mineflayer-pathfinder';
import minecraftData from 'minecraft-data';
import { addLog } from './tui.ts';
import { BotState, getState, setState } from './state.ts';
import { sleep } from '../utils.ts';

const { goals } = pathfinderLib;
const { GoalBlock, GoalGetToBlock } = goals;

// ── Module state ──────────────────────────────────────────────────────────────

let running  = false;
let stopFlag = false;

export function isSurvRunning() { return running; }

export function startSurv(bot: Bot, getSafeMovements: () => any): void {
    if (running) { log('Already running. Use "gsurv stop" to stop.'); return; }
    running  = true;
    stopFlag = false;
    log('▶ Survival mode STARTED');
    log('Goal: collect wood → tools → stone → iron → diamonds');
    runLoop(bot, getSafeMovements).catch(e => {
        logErr(`Fatal error: ${e?.message ?? e}`);
        running = false;
        if (getState() === BotState.COLLECTING) setState(BotState.IDLE);
    });
}

export function stopSurv(): void {
    if (!running) { log('Not running.'); return; }
    stopFlag = true;
    log('⏹ Stop requested — finishing current step...');
}

// ── Logging helpers ───────────────────────────────────────────────────────────

function log(msg: string)    { addLog('system',  `[SURV] ${msg}`); }
function logWarn(msg: string){ addLog('warn',    `[SURV] ${msg}`); }
function logErr(msg: string) { addLog('error',   `[SURV] ${msg}`); }

/** Log + check stop flag. Returns false if we should stop. */
async function step(msg: string): Promise<boolean> {
    if (stopFlag) {
        running  = false;
        stopFlag = false;
        setState(BotState.IDLE);
        log('⏹ Stopped.');
        return false;
    }
    log(msg);
    return true;
}

// ── Inventory helpers ─────────────────────────────────────────────────────────

function countOf(bot: Bot, ...names: string[]): number {
    return bot.inventory.items()
        .filter(i => names.includes(i.name))
        .reduce((s, i) => s + i.count, 0);
}

function has(bot: Bot, ...names: string[]): boolean {
    return bot.inventory.items().some(i => names.includes(i.name));
}

function hasAny(bot: Bot, prefixes: string[]): boolean {
    return bot.inventory.items().some(i => prefixes.some(p => i.name.startsWith(p) || i.name === p));
}

function invSummary(bot: Bot): string {
    const items = bot.inventory.items();
    if (!items.length) return 'empty';
    return items.map(i => `${i.name}×${i.count}`).slice(0, 8).join(' ');
}

// ── Movement helpers ──────────────────────────────────────────────────────────

async function goTo(bot: Bot, block: any, getSafeMovements: () => any): Promise<boolean> {
    try {
        const mv = getSafeMovements();
        mv.canDig = true;
        bot.pathfinder.setMovements(mv);
        await bot.pathfinder.goto(new GoalGetToBlock(block.position.x, block.position.y, block.position.z));
        return true;
    } catch (e: any) {
        logWarn(`Navigation failed: ${e?.message ?? e}`);
        return false;
    }
}

// ── Mining ────────────────────────────────────────────────────────────────────

async function mine(bot: Bot, blockNames: string[], needed: number, getSafeMovements: () => any, searchRadius = 64): Promise<number> {
    let mined = 0;
    log(`  ⛏ Looking for ${blockNames[0]} (need ${needed}, radius ${searchRadius})...`);
    while (mined < needed && !stopFlag) {
        const block = bot.findBlock({
            matching: b => blockNames.includes(b.name),
            maxDistance: searchRadius,
        });
        if (!block) {
            logWarn(`  No ${blockNames[0]} found within ${searchRadius} blocks`);
            break;
        }
        log(`  ⛏ Found ${block.name} at ${block.position.toFloor()}, going there...`);
        const reached = await goTo(bot, block, getSafeMovements);
        if (!reached) { await sleep(500); continue; }
        try {
            await bot.dig(block);
            mined++;
            log(`  ✓ Mined ${block.name} (${mined}/${needed})`);
        } catch (e: any) {
            logWarn(`  Dig failed: ${e?.message ?? e}`);
            await sleep(300);
        }
        await sleep(100);
    }
    return mined;
}

// ── Crafting ──────────────────────────────────────────────────────────────────

async function craft(bot: Bot, itemName: string, amount = 1, needTable = false, getSafeMovements?: () => any): Promise<boolean> {
    const mcData = minecraftData(bot.version);
    const itemDef = mcData.itemsByName[itemName];
    if (!itemDef) { logWarn(`  Unknown item: ${itemName}`); return false; }

    let table: any = null;
    if (needTable) {
        const tableId = mcData.blocksByName['crafting_table']?.id;
        table = bot.findBlock({ matching: tableId, maxDistance: 8 });
        if (!table) { logWarn(`  No crafting table nearby for ${itemName}`); return false; }
        if (getSafeMovements) await goTo(bot, table, getSafeMovements);
    }

    const recipes = bot.recipesFor(itemDef.id, null, 1, table);
    if (!recipes.length) { logWarn(`  No recipe found for ${itemName}`); return false; }

    try {
        await bot.craft(recipes[0], amount, table ?? undefined);
        log(`  ✓ Crafted ${amount}× ${itemName}`);
        return true;
    } catch (e: any) {
        logWarn(`  Craft failed for ${itemName}: ${e?.message ?? e}`);
        return false;
    }
}

// ── Place block ───────────────────────────────────────────────────────────────

async function placeNearby(bot: Bot, itemName: string, getSafeMovements: () => any): Promise<boolean> {
    const item = bot.inventory.items().find(i => i.name === itemName);
    if (!item) { logWarn(`  Don't have ${itemName} to place`); return false; }

    const pos    = bot.entity.position.floored();
    const facing = bot.entity.yaw;
    const dx     = Math.round(-Math.sin(facing));
    const dz     = Math.round(Math.cos(facing));

    // Try up to 4 directions
    const offsets = [[dx, dz], [-dz, dx], [dz, -dx], [-dx, -dz]];
    for (const [ox, oz] of offsets) {
        const target   = pos.offset(ox, 0, oz);
        const below    = bot.blockAt(target.offset(0, -1, 0));
        const occupied = bot.blockAt(target);
        if (!below || below.boundingBox !== 'block') continue;
        if (occupied && occupied.boundingBox === 'block') continue;
        try {
            await bot.equip(item, 'hand');
            await bot.placeBlock(below, new Vec3(0, 1, 0));
            log(`  ✓ Placed ${itemName}`);
            return true;
        } catch {}
    }
    logWarn(`  Could not place ${itemName} — no valid surface nearby`);
    return false;
}

// ── Smelting ──────────────────────────────────────────────────────────────────

async function smelt(bot: Bot, inputName: string, fuelName: string, outputName: string, amount: number, getSafeMovements: () => any): Promise<boolean> {
    log(`  🔥 Smelting ${amount}× ${inputName} → ${outputName}`);

    let furnaceBlock = bot.findBlock({ matching: b => b.name === 'furnace', maxDistance: 32 });
    if (!furnaceBlock) {
        if (!has(bot, 'furnace')) { logWarn('  No furnace in inventory'); return false; }
        log('  Placing furnace...');
        const ok = await placeNearby(bot, 'furnace', getSafeMovements);
        if (!ok) return false;
        await sleep(600);
        furnaceBlock = bot.findBlock({ matching: b => b.name === 'furnace', maxDistance: 8 });
    }
    if (!furnaceBlock) { logWarn('  Furnace not found'); return false; }

    log(`  Going to furnace at ${furnaceBlock.position.toFloor()}...`);
    await goTo(bot, furnaceBlock, getSafeMovements);

    try {
        const furnace = await bot.openFurnace(furnaceBlock);
        await sleep(400);

        const inputItem = bot.inventory.items().find(i => i.name === inputName);
        const fuelItem  = bot.inventory.items().find(i => i.name === fuelName);
        if (!inputItem) { furnace.close(); logWarn(`  No ${inputName} in inventory`); return false; }
        if (!fuelItem)  { furnace.close(); logWarn(`  No ${fuelName} for fuel`); return false; }

        const toSmelt = Math.min(amount, inputItem.count);
        log(`  Loading furnace: ${toSmelt}× ${inputName}, fuel: ${fuelItem.count}× ${fuelName}`);
        await furnace.putFuel(fuelItem.type, null, Math.min(fuelItem.count, toSmelt + 2));
        await sleep(300);
        await furnace.putInput(inputItem.type, null, toSmelt);

        // Wait for smelting — poll for output every 3s, timeout 90s
        const deadline = Date.now() + 90_000;
        let got = 0;
        while (got < toSmelt && Date.now() < deadline) {
            await sleep(3000);
            if (stopFlag) { furnace.close(); return false; }
            const out = furnace.outputItem();
            if (out) {
                log(`  ⏳ Output ready: ${out.count}× ${outputName}`);
                await furnace.takeOutput();
                got += out.count;
                log(`  ✓ Collected ${got}/${toSmelt}× ${outputName}`);
                if (got >= toSmelt) break;
            } else {
                log(`  ⏳ Smelting... (waiting for ${outputName})`);
            }
        }

        furnace.close();
        if (got === 0) { logWarn('  Smelting timed out or produced nothing'); return false; }
        return true;
    } catch (e: any) {
        logWarn(`  Furnace error: ${e?.message ?? e}`);
        return false;
    }
}

// ── Equip best tool ───────────────────────────────────────────────────────────

async function equipBest(bot: Bot, toolType: 'pickaxe' | 'axe' | 'sword'): Promise<void> {
    const tiers = ['netherite', 'diamond', 'iron', 'stone', 'golden', 'wooden'];
    for (const tier of tiers) {
        const item = bot.inventory.items().find(i => i.name === `${tier}_${toolType}`);
        if (item) { try { await bot.equip(item, 'hand'); } catch {} return; }
    }
}

// ── Main loop ─────────────────────────────────────────────────────────────────

async function runLoop(bot: Bot, getSafeMovements: () => any): Promise<void> {
    setState(BotState.COLLECTING);

    const LOG_LOGS = ['oak_log','birch_log','spruce_log','jungle_log','acacia_log','dark_oak_log','mangrove_log','cherry_log'];
    const PLANKS   = ['oak_planks','birch_planks','spruce_planks','jungle_planks','acacia_planks','dark_oak_planks','mangrove_planks','cherry_planks'];
    const STONE    = ['stone','cobblestone','deepslate','cobbled_deepslate'];
    const COBBLE   = ['cobblestone','cobbled_deepslate'];
    const IRON_ORE = ['iron_ore','deepslate_iron_ore'];
    const DIAMOND  = ['diamond_ore','deepslate_diamond_ore'];
    const FUELS    = [...LOG_LOGS, ...PLANKS, 'coal', 'charcoal'];

    // ── Phase 0: Eat / heal ───────────────────────────────────────────────────
    if (!await step('Phase 0 — Health check')) return;
    const hp   = bot.health ?? 20;
    const food = bot.food   ?? 20;
    log(`  HP: ${hp.toFixed(1)}/20  Food: ${food}/20`);

    if (food < 15) {
        log('  Hungry — checking inventory for food...');
        const foodItems = bot.inventory.items().filter(i =>
            ['bread','cooked_beef','cooked_pork','cooked_chicken','cooked_mutton',
             'cooked_rabbit','cooked_cod','cooked_salmon','apple','carrot','potato',
             'baked_potato','beetroot','melon_slice','cookie','pumpkin_pie'].includes(i.name)
        );
        if (foodItems.length) {
            log(`  Eating ${foodItems[0].name}...`);
            try {
                await bot.equip(foodItems[0], 'hand');
                await bot.consume();
                log('  ✓ Ate food');
            } catch (e: any) { logWarn(`  Eat failed: ${e?.message ?? e}`); }
        } else {
            logWarn('  No food in inventory — proceeding anyway');
        }
    }

    log(`  Inventory: ${invSummary(bot)}`);

    // ── Phase 1: Wood ─────────────────────────────────────────────────────────
    if (!await step('Phase 1 — Wood & crafting table')) return;

    const logCount = countOf(bot, ...LOG_LOGS);
    log(`  Have ${logCount} logs`);
    if (logCount < 8) {
        await equipBest(bot, 'axe');
        const got = await mine(bot, LOG_LOGS, 8 - logCount, getSafeMovements, 48);
        log(`  Collected ${got} logs. Total: ${countOf(bot, ...LOG_LOGS)}`);
    }

    // Craft planks
    const plankCount = countOf(bot, ...PLANKS);
    log(`  Have ${plankCount} planks`);
    if (plankCount < 8) {
        const logHave = LOG_LOGS.find(l => has(bot, l));
        if (logHave) {
            const plankName = logHave.replace('_log', '_planks');
            await craft(bot, plankName, 2);
        }
    }

    // Craft sticks
    if (!await step('  Crafting sticks...')) return;
    await craft(bot, 'stick', 2);

    // Craft & place crafting table
    if (!has(bot, 'crafting_table')) {
        if (!await step('  Crafting crafting_table...')) return;
        const plankHave = PLANKS.find(p => has(bot, p));
        if (plankHave) await craft(bot, 'crafting_table', 1);
    }
    if (!bot.findBlock({ matching: b => b.name === 'crafting_table', maxDistance: 6 })) {
        if (!await step('  Placing crafting table...')) return;
        await placeNearby(bot, 'crafting_table', getSafeMovements);
        await sleep(500);
    }
    log(`  ✓ Crafting table ready`);

    // ── Phase 2: Wooden tools ─────────────────────────────────────────────────
    if (!await step('Phase 2 — Wooden tools')) return;
    log(`  Have: ${invSummary(bot)}`);

    if (!has(bot, 'wooden_pickaxe')) { await craft(bot, 'wooden_pickaxe', 1, true, getSafeMovements); }
    else log('  Already have wooden_pickaxe');
    if (!has(bot, 'wooden_axe'))     { await craft(bot, 'wooden_axe',     1, true, getSafeMovements); }
    if (!has(bot, 'wooden_shovel'))  { await craft(bot, 'wooden_shovel',  1, true, getSafeMovements); }

    // ── Phase 3: Stone ────────────────────────────────────────────────────────
    if (!await step('Phase 3 — Stone tools')) return;
    await equipBest(bot, 'pickaxe');
    log(`  Equipped best pickaxe`);

    const cobbleCount = countOf(bot, ...COBBLE);
    log(`  Have ${cobbleCount} cobblestone`);
    if (cobbleCount < 12) {
        const got = await mine(bot, STONE, 12 - cobbleCount, getSafeMovements, 32);
        log(`  Mined ${got} stone. Cobble total: ${countOf(bot, ...COBBLE)}`);
    }

    if (!has(bot, 'stone_pickaxe')) await craft(bot, 'stone_pickaxe', 1, true, getSafeMovements);
    else log('  Already have stone_pickaxe');
    if (!has(bot, 'stone_axe'))     await craft(bot, 'stone_axe',     1, true, getSafeMovements);
    if (!has(bot, 'stone_shovel'))  await craft(bot, 'stone_shovel',  1, true, getSafeMovements);
    if (!has(bot, 'stone_sword'))   await craft(bot, 'stone_sword',   1, true, getSafeMovements);
    log(`  ✓ Stone tools done. Inv: ${invSummary(bot)}`);

    // ── Phase 4: Iron ─────────────────────────────────────────────────────────
    if (!await step('Phase 4 — Iron tools')) return;
    await equipBest(bot, 'pickaxe');

    const rawIron   = countOf(bot, 'raw_iron');
    const ironIngot = countOf(bot, 'iron_ingot');
    log(`  Have ${rawIron} raw_iron, ${ironIngot} iron_ingot`);

    if (rawIron + ironIngot < 9) {
        const need = 9 - rawIron - ironIngot;
        log(`  Need ${need} more iron ore`);
        await mine(bot, IRON_ORE, need, getSafeMovements, 48);
    }

    // Craft furnace if we don't have one
    if (!has(bot, 'furnace') && !bot.findBlock({ matching: b => b.name === 'furnace', maxDistance: 32 })) {
        if (!await step('  Crafting furnace (needs 8 cobblestone)...')) return;
        if (countOf(bot, ...COBBLE) >= 8) {
            await craft(bot, 'furnace', 1, true, getSafeMovements);
        } else {
            logWarn('  Not enough cobblestone for furnace — mining more stone...');
            await mine(bot, STONE, 8 - countOf(bot, ...COBBLE), getSafeMovements, 32);
            await craft(bot, 'furnace', 1, true, getSafeMovements);
        }
    }

    if (countOf(bot, 'iron_ingot') < 9) {
        const fuel = FUELS.find(f => has(bot, f)) ?? 'oak_planks';
        log(`  Using ${fuel} as fuel`);
        await smelt(bot, 'raw_iron', fuel, 'iron_ingot', 9, getSafeMovements);
    }

    log(`  Iron ingots: ${countOf(bot, 'iron_ingot')}`);
    if (!has(bot, 'iron_pickaxe')) await craft(bot, 'iron_pickaxe', 1, true, getSafeMovements);
    else log('  Already have iron_pickaxe');
    if (!has(bot, 'iron_axe'))     await craft(bot, 'iron_axe',     1, true, getSafeMovements);
    if (!has(bot, 'iron_shovel'))  await craft(bot, 'iron_shovel',  1, true, getSafeMovements);
    if (!has(bot, 'iron_sword'))   await craft(bot, 'iron_sword',   1, true, getSafeMovements);
    log(`  ✓ Iron tools done. Inv: ${invSummary(bot)}`);

    // ── Phase 5: Diamonds ─────────────────────────────────────────────────────
    if (!await step('Phase 5 — Diamonds (Y -58 to -64)')) return;
    await equipBest(bot, 'pickaxe');
    log(`  Current Y: ${Math.round(bot.entity.position.y)}`);

    const diamonds = countOf(bot, 'diamond');
    log(`  Have ${diamonds} diamonds`);
    if (diamonds < 9) {
        const got = await mine(bot, DIAMOND, 9 - diamonds, getSafeMovements, 64);
        log(`  Mined ${got} diamond ore. Total diamonds: ${countOf(bot, 'diamond')}`);
    }

    if (!has(bot, 'diamond_pickaxe')) await craft(bot, 'diamond_pickaxe', 1, true, getSafeMovements);
    else log('  Already have diamond_pickaxe');
    if (!has(bot, 'diamond_axe'))     await craft(bot, 'diamond_axe',     1, true, getSafeMovements);
    if (!has(bot, 'diamond_sword'))   await craft(bot, 'diamond_sword',   1, true, getSafeMovements);
    log(`  ✓ Diamond tools done!`);

    // ── Loop complete ─────────────────────────────────────────────────────────
    if (!await step('✅ Full progression complete! Restarting loop in 5s...')) return;
    await sleep(5000);

    running = false;
    setState(BotState.IDLE);
    startSurv(bot, getSafeMovements);
}
