# BPG (Binary Packet Group) Protocol Binary Format

This document describes the binary wire format used by the C++ BPG protocol implementation for communication between the application layer (e.g., Web UI) and native plugins via a Link Layer (like Shared Memory, WebSockets, etc.).

## Packet Structure

Each logical message sent over the link layer consists of one or more BPG packets concatenated together. A logical "group" of related packets is identified by a common `group_id` and is terminated by a packet with the Type ID (TL) "EG".

Each individual BPG packet follows this structure:

```
+------------------------------------+------------------------------------------+
|         Packet Header (14 bytes)   |           Packet Data (Variable)         |
+------------------------------------+------------------------------------------+
| GroupID | TargetID | TL | DataLen | JSONLen | Metadata JSON | Binary Data    |
+---------+----------+----+---------+---------+---------------+----------------+
```

## Field Descriptions

### 1. Packet Header (Fixed Size: 14 Bytes)

| Field       | Size (Bytes) | C++ Type    | Description                                     | Network Order |
|-------------|--------------|-------------|-------------------------------------------------|---------------|
| `group_id`  | 4            | `uint32_t`  | Identifier for the packet group.                | **Big Endian**  |
| `target_id` | 4            | `uint32_t`  | Identifier for the target recipient/context.    | **Big Endian**  |
| `tl`        | 2            | `char[2]`   | Two-letter ASCII packet type identifier (e.g., "IM", "TX", "EG"). | N/A (bytes)   |
| `data_length`| 4           | `uint32_t`  | Total length **in bytes** of the Packet Data section that follows this header (i.e., size of JSONLen + Metadata JSON + Binary Data). | **Big Endian**  |

### 2. Packet Data (Variable Size: `data_length` Bytes)

The format of the data section corresponds to the `HybridData` structure. It always starts with the length of the JSON metadata, followed by the JSON data (if any), and finally the raw binary data (if any).

| Field           | Size (Bytes)            | C++ Type (Origin) | Description                                     | Network Order |
|-----------------|-------------------------|-------------------|-------------------------------------------------|---------------|
| `json_length`   | 4                       | `uint32_t`        | Length **in bytes** of the Metadata JSON string that follows. Can be 0 if no metadata is present. | **Big Endian**  |
| `metadata_json` | `json_length`           | `std::string`     | Optional UTF-8 encoded JSON string providing metadata about the `binary_data`. Empty if `json_length` is 0. | N/A (bytes)   |
| `binary_bytes`  | `data_length` - 4 - `json_length` | `std::vector<uint8_t>` | The raw binary payload of the packet. Can be empty. | N/A (bytes)   |

## Example: Text Packet ("TX")

Let's say the application sends a text message "Hello" as part of Group 300 to Target 10.

*   `group_id`: 300 (0x0000012C)
*   `target_id`: 10 (0x0000000A)
*   `tl`: "TX" (0x54, 0x58)
*   `metadata_json`: "" (empty) -> `json_length` = 0 (0x00000000)
*   `binary_bytes`: "Hello" (0x48, 0x65, 0x6C, 0x6C, 0x6F) -> `binary_bytes_len` = 5
*   `data_length`: 4 (json_length field) + 0 (metadata) + 5 (binary) = 9 (0x00000009)

The resulting byte stream would be:

```
Header:
00 00 01 2C  (group_id = 300)
00 00 00 0A  (target_id = 10)
54 58        (tl = "TX")
00 00 00 09  (data_length = 9)

Data:
00 00 00 00  (json_length = 0)
48 65 6C 6C 6F (binary_bytes = "Hello")
```

Total Bytes: 14 (Header) + 9 (Data) = 23 bytes.

## Endianness Note

All multi-byte integer fields (`group_id`, `target_id`, `data_length`, `json_length`) are encoded and decoded using **Network Byte Order (Big Endian)**. Implementations on different platforms (especially Little Endian machines like x86/x64) must perform the necessary byte swapping (e.g., using `htonl`/`ntohl` in C++ or `DataView.setUint32(offset, value, false)` in JavaScript).