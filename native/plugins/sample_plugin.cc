#include "../plugin_interface.h"
#include <cstring>
#include <iostream>
#include <vector>
#include <string>
#include <map>
#include <opencv2/opencv.hpp>
#include <iomanip>

// Include BPG Protocol headers
#include "BPG_Protocol/bpg_decoder.h"
#include "BPG_Protocol/bpg_encoder.h"
#include "BPG_Protocol/bpg_types.h"

static MessageCallback g_send_message = nullptr;
static BPG::BpgDecoder g_bpg_decoder; // Decoder instance for this plugin

// --- BPG Callbacks --- 

// Example function to handle a fully decoded application packet
static void handle_decoded_packet(const BPG::AppPacket& packet) {
    std::cout << "[SamplePlugin BPG] Decoded Packet - Group: " << packet.group_id
              << ", Target: " << packet.target_id
              << ", Type: " << std::string(packet.tl, 2) << std::endl;
    std::cout << "    Meta: " << (packet.content.metadata_str.empty() ? "<empty>" : packet.content.metadata_str) << std::endl;
    std::cout << "    Binary Size: " << packet.content.binary_bytes.size() << std::endl;

    // Print binary content hex preview (up to 64 bytes)
    if (!packet.content.binary_bytes.empty()) {
        std::cout << "    Binary Hex: ";
        size_t print_len = std::min(packet.content.binary_bytes.size(), (size_t)64);
        for (size_t i = 0; i < print_len; ++i) {
            std::cout << std::hex << std::setw(2) << std::setfill('0') << static_cast<int>(packet.content.binary_bytes[i]) << " ";
        }
        if (packet.content.binary_bytes.size() > 64) {
            std::cout << "...";
        }
        std::cout << std::dec << std::endl; // Reset stream to decimal
    }

    // --- TODO: Add application logic based on packet type/content ---
    // Example: If it's a specific command type, execute it.
    // Example: If it's image data, process it (decode if needed).
    if (strncmp(packet.tl, "IM", 2) == 0) {
        std::cout << "    (Packet is an Image)" << std::endl;
        // Potentially decode using metadata hints
        // cv::Mat img = cv::imdecode(packet.content.binary_bytes, cv::IMREAD_COLOR);
        // if (!img.empty()) { /* process image */ }
    }
}

// --- Example Sending Functions --- 

// NEW: Function to send a simple Acknowledgement Group
static bool send_acknowledgement_group(uint32_t group_id, uint32_t response_target_id) {
    if (!g_send_message) {
        std::cerr << "[SamplePlugin BPG] Error: Cannot send ACK, g_send_message is null." << std::endl;
        return false;
    }

    std::cout << "[SamplePlugin BPG] Sending ACK Group ID: " << group_id << ", Target ID: " << response_target_id << std::endl;
    BPG::BpgEncoder encoder;
    BPG::AppPacketGroup group_to_send; // Will only contain one packet now

    // 1. Acknowledgement Packet - This is the only and last packet
    BPG::AppPacket ack_packet;
    ack_packet.group_id = group_id;
    ack_packet.target_id = response_target_id; 
    std::memcpy(ack_packet.tl, "AK", 2); 
    ack_packet.is_end_of_group = true; // Set EG flag HERE
    BPG::HybridData ack_hybrid_data;
    std::string ack_str = "{\"acknowledged\":true}";
    ack_hybrid_data.binary_bytes.assign(ack_str.begin(), ack_str.end());
    ack_packet.content = std::move(ack_hybrid_data);
    group_to_send.push_back(ack_packet);

    // Encode and send the single ACK packet
    BPG::BinaryData encoded_packet_buffer;
    BPG::BpgError encode_err = encoder.encodePacket(group_to_send[0], encoded_packet_buffer);
    if (encode_err == BPG::BpgError::Success) {
        std::cout << "  Sending ACK packet Type: " << std::string(group_to_send[0].tl, 2) << ", Size: " << encoded_packet_buffer.size() << std::endl;
        g_send_message(encoded_packet_buffer.data(), encoded_packet_buffer.size());
        return true;
    } else {
        std::cerr << "[SamplePlugin BPG] Error encoding ACK packet (Type: "
                  << std::string(group_to_send[0].tl, 2) << "): " << static_cast<int>(encode_err) << std::endl;
        return false;
    }
}

// Example function to handle a completed packet group
static void handle_decoded_group(uint32_t group_id, BPG::AppPacketGroup&& group) {
     std::cout << "[SamplePlugin BPG] Decoded COMPLETE Group - ID: " << group_id 
               << ", Packet Count: " << group.size() << std::endl;
    
    // --- TODO: Add application logic for the complete group --- 
    for(const auto& packet : group) {
         std::cout << "    - Packet Type in Group: " << std::string(packet.tl, 2) << std::endl;
    }

    // --- Echo Back Logic --- 
    if (!group.empty()) {
        uint32_t original_target_id = group[0].target_id; // Assuming target_id is same for the group
        uint32_t response_target_id = original_target_id + 100;
        send_acknowledgement_group(group_id, response_target_id); // Send ACK back
    } else {
         std::cerr << "[SamplePlugin BPG] Warning: Received empty group (ID: " << group_id << "), cannot echo back." << std::endl;
    }
}

