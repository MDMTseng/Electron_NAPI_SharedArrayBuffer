#include <napi.h>
#include <thread>
#include <atomic>
#include <chrono>
#include <cstring>

Napi::Reference<Napi::ArrayBuffer> sharedArrayBufferRef;
std::atomic<bool> shouldRun{true};
std::atomic<uint64_t> totalBytesProcessed{0};
std::atomic<uint64_t> totalMessagesProcessed{0};
std::chrono::high_resolution_clock::time_point startTime;

// Add these global variables for native-to-renderer communication
std::thread* nativeDataThread = nullptr;
bool shouldSendData = false;
uint32_t sendInterval = 1000; // milliseconds

uint8_t* dataR2N = nullptr;
uint8_t* dataN2R = nullptr;
std::atomic<int32_t>* control = nullptr;
size_t r2nBufferSize = 0;
size_t n2rBufferSize = 0;

// Control array layout (24 bytes total):
// [0] - R→N signal
// [1] - R→N length
// [2] - N→R echo signal
// [3] - N→R echo length
// [4] - N→R message signal
// [5] - N→R message length

Napi::String Hello(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  return Napi::String::New(env, "Hello from N-API! dd");
}

void ProcessMessage() {
    if (control[0] == 1) {
        size_t length = static_cast<size_t>(control[1]);
        if (length > 0 && length <= r2nBufferSize) {  // Now using consistent types
            // Print received data
            printf("Data from renderer: ");
            for (size_t i = 0; i < length && i < 32; i++) {  // Print up to first 32 bytes
                printf("%02x ", dataR2N[i]);
            }
            if (length > 32) printf("...");
            printf(" (length: %zu)\n", length);
            
            // Echo the message back
            std::memcpy(dataN2R, dataR2N, length);
            control[2] = 1;  // Set echo signal
            control[3] = static_cast<int32_t>(length);  // Set echo length
            control[0] = 0;  // Reset R→N signal
            
            // Update throughput stats
            totalBytesProcessed.fetch_add(length, std::memory_order_seq_cst);
            totalMessagesProcessed.fetch_add(1, std::memory_order_seq_cst);
        }
    }
}

void NativeThread() {
    while (shouldRun) {
        // Wait for Renderer → Native
        while (control && control[0].load(std::memory_order_seq_cst) != 1) {
            std::this_thread::sleep_for(std::chrono::microseconds(1));
            if (!shouldRun) return;
        }

        if (!control) continue;

        ProcessMessage();
    }
}

std::thread* nativeThread = nullptr;
int send_count = 0;
void SendDataToRenderer() {
    while (shouldRun) {
        if (shouldSendData && control && dataN2R) {
            // Wait until renderer has processed previous message
            while (control[4].load(std::memory_order_seq_cst) == 1) {
                std::this_thread::sleep_for(std::chrono::milliseconds(1));
                if (!shouldRun) return;
            }

            // Generate some test data
            std::string message = std::to_string(send_count++);//"Data from native: " + std::to_string(send_count++) + " " + std::to_string(std::chrono::system_clock::now().time_since_epoch().count());
            size_t length = message.size();
            printf("message:%s, length:%d\n", message.c_str(), length);
            if (length <= n2rBufferSize) {  // Add size check
                memcpy(dataN2R, message.c_str(), length);  // Removed r2nBufferSize offset
                control[5].store(length, std::memory_order_seq_cst);
                control[4].store(1, std::memory_order_seq_cst);
            }

            // Wait for specified interval
            std::this_thread::sleep_for(std::chrono::milliseconds(sendInterval));
        } else {
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
        }
    }
}

