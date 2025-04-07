import React, { useEffect, useState, useRef, useCallback } from 'react';
import { SharedMemoryChannel } from './lib/SharedMemoryChannel';
import { nativeAddon } from './lib/nativeAddon';
// Import BPG Types needed for the App component
import { AppPacket, AppPacketGroup } from './lib/BPG_Protocol';
// Import the custom hook
import { useBPGProtocol, BPGPacketDescriptor, UseBPGProtocolOptions } from './hooks/useBPGProtocol';
import './App.css';

function App() {
    const thisRef = useRef<any>({}).current; // Using useRef for mutable values across renders
    const [messages, setMessages] = useState<string[]>([]);
    const [queueStatus, setQueueStatus] = useState('Queue: 0 messages');
    const [pluginStatus, setPluginStatus] = useState<string>('No plugin loaded');
    const [isSending, setIsSending] = useState<boolean>(false); // To disable button during request
    const [receivedImageData, setReceivedImageData] = useState<ImageData | null>(null); // State for the image data
    const canvasRef = useRef<HTMLCanvasElement>(null); // Ref for the canvas element

    const [speedTest_sendCount, setSpeedTest_sendCount] = useState<number>(1);
    const [speedTestStatus, setSpeedTestStatus] = useState<string>('Not started');

    // --- Use the Custom Hook ---
    const handleUnhandledGroup = useCallback((group: AppPacketGroup) => {
        console.log("[App] Received Unhandled Group:", group);
        setMessages(prev => [...prev, `[BPG Unhandled Group] GID:${group[0]?.group_id}, Count:${group.length}`]);
        // Add specific logic here for these groups
    }, []);

    const bpgOptions: UseBPGProtocolOptions = {
        tx_size: 500 * 1024 * 1024,
        rx_size: 500 * 1024 * 1024,
        unhandled_group: handleUnhandledGroup // Pass the callback
    };
    const { sendGroup, channel, isInitialized } = useBPGProtocol(bpgOptions);
    // --------------------------

    const [bpgTargetId, setBpgTargetId] = useState<number>(1); // Example target ID for messages sent from UI
    const bpgGroupIdRef = useRef<number>(301); // Use ref for group ID to avoid re-renders

    // --- Plugin Loading (remains in App) ---
     useEffect(() => {
         // Initialize channel is handled by the hook now
         loadPlugin(); // Load plugin on mount

         return () => {
             // Channel cleanup is handled by the hook now
         };
     }, []); // Empty dependency array ensures this runs only once on mount

    // --- Speed Test / Queue Status Update (uses channel from hook) ---
     useEffect(() => {
         if (channel) {
             // Assign the callback directly to the channel instance from the hook
             channel.onMessageQueueEmptyCallback = () => {
                thisRef.sentCounter = (thisRef.sentCounter || 0) + 1; // Increment counter
                 channel.queueUpdateThrottle.schedule(() => {
                     updateQueueStatus(channel);
                     if (channel.messageQueue.length === 0 && thisRef.startTime) { // Check if timing started
                         let now = Date.now();
                         let duration = now - thisRef.startTime;
                         let size_MB = (thisRef.totalSize || 0) / 1024 / 1024;
                         let speed = duration > 0 ? 1000 * size_MB / duration : 0;
                         let status = `SendCount:${thisRef.sentCounter} ${size_MB.toFixed(2)} MB, ${duration} ms, ${speed.toFixed(2)} MB/s`;
                         setSpeedTestStatus(status);
                         console.log(status);
                         thisRef.startTime = null; // Reset start time after completion
                         setIsSending(false); // Re-enable button
                     }
                 });
             };
         }
         // Cleanup callback when channel changes or component unmounts
         return () => {
             if (channel) {
                 channel.onMessageQueueEmptyCallback = null;
             }
         };
     }, [channel]); // Re-run if channel instance changes


    const updateQueueStatus = (currentChannel: SharedMemoryChannel) => {
        setQueueStatus(`Queue: ${currentChannel.messageQueue.length} messages`);
    };

    // Send Message using the hook's sendGroup function
    const handleSendMessage = async () => {
        const messageInput = document.getElementById('messageInput') as HTMLInputElement;
        const message = messageInput.value;
        if (!message || !sendGroup || !channel || isSending) return; // Check hook function and sending state

        setIsSending(true); // Disable button
        setSpeedTestStatus('Sending...');
        setMessages(prev => [...prev, `--- Sending Request ---`]);

        const currentGroupId = bpgGroupIdRef.current;
        bpgGroupIdRef.current++; // Increment for next use

        // Define the packet(s) to send using descriptors
        const packetsToSend: BPGPacketDescriptor[] = [
            {
                tl: "TX",
                // str: "", // Optional metadata string
                bin: new TextEncoder().encode(message)
            }
            // Add more packet descriptors here if needed for the group
        ];

        thisRef.startTime = Date.now();
        thisRef.totalSize = 0; // Reset total size for this send batch
        thisRef.sentCounter = 0;
        const sendCount = speedTest_sendCount; // Use state variable

        // Calculate expected total size *before* sending for speed test
         try {
            const { BpgEncoder } = await import('./lib/BPG_Protocol'); // Dynamically import for size calc
            const encoder = new BpgEncoder(); // Temp encoder instance
            packetsToSend.forEach(desc => {
                 const tempPacket: AppPacket = { // Construct temporary AppPacket for size calculation
                     group_id: 0, target_id: 0, tl: desc.tl, is_end_of_group: false, // temp values
                     content: { metadata_str: desc.str || "", binary_bytes: desc.bin || new Uint8Array(0) }
                 };
                 thisRef.totalSize += encoder.encodePacket(tempPacket).length;
            });
            thisRef.totalSize *= sendCount; // Multiply by number of sends
         } catch (e: any) { console.error("Error calculating size", e); }


        logRequestPackets(currentGroupId, bpgTargetId, packetsToSend, sendCount);

        try {
             // Send multiple times for speed test
             for (let i = 0; i < sendCount; i++) {
                 const isLastIteration = i === sendCount - 1;
                 const loopGroupId = currentGroupId + i; // Send unique group IDs
                 
                 // Send the request
                 const promise = sendGroup(loopGroupId, bpgTargetId, packetsToSend);

                 if (isLastIteration) {
                    // Await only the last request in the batch
                    const responsePackets = await promise;
                    logResponsePackets(loopGroupId, responsePackets);
                    console.log(responsePackets);
                    // Speed test results are now handled by onMessageQueueEmptyCallback
                 } else {
                     // Don't wait for intermediate responses in speed test, but catch errors
                     promise.catch((error: Error) => {
                         console.error(`Error sending intermediate group ${loopGroupId}:`, error);
                         setMessages(prev => [...prev, `[BPG Send Error iter ${i}] GID:${loopGroupId}, Error: ${error.message}`]);
                     });
                 }
                 // Need to manually update queue status if not waiting,
                 // though onMessageQueueEmptyCallback should eventually handle it.
                 if(channel) updateQueueStatus(channel);
             }

        } catch (error: any) {
            console.error("Error sending BPG group:", error);
            setMessages(prev => [...prev, `[BPG Send Error] GID:${currentGroupId}, Error: ${error.message || error}`]);
            setSpeedTestStatus(`Error: ${error.message || error}`);
             setIsSending(false); // Re-enable button on error
             thisRef.startTime = null; // Reset start time on error
        }
        // Note: setIsSending(false) is now primarily handled by the queue empty callback
    };

     // Helper function to log request details
     const logRequestPackets = (groupId: number, targetId: number, descriptors: BPGPacketDescriptor[], count: number) => {
         // Log only the first group if count > 1 for brevity
         const displayGroupId = count > 1 ? `${groupId}...${groupId + count - 1}` : `${groupId}`;
         setMessages(prev => [...prev, `[BPG Sent] GID:${displayGroupId} (x${count}), TID:${targetId}, TLs: ${descriptors.map(p => p.tl).join(',')}`]);
         descriptors.forEach((desc, index) => {
             let contentPreview = `Req TL:${desc.tl}, EG:${index === descriptors.length - 1 ? 'Y' : 'N'}`;
             if (desc.str) contentPreview += `, Meta: ${desc.str.substring(0, 30)}...`;
             if (desc.bin) {
                 contentPreview += `, Bin Size: ${desc.bin.length}`;
                 const hexPreview = Array.from(desc.bin.slice(0, 16)).map((b: number) => b.toString(16).padStart(2, '0')).join(' ');
                 contentPreview += ` (Hex: ${hexPreview}${desc.bin.length > 16 ? '...' : ''})`;
                 if (!desc.str && desc.bin.length < 100) {
                     try { const text = new TextDecoder().decode(desc.bin); if (/^[ -~\s]*$/.test(text)) contentPreview += ` (as text: "${text}")` } catch (e: any) { }
                 }
             }
             // Only log details for the first group if sending many
             if (count === 1) {
                 setMessages(prev => [...prev, ` > ${contentPreview}`]);
             }
         });
     };

     // Helper function to log response details
     const logResponsePackets = (originalGroupId: number, responsePackets: AppPacket[]) => {
         setMessages(prev => [...prev, `[BPG Resp Complete] GID:${originalGroupId}, Count:${responsePackets.length}`]);
         responsePackets.forEach(packet => {
             let isImagePacket = false; // Flag to check if we handled this as an image
             let contentPreview = `Resp TL:${packet.tl}, EG:${packet.is_end_of_group ? 'Y' : 'N'}, TID:${packet.target_id}`;
             if (packet.content.metadata_str) contentPreview += `, Meta: ${packet.content.metadata_str.substring(0, 30)}...`;
             if (packet.content.binary_bytes.length > 0) {
                 contentPreview += `, Bin Size: ${packet.content.binary_bytes.length}`;
                 const hexPreview = Array.from(packet.content.binary_bytes.slice(0, 16)).map((b: number) => b.toString(16).padStart(2, '0')).join(' ');
                 contentPreview += ` (Hex: ${hexPreview}${packet.content.binary_bytes.length > 16 ? '...' : ''})`;
                  if (!packet.content.metadata_str && packet.content.binary_bytes.length < 100) {
                     try { const text = new TextDecoder().decode(packet.content.binary_bytes); if (/^[ -~\s]*$/.test(text)) contentPreview += ` (as text: "${text}")` } catch (e: any) { }
                  }
             }

             // --- Handle "IM" packets ---
             if (packet.tl === 'IM' && packet.content.metadata_str && packet.content.binary_bytes.length > 0) {
                 try {
                     const metadata = JSON.parse(packet.content.metadata_str);
                     if (metadata.format === 'raw_rgba' && metadata.width > 0 && metadata.height > 0) {
                         const width = metadata.width;
                         const height = metadata.height;
                         // Ensure binary data length matches expected RGBA size
                         if (packet.content.binary_bytes.length === width * height * 4) {
                             const clampedArray = new Uint8ClampedArray(packet.content.binary_bytes);
                             const imgData = new ImageData(clampedArray, width, height);
                             setReceivedImageData(imgData); // Update state
                             contentPreview += ` (Processed as ${width}x${height} RGBA Image)`;
                             isImagePacket = true;
                         } else {
                              contentPreview += ` (IM format=raw_rgba, but size mismatch: ${packet.content.binary_bytes.length} vs expected ${width * height * 4})`;
                         }
                     } else {
                          contentPreview += ` (IM packet, but unsupported format "${metadata.format}" or invalid dimensions)`;
                     }
                 } catch (e:any) {
                     console.error("Error processing IM packet:", e);
                     contentPreview += ` (Error parsing IM metadata: ${e.message})`;
                 }
             }
             // --- End Handle "IM" packets ---

             setMessages(prev => [...prev, ` < ${contentPreview}`]);
         });
         setMessages(prev => [...prev, `--- Request Complete ---`]);
     };

    // Effect to draw the image onto the canvas when it changes
    useEffect(() => {
        if (receivedImageData && canvasRef.current) {
            const canvas = canvasRef.current;
            const ctx = canvas.getContext('2d');
            if (ctx) {
                // Resize canvas to fit image
                canvas.width = receivedImageData.width;
                canvas.height = receivedImageData.height;
                // Draw the image data
                ctx.putImageData(receivedImageData, 0, 0);
                console.log(`Drew ${receivedImageData.width}x${receivedImageData.height} image to canvas.`);
                setMessages(prev => [...prev, `[Display] Rendered ${receivedImageData.width}x${receivedImageData.height} image on canvas.`]);
            }
        }
    }, [receivedImageData]); // Dependency array ensures this runs when receivedImageData changes

    // --- Plugin Loading/Unloading (no change) ---
     const loadPlugin = () => {
         const platform = process.platform;
         const pluginExt = platform === 'win32' ? '.dll' : platform === 'darwin' ? '.dylib' : '.so';
         const pluginPrefix = platform === 'win32' ? '' : 'lib';
         const pluginPath = `${process.cwd()}/native/plugins/build/lib/${pluginPrefix}sample_plugin${pluginExt}`;
         try {
             const success = nativeAddon.loadPlugin(pluginPath);
             setPluginStatus(success ? 'Plugin loaded successfully' : 'Failed to load plugin');
             // Reset decoder state *inside the hook* if needed, or implicitly handled by channel re-init?
             // Let's assume hook handles reset on init.
         } catch (error: any) {
             setPluginStatus(`Error loading plugin: ${error.message || error}`);
         }
     };
     const unloadPlugin = () => {
        try {
            nativeAddon.unloadPlugin();
            setPluginStatus('Plugin unloaded');
        } catch (error: any) {
            setPluginStatus(`Error unloading plugin: ${error.message || error}`);
        }
    };
     const triggerNativeCallback = () => {
        nativeAddon.triggerTestCallback();
    };
    // --- End Plugin ---


    return (
        <div className="container">
            {/* Top Controls: Target ID, Send Count, Message Input, Send Button */}
             <div className="send-controls">
                 <label>Target ID:</label>
                 <select value={bpgTargetId} onChange={(e) => setBpgTargetId(Number(e.target.value))}>
                     {[1, 2, 50, 55].map(id => <option key={id} value={id}>{id}</option>)}
                 </select>
                 <label>Send Count:</label>
                 <select
                    value={speedTest_sendCount}
                    onChange={(e) => setSpeedTest_sendCount(Number(e.target.value))}
                    disabled={isSending} // Disable during send
                 >
                     {[1, 10, 100, 1000, 10000].map((count) => (
                         <option key={count} value={count}>{count}</option>
                     ))}
                 </select>
                 X
                 <input
                    type="text"
                    id="messageInput"
                    placeholder="Enter message for BPG TX packet"
                    onKeyPress={(e) => e.key === 'Enter' && handleSendMessage()}
                    disabled={isSending} // Disable during send
                 />
                 <button onClick={handleSendMessage} disabled={!isInitialized || isSending}>
                    {isSending ? 'Sending...' : 'Send BPG Group'}
                 </button>
             </div>

             {/* Status Line */}
             <div className="queue-status">{isInitialized ? queueStatus : 'Initializing...'} - {speedTestStatus}</div>

             {/* Log/Plugin Controls */}
            <div className="controls">
                <button onClick={() => setMessages([])} disabled={isSending}>Clear Log</button>
                <button onClick={triggerNativeCallback} disabled={isSending}>Trigger Native Callback</button>
            </div>
            <div className="plugin-controls">
                <button onClick={loadPlugin} disabled={isSending}>Load Plugin</button>
                <button onClick={unloadPlugin} disabled={isSending}>Unload Plugin</button>
                <span className="plugin-status">{pluginStatus}</span>
            </div>

            {/* Message Log Area */}
            <div className="message-log">
                {messages.map((message, index) => (
                    <div key={index} className="message">
                        {message}
                    </div>
                ))}
            </div>

            {/* Canvas Area */}
            <div className="canvas-container">
                <h3>Received Image</h3>
                <canvas ref={canvasRef} style={{ border: '1px solid #ccc', maxWidth: '100%' }}></canvas>
            </div>
        </div>
    );
}

export default App; 