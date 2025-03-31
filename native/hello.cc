#include <napi.h>
#include <thread>
#include <atomic>
#include <chrono>

Napi::Reference<Napi::ArrayBuffer> sharedArrayBufferRef;
std::atomic<bool> shouldRun{true};

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
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
            if (!shouldRun) return;
        }

        if (!control) continue;

        int length = control[1].load(std::memory_order_seq_cst);
        std::string msg((char*)dataR2N, (char*)dataR2N + length);
        printf("Received from Renderer: %s\n", msg.c_str());

        // Respond back
        std::string reply = "Hello from Native!";
        memcpy(dataN2R, reply.c_str(), reply.size());
        control[3].store(reply.size(), std::memory_order_seq_cst);
        control[2].store(1, std::memory_order_seq_cst);

        // Reset
        control[0].store(0, std::memory_order_seq_cst);
    }
}

std::thread* nativeThread = nullptr;

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
    
    if (nativeThread) {
        shouldRun = false;
        nativeThread->join();
        delete nativeThread;
        nativeThread = nullptr;
    }

    return env.Undefined();
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("setSharedBuffer", Napi::Function::New(env, SetSharedBuffer));
    exports.Set("cleanup", Napi::Function::New(env, Cleanup));
    exports.Set(Napi::String::New(env, "hello"),
                Napi::Function::New(env, Hello));
    return exports;
}

NODE_API_MODULE(hello, Init) 