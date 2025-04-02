#include <napi.h>
#include <thread>
#include <atomic>
#include <chrono>
#include <cstring>

class SharedMemoryChannel {
public:
    SharedMemoryChannel() : shouldRun(true), shouldSendData(false), sendInterval(1000),
        nativeThread(nullptr), nativeDataThread(nullptr),
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

        // Start new native thread
        shouldRun = true;
        nativeThread = new std::thread(&SharedMemoryChannel::nativeThreadFunc, this);
    }

    void cleanup() {
        // Stop all running threads
        shouldSendData = false;
        shouldRun = false;

        // Cleanup native thread
        if (nativeThread) {
            nativeThread->join();
            delete nativeThread;
            nativeThread = nullptr;
        }

        // Cleanup data sending thread
        if (nativeDataThread) {
            nativeDataThread->join();
            delete nativeDataThread;
            nativeDataThread = nullptr;
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
    }

    void startSendingData(uint32_t interval) {
        sendInterval = interval;
        shouldSendData = true;
        
        // Start the sending thread if not already running
        if (!nativeDataThread) {
            nativeDataThread = new std::thread(&SharedMemoryChannel::sendDataThreadFunc, this);
        }
    }

    void stopSendingData() {
        shouldSendData = false;
    }

private:
    void processMessage() {
        if (control[0] == 1) {
            size_t length = static_cast<size_t>(control[1]);
            if (length > 0 && length <= r2nBufferSize) {
                // Print received data
                printf("Data from renderer: ");
                for (size_t i = 0; i < length && i < 32; i++) {
                    printf("%02x ", dataR2N[i]);
                }
                if (length > 32) printf("...");
                printf(" (length: %zu)\n", length);
                
                control[0] = 0;  // Reset R→N signal
            }
        }
    }

    void nativeThreadFunc() {
        while (shouldRun) {
            // Wait for Renderer → Native
            while (control && control[0].load(std::memory_order_seq_cst) != 1) {
                std::this_thread::sleep_for(std::chrono::microseconds(1));
                if (!shouldRun) return;
            }

            if (!control) continue;
            processMessage();
        }
    }

    void sendDataThreadFunc() {
        int send_count = 0;
        while (shouldRun) {
            if (shouldSendData && control && dataN2R) {
                // Wait until renderer has processed previous message
                while (control[2].load(std::memory_order_seq_cst) == 1) {
                    std::this_thread::sleep_for(std::chrono::milliseconds(1));
                    if (!shouldRun) return;
                }

                // Generate some test data
                std::string message = std::to_string(send_count++);
                size_t length = message.size();
                printf("message:%s, length:%d\n", message.c_str(), length);
                
                if (length <= n2rBufferSize) {
                    memcpy(dataN2R, message.c_str(), length);
                    control[3].store(length, std::memory_order_seq_cst);
                    control[2].store(1, std::memory_order_seq_cst);
                }

                // Wait for specified interval
                std::this_thread::sleep_for(std::chrono::milliseconds(sendInterval));
            } else {
                std::this_thread::sleep_for(std::chrono::milliseconds(100));
            }
        }
    }

    std::atomic<bool> shouldRun;
    bool shouldSendData;
    uint32_t sendInterval;

    std::thread* nativeThread;
    std::thread* nativeDataThread;

    Napi::Reference<Napi::ArrayBuffer> sharedArrayBufferRef;
    std::atomic<int32_t>* control;
    uint8_t* dataR2N;
    uint8_t* dataN2R;
    size_t r2nBufferSize;
    size_t n2rBufferSize;
};

// Global instance of SharedMemoryChannel
SharedMemoryChannel channel;

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

    printf("r2nBufferSize: %d, n2rBufferSize: %d\n", r2nSize, n2rSize);

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

    channel.startSendingData(interval);
    return env.Undefined();
}

Napi::Value StopSendingData(const Napi::CallbackInfo& info) {
    channel.stopSendingData();
    return info.Env().Undefined();
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("setSharedBuffer", Napi::Function::New(env, SetSharedBuffer));
    exports.Set("cleanup", Napi::Function::New(env, Cleanup));
    exports.Set("hello", Napi::Function::New(env, Hello));
    exports.Set("startSendingData", Napi::Function::New(env, StartSendingData));
    exports.Set("stopSendingData", Napi::Function::New(env, StopSendingData));
    return exports;
}

NODE_API_MODULE(addon, Init) 