#include "../plugin_interface.h"
#include <cstring>
#include <iostream>
#include <vector>
#include <string>
#include <map>
#include <opencv2/opencv.hpp>
#include <iomanip>
#include <memory>
#include <pybind11/embed.h>
#include <pybind11/pybind11.h>

// Include BPG Protocol headers
#include "BPG_Protocol/bpg_decoder.h"
#include "BPG_Protocol/bpg_encoder.h"
#include "BPG_Protocol/bpg_types.h"

// Declare Python plugin functions
extern "C" {
    bool python_initialize();
    const char* python_call_function(const char* function_name, const char** args, int arg_count);
    void python_shutdown();
    void free_result(const char* result);
}

namespace py = pybind11;

BPG::AppPacket create_string_packet(uint32_t group_id, uint32_t target_id,std::string TL, std::string str);

static MessageCallback g_send_message = nullptr;
static BufferRequestCallback g_buffer_request_callback = nullptr;
static BufferSendCallback g_buffer_send_callback = nullptr;
static BPG::BpgDecoder g_bpg_decoder; // Decoder instance for this plugin
static std::unique_ptr<py::scoped_interpreter> g_python_interpreter = nullptr;

// Function to initialize Python interpreter
static bool initialize_python() {
    try {
        if (!g_python_interpreter) {
            g_python_interpreter = std::make_unique<py::scoped_interpreter>();
            
            // Add the python_script directory to Python path
            py::module_ sys = py::module_::import("sys");
            py::str script_dir = py::str("python_script");
            sys.attr("path").attr("append")(script_dir);
            
            std::cout << "Python interpreter initialized successfully" << std::endl;
        }
        return true;
    } catch (const std::exception& e) {
        std::cerr << "Failed to initialize Python interpreter: " << e.what() << std::endl;
        return false;
    }
}

class HybridData_cvMat:public BPG::HybridData{
    public:
    cv::Mat img;
    std::string img_format;
    HybridData_cvMat(cv::Mat img,std::string img_format):img(img),img_format(img_format){
        printf("HybridData_cvMat: %zu <<format: %s\n",calculateBinarySize(),img_format.c_str());
    }

    size_t calculateBinarySize() const {
        if(img_format=="raw"){
            return img.total()*img.elemSize();
        }
        if(img_format=="raw_rgba"){
            return img.total()*4;
        }
        return 0;
    }

    size_t calculateEncodedSize() const override {
        return sizeof(uint32_t) + metadata_str.length() + calculateBinarySize();
    }

    BPG::BpgError encode_binary_to(BPG::BufferWriter& writer) const override {
        uint8_t* buffer = writer.claim_space(calculateBinarySize());
        if(buffer == nullptr) {
             std::cerr << "[HybridData_cvMat ERR] Failed to claim space in buffer! Capacity: " 
                       << writer.capacity() << ", Current Size: " << writer.size() 
                       << ", Requested: " << calculateBinarySize() << std::endl;
             return BPG::BpgError::BufferTooSmall; // Or another appropriate error
        }
        
        if(img_format=="raw"){
            std::memcpy(buffer, img.data, img.total()*img.elemSize());
            return BPG::BpgError::Success;
        }
        if(img_format=="raw_rgba"){

            switch(img.type()){
                case CV_8UC1:
                {

                    uint8_t* img_data = img.data;
                    uint8_t* buffer_ptr = buffer;
                    for(int i=0;i<img.total();i++){
                        uint8_t pixel = *img_data++;
                        *buffer_ptr++=pixel;
                        *buffer_ptr++=pixel;
                        *buffer_ptr++=pixel;
                        *buffer_ptr++=255;
                    }
                }
                    break;
                case CV_8UC3:
                {

                    uint8_t* img_data = img.data;
                    uint8_t* buffer_ptr = buffer;
                    for(int i=0;i<img.total();i++){
                        *buffer_ptr++=*img_data++;
                        *buffer_ptr++=*img_data++;
                        *buffer_ptr++=*img_data++;
                        *buffer_ptr++=255;
                    }
                }
                    break;

                case CV_8UC4:
                {
                    memcpy(buffer,img.data,img.total()*4);
                }
                    break;
                    
            }
            return BPG::BpgError::Success;
        }
        return BPG::BpgError::EncodingError;
    }
};

