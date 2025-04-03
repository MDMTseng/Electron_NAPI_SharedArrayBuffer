#include "../plugin_interface.h"
#include <cstring>
#include <iostream>

static MessageCallback g_callback = nullptr;

// Plugin implementation
static PluginInfo plugin_info = {
    "Sample Plugin",
    "1.0.0",
    PLUGIN_API_VERSION
};

static PluginStatus initialize(MessageCallback callback) {
    g_callback = callback;
    std::cout << "Sample plugin initialized" << std::endl;
    return PLUGIN_SUCCESS;
}

static void shutdown() {
    std::cout << "Sample plugin shutdown" << std::endl;
    g_callback = nullptr;
}

static void process_message(const uint8_t* data, size_t length) {
    std::cout << "Sample plugin received message of length: " << length << std::endl;
    
    // Echo the message back through the callback
    if (g_callback) {
        g_callback(data, length);
    }
}

static void update() {
    // Called periodically by the host
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