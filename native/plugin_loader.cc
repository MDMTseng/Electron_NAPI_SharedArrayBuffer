#include "plugin_loader.h"
#include <iostream>

#ifdef _WIN32
    #define WIN32_LEAN_AND_MEAN
    #include <windows.h>
#else
    #include <dlfcn.h>
#endif

PluginLoader::PluginLoader() : library_(nullptr), interface_(nullptr), loaded_(false) {}

PluginLoader::~PluginLoader() {
    unload();
}

bool PluginLoader::load(const std::string& path) {
    printf("Loading plugin from: %s\n", path.c_str());
    if (loaded_) {
        unload();
    }
    printf("Loading plugin from: %s\n", path.c_str());
    if (!load_library(path)) {
        std::cerr << "Failed to load plugin library: " << path << std::endl;
        return false;
    }

    // Get the plugin interface
    using GetPluginInterface = const PluginInterface* (*)();
    auto get_interface = reinterpret_cast<GetPluginInterface>(get_symbol("get_plugin_interface"));
    
    if (!get_interface) {
        std::cerr << "Failed to get plugin interface" << std::endl;
        free_library();
        return false;
    }

    interface_ = get_interface();
    if (!interface_) {
        std::cerr << "Plugin returned null interface" << std::endl;
        free_library();
        return false;
    }

    // Verify API version
    if (interface_->info.api_version != PLUGIN_API_VERSION) {
        std::cerr << "Plugin API version mismatch. Expected " << PLUGIN_API_VERSION 
                  << ", got " << interface_->info.api_version << std::endl;
        free_library();
        return false;
    }

    loaded_ = true;
    return true;
}

void PluginLoader::unload() {
    if (loaded_ && interface_) {
        interface_->shutdown();
    }
    
    free_library();
    interface_ = nullptr;
    loaded_ = false;
}

bool PluginLoader::is_loaded() const {
    return loaded_;
}

const PluginInterface* PluginLoader::get_interface() const {
    return interface_;
}

void PluginLoader::process_message(const uint8_t* data, size_t length) {
    if (loaded_ && interface_) {
        interface_->process_message(data, length);
    }
}

void PluginLoader::update() {
    if (loaded_ && interface_) {
        interface_->update();
    }
}

#ifdef _WIN32
bool PluginLoader::load_library(const std::string& path) {
    library_ = LoadLibraryA(path.c_str());
    return library_ != nullptr;
}

void PluginLoader::free_library() {
    if (library_) {
        FreeLibrary(library_);
        library_ = nullptr;
    }
}

void* PluginLoader::get_symbol(const char* symbol_name) {
    return library_ ? GetProcAddress(library_, symbol_name) : nullptr;
}
#else
bool PluginLoader::load_library(const std::string& path) {
    library_ = dlopen(path.c_str(), RTLD_NOW);
    return library_ != nullptr;
}

void PluginLoader::free_library() {
    if (library_) {
        dlclose(library_);
        library_ = nullptr;
    }
}

void* PluginLoader::get_symbol(const char* symbol_name) {
    return library_ ? dlsym(library_, symbol_name) : nullptr;
}
#endif 