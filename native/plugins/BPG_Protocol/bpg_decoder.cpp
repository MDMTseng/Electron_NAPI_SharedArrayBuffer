#include "bpg_decoder.h"
#include <cstring> // For memcpy, memcmp
#include <arpa/inet.h> // For ntohl, htonl (assuming network byte order)
#include <iostream> // For potential debug output
#include <algorithm> // For std::copy
#include <iterator> // For std::make_move_iterator

namespace BPG {

BpgDecoder::BpgDecoder() = default;

void BpgDecoder::reset() {
    internal_buffer_.clear();
    active_groups_.clear();
}

bool BpgDecoder::deserializeHeader(const std::deque<uint8_t>& buffer, PacketHeader& out_header) {
    if (buffer.size() < sizeof(PacketHeader)) return false;

    uint8_t header_bytes[sizeof(PacketHeader)];
    // Copy header bytes from deque to a temporary array for easy memcpy
    // This is a small, fixed-size copy.
    std::copy_n(buffer.begin(), sizeof(PacketHeader), header_bytes);

    const uint8_t* ptr = header_bytes;

    uint32_t group_id_n, target_id_n, data_length_n;

    std::memcpy(&group_id_n, ptr, sizeof(group_id_n)); ptr += sizeof(group_id_n);
    std::memcpy(&target_id_n, ptr, sizeof(target_id_n)); ptr += sizeof(target_id_n);
    std::memcpy(out_header.tl, ptr, sizeof(PacketType)); ptr += sizeof(PacketType);
    std::memcpy(&data_length_n, ptr, sizeof(data_length_n));

    out_header.group_id = ntohl(group_id_n);
    out_header.target_id = ntohl(target_id_n);
    out_header.data_length = ntohl(data_length_n);

    return true;
}

// Always deserializes into HybridData
BpgError BpgDecoder::deserializeAppData(const PacketHeader& header,
                                std::deque<uint8_t>::const_iterator data_start,
                                HybridData& out_data) { // Changed argument type
    // Calculate end iterator based on length
    auto data_end = data_start + header.data_length;

    // ALL data is treated as potential HybridData (json_len + json + binary)
    if (header.data_length < sizeof(uint32_t)) {
        // Allow empty payload or payload smaller than json_len field?
        // If we require json_len, then this is an error.
        // If payload can be purely binary (no json), need different handling.
        // Assuming for now all packets *must* have the 4-byte json_len field,
        // even if the length is 0.
        return BpgError::DecodingError; // Not enough data even for JSON length field
    }

    auto current_iter = data_start;

    // 1. Read JSON length (copy 4 bytes)
    uint8_t json_len_bytes[sizeof(uint32_t)];
    std::copy_n(current_iter, sizeof(uint32_t), json_len_bytes);
    current_iter += sizeof(uint32_t);
    uint32_t json_len_n;
    std::memcpy(&json_len_n, json_len_bytes, sizeof(json_len_n));
    uint32_t json_len = ntohl(json_len_n);

    // Check consistency: json_len should not exceed remaining data length
    if (sizeof(uint32_t) + json_len > header.data_length) {
        return BpgError::DecodingError;
    }

    // 2. Read JSON metadata string (copy)
    if (json_len > 0) {
        std::string temp_json(json_len, '\0');
        std::copy(current_iter, current_iter + json_len, temp_json.begin());
        out_data.metadata_json = std::move(temp_json);
    }
    current_iter += json_len;

    // 3. Read remaining binary bytes (copy)
    size_t binary_bytes_len = header.data_length - sizeof(uint32_t) - json_len;
    if (binary_bytes_len > 0) {
        out_data.binary_bytes.resize(binary_bytes_len);
        std::copy(current_iter, data_end, out_data.binary_bytes.begin());
    }

    return BpgError::Success;
}

// Use deque and efficient removal
bool BpgDecoder::tryParsePacket(std::deque<uint8_t>& buffer, 
                            const AppPacketCallback& packet_callback,
                            const AppPacketGroupCallback& group_callback) {
    if (buffer.size() < sizeof(PacketHeader)) { return false; }
    PacketHeader header;
    if (!deserializeHeader(const_cast<const std::deque<uint8_t>&>(buffer), header)) { reset(); return false; }
    size_t total_packet_size = sizeof(PacketHeader) + header.data_length;
    if (buffer.size() < total_packet_size) { return false; }

    AppPacket app_packet;
    app_packet.group_id = header.group_id;
    app_packet.target_id = header.target_id;
    std::memcpy(app_packet.tl, header.tl, sizeof(PacketType));

    // Deserialize directly into app_packet.content (which is HybridData)
    BpgError data_err = deserializeAppData(header, 
                                        buffer.cbegin() + sizeof(PacketHeader),
                                        app_packet.content); // Pass content directly

    if (data_err == BpgError::Success) {
         active_groups_[app_packet.group_id].push_back(std::move(app_packet)); 
    } else {
         std::cerr << "BPG Decoder: Error deserializing app data for packet type "
                   << std::string(header.tl, 2) << std::endl;
    }

    bool is_end_group = (data_err == BpgError::Success && strncmp(app_packet.tl, "EG", 2) == 0);
    uint32_t completed_group_id = (is_end_group) ? app_packet.group_id : 0;

    buffer.erase(buffer.begin(), buffer.begin() + total_packet_size);

    if (data_err == BpgError::Success) {
        if (packet_callback) {
            packet_callback(active_groups_[header.group_id].back());
        }
        
        if (is_end_group && group_callback) {
            auto group_iter = active_groups_.find(completed_group_id);
            if (group_iter != active_groups_.end()) {
                group_callback(completed_group_id, std::move(group_iter->second));
                active_groups_.erase(group_iter);
            }
        }
    }
    return true; 
}

BpgError BpgDecoder::processData(const uint8_t* data, size_t len,
                                 const AppPacketCallback& packet_callback,
                                 const AppPacketGroupCallback& group_callback) {
    if (!data || len == 0) {
        return BpgError::Success;
    }

    // Append incoming data to the internal buffer (deque insert)
    internal_buffer_.insert(internal_buffer_.end(), data, data + len);

    // Process as many complete packets as possible
    while (tryParsePacket(internal_buffer_, packet_callback, group_callback)) {
        // Loop continues
    }

    return BpgError::Success;
}

} // namespace BPG 