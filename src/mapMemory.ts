// src/mapMemory.ts
// Persistent per-map memory: behavior weights, bad spots, block observations.
// Data lives in ./data/<mapName>.json and survives restarts.

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { Vec3 } from 'vec3';
import Mineflayer from 'mineflayer';

// ── Constants ────────────────────────────────────────────────────────────────

const DATA_DIR = path.resolve('./data');

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
const DEATH_BAD_SPOT_RADIUS = 10; // much wider exclusion zone around death spots
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

function listMaps(): string[] {
    ensureDataDir();
    return fs.readdirSync(DATA_DIR)
        .filter(f => f.endsWith('.json'))
        .map(f => f.replace('.json', ''));
}

function loadMap(name: string): MapData {
    const p = mapPath(name);
    if (!fs.existsSync(p)) throw new Error(`Map "${name}" not found`);
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as MapData;
}

function saveMap(data: MapData) {
    ensureDataDir();
    data.lastUsed = Date.now();
    fs.writeFileSync(mapPath(data.name), JSON.stringify(data, null, 2));
}

function defaultWeights(): BehaviorWeightMap {
    return Object.fromEntries(BEHAVIOR_NAMES.map(n => [n, DEFAULT_WEIGHT])) as BehaviorWeightMap;
}

function clamp(v: number) {
    return Math.max(MIN_WEIGHT, Math.min(MAX_WEIGHT, v));
}

function ask(rl: readline.Interface, question: string): Promise<string> {
    return new Promise(resolve => rl.question(question, resolve));
}

// ── Startup prompt ───────────────────────────────────────────────────────────

export async function selectOrCreateMap(rl: readline.Interface): Promise<MapData> {
    ensureDataDir();
    const maps = listMaps();

    console.log('\n📦 Map Memory\n');

    if (maps.length === 0) {
        console.log('No saved maps found. Creating a new one.\n');
        return createNewMap(rl);
    }

    console.log('Do you want to use an existing map or create a new one?');
    console.log('  1. Use existing map');
    console.log('  2. Create new map\n');

    while (true) {
        const choice = (await ask(rl, 'Choice (1/2): ')).trim();

        if (choice === '2') return createNewMap(rl);

        if (choice === '1') {
            console.log('\nSaved maps:');
            maps.forEach((name, i) => {
                const data = loadMap(name);
                const date = new Date(data.lastUsed).toLocaleString();
                console.log(`  ${i + 1}. ${name}  (last used: ${date})`);
            });
            console.log('');

            while (true) {
                const pick = (await ask(rl, `Pick a map (1–${maps.length}): `)).trim();
                const idx = parseInt(pick, 10) - 1;
                if (!isNaN(idx) && idx >= 0 && idx < maps.length) {
                    const data = loadMap(maps[idx]);
                    console.log(`✓ Loaded map: ${data.name}\n`);
                    return data;
                }
                console.log('Invalid choice, try again.');
            }
        }

        console.log('Please enter 1 or 2.');
    }
}

async function createNewMap(rl: readline.Interface): Promise<MapData> {
    while (true) {
        const raw = (await ask(rl, 'Enter a name for this map: ')).trim();
        const name = raw.replace(/[^a-zA-Z0-9_\-]/g, '_'); // sanitize

        if (!name) { console.log('Name cannot be empty.'); continue; }

        if (fs.existsSync(mapPath(name))) {
            const overwrite = (await ask(rl, `"${name}" already exists. Overwrite? (y/n): `)).trim().toLowerCase();
            if (overwrite !== 'y') continue;
        }

        const data: MapData = {
            name,
            createdAt: Date.now(),
            lastUsed: Date.now(),
            behaviorWeights: defaultWeights(),
            badSpots: [],
            blockObservations: [],
        };
        saveMap(data);
        console.log(`✓ Created map: ${name}\n`);
        return data;
    }
}

// ── MapMemory class ──────────────────────────────────────────────────────────

export class MapMemory {
    private data: MapData;
    private dirty = false;
    private saveTimer: NodeJS.Timeout | null = null;

    constructor(data: MapData) {
        this.data = data;
    }

    get name() { return this.data.name; }

    // ── Weights ────────────────────────────────────────────────────────────

    getWeights(): BehaviorWeightMap {
        return { ...this.data.behaviorWeights };
    }

    reward(behavior: BehaviorName) {
        const w = this.data.behaviorWeights;
        w[behavior] = clamp(w[behavior] * REWARD);
        console.log(`[MapMemory] ✓ reward ${behavior} → ${w[behavior].toFixed(1)}`);
        this.scheduleSave();
    }

    penalize(behavior: BehaviorName, reason: 'stuck' | 'fell' | 'water') {
        const w = this.data.behaviorWeights;
        w[behavior] = clamp(w[behavior] * PENALTY);
        console.log(`[MapMemory] ✗ penalize ${behavior} (${reason}) → ${w[behavior].toFixed(1)}`);
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
        this.data.badSpots.push({
            x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z),
            reason: 'fell'
        });
        console.log(`[MapMemory] Death recorded at (${entry.x}, ${entry.y}, ${entry.z}) — exclusion zone ${DEATH_BAD_SPOT_RADIUS} blocks`);
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
        console.log(`[MapMemory] Bad spot added at (${Math.round(pos.x)}, ${Math.round(pos.y)}, ${Math.round(pos.z)}) reason=${reason}`);
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

    isNearBadSpot(pos: Vec3): boolean {
        return this.data.badSpots.some(s => {
            // Deaths get a much wider exclusion zone
            const isDeathSpot = this.data.deaths?.some(
                d => d.x === s.x && d.y === s.y && d.z === s.z
            );
            const radius = isDeathSpot ? DEATH_BAD_SPOT_RADIUS : BAD_SPOT_RADIUS;
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
                    const existing = this.data.blockObservations.find(
                        o => o.x === bx && o.y === by && o.z === bz
                    );

                    if (!existing) {
                        this.data.blockObservations.push({ x: bx, y: by, z: bz, name: block.name, lastSeen: now });
                    } else if (existing.name !== block.name) {
                        console.log(`[MapMemory] Block changed at (${bx},${by},${bz}): ${existing.name} → ${block.name}`);
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

        // Cap observation list size to avoid unbounded growth
        if (this.data.blockObservations.length > 50000) {
            // Drop oldest observations
            this.data.blockObservations.sort((a, b) => b.lastSeen - a.lastSeen);
            this.data.blockObservations = this.data.blockObservations.slice(0, 40000);
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