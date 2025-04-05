#include "bpg_encoder.h"
#include <cstring> // For memcpy
#include <arpa/inet.h> // For htonl, ntohl (assuming network byte order - adjust if needed)
#include <iostream>
#include <iomanip>

namespace BPG {

void BpgEncoder::serializeHeader(const PacketHeader& header, BinaryData& buffer) {
    size_t initial_size = buffer.size();
    // Resize buffer by the fixed header size
    buffer.resize(initial_size + BPG_HEADER_SIZE); 

    uint8_t* ptr = buffer.data() + initial_size;

    uint32_t group_id_n = htonl(header.group_id);
    uint32_t target_id_n = htonl(header.target_id);
    uint32_t data_length_n = htonl(header.data_length);

    // Use BPG_HEADER_SIZE - 4 for the memcpy limit if needed, but sizes are known
    std::memcpy(ptr, &group_id_n, sizeof(group_id_n)); ptr += sizeof(group_id_n);
    std::memcpy(ptr, &target_id_n, sizeof(target_id_n)); ptr += sizeof(target_id_n);
    std::memcpy(ptr, header.tl, sizeof(PacketType)); ptr += sizeof(PacketType);
    std::memcpy(ptr, &data_length_n, sizeof(data_length_n)); ptr += sizeof(data_length_n);
    
    // Ensure exactly BPG_HEADER_SIZE bytes were written (optional sanity check)
    // assert( (ptr - (buffer.data() + initial_size)) == BPG_HEADER_SIZE );
}

// Simplified: Calculates size for HybridData only
size_t BpgEncoder::calculateAppDataSize(const HybridData& data) {
    // Size = 4 (str_len) + metadata_str_len + binary_data_len
    return sizeof(uint32_t) + data.metadata_str.length() + data.binary_bytes.size();
}

// Simplified: Serializes HybridData only
BpgError BpgEncoder::serializeAppData(const HybridData& data, BinaryData& buffer) {
    // 1. Serialize metadata string length (4 bytes, network byte order)
    uint32_t str_len = static_cast<uint32_t>(data.metadata_str.length());
    uint32_t str_len_n = htonl(str_len);
    buffer.insert(buffer.end(), reinterpret_cast<const uint8_t*>(&str_len_n), reinterpret_cast<const uint8_t*>(&str_len_n) + sizeof(str_len_n));

    // 2. Serialize metadata string bytes (if any)
    if (str_len > 0) {
        buffer.insert(buffer.end(), reinterpret_cast<const uint8_t*>(data.metadata_str.data()), reinterpret_cast<const uint8_t*>(data.metadata_str.data() + str_len));
    }

    // 3. Append binary bytes (if any)
    if (!data.binary_bytes.empty()) {
        buffer.insert(buffer.end(), data.binary_bytes.begin(), data.binary_bytes.end());
    }
    
    return BpgError::Success; 
}

BpgError BpgEncoder::encodePacket(const AppPacket& packet, BinaryData& out_buffer) {
    size_t data_size = calculateAppDataSize(packet.content);

    PacketHeader header;
    header.group_id = packet.group_id;
    header.target_id = packet.target_id;
    std::memcpy(header.tl, packet.tl, sizeof(PacketType)); // Copy TL from AppPacket
    header.data_length = static_cast<uint32_t>(data_size);

    // Optional reservation can use the constant
    // out_buffer.reserve(out_buffer.size() + BPG_HEADER_SIZE + data_size);

    serializeHeader(header, out_buffer);
    BpgError data_err = serializeAppData(packet.content, out_buffer);
    if (data_err != BpgError::Success) {
        return data_err;
    }
    return BpgError::Success;
}

BpgError BpgEncoder::encodePacketGroup(const AppPacketGroup& group, BinaryData& out_buffer) {
    out_buffer.clear(); 
    size_t total_size = 0;
    for (const auto& packet : group) {
        // Use constant for header size calculation
        total_size += BPG_HEADER_SIZE + calculateAppDataSize(packet.content);
    }
    out_buffer.reserve(total_size);

    for (const auto& packet : group) {
        BpgError err = encodePacket(packet, out_buffer);
        if (err != BpgError::Success) {
            out_buffer.clear();
            return err;
        }
    }
    return BpgError::Success;
}

} // namespace BPG 