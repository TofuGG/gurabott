/**
 * mcp.ts - MCP (Model Context Protocol) server for Gurabott.
 *
 * When enabled, the bot hosts an MCP server over Streamable HTTP so ANY AI
 * (opencode, Claude, Cursor, ...) can connect and drive the bot:
 *   - observe: state, coords, facing, inventory, the block the bot is looking
 *     at (and its coords), players, nearby blocks/mobs, recent logs
 *   - control: run any g-command, say, goto coords, look_at, stop
 *
 * SECURITY: binds to 127.0.0.1 by default. run_command / say / goto are
 * powerful — only expose the port to trusted clients / your local network.
 */

import HTTP from 'node:http';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { Vec3 } from 'vec3';
import baritonePlugin from '@miner-org/mineflayer-baritone';
import { addLog, getLogs, getTelemetry } from '../core/store.ts';
import { handleCommand, type CommandContext } from './commands.ts';
import { getState, setState, clearAllControls, BotState } from './state.ts';
import { safeGoto } from '../utils.ts';
import { registerMcpCommands, commandHelpLines } from './mcpCommands.ts';

const baritoneGoals = baritonePlugin.goals;

export interface McpOptions {
    getCtx: () => CommandContext | null;
    host?: string;
    port?: number;
}

let httpServer: HTTP.Server | null = null;
let execLock: Promise<void> = Promise.resolve();

interface McpSession {
    server: McpServer;
    transport: StreamableHTTPServerTransport;
}

// The SDK's StreamableHTTPServerTransport is single-session: one transport can
// only serve ONE client until it closes. To let multiple AI clients connect
// (and reconnect) without restarting the bot, each MCP session gets its own
// McpServer + transport, created on the first `initialize` and cleaned up on
// close. Tracked here by the Mcp-Session-Id header.
const sessions = new Map<string, McpSession>();

export function isMcpRunning(): boolean {
    return httpServer !== null;
}

function readBody(req: HTTP.IncomingMessage, maxBytes = 1_000_000): Promise<string> {
    return new Promise((resolve, reject) => {
        let data = '';
        req.on('data', (chunk) => {
            data += chunk;
            if (data.length > maxBytes) {
                req.removeAllListeners('data');
                req.removeAllListeners('end');
                const err: any = new Error('request body too large');
                err.code = 'BODY_TOO_LARGE';
                reject(err);
            }
        });
        req.on('end', () => resolve(data));
        req.on('error', reject);
    });
}

function isInitializeMessage(message: unknown): boolean {
    return !!message && typeof message === 'object' && (message as any).method === 'initialize';
}

function writeJson(res: HTTP.ServerResponse, status: number, payload: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
}

function jsonRpcError(code: number, message: string) {
    return { jsonrpc: '2.0', error: { code, message }, id: null };
}

async function createMcpSession(getCtx: () => CommandContext | null): Promise<McpSession> {
    const server = new McpServer({ name: 'gura-bot', version: '1.0.0' });
    registerAllTools(server, getCtx);

    const session: McpSession = {} as McpSession;
    const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (id: string) => {
            sessions.set(id, session);
        },
    });
    session.server = server;
    session.transport = transport;

    transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) sessions.delete(sid);
        server.close().catch(() => {});
    };

    await server.connect(transport);
    return session;
}

// ── response helpers ──────────────────────────────────────────────────────────

const txt = (data: unknown) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
});

const errTxt = (message: string) => ({
    content: [{ type: 'text' as const, text: message }],
    isError: true as const,
});

// ── bot helpers ───────────────────────────────────────────────────────────────

function requireSpawned(getCtx: () => CommandContext | null): CommandContext | null {
    const ctx = getCtx();
    if (!ctx?.bot?.entity) return null;
    return ctx;
}

