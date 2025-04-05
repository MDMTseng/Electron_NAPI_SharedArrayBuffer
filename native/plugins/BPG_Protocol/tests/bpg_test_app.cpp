#include <iostream>
#include <vector>
#include <string>
#include <cassert>
#include <cstring>
#include <opencv2/opencv.hpp> // Include OpenCV
#include "../bpg_encoder.h"
#include "../bpg_decoder.h"
#include "../bpg_types.h"
#include <map>
#include <algorithm> // for std::max
#include <cctype> // for std::isprint, std::isspace

// Helper function to print packet details
void printAppPacket(const BPG::AppPacket& packet) {
    std::cout << "  Packet GroupID: " << packet.group_id
              << ", TargetID: " << packet.target_id
              << ", Type: " << std::string(packet.tl, 2) << std::endl;
    std::cout << "    Content: [HybridData] Meta: " <<
        (packet.content.metadata_json.empty() ? "<empty>" : packet.content.metadata_json)
              << ", Binary Size: " << packet.content.binary_bytes.size() << " bytes" << std::endl;
    // Optionally show binary content if it's likely text
    if (packet.content.metadata_json.empty() && !packet.content.binary_bytes.empty() && packet.content.binary_bytes.size() < 100) { // Heuristic
        std::string potential_text(packet.content.binary_bytes.begin(), packet.content.binary_bytes.end());
        bool is_printable = true;
        for(char c : potential_text) {
            if (!std::isprint(static_cast<unsigned char>(c)) && !std::isspace(static_cast<unsigned char>(c))) {
                is_printable = false;
                break;
            }
        }
        if (is_printable) {
            std::cout << "      (Binary as text: \"" << potential_text << "\")" << std::endl;
        }
    }
}


