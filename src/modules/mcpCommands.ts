/**
 * mcpCommands.ts - g-command registry exposed as structured MCP tools.
 *
 * Each entry maps 1:1 to a g-command in commands.ts. The AI-facing
 * `description` and typed `schema` are what let a function-calling model pick
 * the right tool ("mine wood for me" -> gcollect wood 8) instead of guessing
 * raw command strings through run_command.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { handleCommand, type CommandContext } from './commands.ts';

export interface McpCommandSpec {
    tool: string;
    description: string;
    schema: Record<string, z.ZodType>;
    build: (args: any) => string;
    argHint: string;
}

const zInt = () => z.number().int();
const zPosInt = () => zInt().min(1);

export const commandSpecs: McpCommandSpec[] = [
    {
        tool: 'gping',
        description: 'The bot replies in chat with its latency (ping) to the server.',
        schema: {},
        build: () => 'gping',
        argHint: 'gping',
    },
    {
        tool: 'gsay',
        description: 'Make the bot speak a message in Minecraft chat.',
        schema: { message: z.string().min(1).max(240) },
        build: (a) => `gsay ${a.message}`,
        argHint: 'gsay <message>',
    },
    {
        tool: 'ginv',
        description: 'The bot announces in chat how many items it is holding.',
        schema: {},
        build: () => 'ginv',
        argHint: 'ginv',
    },
    {
        tool: 'ginvsee',
        description: 'The bot lists its full inventory (index, item, count) in chat.',
        schema: {},
        build: () => 'ginvsee',
        argHint: 'ginvsee',
    },
    {
        tool: 'geat',
        description: 'Eat food to restore hunger. item_index is the 1-based index from the get_inventory tool; amount defaults to 1.',
        schema: {
            item_index: zPosInt().max(36),
            amount: zPosInt().optional(),
        },
        build: (a) => `geat ${a.item_index}${a.amount ? ` ${a.amount}` : ''}`,
        argHint: 'geat <item_index> [amount]',
    },
    {
        tool: 'gjump',
        description: 'Make the bot jump the given number of times (default 1).',
        schema: { amount: zPosInt().optional() },
        build: (a) => `gjump ${a.amount ?? 1}`,
        argHint: 'gjump [amount]',
    },
    {
        tool: 'gdrop',
        description: 'Drop items from the inventory. item_index is the 1-based index from the get_inventory tool; amount defaults to 1.',
        schema: {
            item_index: zPosInt().max(36),
            amount: zPosInt().optional(),
        },
        build: (a) => `gdrop ${a.item_index}${a.amount ? ` ${a.amount}` : ''}`,
        argHint: 'gdrop <item_index> [amount]',
    },
    {
        tool: 'gwalk',
        description: 'The bot takes a short walk forward.',
        schema: {},
        build: () => 'gwalk',
        argHint: 'gwalk',
    },
    {
        tool: 'gcr',
        description: 'The bot crouches/sneaks for the given number of seconds.',
        schema: { seconds: zPosInt() },
        build: (a) => `gcr ${a.seconds}`,
        argHint: 'gcr <seconds>',
    },
    {
        tool: 'gcords',
        description: 'The bot announces its current coordinates in chat.',
        schema: {},
        build: () => 'gcords',
        argHint: 'gcords',
    },
    {
        tool: 'gtp',
        description: 'Teleport the bot to coordinates (requires OP/permission on the server).',
        schema: { x: z.number(), y: z.number(), z: z.number() },
        build: (a) => `gtp ${a.x} ${a.y} ${a.z}`,
        argHint: 'gtp <x> <y> <z>',
    },
    {
        tool: 'gfollow',
        description: 'Walk to and follow a named player (e.g. "TofuDayo"). Use for "follow <player>" requests.',
        schema: { player: z.string().min(1) },
        build: (a) => `gfollow ${a.player}`,
        argHint: 'gfollow <player>',
    },
    {
        tool: 'gsfollow',
        description: 'Stop following — cancel an active gfollow.',
        schema: {},
        build: () => 'gsfollow',
        argHint: 'gsfollow',
    },
    {
        tool: 'gcraft',
        description: 'Craft an item by its minecraft item id, e.g. "wooden_pickaxe", "torch", "stone_sword". Use for "craft/make <item>" requests.',
        schema: { item: z.string().min(1) },
        build: (a) => `gcraft ${a.item}`,
        argHint: 'gcraft <item_id>',
    },
    {
        tool: 'gdump',
        description: 'The bot throws out / drops its entire inventory.',
        schema: {},
        build: () => 'gdump',
        argHint: 'gdump',
    },
    {
        tool: 'gkill',
        description: 'Attack and kill a mob (e.g. "zombie", "cow") or a named player.',
        schema: { target: z.string().min(1) },
        build: (a) => `gkill ${a.target}`,
        argHint: 'gkill <mob|player>',
    },
    {
        tool: 'glast',
        description: 'The bot tells you who last joined the server.',
        schema: {},
        build: () => 'glast',
        argHint: 'glast',
    },
    {
        tool: 'gsleep',
        description: 'The bot walks to and sleeps in the nearest bed (only works at night with no monsters nearby).',
        schema: {},
        build: () => 'gsleep',
        argHint: 'gsleep',
    },
    {
        tool: 'gopendoor',
        description: 'Find and open the nearest door.',
        schema: {},
        build: () => 'gopendoor',
        argHint: 'gopendoor',
    },
    {
        tool: 'gcollect',
        description: 'Mine and collect a resource for you. resource is "wood" (logs), "stone", or "dirt". Use whenever the user asks to gather/mine wood, stone, dirt, logs, or similar raw materials. amount defaults to 2.',
        schema: {
            resource: z.enum(['wood', 'stone', 'dirt']),
            amount: zPosInt().optional(),
        },
        build: (a) => `gcollect ${a.resource}${a.amount ? ` ${a.amount}` : ''}`,
        argHint: 'gcollect <wood|stone|dirt> [amount]',
    },
    {
        tool: 'gscollect',
        description: 'STOP the current collection — cancels an active gcollect/gsurv gathering task and returns the bot to idle.',
        schema: {},
        build: () => 'gscollect',
        argHint: 'gscollect',
    },
    {
        tool: 'gsurv',
        description: 'Run or stop the autonomous survival progression loop (gather wood → craft tools → stone → iron → diamonds).',
        schema: { action: z.enum(['start', 'stop']).optional() },
        build: (a) => (a.action === 'stop' ? 'gsurv stop' : 'gsurv'),
        argHint: 'gsurv [start|stop]',
    },
];

export function commandHelpLines(): string[] {
    return commandSpecs.map((s) => s.argHint);
}

export interface McpCommandDeps {
    getCtx: () => CommandContext | null;
    withExecLock: <T>(fn: () => Promise<T>) => Promise<T>;
    txt: (data: unknown) => { content: { type: 'text'; text: string }[] };
    errTxt: (message: string) => { content: { type: 'text'; text: string }[]; isError: true };
}

function raceDone<T>(p: Promise<T>, ms: number): Promise<{ done: boolean; value?: T }> {
    return new Promise((resolve) => {
        const t = setTimeout(() => resolve({ done: false }), ms);
        p.then(
            (v) => { clearTimeout(t); resolve({ done: true, value: v }); },
            () => { clearTimeout(t); resolve({ done: false }); },
        );
    });
}

export function registerMcpCommands(server: McpServer, deps: McpCommandDeps): void {
    for (const spec of commandSpecs) {
        server.registerTool(
            spec.tool,
            {
                description: spec.description,
                inputSchema: spec.schema,
            },
            async (args: any) => {
                const ctx = deps.getCtx();
                if (!ctx?.bot?.entity) return deps.errTxt('Bot not spawned');
                // The lock wraps the command's FULL execution (not just until
                // the 15s response cap), so a long gcollect/gsurv can't be
                // overlapped by a second concurrent command fighting for
                // movement. The cap only bounds the client's wait; the command
                // keeps running in the background with the lock held.
                const run = deps.withExecLock(() => handleCommand(ctx, 'MCP', spec.build(args)));
                const res = await raceDone(run, 15_000);
                if (res.done) {
                    return deps.txt({
                        tool: spec.tool,
                        recognized: res.value,
                        note: res.value
                            ? 'executed — see get_logs for the bot\'s output'
                            : 'command failed to dispatch — see get_help',
                    });
                }
                return deps.txt({
                    tool: spec.tool,
                    recognized: true,
                    started: true,
                    stillRunning: true,
                    note: 'command is running in the background — poll get_logs / get_inventory for progress',
                });
            },
        );
    }
}
