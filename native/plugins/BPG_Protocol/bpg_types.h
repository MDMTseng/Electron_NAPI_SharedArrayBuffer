#pragma once

#include <cstdint>
#include <vector>
#include <string>
// #include <array> // No longer needed

namespace BPG {

// Fixed size of the BPG packet header in bytes.
// Breakdown: group_id(4) + target_id(4) + tl(2) + prop(4) + data_length(4) = 18
constexpr size_t BPG_HEADER_SIZE = 18;
constexpr uint32_t BPG_PROP_EG_BIT_MASK = 0x00000001; // Mask for the EG bit (LSB of prop field)

// Two-letter packet type identifier
typedef char PacketType[2];

// Packet Header Structure Definition.
// NOTE: Use the BPG_HEADER_SIZE constant for serialization/deserialization logic.
struct PacketHeader {
    uint32_t group_id;      // 4 bytes, Big Endian
    uint32_t target_id;     // 4 bytes, Big Endian
    PacketType tl;          // 2 bytes
    uint32_t prop;          // 4 bytes, Big Endian, Property bitfield
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
    bool is_end_of_group; // NEW: Flag to indicate if this is the last packet of the group
    HybridData content;
};

// Represents a group of packets at the application level
// Note: The concept of a 'group' is now less explicit in the protocol itself,
// but still useful at the application layer for collecting related packets.
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