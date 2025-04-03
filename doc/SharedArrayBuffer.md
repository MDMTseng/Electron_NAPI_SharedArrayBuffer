# SharedArrayBuffer Communication System

## Overview
This system implements a bidirectional communication channel between a Node.js native addon (C++) and a React/TypeScript frontend using SharedArrayBuffer. The communication is designed for high-performance data transfer between the native and JavaScript layers.

## Architecture

### Memory Layout
```
SharedArrayBuffer Layout:
+----------------+------------------+------------------+
|   Control (16B)|    R→N Buffer   |    N→R Buffer   |
+----------------+------------------+------------------+
```

Control Array (16 bytes total):
- [0] - R→N signal
- [1] - R→N message length
- [2] - N→R signal
- [3] - N→R message length

## Components

### 1. Native Side (C++ Addon)
- Implements a `SharedMemoryChannel` class handling native-side operations
- Features:
  - Message processing thread
  - Data sending thread with configurable interval
  - Callback mechanism to JavaScript
  - Buffer management and synchronization

### 2. JavaScript/TypeScript Side
- Implements a matching `SharedMemoryChannel` class
- Key features:
  - Message queuing system
  - Throttled queue processing
  - Bidirectional communication
  - Automatic cleanup and resource management

### 3. React Integration
- Provides UI controls for:
  - Sending messages
  - Starting/stopping message reception
  - Configuring send intervals
  - Performance testing with batch sends

## Communication Flow

### Renderer to Native
1. Messages are queued in the JavaScript layer
2. Queue processor batches messages within buffer size limits
3. Data is written to R→N buffer
4. Control signal [0] is set to 1
5. Native side processes message and resets signal

### Native to Renderer
1. Native side writes data to N→R buffer
2. Sets control signal [2] to 1
3. JavaScript side polls for signal
4. Processes message when detected
5. Resets signal after processing

## Performance Features
- Message batching
- Throttled queue processing
- Configurable check intervals
- Large buffer support (up to 500MB per direction)
- Performance monitoring and statistics

## Usage Example
```typescript
// Initialize channel
const channel = new SharedMemoryChannel(bufferSize, bufferSize);

// Send message
channel.send(messageBytes);

// Start receiving
channel.startReceiving((message) => {
  console.log('Received:', message);
});

// Cleanup
channel.cleanup();
```

## Performance Considerations
- Uses `requestAnimationFrame` and throttling for efficient queue processing
- Implements dynamic polling intervals (fast/slow) for receive operations
- Supports batch operations for high-throughput scenarios
- Includes built-in performance monitoring

## Security Notes
- SharedArrayBuffer requires specific headers for cross-origin isolation
- Proper cleanup is essential to prevent memory leaks
- Buffer size validation prevents overflow

## Error Handling
- Message size validation
- Queue overflow protection
- Automatic cleanup on component unmount
- Signal synchronization checks 