// Example function to send a pre-defined group
static bool send_example_bpg_group(uint32_t group_id, uint32_t target_id) {
    if (!g_send_message) {
        std::cerr << "[SamplePlugin BPG] Error: Cannot send, g_send_message is null." << std::endl;
        return false;
    }

    std::cout << "[SamplePlugin BPG] Encoding and Sending Example Group ID: " << group_id << std::endl;
    BPG::BpgEncoder encoder;
    BPG::AppPacketGroup group_to_send;

    // 1. Example Text Packet
    BPG::AppPacket text_packet;
    text_packet.group_id = group_id;
    text_packet.target_id = target_id;
    std::memcpy(text_packet.tl, "TX", 2);
    text_packet.is_end_of_group = false; // Not the last packet
    BPG::HybridData text_hybrid_data;
    std::string text_str = "Response from Sample Plugin";
    text_hybrid_data.binary_bytes.assign(text_str.begin(), text_str.end());
    text_packet.content = std::move(text_hybrid_data);
    group_to_send.push_back(text_packet);

    // 2. Example Status Packet - This is now the last packet
    BPG::AppPacket status_packet;
    status_packet.group_id = group_id;
    status_packet.target_id = target_id;
    std::memcpy(status_packet.tl, "ST", 2); 
    status_packet.is_end_of_group = true; // Set EG flag HERE
    BPG::HybridData status_hybrid_data;
    status_hybrid_data.metadata_str = "{\"status\":\"idle\"}"; // Use metadata_str
    status_packet.content = std::move(status_hybrid_data);
    group_to_send.push_back(status_packet);

    // Encode packets individually and send them
    bool success = true;
    for (const auto& packet : group_to_send) {
        BPG::BinaryData encoded_packet_buffer;
        BPG::BpgError encode_err = encoder.encodePacket(packet, encoded_packet_buffer);
        if (encode_err == BPG::BpgError::Success) {
            std::cout << "  Sending packet Type: " << std::string(packet.tl, 2) << ", Size: " << encoded_packet_buffer.size() << std::endl;
            g_send_message(encoded_packet_buffer.data(), encoded_packet_buffer.size());
        } else {
            std::cerr << "[SamplePlugin BPG] Error encoding packet (Type: "
                      << std::string(packet.tl, 2) << "): " << static_cast<int>(encode_err) << std::endl;
            success = false;
            break; 
        }
    }
    return success;
}


// --- Plugin Interface Implementation --- 

static PluginInfo plugin_info = {
    "Sample Plugin (BPG Enabled)", // Updated name
    "1.1.0", // Version bump
    PLUGIN_API_VERSION
};

static PluginStatus initialize(MessageCallback callback) {
    g_send_message = callback;
    g_bpg_decoder.reset(); // Reset decoder state on initialization
    std::cout << "Sample plugin (BPG Enabled) initialized" << std::endl;
    
    // Example: Send an initial status message when plugin loads
    // send_example_bpg_group(901, 1); // Example group ID and target ID

    return PLUGIN_SUCCESS;
}

static void shutdown() {
    std::cout << "Sample plugin (BPG Enabled) shutdown" << std::endl;
    g_send_message = nullptr;
    // No explicit decoder shutdown needed unless it holds resources
}

// Process incoming raw data from the host using the BPG decoder
static void process_message(const uint8_t* data, size_t length) {
    std::cout << "Sample plugin received raw data length: " << length << std::endl;
    
    // Feed data into the BPG decoder
    BPG::BpgError decode_err = g_bpg_decoder.processData(
        data, 
        length, 
        handle_decoded_packet, // Callback for individual packets
        handle_decoded_group   // Callback for completed groups
    );
    std::cout << "processed " << std::endl;
    if (decode_err != BPG::BpgError::Success) {
        std::cerr << "[SamplePlugin BPG] Decoder error: " << static_cast<int>(decode_err) << std::endl;
        // Decide how to handle decoder errors (e.g., reset decoder?)
        // g_bpg_decoder.reset(); 
    }

    // // Original echo behavior (now handled by BPG callbacks if needed)
    // if (g_send_message) {
    //     g_send_message(data, length);
    // }
}

static void update() {
    // Called periodically by the host
    // Could potentially check for timeouts on incomplete BPG groups here if needed
}

// Plugin interface instance
static PluginInterface plugin_interface = {
    plugin_info,
    initialize,
    shutdown,
    process_message,
    update
};

// Plugin entry point
extern "C" PLUGIN_EXPORT const PluginInterface* get_plugin_interface() {
    return &plugin_interface;
} 