// --- BPG Callbacks --- 

// Example function to handle a fully decoded application packet
static void handle_decoded_packet(const BPG::AppPacket& packet) {
    std::cout << "[SamplePlugin BPG] Decoded Packet - Group: " << packet.group_id
              << ", Target: " << packet.target_id
              << ", Type: " << std::string(packet.tl, 2) << std::endl;

    if (!packet.content) {
        std::cout << "    Content: <null>" << std::endl;
        return; 
    }
    
    std::cout << "    Meta: " << (packet.content->metadata_str.empty() ? "<empty>" : packet.content->metadata_str) << std::endl;
    std::cout << "    Binary Size: " << packet.content->calculateEncodedSize() - sizeof(uint32_t) - packet.content->metadata_str.length() << std::endl; // Approx binary size

    // Print binary content hex preview (up to 64 bytes)
    if (!packet.content->internal_binary_bytes.empty()) {
        std::cout << "    Binary Hex: ";
        size_t print_len = std::min(packet.content->internal_binary_bytes.size(), (size_t)64);
        for (size_t i = 0; i < print_len; ++i) {
            std::cout << std::hex << std::setw(2) << std::setfill('0') << static_cast<int>(packet.content->internal_binary_bytes[i]) << " ";
        }
        if (packet.content->internal_binary_bytes.size() > 64) {
            std::cout << "...";
        }
        std::cout << std::dec << std::endl; // Reset stream to decimal
    }

    // Call Python function for text packets
    if (false && strncmp(packet.tl, "TX", 2) == 0 && packet.content) {
        std::vector<std::string> args;
        if (!packet.content->internal_binary_bytes.empty()) {
            // Convert binary data to string
            std::string text_data(packet.content->internal_binary_bytes.begin(), 
                                packet.content->internal_binary_bytes.end());
            args.push_back(text_data);
        }
        
        // Prepare arguments for Python call
        const char** c_args = new const char*[args.size()];
        for (size_t i = 0; i < args.size(); ++i) {
            c_args[i] = args[i].c_str();
        }
        
        // Call Python process_data function through the Python plugin
        const char* python_result = python_call_function("process_data", c_args, args.size());
        std::cout << "Python processing result: " << python_result << std::endl;
        
        // Send the result back through BPG
        BPG::AppPacketGroup response_group;
        response_group.push_back(create_string_packet(packet.group_id, packet.target_id, "TX", python_result));
        response_group.back().is_end_of_group = true;
        
        // Send the response
        uint8_t* buffer = nullptr;
        uint32_t buffer_size = 0;
        g_buffer_request_callback(1000, &buffer, &buffer_size);
        
        BPG::BufferWriter stream_writer(buffer, buffer_size);
        bool success = true;
        for (const auto& resp_packet : response_group) {
            BPG::BpgError encode_err = resp_packet.encode(stream_writer);
            if (encode_err != BPG::BpgError::Success) {
                success = false;
                break;
            }
        }
        
        if (success) {
            g_buffer_send_callback(stream_writer.size());
        } else {
            g_buffer_send_callback(0);
        }
        
        // Clean up
        delete[] c_args;
        free_result(python_result);
    }

    // --- TODO: Add application logic based on packet type/content ---
    if (strncmp(packet.tl, "IM", 2) == 0) {
        std::cout << "    (Packet is an Image)" << std::endl;
        // Potentially decode using metadata hints
        // cv::Mat img = cv::imdecode(packet.content->internal_binary_bytes, cv::IMREAD_COLOR);
        // if (!img.empty()) { /* process image */ }
    }
}


