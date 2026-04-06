import { describe, it, expect, beforeEach } from 'vitest';
import {
    BpgEncoder,
    BpgDecoder,
    AppPacket,
    AppPacketGroup,
    HEADER_SIZE,
} from '../BPG_Protocol';

function makePacket(overrides: Partial<AppPacket> = {}): AppPacket {
    return {
        group_id: 1,
        target_id: 2,
        tl: 'AI',
        is_end_of_group: false,
        content: {
            metadata_str: '{"key":"value"}',
            binary_bytes: new Uint8Array([0x01, 0x02, 0x03]),
        },
        ...overrides,
    };
}

describe('BPG Protocol', () => {
    let encoder: BpgEncoder;
    let decoder: BpgDecoder;

    beforeEach(() => {
        encoder = new BpgEncoder();
        decoder = new BpgDecoder();
    });

    // Helper: encode then decode a single packet, return decoded packet
    function roundTrip(packet: AppPacket): AppPacket {
        const encoded = encoder.encodePacket(packet);
        const packets: AppPacket[] = [];
        decoder.processData(
            encoded,
            (p) => packets.push(p),
            () => {},
        );
        expect(packets).toHaveLength(1);
        return packets[0];
    }

    // ----------------------------------------------------------------
    // Round-trip encode/decode
    // ----------------------------------------------------------------
    describe('round-trip encode/decode', () => {
        it('should preserve all fields through encode then decode', () => {
            const original = makePacket();
            const decoded = roundTrip(original);

            expect(decoded.group_id).toBe(original.group_id);
            expect(decoded.target_id).toBe(original.target_id);
            expect(decoded.tl).toBe(original.tl);
            expect(decoded.is_end_of_group).toBe(original.is_end_of_group);
            expect(decoded.content.metadata_str).toBe(original.content.metadata_str);
            expect(decoded.content.binary_bytes).toEqual(original.content.binary_bytes);
        });
    });

    // ----------------------------------------------------------------
    // TL codes
    // ----------------------------------------------------------------
    describe('TL codes', () => {
        const codes = ['AI', 'RP', 'TT', 'XX', 'ZZ', 'ab', '00'];

        it.each(codes)('should correctly round-trip TL code "%s"', (tl) => {
            const decoded = roundTrip(makePacket({ tl }));
            expect(decoded.tl).toBe(tl);
        });
    });

    // ----------------------------------------------------------------
    // Props / flags
    // ----------------------------------------------------------------
    describe('props and flags', () => {
        it('should set is_end_of_group = true when prop bit 0 is set', () => {
            const decoded = roundTrip(makePacket({ is_end_of_group: true }));
            expect(decoded.is_end_of_group).toBe(true);
        });

        it('should set is_end_of_group = false when prop bit 0 is not set', () => {
            const decoded = roundTrip(makePacket({ is_end_of_group: false }));
            expect(decoded.is_end_of_group).toBe(false);
        });
    });

    // ----------------------------------------------------------------
    // Target / Group IDs
    // ----------------------------------------------------------------
    describe('target and group IDs', () => {
        const idCases: Array<{ label: string; group_id: number; target_id: number }> = [
            { label: 'zeros', group_id: 0, target_id: 0 },
            { label: 'ones', group_id: 1, target_id: 1 },
            { label: 'max uint32', group_id: 0xFFFFFFFF, target_id: 0xFFFFFFFF },
            { label: 'mixed', group_id: 42, target_id: 0xDEADBEEF },
        ];

        it.each(idCases)('should round-trip IDs ($label)', ({ group_id, target_id }) => {
            const decoded = roundTrip(makePacket({ group_id, target_id }));
            expect(decoded.group_id).toBe(group_id);
            expect(decoded.target_id).toBe(target_id);
        });
    });

    // ----------------------------------------------------------------
    // Metadata only (no binary)
    // ----------------------------------------------------------------
    describe('metadata only', () => {
        it('should handle packet with metadata string but empty binary', () => {
            const packet = makePacket({
                content: {
                    metadata_str: '{"action":"inspect","id":999}',
                    binary_bytes: new Uint8Array(0),
                },
            });
            const decoded = roundTrip(packet);
            expect(decoded.content.metadata_str).toBe('{"action":"inspect","id":999}');
            expect(decoded.content.binary_bytes).toEqual(new Uint8Array(0));
        });
    });

    // ----------------------------------------------------------------
    // Binary only (empty metadata)
    // ----------------------------------------------------------------
    describe('binary only', () => {
        it('should handle packet with binary data but empty metadata', () => {
            const binaryData = new Uint8Array([0xFF, 0x00, 0xAB, 0xCD, 0xEF]);
            const packet = makePacket({
                content: {
                    metadata_str: '',
                    binary_bytes: binaryData,
                },
            });
            const decoded = roundTrip(packet);
            expect(decoded.content.metadata_str).toBe('');
            expect(decoded.content.binary_bytes).toEqual(binaryData);
        });
    });

    // ----------------------------------------------------------------
    // Both metadata and binary
    // ----------------------------------------------------------------
    describe('both metadata and binary', () => {
        it('should handle packet with both metadata and binary data', () => {
            const packet = makePacket({
                content: {
                    metadata_str: '{"type":"image","width":640}',
                    binary_bytes: new Uint8Array([0x89, 0x50, 0x4E, 0x47]),
                },
            });
            const decoded = roundTrip(packet);
            expect(decoded.content.metadata_str).toBe('{"type":"image","width":640}');
            expect(decoded.content.binary_bytes).toEqual(new Uint8Array([0x89, 0x50, 0x4E, 0x47]));
        });
    });

    // ----------------------------------------------------------------
    // Empty metadata and empty binary
    // ----------------------------------------------------------------
    describe('empty packet content', () => {
        it('should handle packet with empty metadata and empty binary', () => {
            const packet = makePacket({
                content: {
                    metadata_str: '',
                    binary_bytes: new Uint8Array(0),
                },
            });
            const decoded = roundTrip(packet);
            expect(decoded.content.metadata_str).toBe('');
            expect(decoded.content.binary_bytes).toEqual(new Uint8Array(0));
        });
    });

    // ----------------------------------------------------------------
    // Large payloads
    // ----------------------------------------------------------------
    describe('large payloads', () => {
        it('should handle a large metadata string (~10KB)', () => {
            const largeStr = 'A'.repeat(10 * 1024);
            const packet = makePacket({
                content: {
                    metadata_str: largeStr,
                    binary_bytes: new Uint8Array(0),
                },
            });
            const decoded = roundTrip(packet);
            expect(decoded.content.metadata_str).toBe(largeStr);
            expect(decoded.content.metadata_str.length).toBe(10 * 1024);
        });

        it('should handle large binary data (~100KB)', () => {
            const largeBin = new Uint8Array(100 * 1024);
            for (let i = 0; i < largeBin.length; i++) {
                largeBin[i] = i % 256;
            }
            const packet = makePacket({
                content: {
                    metadata_str: '',
                    binary_bytes: largeBin,
                },
            });
            const decoded = roundTrip(packet);
            expect(decoded.content.binary_bytes).toEqual(largeBin);
            expect(decoded.content.binary_bytes.length).toBe(100 * 1024);
        });

        it('should handle large metadata AND large binary together', () => {
            const largeStr = 'B'.repeat(10 * 1024);
            const largeBin = new Uint8Array(100 * 1024);
            largeBin.fill(0xCC);
            const packet = makePacket({
                content: {
                    metadata_str: largeStr,
                    binary_bytes: largeBin,
                },
            });
            const decoded = roundTrip(packet);
            expect(decoded.content.metadata_str).toBe(largeStr);
            expect(decoded.content.binary_bytes).toEqual(largeBin);
        });
    });

    // ----------------------------------------------------------------
    // Multiple packets in one buffer
    // ----------------------------------------------------------------
    describe('multiple packets in one buffer', () => {
        it('should decode multiple packets encoded into a single buffer', () => {
            const packets: AppPacket[] = [
                makePacket({ tl: 'AI', group_id: 1, target_id: 10, is_end_of_group: false }),
                makePacket({ tl: 'RP', group_id: 1, target_id: 20, is_end_of_group: false }),
                makePacket({ tl: 'TT', group_id: 1, target_id: 30, is_end_of_group: true }),
            ];

            // Encode all into one buffer using encodePacketGroup
            const combined = encoder.encodePacketGroup(packets);

            const decoded: AppPacket[] = [];
            const groups: Array<{ id: number; group: AppPacketGroup }> = [];

            decoder.processData(
                combined,
                (p) => decoded.push(p),
                (id, group) => groups.push({ id, group }),
            );

            expect(decoded).toHaveLength(3);
            expect(decoded[0].tl).toBe('AI');
            expect(decoded[0].target_id).toBe(10);
            expect(decoded[1].tl).toBe('RP');
            expect(decoded[1].target_id).toBe(20);
            expect(decoded[2].tl).toBe('TT');
            expect(decoded[2].target_id).toBe(30);
            expect(decoded[2].is_end_of_group).toBe(true);

            // Group callback should have fired once for group_id=1
            expect(groups).toHaveLength(1);
            expect(groups[0].id).toBe(1);
            expect(groups[0].group).toHaveLength(3);
        });

        it('should handle multiple independent groups', () => {
            const packets: AppPacket[] = [
                makePacket({ tl: 'AI', group_id: 100, target_id: 1, is_end_of_group: true }),
                makePacket({ tl: 'RP', group_id: 200, target_id: 2, is_end_of_group: true }),
            ];

            const combined = encoder.encodePacketGroup(packets);
            const groups: Array<{ id: number; group: AppPacketGroup }> = [];

            decoder.processData(
                combined,
                () => {},
                (id, group) => groups.push({ id, group }),
            );

            expect(groups).toHaveLength(2);
            expect(groups[0].id).toBe(100);
            expect(groups[0].group).toHaveLength(1);
            expect(groups[1].id).toBe(200);
            expect(groups[1].group).toHaveLength(1);
        });
    });

    // ----------------------------------------------------------------
    // Incremental / chunked delivery
    // ----------------------------------------------------------------
    describe('incremental data delivery', () => {
        it('should buffer partial data and decode when complete', () => {
            const packet = makePacket();
            const encoded = encoder.encodePacket(packet);

            const decoded: AppPacket[] = [];
            const mid = Math.floor(encoded.length / 2);

            // Feed first half - should not produce any packet
            decoder.processData(
                encoded.slice(0, mid),
                (p) => decoded.push(p),
                () => {},
            );
            expect(decoded).toHaveLength(0);

            // Feed second half - now it should decode
            decoder.processData(
                encoded.slice(mid),
                (p) => decoded.push(p),
                () => {},
            );
            expect(decoded).toHaveLength(1);
            expect(decoded[0].tl).toBe(packet.tl);
        });
    });

    // ----------------------------------------------------------------
    // Header size constant
    // ----------------------------------------------------------------
    describe('constants', () => {
        it('HEADER_SIZE should be 18', () => {
            expect(HEADER_SIZE).toBe(18);
        });

        it('encoded packet size should equal HEADER_SIZE + data length', () => {
            const packet = makePacket();
            const encoded = encoder.encodePacket(packet);
            const metaBytes = new TextEncoder().encode(packet.content.metadata_str);
            const expectedDataSize = 4 + metaBytes.length + packet.content.binary_bytes.length;
            expect(encoded.length).toBe(HEADER_SIZE + expectedDataSize);
        });
    });
});
