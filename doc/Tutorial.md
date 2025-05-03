# Tutorial: Using the SharedArrayBuffer Communication System

This step-by-step tutorial shows how to use the SharedArrayBuffer communication system in your own Electron applications.

## Prerequisites

- Node.js 14+ with npm
- Electron 14+
- Basic understanding of JavaScript/TypeScript and C++

## Project Setup

1. Start with a basic Electron project structure or use this project as a template.

2. Install required dependencies:

```bash
npm install node-addon-api bindings electron
npm install --save-dev electron-builder node-gyp
```

## Step 1: Configure Your Build Environment

Create a `binding.gyp` file for native module configuration:

```json
{
  "targets": [
    {
      "target_name": "addon",
      "sources": [ 
        "native/addon.cc"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      'defines': [ 'NAPI_DISABLE_CPP_EXCEPTIONS' ]
    }
  ]
}
```

## Step 2: Implement the Native Module

Create a folder called `native` and add a file `addon.cc`:

```cpp
#include <napi.h>
#include <thread>
#include <atomic>
#include <chrono>

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

    // Thread function for receiving messages
    void recvThreadFunc() {
        while (isChannelOperating) {
            // Check if there's a message from renderer
            if (control[0].load(std::memory_order_seq_cst) == 1) {
                // Get message length
                int32_t msgLen = control[1].load(std::memory_order_seq_cst);
                
                // Process message (echo it back for this example)
                if (msgLen > 0 && msgLen <= r2nBufferSize) {
                    // Wait until N→R channel is clear
                    while (isChannelOperating && control[2].load(std::memory_order_seq_cst) != 0) {
                        std::this_thread::sleep_for(std::chrono::milliseconds(1));
                    }
                    
                    // Copy data from R→N to N→R buffer
                    std::memcpy(dataN2R, dataR2N, msgLen);
                    
                    // Set message length
                    control[3].store(msgLen, std::memory_order_seq_cst);
                    
                    // Set signal to notify renderer
                    control[2].store(1, std::memory_order_seq_cst);
                }
                
                // Reset signal
                control[0].store(0, std::memory_order_seq_cst);
            }
            
            // Sleep to prevent high CPU usage
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
        }
    }

    void cleanup() {
        // Stop thread
        isChannelOperating = false;
        
        // Wait for thread to finish
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
    }

private:
    std::atomic<bool> isChannelOperating;
    std::thread* recvThread;
    std::atomic<int32_t>* control;
    uint8_t* dataR2N;
    uint8_t* dataN2R;
    size_t r2nBufferSize;
    size_t n2rBufferSize;
    Napi::Reference<Napi::ArrayBuffer> sharedArrayBufferRef;
};

// Global channel instance
SharedMemoryChannel g_channel;

// Native addon functions
Napi::Value SetSharedBuffer(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    if (info.Length() < 3 || !info[0].IsArrayBuffer() || 
        !info[1].IsNumber() || !info[2].IsNumber()) {
        Napi::TypeError::New(env, "Wrong arguments").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    
    Napi::ArrayBuffer sab = info[0].As<Napi::ArrayBuffer>();
    size_t r2nSize = info[1].As<Napi::Number>().Uint32Value();
    size_t n2rSize = info[2].As<Napi::Number>().Uint32Value();
    
    g_channel.initialize(sab, r2nSize, n2rSize);
    
    return env.Undefined();
}

Napi::Value Cleanup(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    g_channel.cleanup();
    return env.Undefined();
}

// Initialize addon
Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("setSharedBuffer", Napi::Function::New(env, SetSharedBuffer));
    exports.Set("cleanup", Napi::Function::New(env, Cleanup));
    return exports;
}

NODE_API_MODULE(addon, Init)
```

## Step 3: Create the JavaScript Wrapper

Create a file `src/lib/SharedMemoryChannel.ts`:

