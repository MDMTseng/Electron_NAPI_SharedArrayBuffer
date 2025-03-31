#include <napi.h>
#include <thread>
#include <atomic>
#include <chrono>

Napi::Reference<Napi::ArrayBuffer> sharedArrayBufferRef;
std::atomic<bool> shouldRun{true};
std::atomic<uint64_t> totalBytesProcessed{0};
std::atomic<uint64_t> totalMessagesProcessed{0};
std::chrono::high_resolution_clock::time_point startTime;

// Add these global variables for native-to-renderer communication
std::thread* nativeDataThread = nullptr;
bool shouldSendData = false;
uint32_t sendInterval = 1000; // milliseconds

Napi::String Hello(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  return Napi::String::New(env, "Hello from N-API! dd");
}

uint8_t* dataR2N = nullptr;
uint8_t* dataN2R = nullptr;
std::atomic<int32_t>* control = nullptr;
const size_t BUFFER_SIZE = 1024 * 1024;

void NativeThread() {
    while (shouldRun) {
        // Wait for Renderer → Native
        while (control && control[0].load(std::memory_order_seq_cst) != 1) {
            std::this_thread::sleep_for(std::chrono::microseconds(1000));
            if (!shouldRun) return;
        }

        if (!control) continue;

        int length = control[1].load(std::memory_order_seq_cst);
        totalBytesProcessed.fetch_add(length, std::memory_order_seq_cst);
        totalMessagesProcessed.fetch_add(1, std::memory_order_seq_cst);

        // Respond back
        memcpy(dataN2R, dataR2N, length);
        control[3].store(length, std::memory_order_seq_cst);
        control[2].store(1, std::memory_order_seq_cst);
        control[0].store(0, std::memory_order_seq_cst);
    }
}

std::thread* nativeThread = nullptr;

void SendDataToRenderer() {
    while (shouldRun) {
        if (shouldSendData && control && dataN2R) {
            // Wait until renderer has processed previous message
            while (control[2].load(std::memory_order_seq_cst) == 1) {
                std::this_thread::sleep_for(std::chrono::milliseconds(1));
                if (!shouldRun) return;
            }

            // Generate some test data
            std::string message = "Data from native: " + std::to_string(std::chrono::system_clock::now().time_since_epoch().count());
            size_t length = message.size();

            // Copy data to shared buffer
            memcpy(dataN2R, message.c_str(), length);
            control[3].store(length, std::memory_order_seq_cst);
            
            // Signal renderer
            control[2].store(1, std::memory_order_seq_cst);

            // Wait for specified interval
            std::this_thread::sleep_for(std::chrono::milliseconds(sendInterval));
        } else {
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
        }
    }
}

Napi::Value SetSharedBuffer(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    if (!info[0].IsArrayBuffer()) {
        Napi::TypeError::New(env, "Expected ArrayBuffer").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    auto sab = info[0].As<Napi::ArrayBuffer>();
    sharedArrayBufferRef = Napi::Persistent(sab);
    sharedArrayBufferRef.SuppressDestruct();

    void* base = sab.Data();
    control = reinterpret_cast<std::atomic<int32_t>*>(base);
    dataR2N = reinterpret_cast<uint8_t*>((int8_t*)base + 16);
    dataN2R = dataR2N + BUFFER_SIZE;

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