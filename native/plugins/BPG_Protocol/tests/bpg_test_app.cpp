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
#include <iomanip>

// --- Test Callbacks --- 
std::map<uint32_t, BPG::AppPacketGroup> received_groups;

void testPacketCallback(const BPG::AppPacket& packet) {
    std::cout << " -> Received Individual Packet (Group: " << packet.group_id << ")" << std::endl;
}

void testGroupCallback(uint32_t group_id, BPG::AppPacketGroup&& group) {
    std::cout << "===> Received COMPLETE Group ID: " << group_id << std::endl;
    std::cout << "     Group Packet Count: " << group.size() << std::endl;
    received_groups[group_id] = std::move(group);
}

// Helper function to print packet details
void printAppPacket(const BPG::AppPacket& packet) {
    std::cout << "  Packet GroupID: " << std::hex << packet.group_id << std::dec
              << ", TargetID: " << std::hex << packet.target_id << std::dec
              << ", Type: " << std::string(packet.tl, 2) 
              << ", EG Flag: " << (packet.is_end_of_group ? "Set" : "Not Set") << std::endl; // Show EG flag
    std::cout << "    Content: [HybridData] Meta: " <<
        (packet.content.metadata_str.empty() ? "<empty>" : packet.content.metadata_str)
              << ", Binary Size: " << std::hex << packet.content.binary_bytes.size() << std::dec << " bytes" << std::endl;

    // Optionally show binary content if it's likely text
    if (packet.content.metadata_str.empty() && !packet.content.binary_bytes.empty() && packet.content.binary_bytes.size() < 100) { // Heuristic
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

    if (!packet.content.binary_bytes.empty()) {
        std::cout << "    Binary Hex: ";
        size_t print_len = std::min(packet.content.binary_bytes.size(), (size_t)64);
        for (size_t i = 0; i < print_len; ++i) {
            std::cout << std::hex << std::setw(2) << std::setfill('0') << static_cast<int>(packet.content.binary_bytes[i]) << " ";
        }
        if (packet.content.binary_bytes.size() > 64) {
            std::cout << "...";
        }
        std::cout << std::dec << std::endl; 
    }
}


// --- Test Case: Interleaved Groups --- Updated EG logic
int testCase_InterleavedGroups() {
    std::cout << "\n--- Test Case: Interleaved Groups --- \n" << std::endl;
    received_groups.clear();
    BPG::BpgEncoder encoder;
    BPG::BpgDecoder decoder;

    uint32_t group_id_101 = 101;
    uint32_t target_id_101 = 50;
    uint32_t group_id_102 = 102;
    uint32_t target_id_102 = 55;

    std::cout << "--- Sender Creating Packet Groups --- " << std::endl;

    // Group 101 (Image -> Report -> ACK)
    BPG::AppPacketGroup group101;
    {
        // Packet 1: Image Data ("IM")
        BPG::AppPacket img_packet;
        img_packet.group_id = group_id_101;
        img_packet.target_id = target_id_101;
        std::memcpy(img_packet.tl, "IM", 2);
        img_packet.is_end_of_group = false; // Not the last packet
        BPG::HybridData img_hybrid_data;
        // Simulate creating a small JPEG image with OpenCV
        cv::Mat original_image(5, 5, CV_8UC3, cv::Scalar(0, 100, 255)); // 5x5 BGR
        cv::putText(original_image, "Hi", cv::Point(1,4), cv::FONT_HERSHEY_PLAIN, 0.5, cv::Scalar(255,255,255), 1);
        std::string image_format = ".jpg";
        std::vector<int> params;
        params.push_back(cv::IMWRITE_JPEG_QUALITY);
        params.push_back(90); // JPEG quality
        cv::imencode(image_format, original_image, img_hybrid_data.binary_bytes, params);
         img_hybrid_data.metadata_str = 
            "{\"width\": " + std::to_string(original_image.cols) + ", \"height\": " + std::to_string(original_image.rows) + ", \"channels\": " + std::to_string(original_image.channels()) + ", \"format\": \"" + image_format.substr(1) + "\"}";
         img_packet.content = std::move(img_hybrid_data);
        group101.push_back(img_packet);
        printAppPacket(img_packet);

        // Packet 2: Report ("RP")
        BPG::AppPacket report_packet;
        report_packet.group_id = group_id_101;
        report_packet.target_id = target_id_101;
        std::memcpy(report_packet.tl, "RP", 2);
        report_packet.is_end_of_group = false; // Not the last packet
        BPG::HybridData report_hybrid_data;
        std::string report_str = "{\"status\":\"processing\",\"progress\":0.75}";
        report_hybrid_data.binary_bytes.assign(report_str.begin(), report_str.end());
        report_packet.content = std::move(report_hybrid_data);
        group101.push_back(report_packet);
        printAppPacket(report_packet);

        // Packet 3: Acknowledge ("AK") - This is the *last* packet for group 101
        BPG::AppPacket ack_packet;
        ack_packet.group_id = group_id_101;
        ack_packet.target_id = target_id_101;
        std::memcpy(ack_packet.tl, "AK", 2); // Changed from EG
        ack_packet.is_end_of_group = true; // Set EG flag HERE
        BPG::HybridData ack_hybrid_data;
        std::string ack_str = "{\"ack\":true}";
        ack_hybrid_data.binary_bytes.assign(ack_str.begin(), ack_str.end());
        ack_packet.content = std::move(ack_hybrid_data);
        group101.push_back(ack_packet);
        printAppPacket(ack_packet);
    }

    // Group 102 (Text -> Done)
    BPG::AppPacketGroup group102;
    {
        // Packet 1: Text ("TX")
        BPG::AppPacket text_packet;
        text_packet.group_id = group_id_102;
        text_packet.target_id = target_id_102;
        std::memcpy(text_packet.tl, "TX", 2);
        text_packet.is_end_of_group = false; // Not the last packet
        BPG::HybridData text_hybrid_data;
        std::string text_str = "Hello from Group 102";
        text_hybrid_data.binary_bytes.assign(text_str.begin(), text_str.end());
        text_packet.content = std::move(text_hybrid_data);
        group102.push_back(text_packet);
        printAppPacket(text_packet);

        // Packet 2: Done ("DN") - This is the *last* packet for group 102
        BPG::AppPacket done_packet;
        done_packet.group_id = group_id_102;
        done_packet.target_id = target_id_102;
        std::memcpy(done_packet.tl, "DN", 2); // Changed from EG
        done_packet.is_end_of_group = true; // Set EG flag HERE
        BPG::HybridData done_hybrid_data;
        std::string done_str = "{\"done\":true}";
        done_hybrid_data.binary_bytes.assign(done_str.begin(), done_str.end());
        done_packet.content = std::move(done_hybrid_data);
        group102.push_back(done_packet);
        printAppPacket(done_packet);
    }

    // ... (Encoding and Streaming logic - encode individual packets, no change needed)
    std::cout << "\n--- Sender Encoding and Streaming Interleaved Packets --- " << std::endl;
    BPG::BinaryData full_stream;
    BPG::BinaryData encoded_packet;
    // Interleave packets for sending
    encoder.encodePacket(group101[0], encoded_packet); full_stream.insert(full_stream.end(), encoded_packet.begin(), encoded_packet.end()); encoded_packet.clear();
    encoder.encodePacket(group102[0], encoded_packet); full_stream.insert(full_stream.end(), encoded_packet.begin(), encoded_packet.end()); encoded_packet.clear();
    encoder.encodePacket(group101[1], encoded_packet); full_stream.insert(full_stream.end(), encoded_packet.begin(), encoded_packet.end()); encoded_packet.clear();
    encoder.encodePacket(group102[1], encoded_packet); full_stream.insert(full_stream.end(), encoded_packet.begin(), encoded_packet.end()); encoded_packet.clear();
    encoder.encodePacket(group101[2], encoded_packet); full_stream.insert(full_stream.end(), encoded_packet.begin(), encoded_packet.end()); encoded_packet.clear();
    std::cout << "Total stream size: " << full_stream.size() << " bytes" << std::endl;

    // ... (Receiver Processing logic - no change needed) ...
    std::cout << "\n--- Receiver Processing Interleaved Stream (Simulating Link Layer Chunks) --- " << std::endl;
    // ... (Simulate receiving in chunks) ...
    size_t chunk_size = 32;
     std::cout << "   (Simulating receive with chunk size: " << chunk_size << ")" << std::endl;
    for (size_t i = 0; i < full_stream.size(); i += chunk_size) {
        size_t end = std::min(i + chunk_size, full_stream.size());
        decoder.processData(full_stream.data() + i, end - i, testPacketCallback, testGroupCallback);
    }

    // ... (Verification logic - check received groups) ...
    std::cout << "\n--- Verification --- " << std::endl;
    // Verify Group 101
    // ... (Check count, types, content, last packet EG flag) ...
     assert(received_groups.count(group_id_101));
     const auto& received_group_101 = received_groups[group_id_101];
     assert(received_group_101.size() == 3); 
     assert(strncmp(received_group_101[0].tl, "IM", 2) == 0 && !received_group_101[0].is_end_of_group);
     assert(strncmp(received_group_101[1].tl, "RP", 2) == 0 && !received_group_101[1].is_end_of_group);
     assert(strncmp(received_group_101[2].tl, "AK", 2) == 0 && received_group_101[2].is_end_of_group); // Verify last packet EG flag
     std::cout << "Verifying Group 101... PASSED." << std::endl;

    // Verify Group 102
    // ... (Check count, types, content, last packet EG flag) ...
     assert(received_groups.count(group_id_102));
     const auto& received_group_102 = received_groups[group_id_102];
     assert(received_group_102.size() == 2); 
     assert(strncmp(received_group_102[0].tl, "TX", 2) == 0 && !received_group_102[0].is_end_of_group);
     assert(strncmp(received_group_102[1].tl, "DN", 2) == 0 && received_group_102[1].is_end_of_group); // Verify last packet EG flag
     std::cout << "Verifying Group 102... PASSED." << std::endl;

    std::cout << "\nOverall Verification PASSED." << std::endl;
    return 0;
}

// --- Test Case: Empty Group --- Updated EG logic
// An "empty" group now just means a single packet with the EG flag set.
int testCase_SinglePacketGroup() {
    std::cout << "\n--- Test Case: Single Packet Group --- " << std::endl;
    received_groups.clear();
    BPG::BpgEncoder encoder;
    BPG::BpgDecoder decoder;

    uint32_t group_id = 201;
    uint32_t target_id = 60;

    std::cout << "Sender: Creating Single Packet Group (ST packet with EG flag)" << std::endl;
    BPG::AppPacket single_packet;
    single_packet.group_id = group_id;
    single_packet.target_id = target_id;
    std::memcpy(single_packet.tl, "ST", 2); // Status packet type
    single_packet.is_end_of_group = true; // Set EG flag as it's the only packet
    BPG::HybridData status_hybrid_data;
    std::string status_str = "{\"status\":\"ready\"}";
    status_hybrid_data.binary_bytes.assign(status_str.begin(), status_str.end());
    single_packet.content = std::move(status_hybrid_data);
    printAppPacket(single_packet);

    BPG::BinaryData encoded_packet;
    encoder.encodePacket(single_packet, encoded_packet);
    std::cout << "Encoded single packet size: " << encoded_packet.size() << " bytes" << std::endl;

    std::cout << "Receiver: Processing stream" << std::endl;
    decoder.processData(encoded_packet.data(), encoded_packet.size(), testPacketCallback, testGroupCallback);

    std::cout << "\nVerifying Single Packet Group..." << std::endl;
    assert(received_groups.count(group_id));
    const auto& received_group = received_groups[group_id];
    assert(received_group.size() == 1);
    assert(strncmp(received_group[0].tl, "ST", 2) == 0);
    assert(received_group[0].is_end_of_group == true); // Verify EG flag
    std::cout << "Single Packet Group PASSED." << std::endl;
    return 0;
}

int main() {
    if (testCase_InterleavedGroups() != 0) return 1;
    if (testCase_SinglePacketGroup() != 0) return 1; // Renamed test

    std::cout << "\n--------------------------\n";
    std::cout << "All test cases PASSED." << std::endl;
    std::cout << "--------------------------\n" << std::endl;
    return 0;
}