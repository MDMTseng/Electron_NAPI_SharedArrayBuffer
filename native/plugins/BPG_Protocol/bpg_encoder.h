#pragma once

#include "bpg_types.h"
#include <vector>
#include <cstdint>
#include <cstddef>
#include <cstring>
#include <arpa/inet.h> // For htonl
#include <string>

namespace BPG {

// --- BufferWriter Utility Class ---
// Wraps a raw buffer to provide safer, vector-like append operations.
class BufferWriter {
private:
    uint8_t* start_ptr_;
    size_t capacity_;
    size_t current_offset_;

public:
    BufferWriter(uint8_t* buffer, size_t capacity)
        : start_ptr_(buffer), capacity_(capacity), current_offset_(0) {
        if (!buffer && capacity > 0) {
            // Handle error: Null buffer with non-zero capacity
            // Maybe throw or set an internal error state? For now, let capacity be 0.
            capacity_ = 0;
        }
    }

    // Appends raw bytes if capacity allows
    bool append(const void* data, size_t length) {
        if (!start_ptr_ || current_offset_ + length > capacity_) {
            return false; // Not enough space or invalid buffer
        }
        std::memcpy(start_ptr_ + current_offset_, data, length);
        current_offset_ += length;
        return true;
    }

    // Appends a network-order (Big Endian) uint32_t
    bool append_uint32_network(uint32_t value) {
        uint32_t value_n = htonl(value);
        return append(&value_n, sizeof(value_n));
    }

    // Appends bytes from a specific pointer
    bool append_bytes(const uint8_t* data, size_t length) {
        return append(data, length);
    }

     // Appends 2 bytes directly (useful for TL)
    bool append_bytes_2(const char data[2]) {
        return append(data, 2);
    }

    // Appends data from a std::string
    bool append_string(const std::string& str) {
        return append(str.data(), str.length());
    }

    // Appends data from a std::vector<uint8_t>
     bool append_vector(const std::vector<uint8_t>& vec) {
        return append(vec.data(), vec.size());
     }

    // Returns the number of bytes currently written
    size_t size() const {
        return current_offset_;
    }

    // Returns the remaining capacity
    size_t remaining() const {
        return capacity_ - current_offset_;
    }

    // Returns pointer to the start of the buffer (const version)
    const uint8_t* data() const {
        return start_ptr_;
    }
     // Returns pointer to the start of the buffer (non-const version)
     // Use with caution, direct writes bypass the writer's size tracking.
     uint8_t* raw_data() {
         return start_ptr_;
     }

    // Returns total capacity
    size_t capacity() const {
        return capacity_;
    }
};
// --- End BufferWriter ---

class BpgEncoder {
public:
    BpgEncoder() = default;

    /**
     * @brief Encodes a single application packet into a binary representation.
     * @param packet The application packet to encode.
     * @param writer The BufferWriter to append the encoded binary data to.
     * @return BpgError indicating success or failure.
     */
    BpgError encodePacket(const AppPacket& packet, BufferWriter& writer);

    /**
     * @brief Calculates the size of the binary representation of a given HybridData.
     * @param data The HybridData to calculate the size for.
     * @return The size of the binary representation of the given HybridData.
     */
    size_t calculateAppDataSize(const HybridData& data);

private:
    // Corrected helper declarations
    bool serializeHeaderInternal(const PacketHeader& header, BufferWriter& writer); // Use BufferWriter
    bool serializeAppDataInternal(const HybridData& data, BufferWriter& writer);  // Use BufferWriter

    // Removed vector helpers...
};

} // namespace BPG 