BPG::AppPacket create_image_packet(uint32_t group_id, uint32_t target_id, const cv::Mat& img, std::string img_format="") {
    BPG::AppPacket img_packet;
    img_packet.group_id = group_id;
    img_packet.target_id = target_id;
    std::memcpy(img_packet.tl, "IM", 2);
    img_packet.is_end_of_group = false;

    // Create the derived object using make_shared
    auto img_hybrid_data_ptr = std::make_shared<HybridData_cvMat>(img, img_format);
    
    // Set metadata on the object via the pointer
    img_hybrid_data_ptr->metadata_str = 
        "{\"width\":"+std::to_string(img.cols)+
        ",\"height\":"+std::to_string(img.rows)+
        ",\"channels\":"+std::to_string(img.channels())+
        ",\"type\":"+std::to_string(img.type())+
        ",\"format\":\""+img_format+"\"}";
    

    printf("metadata_str: %s\n",img_hybrid_data_ptr->metadata_str.c_str());
    // Assign the shared_ptr to content
    img_packet.content = img_hybrid_data_ptr;
    return img_packet;
}




BPG::AppPacket create_string_packet(uint32_t group_id, uint32_t target_id,std::string TL, std::string str){
    BPG::AppPacket string_packet;
    string_packet.group_id = group_id;
    string_packet.target_id = target_id; // Use the provided target_id
    std::memcpy(string_packet.tl, TL.c_str(), TL.size());
    string_packet.is_end_of_group = false;
    auto hybrid_data_ptr = std::make_shared<BPG::HybridData>();
    
    // Set metadata on the object via the pointer
    hybrid_data_ptr->metadata_str = str;
    string_packet.content = hybrid_data_ptr;
    return string_packet;
}

// --- Example Sending Functions --- 


int drawCounter=0;
// NEW: Function to send a simple Acknowledgement Group
static bool send_acknowledgement_group(uint32_t group_id, uint32_t target_id) {
    if (!g_send_message) {
        std::cerr << "[SamplePlugin BPG] Error: Cannot send ACK, g_send_message is null." << std::endl;
        return false;
    }

    std::cout << "[SamplePlugin BPG] Encoding and Sending ACK Group ID: " << group_id << std::endl;
    BPG::AppPacketGroup group_to_send;

    {
        // --- Construct IM Packet ---

        cv::Mat img(600,800,CV_8UC4,cv::Scalar(0,0,255,100));
        // draw text on the image
        cv::putText(img, "Hello, World!"+std::to_string(drawCounter++), cv::Point(10,50), cv::FONT_HERSHEY_SIMPLEX, 1, cv::Scalar(0,0,0,255), 2);
        group_to_send.push_back(
            create_image_packet(group_id, target_id, 
        img, 
        "raw_rgba")
        );
    }





    {
        group_to_send.push_back(
            create_string_packet(group_id, target_id,"AK","{\"received\":true}")
        );


    }

    //set last packet as end of group
    group_to_send.back().is_end_of_group = true;

    // --- Calculate Size and Create Buffer/Writer ---
    size_t total_estimated_size = 0;
    for(const auto& packet : group_to_send) {
        if (packet.content) { 
            // printf("packet.content->calculateEncodedSize(): %zu\n",packet.content->calculateEncodedSize());
            total_estimated_size += BPG::BPG_HEADER_SIZE + packet.content->calculateEncodedSize();
        } else {
            total_estimated_size += BPG::BPG_HEADER_SIZE; 
        }
    }

    // --- Request Buffer ---
    uint8_t* buffer = nullptr;
    uint32_t buffer_size = 0;
    g_buffer_request_callback(1000,&buffer, &buffer_size);

    BPG::BufferWriter stream_writer(buffer, buffer_size);



    // --- Encode the Group into the Writer ---
    // write packets back to back
    bool success = true;
    for (const auto& packet : group_to_send) { 
        uint8_t* buffer_ptr = stream_writer.raw_data()+stream_writer.currentPosition();
        memset(buffer_ptr,0,200);
        printf("encoding packet: %s, group_id: %d\n",std::string(packet.tl, 2).c_str(),packet.group_id);
        BPG::BpgError encode_err = packet.encode(stream_writer);


        if (encode_err != BPG::BpgError::Success) {
            std::cerr << "[SamplePlugin BPG] Error encoding ACK packet: " << static_cast<int>(encode_err) << std::endl;
            success = false;
            break; // Exit loop on error
        }
    }

    // --- Send the Entire Buffer ---
    if (success) {
         std::cout << "  Sending ACK Group (ID: " << group_id << "), Total Size: " << stream_writer.size() << std::endl;
        //  g_send_message(stream_writer.data(), stream_writer.size());
        g_buffer_send_callback(stream_writer.size());
    }
    else
    {
        g_buffer_send_callback(0);
    }

    return success; // Return overall success/failure
}