function facingFromYaw(yaw: number): string {
    const dirs = ['S', 'W', 'N', 'E'];
    const norm = ((yaw % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    return dirs[Math.round(norm / (Math.PI / 2)) % 4];
}

async function withExecLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = execLock.then(fn, fn);
    execLock = run.then(() => undefined, () => undefined);
    return run;
}

/**
 * Resolve with the promise's value if it settles within `ms`, or `{done:false}`
 * when the cap fires. The wrapped promise keeps running in the background — the
 * caller returns early, but the exec lock is held until the command ACTUALLY
 * finishes (see withExecLock call sites), so a long-running command (gcollect,
 * gsurv) can't be overlapped by a second concurrent command fighting for
 * movement. The cap only bounds the CLIENT's wait, not the command's lifetime.
 */
function withResponseCap<T>(p: Promise<T>, ms: number): Promise<{ done: boolean; value?: T }> {
    return new Promise((resolve) => {
        const t = setTimeout(() => resolve({ done: false }), ms);
        p.then(
            (v) => { clearTimeout(t); resolve({ done: true, value: v }); },
            () => { clearTimeout(t); resolve({ done: false }); },
        );
    });
}

// ── tools ─────────────────────────────────────────────────────────────────────

function registerAllTools(server: McpServer, getCtx: () => CommandContext | null): void {
    server.registerTool(
        'get_state',
        {
            description: 'Current bot state: connection, hp/food, coordinates, mode, inventory count, uptime.',
        },
        async () => {
            const t = getTelemetry();
            const ctx = getCtx();
            return txt({
                connected: t?.connected ?? false,
                server: t?.server ?? null,
                username: t?.username ?? null,
                ping: t?.ping ?? null,
                players: t?.players ?? null,
                hp: t?.hp ?? null,
                food: t?.food ?? null,
                pos: t?.pos ?? null,
                state: t?.state ?? null,
                stateName: ctx?.bot?.entity ? getState() : null,
                invCount: t?.invCount ?? null,
                aiEnabled: t?.aiEnabled ?? false,
                uptime: t?.uptime ?? null,
            });
        },
    );

    server.registerTool(
        'get_position',
        {
            description: 'The bot\'s exact coordinates, yaw/pitch, and the cardinal direction it is facing.',
        },
        async () => {
            const ctx = getCtx();
            const e = ctx?.bot?.entity;
            if (!e) return errTxt('Bot not spawned');
            const p = e.position;
            return txt({
                pos: { x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2) },
                yaw: +e.yaw.toFixed(2),
                pitch: +e.pitch.toFixed(2),
                facing: facingFromYaw(e.yaw),
            });
        },
    );

    server.registerTool(
        'get_inventory',
        {
            description: 'Full inventory: item name, count, slot, and the 1-based index used by geat/gdrop.',
        },
        async () => {
            const ctx = getCtx();
            const items = ctx?.bot?.inventory?.items?.();
            if (!items) return errTxt('Bot not spawned / no inventory');
            return txt({
                items: items.map((i, idx) => ({
                    index: idx + 1,
                    name: i.name,
                    displayName: i.displayName ?? i.name,
                    count: i.count,
                    slot: i.slot,
                    metadata: i.metadata,
                })),
            });
        },
    );

    server.registerTool(
        'get_block_looking_at',
        {
            description: 'The block the bot is currently looking at, including its coordinates and distance.',
            inputSchema: { maxDistance: z.number().int().min(1).max(512).optional().describe('raycast range, default 256') },
        },
        async (args) => {
            const ctx = requireSpawned(getCtx);
            if (!ctx) return errTxt('Bot not spawned');
            try {
                const block = ctx.bot.blockAtCursor(args.maxDistance ?? 256);
                if (!block) return txt({ block: null, note: 'nothing in view within range' });
                const eye = ctx.bot.entity.position.offset(0, ctx.bot.entity.height ?? 1.6, 0);
                return txt({
                    block: {
                        name: block.name,
                        displayName: block.displayName ?? block.name,
                        pos: { x: block.position.x, y: block.position.y, z: block.position.z },
                        distance: +eye.distanceTo(block.position).toFixed(1),
                    },
                });
            } catch (e: any) {
                return errTxt(`raycast failed: ${e?.message ?? e}`);
            }
        },
    );

    server.registerTool(
        'get_block_at',
        {
            description: 'The block at an arbitrary coordinate (name + state properties).',
            inputSchema: { x: z.number().int(), y: z.number().int(), z: z.number().int() },
        },
        async (args) => {
            const ctx = getCtx();
            if (!ctx?.bot) return errTxt('Bot not connected');
            const block = ctx.bot.blockAt(new Vec3(args.x, args.y, args.z));
            if (!block) return txt({ block: null, note: 'unloaded chunk or air' });
            const props: Record<string, unknown> = {};
            try {
                const p = (block as any).getProperties?.();
                if (p && typeof p === 'object') Object.assign(props, p);
            } catch {}
            return txt({
                block: {
                    name: block.name,
                    displayName: block.displayName ?? block.name,
                    pos: { x: block.position.x, y: block.position.y, z: block.position.z },
                    properties: props,
                },
            });
        },
    );

    server.registerTool(
        'get_players',
        {
            description: 'Online players (excluding the bot) with ping and position if visible.',
        },
        async () => {
            const ctx = getCtx();
            const players = ctx?.bot?.players;
            if (!players) return errTxt('Bot not connected');
            const self = ctx?.bot.username;
            const list = Object.entries(players)
                .filter(([name]) => name !== self)
                .map(([name, p]) => {
                    const ep = p.entity?.position;
                    return {
                        name,
                        ping: p.ping,
                        pos: ep ? { x: +ep.x.toFixed(1), y: +ep.y.toFixed(1), z: +ep.z.toFixed(1) } : null,
                    };
                });
            return txt({ players: list });
        },
    );

    server.registerTool(
        'get_nearby',
        {
            description: 'Distinct block names within a radius around the bot, plus nearby mobs with positions.',
            inputSchema: { radius: z.number().int().min(1).max(32).optional().describe('block scan radius, default 8') },
        },
        async (args) => {
            const ctx = requireSpawned(getCtx);
            if (!ctx) return errTxt('Bot not spawned');
            const radius = args.radius ?? 8;
            const pos = ctx.bot.entity.position;
            const yHalf = Math.min(3, radius);
            const blocks = new Set<string>();
            for (let x = -radius; x <= radius; x++)
                for (let y = -yHalf; y <= yHalf; y++)
                    for (let z = -radius; z <= radius; z++) {
                        const b = ctx.bot.blockAt(pos.offset(x, y, z));
                        if (b && b.name !== 'air') blocks.add(b.name);
                    }
            const mobs = Object.values(ctx.bot.entities)
                .filter(e => e.type === 'mob' && (e.position?.distanceTo(pos) ?? Infinity) <= radius)
                .map(e => ({
                    name: e.name ?? e.username ?? 'mob',
                    pos: { x: +e.position.x.toFixed(1), y: +e.position.y.toFixed(1), z: +e.position.z.toFixed(1) },
                }));
            return txt({ blocks: [...blocks].slice(0, 40), mobs });
        },
    );

    server.registerTool(
        'get_logs',
        {
            description: 'Recent bot log entries. Optionally filter by type (chat/system/error/state/ai/movement/warn).',
            inputSchema: {
                limit: z.number().int().min(1).max(500).optional().describe('number of entries, default 50'),
                type: z.string().optional().describe('filter by log type'),
            },
        },
        async (args) => {
            const all = getLogs();
            const filtered = args.type ? all.filter(l => l.type === args.type) : all;
            const recent = filtered.slice(-Math.max(1, Math.min(args.limit ?? 50, 500)));
            return txt({ logs: recent.map(l => ({ type: l.type, text: l.text, ts: l.ts })) });
        },
    );

    server.registerTool(
        'get_help',
        {
            description: 'List every MCP tool and g-command available to the bot.',
        },
        async () => {
            return txt({
                tools: [
                    'get_state', 'get_position', 'get_inventory', 'get_block_looking_at', 'get_block_at',
                    'get_players', 'get_nearby', 'get_logs', 'get_help',
                    'run_command', 'say', 'goto', 'look_at', 'stop',
                ],
                commands: commandHelpLines(),
                note: 'Prefer the dedicated per-command tools (gcollect, gfollow, geat, gcraft, ...) over run_command. ' +
                      'Command output appears in the bot log (get_logs) and in Minecraft chat.',
            });
        },
    );

    server.registerTool(
        'run_command',
        {
            description: 'Fallback: execute a raw g-command string verbatim, e.g. "gcollect wood 8" or "gsurv stop". ' +
                         'Prefer the dedicated tools (gcollect, gfollow, geat, gcraft, gtp, gkill, gsurv, ...) when available.',
            inputSchema: { command: z.string().min(1).describe('full command string, e.g. "gsay hello"') },
        },
        async (args) => {
            const ctx = requireSpawned(getCtx);
            if (!ctx) return errTxt('Bot not spawned');
            // The lock wraps the command's FULL execution (not just until the
            // response cap fires), so two long commands can't run concurrently.
            const run = withExecLock(() => handleCommand(ctx, 'MCP', args.command));
            const res = await withResponseCap(run, 15_000);
            if (res.done) {
                return txt({
                    recognized: res.value,
                    command: args.command,
                    note: res.value
                        ? 'executed — see get_logs for the bot\'s output'
                        : 'unknown command — see get_help for the list',
                });
            }
            return txt({
                recognized: true,
                started: true,
                stillRunning: true,
                command: args.command,
                note: 'command is running in the background — poll get_logs / get_inventory for progress',
            });
        },
    );

    server.registerTool(
        'say',
        {
            description: 'Make the bot speak a message in Minecraft chat.',
            inputSchema: { message: z.string().min(1).max(256) },
        },
        async (args) => {
            const ctx = requireSpawned(getCtx);
            if (!ctx) return errTxt('Bot not spawned');
            try {
                ctx.bot.chat(args.message);
                return txt({ said: true, message: args.message });
            } catch (e: any) {
                return errTxt(`say failed: ${e?.message ?? e}`);
            }
        },
    );

    server.registerTool(
        'goto',
        {
            description: 'Pathfind the bot to an exact coordinate (baritone, 12s timeout).',
            inputSchema: { x: z.number(), y: z.number(), z: z.number() },
        },
        async (args) => {
            const ctx = requireSpawned(getCtx);
            if (!ctx) return errTxt('Bot not spawned');
            return withExecLock(async () => {
                const nav = await safeGoto(ctx.bot, new baritoneGoals.GoalExact(new Vec3(args.x, args.y, args.z)), 12000);
                return txt({ status: nav.status, error: nav.error?.message ?? nav.error ?? null });
            });
        },
    );

    server.registerTool(
        'look_at',
        {
            description: 'Turn the bot\'s head. Provide x/y/z coordinates OR yaw/pitch.',
            inputSchema: {
                x: z.number().optional(),
                y: z.number().optional(),
                z: z.number().optional(),
                yaw: z.number().optional(),
                pitch: z.number().optional(),
            },
        },
        async (args) => {
            const ctx = requireSpawned(getCtx);
            if (!ctx) return errTxt('Bot not spawned');
            try {
                if (args.x !== undefined && args.y !== undefined && args.z !== undefined) {
                    await ctx.bot.lookAt(new Vec3(args.x, args.y, args.z));
                } else if (args.yaw !== undefined && args.pitch !== undefined) {
                    await ctx.bot.look(args.yaw, args.pitch);
                } else {
                    return errTxt('provide x,y,z OR yaw,pitch');
                }
                return txt({ ok: true });
            } catch (e: any) {
                return errTxt(`look failed: ${e?.message ?? e}`);
            }
        },
    );

    server.registerTool(
        'stop',
        {
            description: 'Cancel all movement and set the bot back to idle.',
        },
        async () => {
            const ctx = requireSpawned(getCtx);
            if (!ctx) return errTxt('Bot not spawned');
            return withExecLock(async () => {
                try { ctx.bot.ashfinder?.stop?.(); } catch {}
                setState(BotState.IDLE);
                clearAllControls(ctx.bot);
                return txt({ stopped: true, state: getState() });
            });
        },
    );

    registerMcpCommands(server, { getCtx, withExecLock, txt, errTxt });
}

