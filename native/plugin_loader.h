#ifndef PLUGIN_LOADER_H
#define PLUGIN_LOADER_H

#include <string>
#include <memory>
#include "plugin_interface.h"

#ifdef _WIN32
#include <windows.h>
typedef HMODULE LibraryHandle;
#else
typedef void* LibraryHandle;
#endif

class PluginLoader {
public:
    PluginLoader();
    ~PluginLoader();

    // Load a plugin from the specified path
    bool load(const std::string& path);
    
    // Unload the current plugin
    void unload();
    
    // Check if a plugin is loaded
    bool is_loaded() const;
    
    // Get the plugin interface
    const PluginInterface* get_interface() const;
    
    // Process message through the plugin
    void process_message(const uint8_t* data, size_t length);
    
    // Update the plugin
    void update();

private:
    LibraryHandle library_;
    const PluginInterface* interface_;
    bool loaded_;

    // Platform-specific functions
    bool load_library(const std::string& path);
    void free_library();
    void* get_symbol(const char* symbol_name);
};

#endif // PLUGIN_LOADER_H 