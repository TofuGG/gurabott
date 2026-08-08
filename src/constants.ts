/**
 * constants.ts - Shared block/entity name lists used across modules.
 */

// Hostile mobs the bot will fight or flee from.
export const HOSTILE_MOBS = new Set([
    'zombie', 'creeper', 'skeleton', 'spider', 'enderman', 'witch', 'slime', 'drowned', 'husk', 'stray',
    'phantom', 'pillager', 'vindicator', 'evoker', 'ravager', 'illusioner', 'blaze', 'magma_cube', 'ghast',
    'wither_skeleton', 'piglin', 'piglin_brute', 'zombified_piglin', 'hoglin', 'zoglin', 'warden', 'shulker',
    'silverfish', 'endermite', 'guardian', 'elder_guardian', 'vex',
]);

// gcollect resource groups.
export const RESOURCE_GROUPS: Record<string, string[]> = {
    wood: [
        'oak_log', 'acacia_log', 'birch_log', 'cherry_log', 'dark_oak_log', 'jungle_log',
        'mangrove_log', 'spruce_log', 'oak_wood', 'acacia_wood', 'birch_wood', 'cherry_wood',
        'dark_oak_wood', 'jungle_wood', 'mangrove_wood', 'spruce_wood',
    ],
    stone: ['stone', 'cobblestone'],
    dirt:  ['dirt'],
};

// Blocks that drop under a different item name than the block itself.
// Everything else (logs, dirt, ...) drops under its own name.
export const BLOCK_DROPS: Record<string, string[]> = {
    stone: ['cobblestone'],
    deepslate: ['cobbled_deepslate'],
};

// Survival progression name lists.
export const LOG_LOGS = ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log'];
export const PLANKS   = ['oak_planks', 'birch_planks', 'spruce_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks', 'mangrove_planks', 'cherry_planks'];
export const STONE    = ['stone', 'cobblestone', 'deepslate', 'cobbled_deepslate'];
export const COBBLE   = ['cobblestone', 'cobbled_deepslate'];
export const IRON_ORE = ['iron_ore', 'deepslate_iron_ore'];
export const DIAMOND  = ['diamond_ore', 'deepslate_diamond_ore'];

// Door/trapdoor names for gopendoor.
export const DOOR_NAMES = [
    'oak_door', 'spruce_door', 'birch_door', 'jungle_door', 'acacia_door',
    'dark_oak_door', 'mangrove_door', 'cherry_door', 'crimson_door', 'warped_door',
    'iron_door', 'oak_trapdoor', 'spruce_trapdoor', 'birch_trapdoor', 'jungle_trapdoor',
    'acacia_trapdoor', 'dark_oak_trapdoor', 'mangrove_trapdoor', 'iron_trapdoor',
];