// Example function to handle a completed packet group
static void handle_decoded_group(uint32_t group_id, BPG::AppPacketGroup&& group) {
     std::cout << "[SamplePlugin BPG] Decoded COMPLETE Group - ID: " << group_id 
               << ", Packet Count: " << group.size() << std::endl;
    
    // --- TODO: Add application logic for the complete group --- 
    for(const auto& packet : group) {
         std::cout << "    - Packet Type in Group: " << std::string(packet.tl, 2) << std::endl;
         if (packet.content) {
             std::cout << "      Meta: " << (packet.content->metadata_str.empty() ? "<empty>" : packet.content->metadata_str) << std::endl;
             std::cout << "      Binary Size: " << packet.content->calculateEncodedSize() - sizeof(uint32_t) - packet.content->metadata_str.length() << std::endl; // Approx binary size
         } else {
             std::cout << "      Content: <null>" << std::endl;
         }
    }

    // --- Echo Back Logic --- 
    if (!group.empty()) {
        uint32_t original_target_id = group[0].target_id; // Assuming target_id is same for the group
        uint32_t response_target_id = original_target_id;
        send_acknowledgement_group(group_id, response_target_id); // Send ACK back
    } else {
         std::cerr << "[SamplePlugin BPG] Warning: Received empty group (ID: " << group_id << "), cannot echo back." << std::endl;
    }
}

// --- Plugin Interface Implementation --- 

static PluginInfo plugin_info = {
    "Sample Plugin (BPG Enabled)", // Updated name
    "1.1.0", // Version bump
    PLUGIN_API_VERSION
};

static PluginStatus initialize(MessageCallback send_message, 
                             BufferRequestCallback buffer_request_callback,
                             BufferSendCallback buffer_send_callback) {
    g_send_message = send_message;
    g_buffer_request_callback = buffer_request_callback;
    g_buffer_send_callback = buffer_send_callback;
    g_bpg_decoder.reset(); // Reset decoder state on initialization
    
    printf("Initializing Python....\n");
    
    try {
        // Initialize Python interpreter
        if (!g_python_interpreter) {
            g_python_interpreter = std::make_unique<py::scoped_interpreter>();
            
            // Add the python_script directory to Python path
            py::module_ sys = py::module_::import("sys");
            py::str script_dir = py::str("native/plugins/python_script");
            sys.attr("path").attr("append")(script_dir);
            
            std::cout << "Python interpreter initialized successfully" << std::endl;
            std::cout << "Python path: " << py::str(sys.attr("path")).cast<std::string>() << std::endl;
        }

        // Import the test module
        py::module_ test_module = py::module_::import("test_plugin");
        
        // Call a simple test function
        py::object result = test_module.attr("test_function")(py::make_tuple("Hello", "from", "C++"));
        std::string result_str = py::str(result).cast<std::string>();
        std::cout << "Python test function result: " << result_str << std::endl;
        
        return PLUGIN_SUCCESS;
    } catch (const std::exception& e) {
        std::cerr << "Python error: " << e.what() << std::endl;
        return PLUGIN_ERROR_INITIALIZATION;
    }
}

static void shutdown() {
    std::cout << "Sample plugin (BPG Enabled with Python) shutdown" << std::endl;
    python_shutdown(); // Shutdown Python through the Python plugin
    g_send_message = nullptr;
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