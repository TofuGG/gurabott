/**
 * protocolFix.ts - Runtime fix for the 1.21.6+ dialog system packets.
 *
 * minecraft-data 3.113.0 / minecraft-protocol 1.66.2 encode the
 * `custom_click_action` payload as `nbt?: anonymousNbt` (i.e. a spurious
 * presence boolean + NBT with no length prefix). The real wire format is a
 * VarInt byte-length followed by an anonymous optional NBT tag
 * (Mojang: ByteBufCodecs.optionalTagCodec(...).apply(ByteBufCodecs.lengthPrefixed(65536))).
 *
 * Upstream PRs are still unmerged:
 *   - PrismarineJS/node-minecraft-protocol#1495 (datatype registration)
 *   - PrismarineJS/minecraft-data#1196 (protocol definition)
 * so we register the `nbtOptionalLengthPrefixed` datatype and override the
 * packet definition at runtime, before any serializer for 1.21.11 is built.
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// Reference the exact copies of these modules that minecraft-protocol's
// serializer.js uses (pnpm dedupes to these paths).
const minecraftTypes = require('minecraft-protocol/src/datatypes/minecraft.js');
const compilerMinecraft = require('minecraft-protocol/src/datatypes/compiler-minecraft.js');
const minecraftData = require('minecraft-data');

// protodef is a transitive dependency of minecraft-protocol, so resolve it
// relative to minecraft-protocol's own datatype module to get the same copy
// that its serializer.js uses. (protodef is not a direct dependency of this
// project, so it must be required from inside minecraft-protocol's tree.)
const minecraftPath = require.resolve('minecraft-protocol/src/datatypes/minecraft.js');
const protodefRequire = createRequire(minecraftPath);
const protodef = protodefRequire('protodef') as any;
const { PartialReadError } = protodef.utils;
const [readVarInt, writeVarInt, sizeOfVarInt] = protodef.types.varint;
// prismarine-nbt is also a transitive dependency of minecraft-protocol (its
// datatype module uses it), so resolve the same copy from there.
const nbt = protodefRequire('prismarine-nbt') as any;

let applied = false;

// A network (anonymous) optional NBT tag preceded by its byte length as a
// VarInt. Empty tag is a single TAG_END (0) byte, so an absent value
// encodes as `01 00`. Mirrors minecraft-protocol PR #1495.
function readNbtOptionalLengthPrefixed(buffer: Buffer, offset: number): { value: unknown; size: number } {
    const { value: length, size: lengthSize } = readVarInt(buffer, offset);
    if (offset + lengthSize + length > buffer.length) throw new PartialReadError();
    const tag = nbt.proto.read(buffer, offset + lengthSize, 'anonOptionalNbt');
    return { value: tag.value, size: lengthSize + tag.size };
}

function writeNbtOptionalLengthPrefixed(value: unknown, buffer: Buffer, offset: number): number {
    const innerSize = nbt.proto.sizeOf(value, 'anonOptionalNbt');
    offset = writeVarInt(innerSize, buffer, offset);
    return nbt.proto.write(value, buffer, offset, 'anonOptionalNbt');
}

function sizeOfNbtOptionalLengthPrefixed(value: unknown): number {
    const innerSize = nbt.proto.sizeOf(value, 'anonOptionalNbt');
    return sizeOfVarInt(innerSize) + innerSize;
}

/**
 * Registers the `nbtOptionalLengthPrefixed` datatype with minecraft-protocol's
 * datatype modules and overrides the `custom_click_action` packet definition.
 *
 * MUST run before the first `createClient`/`createBot` call for 1.21.11, since
 * compiled protocols are cached by (state, direction, version) in serializer.js.
 * Idempotent.
 */
export function installProtocolFix(): void {
    if (applied) return;
    applied = true;

    // 1. Add the datatype implementation to the interpreter datatype module.
    (minecraftTypes as any).nbtOptionalLengthPrefixed = [
        readNbtOptionalLengthPrefixed,
        writeNbtOptionalLengthPrefixed,
        sizeOfNbtOptionalLengthPrefixed,
    ];

    // 2. Register it as a native type with the compiler module.
    (compilerMinecraft as any).Read.nbtOptionalLengthPrefixed = ['native', minecraftTypes.nbtOptionalLengthPrefixed[0]];
    (compilerMinecraft as any).Write.nbtOptionalLengthPrefixed = ['native', minecraftTypes.nbtOptionalLengthPrefixed[1]];
    (compilerMinecraft as any).SizeOf.nbtOptionalLengthPrefixed = ['native', minecraftTypes.nbtOptionalLengthPrefixed[2]];

    // 3. Override the packet definition in the shared, cached protocol object.
    const md: any = minecraftData('1.21.11');
    md.protocol.types.nbtOptionalLengthPrefixed = 'native';
    md.protocol.types.packet_common_custom_click_action = [
        'container',
        [
            { name: 'id', type: 'string' },
            { name: 'payload', type: 'nbtOptionalLengthPrefixed' },
        ],
    ];
}
