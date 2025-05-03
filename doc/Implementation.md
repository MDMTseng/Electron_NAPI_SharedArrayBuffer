# Electron NAPI SharedArrayBuffer Implementation Details

This document provides in-depth details about the implementation of the SharedArrayBuffer communication system between Electron's renderer process and native C++ code.

## Core Mechanism

The implementation uses JavaScript's `SharedArrayBuffer` feature to create a memory region accessible by both JavaScript and C++ code. This eliminates the need for serialization/deserialization and IPC overhead.

### Memory Organization

The shared memory is organized into three sections:
1. **Control Section (16 bytes)** - Four 32-bit integers that control signaling
2. **Renderer-to-Native Buffer** - Data sent from JavaScript to C++
3. **Native-to-Renderer Buffer** - Data sent from C++ to JavaScript

Access to the control section is synchronized using `Atomics` operations in JavaScript and `std::atomic` in C++.

## Native Implementation (C++)

### Key Classes

#### SharedMemoryChannel

```cpp
class SharedMemoryChannel {
public:
    SharedMemoryChannel();
    ~SharedMemoryChannel();
    
    // Initialize the channel with the shared buffer
    void initialize(Napi::ArrayBuffer& sab, size_t r2nSize, size_t n2rSize);
    
    // Send data from native to renderer
    int send_buffer(const uint8_t* data, size_t length, uint32_t wait_ms);
    
    // Request buffer for sending
    int req_available_buffer(uint32_t wait_ms, uint8_t** ret_buffer, uint32_t* ret_buffer_space);
    
    // Complete a send operation
    int send_current_buffer(uint32_t data_length);
    
    // Clean up resources
    void cleanup();
    
private:
    // Thread function for receiving from renderer
    void recvThreadFunc();
    
    // Fields
    std::atomic<bool> isChannelOperating;
    std::thread* recvThread;
    std::atomic<int32_t>* control;
    uint8_t* dataR2N;
    uint8_t* dataN2R;
    size_t r2nBufferSize;
    size_t n2rBufferSize;
    Napi::Reference<Napi::ArrayBuffer> sharedArrayBufferRef;
    std::mutex send_buffer_mutex;
};
```

The native implementation uses a dedicated thread for monitoring signals from JavaScript and processing incoming messages.

### Signal Handling

```cpp
// In recvThreadFunc
while (isChannelOperating) {
    // Check if there's a message from renderer
    if (control[0].load(std::memory_order_seq_cst) == 1) {
        // Get message length
        int32_t msgLen = control[1].load(std::memory_order_seq_cst);
        
        // Process message...
        
        // Reset signal to indicate we've processed the message
        control[0].store(0, std::memory_order_seq_cst);
    }
    
    // Sleep to prevent high CPU usage
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
}
```

### N-API Integration

The native module exposes several functions to JavaScript:

```cpp
// Set up exports
exports.Set("setSharedBuffer", Napi::Function::New(env, SetSharedBuffer));
exports.Set("setMessageCallback", Napi::Function::New(env, SetMessageCallback));
exports.Set("sendMessage", Napi::Function::New(env, SendMessage));
exports.Set("cleanup", Napi::Function::New(env, Cleanup));
```

## JavaScript Implementation

### SharedMemoryChannel Class

```typescript
export class SharedMemoryChannel {
    constructor(rendererToNativeSize = 1024, nativeToRendererSize = 1024) {
        // Initialize buffers and state
    }
    
    // Send message asynchronously (queued)
    public send(messageBytes: Uint8Array) {
        // Queue message and initiate processing
    }
    
    // Send message synchronously (with timeout)
    public async send_direct(messageBytes: Uint8Array, wait_ms: number = 1000) {
        // Send directly with timeout handling
    }
    
    // Start receiving messages from native code
    public startReceiving(callback: (message: Uint8Array) => void) {
        // Set up callback and start polling
    }
    
    // Stop receiving messages
    public stopReceiving() {
        // Stop the polling loop
    }
    
    // Clean up resources
    public cleanup() {
        // Release all resources
    }
    
    // Private methods for queue processing
    private _processSendQueue() {
        // Process the outgoing message queue
    }
    
    private _processReceiveQueue() {
        // Poll for incoming messages
    }
}
```

### Message Queue Processing

The JavaScript implementation uses a queue system to handle multiple messages:

