# Electron NAPI SharedArrayBuffer

## Overview

This project demonstrates a high-performance communication channel between Electron's renderer process (JavaScript/TypeScript) and main process (Node.js) using SharedArrayBuffer. It provides a bidirectional communication mechanism that enables efficient data transfer between the native C++ and JavaScript layers without serialization overhead.

## Key Features

- **Bidirectional Communication**: Full-duplex communication between native C++ code and JavaScript
- **High Performance**: Direct memory access without serialization/deserialization overhead
- **Configurable Buffer Sizes**: Support for buffers up to 500MB per direction
- **Message Batching**: Optimized for sending multiple messages efficiently
- **Throttled Processing**: Prevents UI blocking during intensive operations
- **Automatic Resource Management**: Proper cleanup of resources when components unmount

## Architecture

### Memory Layout

```
SharedArrayBuffer Layout:
+----------------+------------------+------------------+
|   Control (16B)|    R→N Buffer   |    N→R Buffer   |
+----------------+------------------+------------------+
```

Control Array (16 bytes total):
- [0] - R→N signal (Renderer to Native)
- [1] - R→N message length
- [2] - N→R signal (Native to Renderer)
- [3] - N→R message length

### Components

1. **Native Module (C++)**
   - Implements SharedMemoryChannel in C++
   - Manages a separate processing thread
   - Provides buffer management and synchronization
   - Callback mechanism to JavaScript

2. **JavaScript/TypeScript Module**
   - Implements matching SharedMemoryChannel class
   - Message queueing and batching
   - Throttled processing to maintain UI responsiveness
   - Event-based message handling

3. **React Integration**
   - UI controls for sending messages
   - Configuration for buffer sizes and intervals
   - Real-time performance monitoring
   - Test utilities for benchmarking

## Communication Flow

### Renderer to Native
1. Messages are queued in the JavaScript layer
2. Queue processor checks for signal availability
3. When signal is clear, writes message to R→N buffer
4. Sets control signal to notify native code
5. Native code processes message and resets signal

### Native to Renderer
1. Native code writes to N→R buffer
2. Sets appropriate control signal
3. JavaScript polls for signal changes
4. Processes incoming message
5. Resets signal for next message

## Project Structure

- `/native` - C++ implementation of the native addon
  - `addon.cc` - Main NAPI module and SharedMemoryChannel implementation
  - `plugin_loader.{h,cc}` - Plugin loading utilities
  - `thread_safe_queue.h` - Thread-safe queue implementation

- `/APP` - Electron application
  - `/frontend` - React/TypeScript UI implementation
    - `/src/lib/SharedMemoryChannel.ts` - JS implementation of shared memory channel
    - `/src/lib/BPG_Protocol.ts` - Binary protocol implementation
  - `/backend` - Backend code

- `/doc` - Documentation
  - `SharedArrayBuffer.md` - Detailed technical documentation

## Performance Considerations

- Uses throttling and requestAnimationFrame for efficient queue processing
- Implements dynamic polling intervals for optimal CPU usage
- Supports large buffer sizes for high-throughput scenarios
- Message batching reduces overhead for multiple small messages

## Security Notes

- SharedArrayBuffer requires cross-origin isolation headers
- Electron context provides necessary security permissions
- Buffer size validation prevents overflow attacks
- Proper signal synchronization prevents race conditions

## Building and Running

```bash
# Install dependencies
npm install

# Run in development mode
npm run electron:dev

# Build for production
npm run electron:build

# Run the built application
npm run APP_RUN_REL
```

## Example Usage

```typescript
// Initialize channel with buffer sizes (in bytes)
const channel = new SharedMemoryChannel(1024 * 1024, 1024 * 1024);

// Send a message
const data = new Uint8Array([1, 2, 3, 4]);
channel.send(data);

// Start receiving messages
channel.startReceiving((message) => {
  console.log('Received message:', message);
});

// Clean up resources when done
channel.cleanup();
```

## Advanced Features

- **Direct Send Mode**: For synchronous sending with timeout control
- **Queue Empty Callbacks**: For chaining operations after queue processing
- **Performance Statistics**: Real-time monitoring of throughput and latency
- **Customizable Polling Intervals**: For balancing responsiveness and CPU usage

## Dependencies

- Electron: ^29.1.0
- Node.js NAPI: ^7.1.1
- React: ^18.2.0
- TypeScript: ^5.2.2 