// --- Test Case: Interleaved Groups ---
int testCase_InterleavedGroups() {
    std::cout << "\n--- Test Case: Interleaved Groups --- " << std::endl;

    // --- Sender Side (APP Layer Simulation) ---
    std::cout << "\n--- Sender Creating Packet Groups --- " << std::endl;
    BPG::BpgEncoder encoder;

    // Group 101 Packets
    BPG::AppPacketGroup group_101;
    uint32_t group_id_101 = 101;
    uint32_t target_id_101 = 50;
    std::string report_str_101 = "{\"status\":\"processing\",\"progress\":0.75}";
    std::string eg_str_101 = "{\"ack\":true}";
    cv::Mat original_image(48, 64, CV_8UC3, cv::Scalar(100, 150, 200)); // Keep original for verification
    {
        // Image Packet (Group 101)
        BPG::AppPacket img_packet;
        img_packet.group_id = group_id_101;
        img_packet.target_id = target_id_101;
        std::memcpy(img_packet.tl, "IM", 2);
        // cv::Mat original_image(48, 64, CV_8UC3, cv::Scalar(100, 150, 200));
        for (int r = 0; r < original_image.rows; ++r) { for (int c = 0; c < original_image.cols; ++c) { original_image.at<cv::Vec3b>(r, c)[0] = (r * 4) % 256; original_image.at<cv::Vec3b>(r, c)[1] = (c * 4) % 256; original_image.at<cv::Vec3b>(r, c)[2] = (r + c) % 256; }}
        BPG::HybridData img_hybrid_data;
        std::string image_format = ".jpg";
        std::vector<int> encode_params = {cv::IMWRITE_JPEG_QUALITY, 90};
        bool encode_success = cv::imencode(image_format, original_image, img_hybrid_data.binary_bytes, encode_params);
        if (!encode_success) { std::cerr << "Error encoding image (101)\n"; return 1; }
        img_hybrid_data.metadata_json = "{\"width\": " + std::to_string(original_image.cols) + ", \"height\": " + std::to_string(original_image.rows) + ", \"channels\": " + std::to_string(original_image.channels()) + ", \"format\": \"" + image_format.substr(1) + "\"}";
        img_packet.content = std::move(img_hybrid_data);
        group_101.push_back(img_packet);
        printAppPacket(img_packet);

        // Report Packet (Group 101)
        BPG::AppPacket report_packet;
        report_packet.group_id = group_id_101;
        report_packet.target_id = target_id_101;
        std::memcpy(report_packet.tl, "RP", 2);
        BPG::HybridData report_hybrid_data;
        report_hybrid_data.binary_bytes.assign(report_str_101.begin(), report_str_101.end());
        report_packet.content = std::move(report_hybrid_data);
        group_101.push_back(report_packet);
        printAppPacket(report_packet);

        // End Group Packet (Group 101)
        BPG::AppPacket eg_packet;
        eg_packet.group_id = group_id_101;
        eg_packet.target_id = target_id_101;
        std::memcpy(eg_packet.tl, "EG", 2);
        BPG::HybridData eg_hybrid_data;
        eg_hybrid_data.binary_bytes.assign(eg_str_101.begin(), eg_str_101.end());
        eg_packet.content = std::move(eg_hybrid_data);
        group_101.push_back(eg_packet);
        printAppPacket(eg_packet);
    }

    // Group 102 Packets
    BPG::AppPacketGroup group_102;
    uint32_t group_id_102 = 102;
    uint32_t target_id_102 = 55;
    std::string text_str_102 = "Hello from Group 102";
    std::string eg_str_102 = "{\"done\":true}";
    {
        // Text Packet (Group 102)
        BPG::AppPacket text_packet_102;
        text_packet_102.group_id = group_id_102;
        text_packet_102.target_id = target_id_102;
        std::memcpy(text_packet_102.tl, "TX", 2);
        BPG::HybridData text_hybrid_data;
        text_hybrid_data.binary_bytes.assign(text_str_102.begin(), text_str_102.end());
        text_packet_102.content = std::move(text_hybrid_data);
        group_102.push_back(text_packet_102);
        printAppPacket(text_packet_102);

        // End Group Packet (Group 102)
        BPG::AppPacket eg_packet_102;
        eg_packet_102.group_id = group_id_102;
        eg_packet_102.target_id = target_id_102;
        std::memcpy(eg_packet_102.tl, "EG", 2);
        BPG::HybridData eg_hybrid_data_102;
        eg_hybrid_data_102.binary_bytes.assign(eg_str_102.begin(), eg_str_102.end());
        eg_packet_102.content = std::move(eg_hybrid_data_102);
        group_102.push_back(eg_packet_102);
        printAppPacket(eg_packet_102);
    }

    // --- Create Interleaved Stream ---
    std::cout << "\n--- Sender Encoding and Streaming Interleaved Packets --- " << std::endl;
    BPG::BinaryData stream_buffer;
    std::vector<BPG::AppPacket> all_packets_interleaved;
    size_t max_len = std::max(group_101.size(), group_102.size());
    for(size_t i=0; i < max_len; ++i) {
        if (i < group_101.size()) all_packets_interleaved.push_back(group_101[i]);
        if (i < group_102.size()) all_packets_interleaved.push_back(group_102[i]);
    }

    // Encode interleaved packets directly into the stream buffer
    for (const auto& packet : all_packets_interleaved) {
        size_t size_before_encode = stream_buffer.size();
        BPG::BpgError encode_err = encoder.encodePacket(packet, stream_buffer);
        if (encode_err != BPG::BpgError::Success) {
             std::cerr << "Error encoding packet (Group: " << packet.group_id << ", Type: "
                       << std::string(packet.tl, 2) << "): "
                       << static_cast<int>(encode_err) << std::endl;
             return 1;
         }
        size_t packet_size = stream_buffer.size() - size_before_encode;
        std::cout << "  Encoded Packet Group: " << packet.group_id << ", Type: " << std::string(packet.tl, 2)
                  << ", Size: " << packet_size << " bytes" << std::endl;
    }
    std::cout << "Total stream size: " << stream_buffer.size() << " bytes" << std::endl;

    // --- Receiver Side (APP Layer Simulation) ---
    std::cout << "\n--- Receiver Processing Interleaved Stream (Simulating Link Layer Chunks) --- " << std::endl;
    BPG::BpgDecoder decoder;
    std::map<uint32_t, BPG::AppPacketGroup> received_groups_map;
    int groups_completed = 0;
    BPG::BpgError decode_err = BPG::BpgError::Success;
    auto on_packet_decoded = [](const BPG::AppPacket& packet) {
        std::cout << " -> Received Individual Packet (Group: " << packet.group_id << ")" << std::endl;
    };
    auto on_group_decoded = [&](uint32_t group_id, BPG::AppPacketGroup&& group) {
        std::cout << "===> Received COMPLETE Group ID: " << group_id << std::endl;
        std::cout << "     Group Packet Count: " << group.size() << std::endl;
        received_groups_map[group_id] = std::move(group);
        groups_completed++;
    };
    size_t chunk_size = 50;
    std::cout << "   (Simulating receive with chunk size: " << chunk_size << ")" << std::endl;
    size_t bytes_sent = 0;
    while (bytes_sent < stream_buffer.size()) {
        size_t current_chunk_size = std::min(chunk_size, stream_buffer.size() - bytes_sent);
        decode_err = decoder.processData( stream_buffer.data() + bytes_sent, current_chunk_size, on_packet_decoded, on_group_decoded );
        if (decode_err != BPG::BpgError::Success) {
             std::cerr << "Error decoding data chunk: " << static_cast<int>(decode_err) << std::endl;
             return 1;
         }
        bytes_sent += current_chunk_size;
    }

    // --- Verification ---
    std::cout << "\n--- Verification --- " << std::endl;
    if (groups_completed != 2) {
         std::cerr << "Verification FAILED: Expected 2 completed groups, got " << groups_completed << std::endl;
         return 1;
    }
    if (!received_groups_map.count(group_id_101) || !received_groups_map.count(group_id_102)) {
         std::cerr << "Verification FAILED: Did not receive both group IDs 101 and 102." << std::endl;
         return 1;
    }


    // Verify Group 101
    std::cout << "Verifying Group 101..." << std::endl;
    const auto& received_group_101 = received_groups_map[group_id_101];
    if (received_group_101.size() != group_101.size()) {
        std::cerr << "Verification FAILED (101): Size mismatch. Expected " << group_101.size() << ", got " << received_group_101.size() << std::endl; return 1;
    }
    if (strncmp(received_group_101[0].tl, "IM", 2) != 0) { std::cerr << "Verification FAILED (101): Packet 0 type mismatch" << std::endl; return 1; }
    if (strncmp(received_group_101[1].tl, "RP", 2) != 0) { std::cerr << "Verification FAILED (101): Packet 1 type mismatch" << std::endl; return 1; }
    if (strncmp(received_group_101[2].tl, "EG", 2) != 0) { std::cerr << "Verification FAILED (101): Packet 2 type mismatch" << std::endl; return 1; }
    
    const BPG::HybridData& received_report_hybrid_101 = received_group_101[1].content;
    std::string received_report_str_101(received_report_hybrid_101.binary_bytes.begin(), received_report_hybrid_101.binary_bytes.end());
    if (received_report_str_101 != report_str_101) {
         std::cerr << "Verification FAILED (101): Report content mismatch" << std::endl; return 1;
    }
    // Add image verification if needed (or keep skipped)
    const BPG::HybridData& received_img_hybrid_101 = received_group_101[0].content;
     cv::Mat decoded_image;
     try {
         decoded_image = cv::imdecode(received_img_hybrid_101.binary_bytes, cv::IMREAD_COLOR);
         if (decoded_image.empty()) { throw cv::Exception(cv::Error::StsError, "Decoded image is empty", __func__, __FILE__, __LINE__); }
         if (decoded_image.cols != original_image.cols || decoded_image.rows != original_image.rows || decoded_image.type() != original_image.type()) {
              throw cv::Exception(cv::Error::StsError, "Decoded image dimensions/type mismatch", __func__, __FILE__, __LINE__);
         }
         // Skipping exact JPEG compare for now
     } catch (const cv::Exception& e) {
         std::cerr << "Verification FAILED (101): OpenCV Error decoding/verifying image: " << e.what() << std::endl;
         return 1;
     }
    std::cout << "Group 101 PASSED." << std::endl;

    // Verify Group 102
    std::cout << "Verifying Group 102..." << std::endl;
    const auto& received_group_102 = received_groups_map[group_id_102];
     if (received_group_102.size() != group_102.size()) {
        std::cerr << "Verification FAILED (102): Size mismatch. Expected " << group_102.size() << ", got " << received_group_102.size() << std::endl; return 1;
    }
    if (strncmp(received_group_102[0].tl, "TX", 2) != 0) { std::cerr << "Verification FAILED (102): Packet 0 type mismatch" << std::endl; return 1; }
    if (strncmp(received_group_102[1].tl, "EG", 2) != 0) { std::cerr << "Verification FAILED (102): Packet 1 type mismatch" << std::endl; return 1; }
    
    const BPG::HybridData& received_text_hybrid_102 = received_group_102[0].content;
    if (!received_text_hybrid_102.metadata_json.empty()) { std::cerr << "Verification FAILED (102): Text metadata not empty" << std::endl; return 1; }
    std::string received_text_str_102(received_text_hybrid_102.binary_bytes.begin(), received_text_hybrid_102.binary_bytes.end());
    if (received_text_str_102 != text_str_102) {
        std::cerr << "Verification FAILED (102): Text content mismatch" << std::endl; return 1;
    }
    std::cout << "Group 102 PASSED." << std::endl;

    std::cout << "\nOverall Verification PASSED." << std::endl;

    return 0; // Return 0 on success
}