```typescript
private _processSendQueue() {
    if (!this.sharedBuffer || !this.isProcessingQueue) return;

    if (this.messageQueue.length === 0) {
        this.isProcessingQueue = false;
        return;
    }
    
    // Check if the signal is clear
    if (Atomics.load(this.control!, 0) !== 0) {
        // Channel is busy, try again later
        setTimeout(this.binded_processSendQueue, 0);
        return;
    }
    
    // Send the next message
    this.dataR2N!.set(this.messageQueue[0], 0);
    this.control![1] = this.messageQueue[0].length;
    this.messageQueue.splice(0, 1); // remove the first message
    
    // Set signal to notify native code
    Atomics.store(this.control!, 0, 1);
    
    // Continue processing if there are more messages
    if (this.messageQueue.length > 0) {
        setTimeout(this.binded_processSendQueue, 0);
    } else {
        this.isProcessingQueue = false;
        if (this.onMessageQueueEmptyCallback) {
            this.onMessageQueueEmptyCallback();
        }
    }
}
```

### Receiving Messages

```typescript
private _processReceiveQueue() {
    if (!this.isReceiving || !this.sharedBuffer) return;
    
    // Check for message from native code
    if (Atomics.load(this.control!, 2) === 1) {
        const msgLen = this.control![3];
        
        // Extract message from shared buffer
        const message = new Uint8Array(msgLen);
        message.set(this.dataN2R!.subarray(0, msgLen));
        
        // Reset signal
        Atomics.store(this.control!, 2, 0);
        
        // Call the callback with the message
        if (this.onMessageCallback) {
            this.onMessageCallback(message);
        }
        
        // Use faster polling when actively receiving
        setTimeout(() => this._processReceiveQueue(), this.recv_fast_check_interval);
    } else {
        // Use slower polling when idle
        setTimeout(() => this._processReceiveQueue(), this.recv_slow_check_interval);
    }
}
```

## Optimizations

### Message Batching

The system supports batching multiple small messages into a single transfer:

```typescript
let packOffset = 0;
let pack_last_idx = -1;

for (let i = 0; i < this.messageQueue.length; i++) {
    if (packOffset + this.messageQueue[i].length > this.dataR2N!.length) {
        break;
    }
    this.dataR2N!.set(this.messageQueue[i], packOffset);
    packOffset += this.messageQueue[i].length;
    pack_last_idx = i;
}

this.control![1] = packOffset;
this.messageQueue.splice(0, pack_last_idx + 1);
```

### Adaptive Polling

The polling interval adapts based on activity:

```typescript
// Use faster polling when actively receiving
setTimeout(() => this._processReceiveQueue(), this.recv_fast_check_interval);

// Use slower polling when idle
setTimeout(() => this._processReceiveQueue(), this.recv_slow_check_interval);
```

## Integration with Electron

### Main Process Setup

In Electron's main process, the native addon is initialized and made available to the renderer:

```javascript
// In main.js
const nativeAddon = require('../build/Release/addon.node');

app.whenReady().then(() => {
    // Create window and load app
    const mainWindow = new BrowserWindow({
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            // Required for SharedArrayBuffer 
            contextIsolation: false,
            webSecurity: true
        }
    });
    
    // Make the addon available to the renderer process
    global.nativeAddon = nativeAddon;
});
```

### Renderer Process Integration

```typescript
// In nativeAddon.ts
import { ipcRenderer } from 'electron';

// Access the native addon from the main process
const nativeAddon = (window as any).require('../build/Release/addon.node');

export { nativeAddon };
```

## Security Considerations

### SharedArrayBuffer Requirements

SharedArrayBuffer requires specific headers for security:

```javascript
// In main.js
app.on('ready', () => {
    // Required for SharedArrayBuffer
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
        callback({
            responseHeaders: {
                ...details.responseHeaders,
                'Cross-Origin-Opener-Policy': ['same-origin'],
                'Cross-Origin-Embedder-Policy': ['require-corp']
            }
        });
    });
});
```

### Buffer Validation

All buffer operations include size validation to prevent overflows:

```cpp
if (length <= 0 || length > n2rBufferSize || data == nullptr) {
    return -1; // Error: Invalid data or length
}
```

## Error Handling

The implementation includes robust error handling:

1. **Timeouts** - Prevents deadlocks when signals aren't processed
2. **Buffer Overflow Prevention** - Checks sizes before writing
3. **Graceful Shutdown** - Proper cleanup of threads and resources
4. **Signal Validation** - Ensures consistent signal state

## Performance Tips

1. **Adjusting Buffer Sizes** - Larger buffers for high-throughput applications
2. **Batch Operations** - Multiple small messages can be combined
3. **Polling Intervals** - Balance between responsiveness and CPU usage
4. **Direct Mode** - Use `send_direct` for synchronous operations when needed 