#pragma once

#include "bpg_types.h"
#include <vector>

namespace BPG {

class BpgEncoder {
public:
    BpgEncoder() = default;

    /**
     * @brief Encodes a single application packet into a binary representation.
     * @param packet The application packet to encode.
     * @param out_buffer The vector where the encoded binary data will be appended.
     * @return BpgError indicating success or failure.
     */
    BpgError encodePacket(const AppPacket& packet, BinaryData& out_buffer);

    /**
     * @brief Encodes a group of application packets into a single binary blob.
     *        Note: This might not be suitable for streaming large groups.
     *        Consider encoding and sending packet by packet via the link layer.
     * @param group The group of application packets to encode.
     * @param out_buffer The vector where the encoded binary data will be stored.
     * @return BpgError indicating success or failure.
     */
    BpgError encodePacketGroup(const AppPacketGroup& group, BinaryData& out_buffer);

private:
    // Helper function to serialize the header
    void serializeHeader(const PacketHeader& header, BinaryData& buffer);

    // Helper function to calculate serialized size of application data
    size_t calculateAppDataSize(const HybridData& data);

    // Helper function to serialize application data based on its type
    BpgError serializeAppData(const HybridData& data, BinaryData& buffer);
};

} // namespace BPG 