// --- Test Case: Empty Group ---
int testCase_EmptyGroup() {
    std::cout << "\n--- Test Case: Empty Group --- " << std::endl;
    BPG::BpgEncoder encoder;
    BPG::BpgDecoder decoder;

    uint32_t group_id = 201;
    uint32_t target_id = 60;

    // --- Sender ---
    std::cout << "Sender: Creating Empty Group (only EG packet)" << std::endl;
    BPG::AppPacket eg_packet;
    eg_packet.group_id = group_id;
    eg_packet.target_id = target_id;
    std::memcpy(eg_packet.tl, "EG", 2);
    // Content can be empty or contain minimal info
    BPG::HybridData eg_hybrid_data;
    std::string eg_str = "{\"status\":\"empty_group\"}"; // Store original for verification
    eg_hybrid_data.binary_bytes.assign(eg_str.begin(), eg_str.end());
    eg_packet.content = std::move(eg_hybrid_data);
    printAppPacket(eg_packet);

    BPG::BinaryData stream_buffer;
    size_t size_before = stream_buffer.size();
    BPG::BpgError encode_err = encoder.encodePacket(eg_packet, stream_buffer);
    if (encode_err != BPG::BpgError::Success) {
        std::cerr << "Error encoding empty group EG packet: " << static_cast<int>(encode_err) << std::endl;
        return 1;
    }
    std::cout << "Encoded EG packet size: " << stream_buffer.size() - size_before << " bytes" << std::endl;

    // --- Receiver ---
    std::cout << "Receiver: Processing stream" << std::endl;
    BPG::AppPacketGroup received_group;
    bool group_complete = false;
    int packets_received = 0;

    auto on_packet_decoded = [&](const BPG::AppPacket& packet) {
        std::cout << " -> Received Individual Packet (Group: " << packet.group_id << ")" << std::endl;
        packets_received++;
    };
    auto on_group_decoded = [&](uint32_t gid, BPG::AppPacketGroup&& group) {
        std::cout << "===> Received COMPLETE Group ID: " << gid << std::endl;
        std::cout << "     Group Packet Count: " << group.size() << std::endl;
        if (gid == group_id) {
            received_group = std::move(group);
            group_complete = true;
        } else {
             std::cerr << "Received unexpected group ID: " << gid << std::endl;
        }
    };

    BPG::BpgError decode_err = decoder.processData(stream_buffer.data(), stream_buffer.size(), on_packet_decoded, on_group_decoded);
     if (decode_err != BPG::BpgError::Success) {
         std::cerr << "Error decoding data: " << static_cast<int>(decode_err) << std::endl;
         return 1;
     }

    // --- Verification ---
    std::cout << "\nVerifying Empty Group..." << std::endl;
     if (!group_complete) { std::cerr << "Verification FAILED: Empty group not completed" << std::endl; return 1; }
     if (packets_received != 1) { std::cerr << "Verification FAILED: Expected 1 packet, got " << packets_received << std::endl; return 1; }
     if (received_group.size() != 1) { std::cerr << "Verification FAILED: Expected group size 1, got " << received_group.size() << std::endl; return 1; }
     if (received_group[0].group_id != group_id) { std::cerr << "Verification FAILED: Group ID mismatch" << std::endl; return 1; }
     if (strncmp(received_group[0].tl, "EG", 2) != 0) { std::cerr << "Verification FAILED: Packet type not EG" << std::endl; return 1; }
    
    std::string received_eg_str(received_group[0].content.binary_bytes.begin(), received_group[0].content.binary_bytes.end());
     if (received_eg_str != eg_str) {
         std::cerr << "Verification FAILED: EG content mismatch. Expected '"<< eg_str << "', got '" << received_eg_str << "'" << std::endl;
         return 1;
     }
    std::cout << "Empty Group PASSED." << std::endl;

    return 0; // Success
}


// --- Add new test cases below ---


int main() {
    int result = 0;

    // Run Test Case 1
    result = testCase_InterleavedGroups();
    if (result != 0) {
        std::cerr << "\nTest Case FAILED: testCase_InterleavedGroups with code " << result << std::endl;
        return result;
    }

    // Run Test Case 2
    result = testCase_EmptyGroup();
     if (result != 0) {
        std::cerr << "\nTest Case FAILED: testCase_EmptyGroup with code " << result << std::endl;
        return result;
    }


    std::cout << "\n--------------------------" << std::endl;
    std::cout << "All test cases PASSED." << std::endl;
    std::cout << "--------------------------" << std::endl;
    return 0;
}