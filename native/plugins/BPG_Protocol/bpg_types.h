#pragma once

#include <cstdint>
#include <vector>
#include <string>
#include <variant>

namespace BPG {

// Two-letter packet type identifier
using PacketType = char[2];

// Packet Header Structure (Fixed Size)
struct PacketHeader {
    uint32_t group_id;       // Group Identifier
    uint32_t target_id;      // Target Identifier
    PacketType tl;      // Two-letter type ID (e.g., "IM", "RP", "EG")
    uint32_t data_length;    // Length of the packet data following this header
};

// Simple structure for holding raw binary data
using BinaryData = std::vector<uint8_t>;

// Define possible application data types
// Using std::string for text/JSON for simplicity, BinaryData for raw bytes
// HybridData structure will now be used for ALL packet content types.
struct HybridData { 
    std::string metadata_json; // Describes the binary data (e.g., image info, text encoding) or can be empty.
    BinaryData binary_bytes; 
};

// Structure representing a packet at the application layer
struct AppPacket {
    uint32_t group_id;
    uint32_t target_id;
    PacketType tl;
    HybridData content; // Changed from AppDataVariant
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