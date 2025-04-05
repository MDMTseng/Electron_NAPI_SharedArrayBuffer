#pragma once

#include "bpg_types.h"
#include <cstddef>
#include <functional>

namespace BPG {

/**
 * @brief Abstract interface for the Link Layer.
 *
 * This defines the contract for different transport mechanisms (TCP, UDP, WebSocket, etc.)
 * that the BPG layer can use to send and receive raw binary data.
 */
class IBpgLink {
public:
    virtual ~IBpgLink() = default;

    // Callback type for receiving data from the link layer
    // Parameters: (data pointer, data length)
    using DataReceivedCallback = std::function<void(const uint8_t*, size_t)>;

    /**
     * @brief Sends binary data over the link.
     * @param data Pointer to the data buffer.
     * @param len Length of the data to send.
     * @return True if sending was initiated successfully, false otherwise.
     *         Note: Successful initiation doesn't guarantee delivery.
     */
    virtual bool sendData(const uint8_t* data, size_t len) = 0;

    /**
     * @brief Sets the callback function to be invoked when data is received.
     *        The BPG Decoder's processData method would typically be set here.
     * @param callback The function to call upon data reception.
     */
    virtual void setDataReceivedCallback(DataReceivedCallback callback) = 0;

    /**
     * @brief Initializes or connects the link layer.
     * @return True on success, false on failure.
     */
    virtual bool initialize() = 0;

    /**
     * @brief Closes or disconnects the link layer.
     */
    virtual void close() = 0;

    /**
     * @brief Optional: Returns the maximum payload size this link layer supports per send operation.
     *        This can help the BPG layer decide if it needs to fragment larger encoded packets,
     *        although the BPG protocol itself doesn't mandate fragmentation at its level.
     *        The link layer itself might handle underlying fragmentation (like TCP).
     * @return Maximum send size, or 0 if not applicable/unlimited.
     */
    virtual size_t getMaxSendSize() const { return 0; } // Default: No specific limit 알려짐
};

} // namespace BPG 