```typescript
// Basic implementation of SharedMemoryChannel
export class SharedMemoryChannel {
    private RENDERER_TO_NATIVE_SIZE: number;
    private NATIVE_TO_RENDERER_SIZE: number;
    private sharedBuffer: ArrayBuffer | null;
    private control: Int32Array | null;
    private dataR2N: Uint8Array | null;
    private dataN2R: Uint8Array | null;
    private isReceiving: boolean;
    private onMessageCallback: ((data: Uint8Array) => void) | null;
    private checkInterval: number;
    private intervalId: number | null;

    constructor(rendererToNativeSize = 1024, nativeToRendererSize = 1024) {
        this.RENDERER_TO_NATIVE_SIZE = rendererToNativeSize;
        this.NATIVE_TO_RENDERER_SIZE = nativeToRendererSize;
        this.isReceiving = false;
        this.onMessageCallback = null;
        this.checkInterval = 10; // ms
        this.intervalId = null;
        this.sharedBuffer = null;
        this.control = null;
        this.dataR2N = null;
        this.dataN2R = null;
        this.initialize();
    }

    private initialize() {
        // Create shared buffer with space for both directions plus control array (16 bytes)
        this.sharedBuffer = new ArrayBuffer(16 + this.RENDERER_TO_NATIVE_SIZE + this.NATIVE_TO_RENDERER_SIZE);
        
        // Initialize the addon with the shared buffer and sizes
        const { nativeAddon } = window as any;
        nativeAddon.setSharedBuffer(this.sharedBuffer, this.RENDERER_TO_NATIVE_SIZE, this.NATIVE_TO_RENDERER_SIZE);

        // Control array (16 bytes total):
        // [0] - R→N signal
        // [1] - R→N length
        // [2] - N→R signal
        // [3] - N→R length
        this.control = new Int32Array(this.sharedBuffer, 0, 4);
        
        // Create views for the data regions
        this.dataR2N = new Uint8Array(this.sharedBuffer, 16, this.RENDERER_TO_NATIVE_SIZE);
        this.dataN2R = new Uint8Array(this.sharedBuffer, 16 + this.RENDERER_TO_NATIVE_SIZE, this.NATIVE_TO_RENDERER_SIZE);
    }

    public send(data: Uint8Array) {
        if (!this.sharedBuffer) return;
        
        if (data.length > this.RENDERER_TO_NATIVE_SIZE) {
            throw new Error(`Message too long (${data.length} > ${this.RENDERER_TO_NATIVE_SIZE})`);
        }
        
        // Wait until R→N channel is clear
        let attempts = 0;
        while (Atomics.load(this.control!, 0) !== 0) {
            if (attempts++ > 1000) {
                throw new Error('Send timeout: channel busy');
            }
            // Small delay
            void new Promise(resolve => setTimeout(resolve, 1));
        }
        
        // Copy data to shared buffer
        this.dataR2N!.set(data);
        
        // Set message length
        this.control![1] = data.length;
        
        // Set signal to notify native code
        Atomics.store(this.control!, 0, 1);
    }

    public startReceiving(callback: (data: Uint8Array) => void) {
        if (!this.sharedBuffer) return;
        
        this.onMessageCallback = callback;
        this.isReceiving = true;
        
        // Start polling for messages
        this.checkForMessages();
    }

    private checkForMessages() {
        if (!this.isReceiving) return;
        
        // Check if there's a message from native code
        if (Atomics.load(this.control!, 2) === 1) {
            // Get message length
            const length = this.control![3];
            
            // Create a copy of the message
            const message = new Uint8Array(length);
            message.set(this.dataN2R!.subarray(0, length));
            
            // Reset signal
            Atomics.store(this.control!, 2, 0);
            
            // Call the callback
            if (this.onMessageCallback) {
                this.onMessageCallback(message);
            }
        }
        
        // Continue polling
        setTimeout(() => this.checkForMessages(), this.checkInterval);
    }

    public stopReceiving() {
        this.isReceiving = false;
    }

    public cleanup() {
        this.stopReceiving();
        
        const { nativeAddon } = window as any;
        nativeAddon.cleanup();
        
        this.sharedBuffer = null;
        this.control = null;
        this.dataR2N = null;
        this.dataN2R = null;
    }
}
```

## Step 4: Set Up Electron Main Process

Create an `electron/main.js` file:

```javascript
const { app, BrowserWindow, session } = require('electron');
const path = require('path');

// Load native addon
const nativeAddon = require('../build/Release/addon.node');

function createWindow() {
  // Create browser window
  const mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false, // Required for SharedArrayBuffer
      preload: path.join(__dirname, 'preload.js')
    }
  });

  // Load app
  mainWindow.loadFile('index.html');
  
  // Make addon available to renderer
  global.nativeAddon = nativeAddon;
}

// Set headers for SharedArrayBuffer (required)
app.on('ready', () => {
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

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
```

## Step 5: Create a Preload Script

Create `electron/preload.js`:

```javascript
const { contextBridge } = require('electron');
const { nativeAddon } = global;

// Expose the native addon to the renderer process
window.nativeAddon = nativeAddon;
```

## Step 6: Create React Component for Testing

Create a React component that uses the SharedMemoryChannel:

```tsx
import React, { useEffect, useState, useRef } from 'react';
import { SharedMemoryChannel } from './lib/SharedMemoryChannel';

export function SharedBufferTest() {
  const [message, setMessage] = useState('');
  const [received, setReceived] = useState<string[]>([]);
  const [bufferSize, setBufferSize] = useState(1024);
  const channelRef = useRef<SharedMemoryChannel | null>(null);

  useEffect(() => {
    // Create channel on component mount
    const channel = new SharedMemoryChannel(bufferSize, bufferSize);
    channelRef.current = channel;

    // Start receiving messages
    channel.startReceiving((data) => {
      const decoder = new TextDecoder();
      const text = decoder.decode(data);
      setReceived(prev => [...prev, text]);
    });

    // Cleanup on unmount
    return () => {
      channel.cleanup();
    };
  }, [bufferSize]);

  const handleSend = () => {
    if (!channelRef.current) return;
    
    const encoder = new TextEncoder();
    const data = encoder.encode(message);
    
    try {
      channelRef.current.send(data);
      setMessage('');
    } catch (error) {
      console.error('Error sending message:', error);
    }
  };

  return (
    <div>
      <h2>SharedArrayBuffer Test</h2>
      
      <div>
        <label>
          Buffer Size:
          <input 
            type="number" 
            value={bufferSize} 
            onChange={(e) => setBufferSize(Number(e.target.value))}
            min="64"
            max="1048576"
          />
          bytes
        </label>
      </div>
      
      <div>
        <input
          type="text"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Enter message"
        />
        <button onClick={handleSend}>Send</button>
      </div>
      
      <div>
        <h3>Received Messages:</h3>
        <ul>
          {received.map((msg, i) => (
            <li key={i}>{msg}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}
```

## Step 7: Build and Run

1. Build the native addon:

```bash
npx node-gyp rebuild
```

2. Start the Electron app:

```bash
npm run electron:dev
```

## Advanced Usage

### Binary Protocol

For more complex applications, define a binary protocol for your messages:

```typescript
// Example binary protocol
export enum MessageType {
  TEXT = 0,
  BINARY = 1,
  COMMAND = 2
}

export class Protocol {
  static createMessage(type: MessageType, payload: Uint8Array): Uint8Array {
    // Header: 1 byte type + 4 bytes length
    const result = new Uint8Array(5 + payload.length);
    result[0] = type;
    
    // Store payload length as big-endian 32-bit integer
    const view = new DataView(result.buffer);
    view.setUint32(1, payload.length, false);
    
    // Copy payload
    result.set(payload, 5);
    
    return result;
  }
  
  static parseMessage(data: Uint8Array): { type: MessageType, payload: Uint8Array } {
    const type = data[0] as MessageType;
    
    // Read payload length as big-endian 32-bit integer
    const view = new DataView(data.buffer, data.byteOffset);
    const payloadLength = view.getUint32(1, false);
    
    // Extract payload
    const payload = data.subarray(5, 5 + payloadLength);
    
    return { type, payload };
  }
}
```

### Performance Optimization

For high-performance applications:

1. **Increase Buffer Size**: Use larger buffers for high-throughput applications.
2. **Avoid Encoding/Decoding**: Work with binary data directly when possible.
3. **Message Batching**: Combine multiple small messages for better efficiency.
4. **Optimize Polling**: Adjust polling intervals based on your application's needs.

### Error Handling

Implement robust error handling:

```typescript
try {
  channel.send(data);
} catch (error) {
  console.error('Send error:', error);
  // Implement retry logic or fallback mechanism
}

// With timeout handling
async function sendWithTimeout(data: Uint8Array, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      channel.send(data);
      resolve(true);
    } catch (error) {
      console.error('Send failed:', error);
      resolve(false);
    }
    
    // Timeout
    setTimeout(() => resolve(false), timeoutMs);
  });
}
```

## Troubleshooting

### SharedArrayBuffer Issues

If you encounter errors about SharedArrayBuffer not being available:

1. Check that the appropriate headers are set:
   - Cross-Origin-Opener-Policy: same-origin
   - Cross-Origin-Embedder-Policy: require-corp

2. Ensure contextIsolation is set to false in your BrowserWindow options.

### Build Problems

If native addon build fails:

1. Check node-gyp installation: `npm install -g node-gyp`
2. Verify C++ development tools are installed for your platform
3. Check that binding.gyp is correctly configured

## Next Steps

1. Implement a more sophisticated protocol for your specific needs
2. Add error handling and retries
3. Implement a flow control mechanism for high-throughput scenarios
4. Add encryption for sensitive data 