#include <napi.h>
#include <thread>
#include <atomic>
#include <chrono>
#include <cstring>
#include <vector>
#include <functional>
#include "plugin_loader.h"
#include "thread_safe_queue.h"

// Forward declare our async helper
void schedule_async_callback(Napi::Env env, std::function<void()> callback);

// Global plugin loader instance
PluginLoader g_plugin_loader;

Napi::FunctionReference messageCallback;
void setMessageCallback(const Napi::Function& callback) {
    messageCallback = Napi::Persistent(callback);
}

Napi::Value SetMessageCallback(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    if (info.Length() < 1 || !info[0].IsFunction()) {
        Napi::TypeError::New(env, "Expected a function argument").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    setMessageCallback(info[0].As<Napi::Function>());
    return env.Undefined();
}

// Helper function to execute callbacks in the Node.js event loop
void schedule_async_callback(Napi::Env env, std::function<void()> callback) {
    struct AsyncData {
        std::function<void()> callback;
        napi_async_work work;
    };

    auto async_data = new AsyncData{std::move(callback), nullptr};

    // Create async work
    napi_create_async_work(
        env,
        nullptr,
        Napi::String::New(env, "AsyncCallback"),
        // Execute (runs in worker thread - we do nothing here)
        [](napi_env env, void* data) {},
        // Complete (runs in main thread - we execute our callback here)
        [](napi_env env, napi_status status, void* data) {
            auto async_data = static_cast<AsyncData*>(data);
            async_data->callback();
            delete async_data;
        },
        async_data,
        &async_data->work
    );

    // Queue the async work
    napi_queue_async_work(env, async_data->work);
}

// Callback from plugin to Node.js
void plugin_message_callback(const uint8_t* data, size_t length) {
    if (!messageCallback.IsEmpty()) {
        // Create a copy of the data for the callback
        std::vector<uint8_t> data_copy(data, data + length);
        
        // Create a function to execute the callback in the JavaScript thread
        auto callback = [data = std::move(data_copy)]() {
            Napi::HandleScope scope(messageCallback.Env());
            
            // Create a Node.js Buffer containing our data
            Napi::Buffer<uint8_t> buffer = Napi::Buffer<uint8_t>::Copy(
                messageCallback.Env(), 
                data.data(), 
                data.size()
            );
            
            // Call the JavaScript callback with the buffer
            messageCallback.Call({buffer});
        };
        
        // Schedule the callback to be executed in the Node.js event loop
        schedule_async_callback(messageCallback.Env(), std::move(callback));
    }
}


class SharedMemoryChannel {
public:
    SharedMemoryChannel() : isChannelOperating(true),
        recvThread(nullptr),
        control(nullptr), dataR2N(nullptr), dataN2R(nullptr),
        r2nBufferSize(0), n2rBufferSize(0) {}

    ~SharedMemoryChannel() {
        cleanup();
    }

    void initialize(Napi::ArrayBuffer& sab, size_t r2nSize, size_t n2rSize) {
        cleanup(); // Cleanup existing resources first

        r2nBufferSize = r2nSize;
        n2rBufferSize = n2rSize;

        // Set up new shared buffer
        sharedArrayBufferRef = Napi::Persistent(sab);
        sharedArrayBufferRef.SuppressDestruct();

        void* base = sab.Data();
        control = reinterpret_cast<std::atomic<int32_t>*>(base);
        dataR2N = reinterpret_cast<uint8_t*>((int8_t*)base + 16);
        dataN2R = dataR2N + r2nBufferSize;

        // Initialize control values
        for (int i = 0; i < 4; i++) {
            control[i].store(0, std::memory_order_seq_cst);
        }

        // Start threads
        isChannelOperating = true;
        recvThread = new std::thread(&SharedMemoryChannel::recvThreadFunc, this);

    }

    void cleanup() {
        // First stop all threads by setting isChannelOperating to false
        // This will interrupt wait_and_pop in the sending thread
        isChannelOperating = false;
        
        

        // Cleanup native thread
        if (recvThread) {
            recvThread->join();
            delete recvThread;
            recvThread = nullptr;
        }


        // Reset pointers
        control = nullptr;
        dataR2N = nullptr;
        dataN2R = nullptr;
        
        // Reset buffer sizes
        r2nBufferSize = 0;
        n2rBufferSize = 0;

        // Clear shared buffer reference
        if (!sharedArrayBufferRef.IsEmpty()) {
            sharedArrayBufferRef.Reset();
        }

        // Clear callback reference
        if (!messageCallback.IsEmpty()) {
            messageCallback.Reset();
        }

    }

    int req_available_buffer(uint32_t wait_ms,uint8_t**ret_buffer,uint32_t *ret_buffer_sapce) {
        send_buffer_mutex.lock();
        int isLineBusy=1;
        for (int i = 0; i < wait_ms; i++) {
            isLineBusy=control[2].load(std::memory_order_seq_cst);
            if(isLineBusy==0)break;
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
        }
        if(isLineBusy==1)
        {
            send_buffer_mutex.unlock();
            return -2;
        }

        *ret_buffer=dataN2R;
        *ret_buffer_sapce=n2rBufferSize;
        return 0;
    }

    int send_current_buffer(uint32_t data_length) {
        if(data_length==0)
        {
            send_buffer_mutex.unlock();
            return -1;
        }
        control[3].store(data_length, std::memory_order_seq_cst);
        control[2].store(1, std::memory_order_seq_cst);//send

        send_buffer_mutex.unlock();
        return 0;
    }

    int send_buffer(const uint8_t* data, size_t length,uint32_t wait_ms) {
        if (length <= 0 || length > n2rBufferSize || data==nullptr)return -1;

        uint8_t* buffer=nullptr;
        uint32_t buffer_sapce=0;
        int ret=req_available_buffer(wait_ms,&buffer,&buffer_sapce);
        if(ret!=0)return ret;

        memcpy(buffer,data,length);
        ret=send_current_buffer(length);
        return ret;
    }
    
private:


    void recvThreadFunc() {
        while (isChannelOperating) {
            // Update plugin if loaded
            if (g_plugin_loader.is_loaded()) {
                g_plugin_loader.update();
            }

            int wait_time = 1;
            // Wait for Renderer → Native
            while (control && control[0].load(std::memory_order_seq_cst) != 1) {
                std::this_thread::sleep_for(std::chrono::microseconds(wait_time));
                wait_time++;
                if(wait_time > 1000) {
                    wait_time = 1000;
                }
                if (!isChannelOperating) return;
            }

            size_t length = static_cast<size_t>(control[1]);
            if (length > 0 && length <= r2nBufferSize) {
                // Forward to plugin if loaded
                if (g_plugin_loader.is_loaded()) {
                    g_plugin_loader.process_message(dataR2N, length);
                } else {
                    // Original message handling
                    printf("Data from renderer: ");
                    for (size_t i = 0; i < length && i < 32; i++) {
                        printf("%02x ", dataR2N[i]);
                    }
                    if (length > 32) printf("...");
                    printf(" (length: %zu)\n", length);
                }
                
                control[0] = 0;  // Reset R→N signal
            }
        }
    }

    //lock
    std::mutex send_buffer_mutex;
    std::atomic<bool> isChannelOperating;

    std::thread* recvThread;
    Napi::Reference<Napi::ArrayBuffer> sharedArrayBufferRef;
    std::atomic<int32_t>* control;
    uint8_t* dataR2N;
    uint8_t* dataN2R;
    size_t r2nBufferSize;
    size_t n2rBufferSize;

};

// Global instance of SharedMemoryChannel
SharedMemoryChannel channel;



void memcpy_to_shared_buffer(const uint8_t* data, size_t length) {
    channel.send_buffer(data,length,1000);
}
int req_available_buffer(uint32_t wait_ms,uint8_t** buffer, uint32_t* buffer_sapce) {
    return channel.req_available_buffer(wait_ms,buffer,buffer_sapce);
}
int send_current_buffer(uint32_t data_length) {
    return channel.send_current_buffer(data_length);
}


Napi::String Hello(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    return Napi::String::New(env, "Hello from N-API! dd");
}

Napi::Value SetSharedBuffer(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    if (info.Length() < 3 || !info[0].IsArrayBuffer() || !info[1].IsNumber() || !info[2].IsNumber()) {
        Napi::TypeError::New(env, "Expected (ArrayBuffer, Number, Number)").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    auto sab = info[0].As<Napi::ArrayBuffer>();
    size_t r2nSize = info[1].As<Napi::Number>().Uint32Value();
    size_t n2rSize = info[2].As<Napi::Number>().Uint32Value();

    printf("r2nBufferSize: %zu, n2rBufferSize: %zu\n", r2nSize, n2rSize);

    size_t totalSize = 16 + r2nSize + n2rSize; // 16 bytes for control
    if (sab.ByteLength() < totalSize) {
        Napi::TypeError::New(env, "Buffer too small for specified sizes").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    channel.initialize(sab, r2nSize, n2rSize);
    return env.Undefined();
}

Napi::Value Cleanup(const Napi::CallbackInfo& info) {
    channel.cleanup();
    return info.Env().Undefined();
}

Napi::Value TriggerTestCallback(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    std::string testMessage = "Test callback from native code!";


    channel.send_buffer((uint8_t*)testMessage.c_str(),testMessage.size(),1000);
  
    return env.Undefined();
}

// New function to load a plugin
Napi::Value LoadPlugin(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "Expected plugin path argument").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    std::string plugin_path = info[0].As<Napi::String>().Utf8Value();
    
    bool success = g_plugin_loader.load(plugin_path);
    if (success) {
        // Initialize the plugin with our callback
        const PluginInterface* interface = g_plugin_loader.get_interface();
        if (interface) {
            interface->initialize(memcpy_to_shared_buffer,
            req_available_buffer,send_current_buffer);
        }
    }
    
    return Napi::Boolean::New(env, success);
}

// New function to unload the current plugin
Napi::Value UnloadPlugin(const Napi::CallbackInfo& info) {
    g_plugin_loader.unload();
    return info.Env().Undefined();
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("setSharedBuffer", Napi::Function::New(env, SetSharedBuffer));
    exports.Set("cleanup", Napi::Function::New(env, Cleanup));
    exports.Set("hello", Napi::Function::New(env, Hello));
    exports.Set("setMessageCallback", Napi::Function::New(env, SetMessageCallback));
    exports.Set("triggerTestCallback", Napi::Function::New(env, TriggerTestCallback));
    exports.Set("loadPlugin", Napi::Function::New(env, LoadPlugin));
    exports.Set("unloadPlugin", Napi::Function::New(env, UnloadPlugin));
    return exports;
}

NODE_API_MODULE(addon, Init) 