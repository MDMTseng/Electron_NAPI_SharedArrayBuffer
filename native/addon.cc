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
    SharedMemoryChannel() : shouldRun(true), shouldSendData(true), sendInterval(1000),
        nativeThread(nullptr), sendingThread(nullptr),
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
        shouldRun = true;
        nativeThread = new std::thread(&SharedMemoryChannel::nativeThreadFunc, this);
        sendingThread = new std::thread(&SharedMemoryChannel::sendingThreadFunc, this);

    }

    void cleanup() {
        // Clear the sending queue and stop all threads
        sendQueue.clear();
        shouldSendData = false;
        shouldRun = false;

        // Cleanup native thread
        if (nativeThread) {
            nativeThread->join();
            delete nativeThread;
            nativeThread = nullptr;
        }

        // Cleanup sending thread
        if (sendingThread) {
            sendingThread->join();
            delete sendingThread;
            sendingThread = nullptr;
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

    void startSendingData(uint32_t interval) {
        sendInterval = interval;
        shouldSendData = true;
    }

    void stopSendingData() {
        shouldSendData = false;
    }

    // New method to queue data for sending
    void queueData(const std::vector<uint8_t>& data) {
        if (shouldSendData && data.size() <= n2rBufferSize) {
            sendQueue.push(data);
        }
    }

private:
    void processMessage() {
        if (control[0] == 1) {
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

    void nativeThreadFunc() {
        int wait_time = 1;
        while (shouldRun) {
            // Update plugin if loaded
            if (g_plugin_loader.is_loaded()) {
                g_plugin_loader.update();
            }

            // Wait for Renderer → Native
            while (control && control[0].load(std::memory_order_seq_cst) != 1) {
                std::this_thread::sleep_for(std::chrono::microseconds(wait_time));
                wait_time++;
                if(wait_time > 1000) {
                    wait_time = 1000;
                }
                if (!shouldRun) return;
            }
            wait_time = 1;

            if (!control) continue;
            processMessage();
        }
    }

    void sendingThreadFunc() {
        std::vector<uint8_t> data;
        int wait_time = 1;
        bool should_continue = true;

        while (shouldRun) {
            should_continue = shouldRun.load(std::memory_order_seq_cst);
            
            if (shouldSendData && control && dataN2R) {
                // Try to get data from the queue
                if (sendQueue.wait_and_pop(data, should_continue)) {
                    // Wait until renderer has processed previous message
                    while (control[2].load(std::memory_order_seq_cst) == 1) {
                        std::this_thread::sleep_for(std::chrono::microseconds(wait_time));
                        wait_time++;
                        if(wait_time > 1000) {
                            wait_time = 1000;
                        }
                        if (!shouldRun) return;
                    }
                    wait_time = 1;

                    // Send the data
                    if (data.size() <= n2rBufferSize) {
                        memcpy(dataN2R, data.data(), data.size());
                        control[3].store(data.size(), std::memory_order_seq_cst);
                        control[2].store(1, std::memory_order_seq_cst);
                    }

                    // Optional delay between sends
                    if (sendInterval > 0) {
                        std::this_thread::sleep_for(std::chrono::milliseconds(sendInterval));
                    }
                }
            } else {
                std::this_thread::sleep_for(std::chrono::milliseconds(100));
            }
        }
    }

    std::atomic<bool> shouldRun;
    bool shouldSendData;
    uint32_t sendInterval;

    std::thread* nativeThread;
    std::thread* sendingThread;  // Renamed from nativeDataThread

    Napi::Reference<Napi::ArrayBuffer> sharedArrayBufferRef;
    std::atomic<int32_t>* control;
    uint8_t* dataR2N;
    uint8_t* dataN2R;
    size_t r2nBufferSize;
    size_t n2rBufferSize;

    ThreadSafeQueue<std::vector<uint8_t>> sendQueue;  // Queue for sending data
};

// Global instance of SharedMemoryChannel
SharedMemoryChannel channel;


void plugin_message_to_queue(const uint8_t* data, size_t length) {
    std::vector<uint8_t> data_copy(data, data + length);
    channel.queueData(data_copy);
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

Napi::Value StartSendingData(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    uint32_t interval = 1000;
    if (info.Length() > 0 && info[0].IsNumber()) {
        interval = info[0].As<Napi::Number>().Uint32Value();
    }

    channel.startSendingData(0);
    return env.Undefined();
}

Napi::Value StopSendingData(const Napi::CallbackInfo& info) {
    channel.stopSendingData();
    return info.Env().Undefined();
}

Napi::Value TriggerTestCallback(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    std::string testMessage = "Test callback from native code!";
    std::vector<uint8_t> testMessageVector(testMessage.begin(), testMessage.end());
    
    int length = testMessageVector.size();
    printf("length: %d\n",length);
    // Queue the test message for sending
    channel.queueData(testMessageVector);
    // printf("q size: %zu, length: %d\n", channel.sendQueue.size(), length);
    
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
            interface->initialize(plugin_message_to_queue);
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
    exports.Set("startSendingData", Napi::Function::New(env, StartSendingData));
    exports.Set("stopSendingData", Napi::Function::New(env, StopSendingData));
    exports.Set("setMessageCallback", Napi::Function::New(env, SetMessageCallback));
    exports.Set("triggerTestCallback", Napi::Function::New(env, TriggerTestCallback));
    exports.Set("loadPlugin", Napi::Function::New(env, LoadPlugin));
    exports.Set("unloadPlugin", Napi::Function::New(env, UnloadPlugin));
    return exports;
}

NODE_API_MODULE(addon, Init) 