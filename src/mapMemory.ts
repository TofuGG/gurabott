// src/mapMemory.ts
// Persistent per-map memory: behavior weights, bad spots, block observations.
// Data lives in ./data/<mapName>.json and survives restarts.

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { Vec3 } from 'vec3';
import Mineflayer from 'mineflayer';
import { addLog } from './modules/tui.ts';

// ── Constants ────────────────────────────────────────────────────────────────

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');

export const BEHAVIOR_NAMES = [
    'stand_look', 'short_stroll', 'long_walk', 'distracted_walk',
    'crouch_fidget', 'look_at_player', 'look_at_sky',
    'pace_back_forth', 'circle_spot'
] as const;

export type BehaviorName = typeof BEHAVIOR_NAMES[number];

const DEFAULT_WEIGHT = 10;
const REWARD = 1.5;       // multiplier on success
const PENALTY = 0.6;      // multiplier on failure
const MIN_WEIGHT = 1;
const MAX_WEIGHT = 80;
const BAD_SPOT_RADIUS = 3;
const DEATH_BAD_SPOT_RADIUS = 10;
const MAX_BAD_SPOTS = 200;
// ── Types ────────────────────────────────────────────────────────────────────

export type BehaviorWeightMap = Record<BehaviorName, number>;

type BadSpot = { x: number; y: number; z: number; reason: 'stuck' | 'fell' | 'water' };

type BlockObservation = {
    x: number; y: number; z: number;
    name: string;
    lastSeen: number; // unix ms
};

