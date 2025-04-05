#pragma once

#include <cstdint>
#include <vector>
#include <string>
// #include <variant> // No longer needed if AppDataVariant was removed

namespace BPG {

// Fixed size of the BPG packet header in bytes.
// Breakdown: group_id(4) + target_id(4) + tl(2) + data_length(4) = 14
constexpr size_t BPG_HEADER_SIZE = 14;

// Two-letter packet type identifier
typedef char PacketType[2];

// Packet Header Structure Definition.
// NOTE: Do NOT use sizeof(PacketHeader) directly in serialization/deserialization logic.
// Use the BPG_HEADER_SIZE constant instead to ensure the fixed 14-byte wire format.
// The actual memory layout might include padding depending on the compiler,
// but the protocol logic MUST read/write exactly 14 bytes based on the fields.
struct PacketHeader {
    uint32_t group_id;      // 4 bytes, Big Endian
    uint32_t target_id;     // 4 bytes, Big Endian
    PacketType tl;          // 2 bytes
    uint32_t data_length;   // 4 bytes, Big Endian (Length of data *after* header)
};

// Simple structure for holding raw binary data
using BinaryData = std::vector<uint8_t>;

// HybridData structure will now be used for ALL packet content types.
// Format on the wire: str_length(4) + metadata_str(str_length) + binary_bytes(...)
struct HybridData {
    std::string metadata_str; // Describes the binary data. UTF-8 encoded string.
    BinaryData binary_bytes;
};

// Structure representing a packet at the application layer
struct AppPacket {
    uint32_t group_id;
    uint32_t target_id;
    PacketType tl;
    HybridData content;
};

// Represents a group of packets at the application level
using AppPacketGroup = std::vector<AppPacket>;

// Error codes (optional, can be expanded)
enum class BpgError {
    Success = 0,
    EncodingError,
    DecodingError,
    BufferTooSmall,
    InvalidPacketHeader,
    IncompletePacket,
    LinkLayerError
};

} // namespace BPG 