// ── lifecycle ─────────────────────────────────────────────────────────────────

export async function startMcpServer(opts: McpOptions): Promise<boolean> {
    if (httpServer) {
        addLog('warn', '[MCP] Already running');
        return true;
    }
    const host = opts.host ?? '127.0.0.1';
    const port = opts.port ?? 5400;

    try {
        httpServer = HTTP.createServer((req, res) => {
            void (async () => {
                const path = (req.url ?? '/').split('?')[0];
                if (path !== '/mcp' && path !== '/') {
                    writeJson(res, 404, jsonRpcError(-32600, 'Not Found'));
                    return;
                }
                const sessionId = (req.headers['mcp-session-id'] as string) ?? undefined;
                try {
                    if (sessionId) {
                        const existing = sessions.get(sessionId);
                        if (!existing) {
                            writeJson(res, 404, jsonRpcError(-32001, 'Session not found'));
                            return;
                        }
                        await existing.transport.handleRequest(req, res);
                        return;
                    }

                    const rawBody = await readBody(req);
                    let parsed: unknown = null;
                    try { parsed = JSON.parse(rawBody); } catch {}

                    const isInit = Array.isArray(parsed)
                        ? parsed.some(isInitializeMessage)
                        : isInitializeMessage(parsed);

                    if (!isInit) {
                        writeJson(res, 400, jsonRpcError(-32600, 'Bad Request: Missing session ID'));
                        return;
                    }

                    const session = await createMcpSession(opts.getCtx);
                    await session.transport.handleRequest(req, res, parsed);
                } catch (err: any) {
                    if (err?.code === 'BODY_TOO_LARGE') {
                        addLog('warn', '[MCP] Rejected oversized request body');
                        if (!res.headersSent) writeJson(res, 413, jsonRpcError(-32600, 'Payload too large'));
                        return;
                    }
                    addLog('error', `[MCP] request failed: ${err?.message ?? err}`);
                    if (!res.headersSent) {
                        writeJson(res, 500, jsonRpcError(-32603, 'internal error'));
                    }
                }
            })();
        });

        httpServer.on('error', (err: any) => {
            if (err.code === 'EADDRINUSE') {
                addLog('warn', `[MCP] Port ${port} in use — MCP server disabled`);
            } else {
                addLog('error', `[MCP] Server error: ${err?.message ?? err}`);
            }
            httpServer = null;
        });

        await new Promise<void>((resolve, reject) => {
            httpServer!.once('error', reject);
            httpServer!.listen(port, host, () => resolve());
        });
        addLog('system', `[MCP] server on http://${host}:${port}/mcp`);
        return true;
    } catch (e: any) {
        addLog('error', `[MCP] Failed to start: ${e?.message ?? e}`);
        if (httpServer) {
            httpServer.close();
            httpServer = null;
        }
        return false;
    }
}

export async function stopMcpServer(): Promise<void> {
    if (httpServer) {
        httpServer.close();
        httpServer = null;
    }
    for (const [, session] of sessions) {
        try { await session.transport.close(); } catch {}
    }
    sessions.clear();
    execLock = Promise.resolve();
}
