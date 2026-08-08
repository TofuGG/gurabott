/**
 * mining.ts - Shared mining / tool helpers used by gcollect and gsurv.
 */

import type { Bot } from 'mineflayer';
import minecraftData from 'minecraft-data';

/**
 * Pick the best held weapon by tier (netherite → wooden), preferring swords
 * over axes. Returns null when nothing usable is held.
 */
export function getBestWeapon(bot: Bot): any | null {
    const priorities = [
        ['netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'golden_sword', 'wooden_sword'],
        ['netherite_axe',   'diamond_axe',   'iron_axe',   'stone_axe',   'golden_axe',   'wooden_axe'],
    ];
    for (const group of priorities) {
        for (const name of group) {
            const found = bot.inventory.items().find(i => i.name === name);
            if (found) return found;
        }
    }
    return null;
}

/**
 * Equip the best tool of a given kind by tier (netherite → wooden).
 * No-op if none is held in the inventory.
 */
export async function equipBestTool(bot: Bot, toolType: 'pickaxe' | 'axe' | 'sword'): Promise<void> {
    const tiers = ['netherite', 'diamond', 'iron', 'stone', 'golden', 'wooden'];
    for (const tier of tiers) {
        const item = bot.inventory.items().find(i => i.name === `${tier}_${toolType}`);
        if (item) { try { await bot.equip(item, 'hand'); } catch {} return; }
    }
}

/**
 * Pick the best held tool able to harvest `blockName` (by tier). Returns null
 * when the block is unharvestable or nothing in the inventory can break it.
 */
export function getBestToolForBlock(bot: Bot, blockName: string): any | null {
    const mcData = minecraftData(bot.version);
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
}

/**
 * Resolve true once an item matching `names` enters the inventory, or false
 * after `timeoutMs`. Listens to playerCollect + physicsTick (mirrors the
 * historical per-command pickup waits).
 */
export function waitForPickup(bot: Bot, names: string[], timeoutMs = 5000): Promise<boolean> {
    return new Promise(resolve => {
        const countOf = () => bot.inventory.items()
            .filter(i => names.includes(i.name))
            .reduce((s, i) => s + i.count, 0);
        const countBefore = countOf();
        let resolved = false;

        const onCollect = () => {
            if (resolved) return;
            if (countOf() > countBefore) { resolved = true; cleanup(); resolve(true); }
        };
        const onPhys = () => { onCollect(); };
        const cleanup = () => { resolved = true; bot.removeListener('playerCollect', onCollect); bot.removeListener('physicsTick', onPhys); };

        bot.on('playerCollect', onCollect);
        bot.on('physicsTick', onPhys);
        setTimeout(() => { cleanup(); resolve(false); }, timeoutMs);
    });
}
