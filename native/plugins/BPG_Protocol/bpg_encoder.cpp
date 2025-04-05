#include "bpg_encoder.h"
#include <cstring> // For memcpy
#include <arpa/inet.h> // For htonl, ntohl (assuming network byte order - adjust if needed)

namespace BPG {

void BpgEncoder::serializeHeader(const PacketHeader& header, BinaryData& buffer) {
    size_t initial_size = buffer.size();
    buffer.resize(initial_size + sizeof(PacketHeader));

    // Use a temporary pointer to the buffer location
    uint8_t* ptr = buffer.data() + initial_size;

    // Convert fields to network byte order (big-endian) before writing
    uint32_t group_id_n = htonl(header.group_id);
    uint32_t target_id_n = htonl(header.target_id);
    uint32_t data_length_n = htonl(header.data_length);

    std::memcpy(ptr, &group_id_n, sizeof(group_id_n));
    ptr += sizeof(group_id_n);

    std::memcpy(ptr, &target_id_n, sizeof(target_id_n));
    ptr += sizeof(target_id_n);

    std::memcpy(ptr, header.tl, sizeof(PacketType));
    ptr += sizeof(PacketType);

    std::memcpy(ptr, &data_length_n, sizeof(data_length_n));
}

// Simplified: Calculates size for HybridData only
size_t BpgEncoder::calculateAppDataSize(const HybridData& data) {
    // Size = 4 (json_len) + json_string_len + binary_data_len
    return sizeof(uint32_t) + data.metadata_json.length() + data.binary_bytes.size();
}

// Simplified: Serializes HybridData only
BpgError BpgEncoder::serializeAppData(const HybridData& data, BinaryData& buffer) {
    // 1. Serialize metadata JSON length (4 bytes, network byte order)
    uint32_t json_len = static_cast<uint32_t>(data.metadata_json.length());
    uint32_t json_len_n = htonl(json_len);
    buffer.insert(buffer.end(), reinterpret_cast<const uint8_t*>(&json_len_n), reinterpret_cast<const uint8_t*>(&json_len_n) + sizeof(json_len_n));

    // 2. Serialize metadata JSON string bytes (if any)
    if (json_len > 0) {
        buffer.insert(buffer.end(), reinterpret_cast<const uint8_t*>(data.metadata_json.data()), reinterpret_cast<const uint8_t*>(data.metadata_json.data() + json_len));
    }

    // 3. Append binary bytes (if any)
    if (!data.binary_bytes.empty()) {
        buffer.insert(buffer.end(), data.binary_bytes.begin(), data.binary_bytes.end());
    }
    
    return BpgError::Success; 
}

BpgError BpgEncoder::encodePacket(const AppPacket& packet, BinaryData& out_buffer) {
    // 1. Calculate the size of the application data (which is HybridData)
    size_t data_size = calculateAppDataSize(packet.content);

    // 2. Construct the header
    PacketHeader header;
    header.group_id = packet.group_id;
    header.target_id = packet.target_id;
    static_assert(sizeof(header.tl) == sizeof(packet.tl), "Type ID size mismatch");
    std::memcpy(header.tl, packet.tl, sizeof(PacketType));
    header.data_length = static_cast<uint32_t>(data_size);

    // 3. Reserve space in the output buffer if beneficial (reduces reallocations)
    // out_buffer.reserve(out_buffer.size() + sizeof(PacketHeader) + data_size); // Optional optimization

    // 4. Serialize the header directly into the output buffer
    serializeHeader(header, out_buffer);

    // 5. Serialize the HybridData content directly into the output buffer
    BpgError data_err = serializeAppData(packet.content, out_buffer);
    if (data_err != BpgError::Success) {
        return data_err;
    }

    return BpgError::Success;
}

BpgError BpgEncoder::encodePacketGroup(const AppPacketGroup& group, BinaryData& out_buffer) {
    out_buffer.clear(); // Start with an empty buffer for the group

    // Optional: Pre-calculate total size and reserve memory
    size_t total_size = 0;
    for (const auto& packet : group) {
        total_size += sizeof(PacketHeader) + calculateAppDataSize(packet.content);
    }
    out_buffer.reserve(total_size);

    for (const auto& packet : group) {
        BpgError err = encodePacket(packet, out_buffer);
        if (err != BpgError::Success) {
            out_buffer.clear(); // Clear partial data on error
            return err;         // Return the first error encountered
        }
    }
    return BpgError::Success;
}

} // namespace BPG 