type MapData = {
    name: string;
    createdAt: number;
    lastUsed: number;
    behaviorWeights: BehaviorWeightMap;
    badSpots: BadSpot[];
    blockObservations: BlockObservation[];
    deaths?: { x: number; y: number; z: number; healthAtDeath: number; time: number }[];
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function mapPath(name: string): string {
    return path.join(DATA_DIR, `${name}.json`);
}

function defaultWeights(): BehaviorWeightMap {
    return Object.fromEntries(BEHAVIOR_NAMES.map(n => [n, DEFAULT_WEIGHT])) as BehaviorWeightMap;
}

function clamp(v: number) {
    return Math.max(MIN_WEIGHT, Math.min(MAX_WEIGHT, v));
}

function saveMap(data: MapData) {
    try {
        ensureDataDir();
        data.lastUsed = Date.now();
        fs.writeFileSync(mapPath(data.name), JSON.stringify(data, null, 2));
    } catch (err: any) {
        addLog('error', `[MEM] Failed to save ${data.name}: ${err?.message ?? err}`);
    }
}

// ── MapMemory class ──────────────────────────────────────────────────────────

export class MapMemory {
    private data: MapData;
    private dirty = false;
    private saveTimer: NodeJS.Timeout | null = null;
    private _deathKeys: Set<string> | null = null;
    private _blockObsIndex: Map<string, number> | null = null;

    constructor(data: MapData) {
        this.data = data;
        this.rebuildBlockIndex();
    }

    private rebuildBlockIndex(): void {
        this._blockObsIndex = new Map();
        for (let i = 0; i < this.data.blockObservations.length; i++) {
            const o = this.data.blockObservations[i];
            this._blockObsIndex.set(`${o.x},${o.y},${o.z}`, i);
        }
    }

    get name() { return this.data.name; }

    // ── Weights ────────────────────────────────────────────────────────────

    getWeights(): BehaviorWeightMap {
        return { ...this.data.behaviorWeights };
    }

    reward(behavior: BehaviorName) {
        const w = this.data.behaviorWeights;
        w[behavior] = clamp(w[behavior] * REWARD);
        addLog('system', `[MEM] ✓ reward ${behavior} → ${w[behavior].toFixed(1)}`);
        this.scheduleSave();
    }

    penalize(behavior: BehaviorName, reason: 'stuck' | 'fell' | 'water') {
        const w = this.data.behaviorWeights;
        w[behavior] = clamp(w[behavior] * PENALTY);
        addLog('system', `[MEM] ✗ penalize ${behavior} (${reason}) → ${w[behavior].toFixed(1)}`);
        this.scheduleSave();
    }

    // ── Bad spots ──────────────────────────────────────────────────────────

    recordDeath(pos: Vec3, healthAtDeath: number) {
        const entry = {
            x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z),
            healthAtDeath,
            time: Date.now()
        };
        if (!this.data.deaths) this.data.deaths = [];
        this.data.deaths.push(entry);
        if (this.data.deaths.length > 50) this.data.deaths = this.data.deaths.slice(-50);

        // Add a wide bad spot so the bot won't wander back to the death area
        const bx = Math.round(pos.x), by = Math.round(pos.y), bz = Math.round(pos.z);
        const exists = this.data.badSpots.some(s =>
            Math.abs(s.x - bx) < DEATH_BAD_SPOT_RADIUS &&
            Math.abs(s.y - by) < DEATH_BAD_SPOT_RADIUS &&
            Math.abs(s.z - bz) < DEATH_BAD_SPOT_RADIUS
        );
        if (!exists) {
            this.data.badSpots.push({ x: bx, y: by, z: bz, reason: 'fell' });
            if (this.data.badSpots.length > MAX_BAD_SPOTS) {
                this.data.badSpots = this.data.badSpots.slice(-MAX_BAD_SPOTS);
            }
        }
        this._deathKeys = null;
        addLog('system', `[MEM] Death recorded at (${entry.x}, ${entry.y}, ${entry.z}) — exclusion zone ${DEATH_BAD_SPOT_RADIUS} blocks`);
        this.scheduleSave();
    }

    addBadSpot(pos: Vec3, reason: BadSpot['reason']) {
        // Don't add duplicates within BAD_SPOT_RADIUS
        const exists = this.data.badSpots.some(s =>
            Math.abs(s.x - pos.x) < BAD_SPOT_RADIUS &&
            Math.abs(s.y - pos.y) < BAD_SPOT_RADIUS &&
            Math.abs(s.z - pos.z) < BAD_SPOT_RADIUS
        );
        if (exists) return;
        this.data.badSpots.push({ x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z), reason });
        if (this.data.badSpots.length > MAX_BAD_SPOTS) {
            this.data.badSpots = this.data.badSpots.slice(-MAX_BAD_SPOTS);
        }
        addLog('system', `[MEM] Bad spot added at (${Math.round(pos.x)}, ${Math.round(pos.y)}, ${Math.round(pos.z)}) reason=${reason}`);
        this.scheduleSave();
    }

    // XZ-only death check: blocks destinations above/below a known death area too
    isNearDeathXZ(pos: Vec3): boolean {
        if (!this.data.deaths) return false;
        return this.data.deaths.some(d =>
            Math.abs(d.x - pos.x) < DEATH_BAD_SPOT_RADIUS &&
            Math.abs(d.z - pos.z) < DEATH_BAD_SPOT_RADIUS
        );
    }

    private getDeathKeys(): Set<string> {
        if (!this._deathKeys) {
            this._deathKeys = new Set(
                (this.data.deaths ?? []).map(d => `${d.x},${d.y},${d.z}`)
            );
        }
        return this._deathKeys;
    }

    isNearBadSpot(pos: Vec3): boolean {
        const deathKeys = this.getDeathKeys();
        return this.data.badSpots.some(s => {
            const isDeath = deathKeys.has(`${s.x},${s.y},${s.z}`);
            const radius = isDeath ? DEATH_BAD_SPOT_RADIUS : BAD_SPOT_RADIUS;
            return (
                Math.abs(s.x - pos.x) < radius &&
                Math.abs(s.y - pos.y) < radius &&
                Math.abs(s.z - pos.z) < radius
            );
        });
    }

    // ── Block observations (map change detection) ──────────────────────────

    /**
     * Scan ~5 block radius around bot, compare to saved observations.
     * If a block has changed, remove any bad spots near it (terrain changed,
     * old data is stale) and update the observation.
     * Call this every ~30s while idle.
     */
    updateBlockObservations(bot: Mineflayer.Bot) {
        const pos = bot.entity.position;
        const now = Date.now();
        let changes = 0;

        for (let x = -5; x <= 5; x++) {
            for (let y = -3; y <= 3; y++) {
                for (let z = -5; z <= 5; z++) {
                    const bx = Math.round(pos.x) + x;
                    const by = Math.round(pos.y) + y;
                    const bz = Math.round(pos.z) + z;
                    const block = bot.blockAt(new Vec3(bx, by, bz));
                    if (!block) continue;

                    const key = `${bx},${by},${bz}`;
                    const idx = this._blockObsIndex?.get(key);
                    const existing = idx !== undefined ? this.data.blockObservations[idx] : undefined;

                    if (!existing) {
                        const newObs: BlockObservation = { x: bx, y: by, z: bz, name: block.name, lastSeen: now };
                        this.data.blockObservations.push(newObs);
                        this._blockObsIndex?.set(key, this.data.blockObservations.length - 1);
                    } else if (existing.name !== block.name) {
                        addLog('system', `[MEM] Block changed at (${bx},${by},${bz}): ${existing.name} → ${block.name}`);
                        existing.name = block.name;
                        existing.lastSeen = now;
                        changes++;

                        // Terrain changed here — clear nearby bad spots since they may no longer apply
                        this.data.badSpots = this.data.badSpots.filter(s =>
                            !(Math.abs(s.x - bx) < BAD_SPOT_RADIUS &&
                              Math.abs(s.y - by) < BAD_SPOT_RADIUS &&
                              Math.abs(s.z - bz) < BAD_SPOT_RADIUS)
                        );
                    }
                }
            }
        }

        // Cap observation list size to avoid unbounded growth.
        if (this.data.blockObservations.length > 50000) {
            const cutoff = now - 600_000;
            this.data.blockObservations = this.data.blockObservations.filter(o => o.lastSeen > cutoff);
            if (this.data.blockObservations.length > 45000) {
                this.data.blockObservations.length = 45000;
            }
            this.rebuildBlockIndex();
        }

        if (changes > 0) this.scheduleSave();
    }

    // ── Persistence ────────────────────────────────────────────────────────

    private scheduleSave() {
        this.dirty = true;
        if (this.saveTimer) return;
        this.saveTimer = setTimeout(() => {
            this.saveTimer = null;
            if (this.dirty) {
                saveMap(this.data);
                this.dirty = false;
            }
        }, 3000); // debounce — batch writes every 3s
    }

    forceSave() {
        if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
        saveMap(this.data);
        this.dirty = false;
    }
}