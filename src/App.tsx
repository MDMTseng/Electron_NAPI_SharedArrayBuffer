import { useEffect, useState, useRef } from 'react';
import { SharedMemoryChannel } from './lib/SharedMemoryChannel';
import { nativeAddon } from './lib/nativeAddon';
// Import BPG Protocol
import { 
    BpgEncoder, BpgDecoder, AppPacket, AppPacketGroup, 
    HybridData, PacketCallback, GroupCallback 
} from './lib/BPG_Protocol';
import './App.css';

function App() {
  let _this=useRef<any>({}).current;
  const [channel, setChannel] = useState<SharedMemoryChannel | null>(null);
  const [messages, setMessages] = useState<string[]>([]);
  const [queueStatus, setQueueStatus] = useState('Queue: 0 messages');
  const [pluginStatus, setPluginStatus] = useState<string>('No plugin loaded');

  const [speedTest_sendCount, setSpeedTest_sendCount] = useState<number>(1);
  const [speedTestStatus, setSpeedTestStatus] = useState<string>('Not started');

  // BPG State
  const [bpgEncoder] = useState(new BpgEncoder());
  const [bpgDecoder] = useState(new BpgDecoder());
  const [bpgTargetId, setBpgTargetId] = useState<number>(1); // Example target ID for messages sent from UI
  const [bpgGroupId, setBpgGroupId] = useState<number>(301); // Example starting group ID

  useEffect(() => {
    initializeChannel();
    loadPlugin();
   
    return () => {
      if (channel) {
        channel.cleanup();
      }
    };
  }, []);


  _this.setMessages=setMessages;
  const initializeChannel = () => {
    if (channel) {
      channel.cleanup();
    }
    let size=500*1024*1024;
    const newChannel = new SharedMemoryChannel(size, size);
    
    // Reset BPG decoder when channel is initialized
    bpgDecoder.reset(); 

    newChannel.onMessageQueueEmptyCallback = () => {
      _this.sentCounter++;
      newChannel.queueUpdateThrottle.schedule(() => {
        updateQueueStatus(newChannel);
        if(newChannel.messageQueue.length ==0) {
          let now = Date.now();
          let duration = now - _this.startTime;
          let size_MB=_this.totalSize / 1024/1024;
          let speed =1000*size_MB / duration;
          let status=`SendCount:${_this.sentCounter} ${size_MB.toFixed(2)} MB,${duration} ms,${speed.toFixed(2)} MB/s`;
          setSpeedTestStatus(status);
          console.log(status);
        }

      });
    };
    setChannel(newChannel);
    
    // Start receiving raw data and pass it to the BPG decoder
    newChannel.startReceiving((rawData: Uint8Array) => {
      try {
        bpgDecoder.processData(rawData, handleBpgPacket, handleBpgGroup);
      } catch(e) {
        console.error("Error processing BPG data:", e);
        setMessages(prev => [...prev, `[BPG Decode Error] ${e}`]);
      }
    });
  };

  const updateQueueStatus = (currentChannel: SharedMemoryChannel) => {
    setQueueStatus(`Queue: ${currentChannel.messageQueue.length} messages`);
   
  };

  // Send Message using BPG Protocol
  const queueMessage = () => {
    const messageInput = document.getElementById('messageInput') as HTMLInputElement;
    const message = messageInput.value;
    if (!message || !channel) return;
    
    const currentGroupId = bpgGroupId;
    setBpgGroupId(prev => prev + 1); 
    const packetsToSend: AppPacket[] = [];
    
    // 1. Text Packet ('TX') - This is now the only packet in this example
    const textHybrid: HybridData = {
      metadata_str: "", 
      binary_bytes: new TextEncoder().encode(message)
    };
    const textPacket: AppPacket = {
      group_id: currentGroupId,
      target_id: bpgTargetId,
      tl: "TX", 
      is_end_of_group: true, // Set EG flag on the last packet
      content: textHybrid
    };
    packetsToSend.push(textPacket);
    
    // --- Removed EG Packet --- 
    
    _this.startTime=Date.now();
    _this.totalSize = 0; // Reset total size for this send batch
    _this.sentCounter=0;
    let sendCount=speedTest_sendCount;

    try {
      for (let iter = 0; iter < sendCount; iter++) {
        // Send the packets (just the TX packet in this simple case)
        for (const packet of packetsToSend) {
          // Potentially adjust group ID per iteration if needed:
          // packet.group_id = currentGroupId + iter; 
          const encodedPacket = bpgEncoder.encodePacket(packet);
          channel.send(encodedPacket);
          _this.totalSize += encodedPacket.length;
        }
      }
      updateQueueStatus(channel);
      setMessages(prev => [...prev, `[BPG Sent] GID:${currentGroupId} x ${sendCount}, TLs: ${packetsToSend.map(p=>p.tl).join(',')}`]);
    } catch (e) {
      console.error("Error encoding/sending BPG packet:", e);
      setMessages(prev => [...prev, `[BPG Encode/Send Error] ${e}`]);
    }
  };

  // startReceiving/stopReceiving now implicitly handled by initializeChannel
  // const startReceiving = () => { ... };
  // const stopReceiving = () => { ... };

  const triggerNativeCallback = () => {
    nativeAddon.triggerTestCallback();
  };

  const loadPlugin = () => {
    // Get the plugin path based on the platform
    const platform = process.platform;
    const pluginExt = platform === 'win32' ? '.dll' : platform === 'darwin' ? '.dylib' : '.so';
    const pluginPrefix = platform === 'win32' ? '' : 'lib';
    const pluginPath = `${process.cwd()}/native/plugins/build/lib/${pluginPrefix}sample_plugin${pluginExt}`;
    
    try {
      const success = nativeAddon.loadPlugin(pluginPath);
      setPluginStatus(success ? 'Plugin loaded successfully' : 'Failed to load plugin');
      // Reset decoder state when plugin is loaded/reloaded
      bpgDecoder.reset(); 
    } catch (error) {
      setPluginStatus(`Error loading plugin: ${error}`);
    }
  };

  const unloadPlugin = () => {
    try {
      nativeAddon.unloadPlugin();
      setPluginStatus('Plugin unloaded');
    } catch (error) {
      setPluginStatus(`Error unloading plugin: ${error}`);
    }
  };

  // --- BPG Callbacks --- 
  const handleBpgPacket: PacketCallback = (packet) => {
    console.log("[BPG RX Packet]", packet);
    let contentPreview = `TL:${packet.tl}, EG:${packet.is_end_of_group ? 'Y' : 'N'}, `; // Show EG Flag
    if (packet.content.metadata_str) {
      contentPreview += `Meta: ${packet.content.metadata_str.substring(0, 50)}${packet.content.metadata_str.length > 50 ? '...' : ''}`;
    }
    if (packet.content.binary_bytes.length > 0) {
      contentPreview += `${packet.content.metadata_str ? ', ' : ''}Bin Size: ${packet.content.binary_bytes.length}`;
      
      // Add Hex Preview
      const maxHexBytes = 64;
      const hexPreview = Array.from(packet.content.binary_bytes.slice(0, maxHexBytes))
          .map(byte => byte.toString(16).padStart(2, '0'))
          .join(' ');
      contentPreview += ` (Hex: ${hexPreview}${packet.content.binary_bytes.length > maxHexBytes ? '...' : ''})`;

      // Try decoding binary as text if metadata is empty (heuristic)
      if (!packet.content.metadata_str && packet.content.binary_bytes.length < 100) {
        try {
          const text = new TextDecoder().decode(packet.content.binary_bytes);
          if (/^[ -~\s]*$/.test(text)) {
            contentPreview += ` (as text: "${text}")`;
          }
        } catch (e) { /* ignore decoding error */ }
      }
    }
    setMessages(prev => [...prev, `[BPG Packet] GID:${packet.group_id}, ${contentPreview}`]);
  };

  const handleBpgGroup: GroupCallback = (groupId, group) => {
    console.log("[BPG RX Group]", groupId, group);
    setMessages(prev => [...prev, `[BPG Group Complete] GID:${groupId}, Count:${group.length}`]);
    // TODO: Add logic to process the fully assembled group
  };
  // ---------------------

  return (
    <div className="container">
      <div className="send-controls">
        <label>Target ID:</label>
        <select value={bpgTargetId} onChange={(e) => setBpgTargetId(Number(e.target.value))}>
          {[1, 2, 50, 55].map(id => <option key={id} value={id}>{id}</option>)}
        </select>
        <select
          value={speedTest_sendCount}
          onChange={(e) => setSpeedTest_sendCount(Number(e.target.value))}
        >
          {[1, 10, 100, 1000, 10000].map((count) => (
            <option key={count} value={count}>
              {count}
            </option>
          ))}
        </select>
        X
        <input
          type="text"
          id="messageInput"
          placeholder="Enter message for BPG TX packet"
          onKeyPress={(e) => e.key === 'Enter' && queueMessage()}
        />
        <button onClick={queueMessage}>Send BPG Group</button>
      </div>
      <div className="queue-status">{queueStatus}- {speedTestStatus}</div>
      <div className="controls">
        <button onClick={() => setMessages([])}>Clear Log</button>
        <button onClick={triggerNativeCallback}>Trigger Native Callback</button>
      </div>
      <div className="plugin-controls">
        <button onClick={loadPlugin}>Load Plugin</button>
        <button onClick={unloadPlugin}>Unload Plugin</button>
        <span className="plugin-status">{pluginStatus}</span>
      </div>
      <div className="message-log">
        {messages.map((message, index) => (
          <div key={index} className="message">
            {message}
          </div>
        ))}
      </div>
    </div>
  );
}

export default App; 