Napi::Value SetSharedBuffer(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    if (info.Length() < 3 || !info[0].IsArrayBuffer() || !info[1].IsNumber() || !info[2].IsNumber()) {
        Napi::TypeError::New(env, "Expected (ArrayBuffer, Number, Number)").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    auto sab = info[0].As<Napi::ArrayBuffer>();
    r2nBufferSize = info[1].As<Napi::Number>().Uint32Value();
    n2rBufferSize = info[2].As<Napi::Number>().Uint32Value();

    printf("r2nBufferSize: %d, n2rBufferSize: %d\n", r2nBufferSize, n2rBufferSize);

    size_t totalSize = 24 + r2nBufferSize + n2rBufferSize; // 24 bytes for control
    if (sab.ByteLength() < totalSize) {
        Napi::TypeError::New(env, "Buffer too small for specified sizes").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    sharedArrayBufferRef = Napi::Persistent(sab);
    sharedArrayBufferRef.SuppressDestruct();

    void* base = sab.Data();
    control = reinterpret_cast<std::atomic<int32_t>*>(base);
    dataR2N = reinterpret_cast<uint8_t*>((int8_t*)base + 24);
    dataN2R = dataR2N + r2nBufferSize;

    if (nativeThread) {
        shouldRun = false;
        nativeThread->join();
        delete nativeThread;
    }

    shouldRun = true;
    nativeThread = new std::thread(NativeThread);

    return env.Undefined();
}

Napi::Value Cleanup(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    shouldSendData = false;
    shouldRun = false;

    if (nativeThread) {
        nativeThread->join();
        delete nativeThread;
        nativeThread = nullptr;
    }

    if (nativeDataThread) {
        nativeDataThread->join();
        delete nativeDataThread;
        nativeDataThread = nullptr;
    }

    return env.Undefined();
}

Napi::Value StartThroughputTest(const Napi::CallbackInfo& info) {
    totalBytesProcessed.store(0, std::memory_order_seq_cst);
    totalMessagesProcessed.store(0, std::memory_order_seq_cst);
    startTime = std::chrono::high_resolution_clock::now();
    return info.Env().Undefined();
}

Napi::Value GetThroughputStats(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    auto now = std::chrono::high_resolution_clock::now();
    double seconds = std::chrono::duration<double>(now - startTime).count();
    
    uint64_t bytes = totalBytesProcessed.load(std::memory_order_seq_cst);
    uint64_t messages = totalMessagesProcessed.load(std::memory_order_seq_cst);
    
    Napi::Object stats = Napi::Object::New(env);
    stats.Set("bytesPerSecond", Napi::Number::New(env, static_cast<double>(bytes) / seconds));
    stats.Set("messagesPerSecond", Napi::Number::New(env, static_cast<double>(messages) / seconds));
    stats.Set("totalBytes", Napi::Number::New(env, static_cast<double>(bytes)));
    stats.Set("totalMessages", Napi::Number::New(env, static_cast<double>(messages)));
    stats.Set("seconds", Napi::Number::New(env, seconds));
    
    return stats;
}

Napi::Value StartSendingData(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    if (info.Length() > 0 && info[0].IsNumber()) {
        sendInterval = info[0].As<Napi::Number>().Uint32Value();
    }

    shouldSendData = true;
    
    // Start the sending thread if not already running
    if (!nativeDataThread) {
        nativeDataThread = new std::thread(SendDataToRenderer);
    }
    
    return env.Undefined();
}

Napi::Value StopSendingData(const Napi::CallbackInfo& info) {
    shouldSendData = false;
    return info.Env().Undefined();
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("setSharedBuffer", Napi::Function::New(env, SetSharedBuffer));
    exports.Set("cleanup", Napi::Function::New(env, Cleanup));
    exports.Set("hello", Napi::Function::New(env, Hello));
    exports.Set("startThroughputTest", Napi::Function::New(env, StartThroughputTest));
    exports.Set("getThroughputStats", Napi::Function::New(env, GetThroughputStats));
    exports.Set("startSendingData", Napi::Function::New(env, StartSendingData));
    exports.Set("stopSendingData", Napi::Function::New(env, StopSendingData));
    return exports;
}

NODE_API_MODULE(addon, Init) 