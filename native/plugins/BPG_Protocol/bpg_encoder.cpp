#include "bpg_encoder.h"
#include <cstring> // For memcpy
#include <arpa/inet.h> // For htonl, ntohl (assuming network byte order - adjust if needed)
#include <iostream>
#include <iomanip>
#include <stdexcept> 

namespace BPG {

// --- NEW BpgEncoder Helpers using BufferWriter ---

// Renamed internal helper
bool BpgEncoder::serializeHeaderInternal(const PacketHeader& header, BufferWriter& writer) {
    // Check remaining space before attempting appends
    if (writer.remaining() < BPG_HEADER_SIZE) return false;

    // Write fields in the new protocol order using writer methods
    bool success = true;
    success &= writer.append_bytes_2(header.tl);            // TL (2 bytes)
    success &= writer.append_uint32_network(header.prop);   // Prop (4 bytes)
    success &= writer.append_uint32_network(header.target_id); // TargetID (4 bytes)
    success &= writer.append_uint32_network(header.group_id);  // GroupID (4 bytes)
    success &= writer.append_uint32_network(header.data_length); // DataLength (4 bytes)

    return success; // Returns true if all appends succeeded
}

// Renamed internal helper
bool BpgEncoder::serializeAppDataInternal(const HybridData& data, BufferWriter& writer) {
    uint32_t str_len = static_cast<uint32_t>(data.metadata_str.length());
    size_t binary_len = data.binary_bytes.size();
    size_t required = sizeof(uint32_t) + str_len + binary_len;

    // Check remaining space first
    if (writer.remaining() < required) return false;

    bool success = true;
    // String Length
    success &= writer.append_uint32_network(str_len);
    // String Bytes
    if (str_len > 0) {
        success &= writer.append_string(data.metadata_str);
    }
    // Binary Bytes
    if (binary_len > 0) {
        success &= writer.append_vector(data.binary_bytes);
    }

    return success;
}

// calculateAppDataSize remains the same
size_t BpgEncoder::calculateAppDataSize(const HybridData& data) {
    return sizeof(uint32_t) + data.metadata_str.length() + data.binary_bytes.size();
}

// *** IMPLEMENTATION OF OVERLOAD using BufferWriter ***
BpgError BpgEncoder::encodePacket(const AppPacket& packet, BufferWriter& writer)
{
    // 1. Calculate required size
    size_t app_data_size = calculateAppDataSize(packet.content);
    size_t total_required_size = BPG_HEADER_SIZE + app_data_size;

    // 2. Check initial writer capacity
    if (writer.remaining() < total_required_size) {
        return BpgError::BufferTooSmall;
    }

    // 3. Construct Header object (logical representation)
    PacketHeader header;
    header.group_id = packet.group_id;
    header.target_id = packet.target_id;
    std::memcpy(header.tl, packet.tl, sizeof(PacketType));
    header.prop = 0;
    if (packet.is_end_of_group) {
        header.prop |= BPG_PROP_EG_BIT_MASK;
    }
    header.data_length = static_cast<uint32_t>(app_data_size);

    // 4. Serialize using helpers that take the writer
    if (!serializeHeaderInternal(header, writer)) {
        return BpgError::EncodingError;
    }
    if (!serializeAppDataInternal(packet.content, writer)) {
        return BpgError::EncodingError;
    }

    // 5. Success. The writer object now tracks the written size internally.
    return BpgError::Success;
}

} // namespace BPG 