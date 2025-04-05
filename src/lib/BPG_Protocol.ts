export interface HybridData {
    metadata_str: string; // Renamed from metadata_json
    binary_bytes: Uint8Array;
}

export interface AppPacket {
    group_id: number;   // uint32
    target_id: number;  // uint32
    tl: string;         // two-letter type ID
    content: HybridData;
}

export type AppPacketGroup = AppPacket[];

export type PacketCallback = (packet: AppPacket) => void;
export type GroupCallback = (groupId: number, group: AppPacketGroup) => void;

const HEADER_SIZE = 14; // 4 (group) + 4 (target) + 2 (tl) + 4 (data_length)
const JSON_LENGTH_SIZE = 4;

// --- Encoder --- 

export class BpgEncoder {

    private calculateHybridDataSize(data: HybridData): number {
        const strBytes = new TextEncoder().encode(data.metadata_str); // Use metadata_str
        return JSON_LENGTH_SIZE + strBytes.length + data.binary_bytes.length;
    }

    /**
     * Encodes a single AppPacket into a Uint8Array.
     */
    encodePacket(packet: AppPacket): Uint8Array {
        const dataSize = this.calculateHybridDataSize(packet.content);
        const totalSize = HEADER_SIZE + dataSize;
        const buffer = new ArrayBuffer(totalSize);
        const dataView = new DataView(buffer);
        const textEncoder = new TextEncoder();

        let offset = 0;

        // --- Header --- 
        // group_id (uint32, big-endian)
        console.log("group_id", packet.group_id);
        dataView.setUint32(offset, packet.group_id, false); 
        offset += 4;

        // target_id (uint32, big-endian)
        console.log("target_id", packet.target_id);
        dataView.setUint32(offset, packet.target_id, false);
        offset += 4;

        // tl (2 chars)
        if (packet.tl.length !== 2) {
            throw new Error(`Packet type TL must be 2 characters, got "${packet.tl}"`);
        }
        dataView.setUint8(offset, packet.tl.charCodeAt(0));
        offset += 1;
        dataView.setUint8(offset, packet.tl.charCodeAt(1));
        offset += 1;

        // data_length (uint32, big-endian)
        dataView.setUint32(offset, dataSize, false);
        offset += 4;

        // --- Data (HybridData) ---
        const strBytes = new TextEncoder().encode(packet.content.metadata_str); // Use metadata_str
        const strLength = strBytes.length;
        
        // String Length (uint32, big-endian)
        dataView.setUint32(offset, strLength, false); // Represents length of metadata_str
        offset += 4;

        // String Bytes (if any)
        const packetBytes = new Uint8Array(buffer);
        if (strLength > 0) {
            packetBytes.set(strBytes, offset);
            offset += strLength;
        }

        // Binary Bytes (if any)
        if (packet.content.binary_bytes.length > 0) {
            packetBytes.set(packet.content.binary_bytes, offset);
            offset += packet.content.binary_bytes.length;
        }
        
        if (offset !== totalSize) {
            console.warn(`BPG Encoder: Offset mismatch. Expected ${totalSize}, got ${offset}`);
        }

        {//print packetBytes
            console.log("packetBytes",packetBytes);
        }
        return packetBytes;
    }
}

// --- Decoder --- 

export class BpgDecoder {
    private internal_buffer: Uint8Array = new Uint8Array(0);
    private active_groups: Map<number, AppPacketGroup> = new Map();

    reset(): void {
        this.internal_buffer = new Uint8Array(0);
        this.active_groups.clear();
    }

    /**
     * Processes incoming data chunk, decodes packets, and triggers callbacks.
     */
    processData(
        data: Uint8Array, 
        packetCallback: PacketCallback, 
        groupCallback: GroupCallback
    ): void {
        // Append new data to the internal buffer
        // Inefficient for very large buffers/frequent calls, consider alternatives 
        // (e.g., array of buffers, ring buffer) if performance becomes an issue.
        const newData = new Uint8Array(this.internal_buffer.length + data.length);
        newData.set(this.internal_buffer, 0);
        newData.set(data, this.internal_buffer.length);
        this.internal_buffer = newData;

        // Process as many complete packets as possible
        while (true) {
            if (this.internal_buffer.length < HEADER_SIZE) {
                break; // Not enough data for a header
            }

            const dataView = new DataView(this.internal_buffer.buffer, this.internal_buffer.byteOffset, this.internal_buffer.byteLength);
            
            // Deserialize Header
            let offset = 0;
            const groupId = dataView.getUint32(offset, false); offset += 4;
            const targetId = dataView.getUint32(offset, false); offset += 4;
            const tl = String.fromCharCode(dataView.getUint8(offset), dataView.getUint8(offset + 1)); offset += 2;
            const dataLength = dataView.getUint32(offset, false); offset += 4;

            const totalPacketSize = HEADER_SIZE + dataLength;

            if (this.internal_buffer.length < totalPacketSize) {
                break; // Not enough data for the full packet yet
            }

            // --- Deserialize HybridData ---
            const hybridData: HybridData = { metadata_str: "", binary_bytes: new Uint8Array(0) };
            let dataOffset = HEADER_SIZE; // Start reading data after the header
            
            if(dataLength < JSON_LENGTH_SIZE) {
                console.error(`BPG Decoder: Invalid data length (${dataLength}) smaller than JSON length field size (${JSON_LENGTH_SIZE}). Skipping packet.`);
                // Consume the invalid packet data to potentially recover
                this.internal_buffer = this.internal_buffer.slice(totalPacketSize);
                continue; 
            }
            
            const strLength = dataView.getUint32(dataOffset, false); dataOffset += 4;
            const binaryBytesLength = dataLength - JSON_LENGTH_SIZE - strLength;

            if (binaryBytesLength < 0) {
                 console.error(`BPG Decoder: Invalid JSON length (${strLength}) resulting in negative binary length. Skipping packet.`);
                 this.internal_buffer = this.internal_buffer.slice(totalPacketSize);
                 continue; 
            }

            // Metadata String
            if (strLength > 0) {
                const strBytes = this.internal_buffer.slice(dataOffset, dataOffset + strLength);
                hybridData.metadata_str = new TextDecoder().decode(strBytes);
                dataOffset += strLength;
            }

            // Binary bytes
            if (binaryBytesLength > 0) {
                // Slice creates a copy - necessary as we'll discard the buffer section
                hybridData.binary_bytes = this.internal_buffer.slice(dataOffset, dataOffset + binaryBytesLength);
                dataOffset += binaryBytesLength;
            }

            // --- Create AppPacket --- 
            const appPacket: AppPacket = {
                group_id: groupId,
                target_id: targetId,
                tl: tl,
                content: hybridData
            };

            // --- Store and Trigger Callbacks --- 
            if (!this.active_groups.has(groupId)) {
                this.active_groups.set(groupId, []);
            }
            this.active_groups.get(groupId)!.push(appPacket);

            try {
                packetCallback(appPacket);
            } catch (e) {
                console.error("BPG Decoder: Error in packetCallback:", e);
            }

            // Check for End Group
            if (tl === "EG") {
                const completedGroup = this.active_groups.get(groupId)!;
                this.active_groups.delete(groupId); // Remove from active map
                try {
                    groupCallback(groupId, completedGroup);
                } catch (e) {
                    console.error("BPG Decoder: Error in groupCallback:", e);
                }
            }

            // Consume the processed packet from the buffer
            this.internal_buffer = this.internal_buffer.slice(totalPacketSize);
        }
    }
}
