import { useEffect, useState, useRef } from 'react';
import { SharedMemoryChannel } from './lib/SharedMemoryChannel';
import { nativeAddon } from './lib/nativeAddon';
import './App.css';

function App() {
  let _this=useRef<any>({}).current;
  const [channel, setChannel] = useState<SharedMemoryChannel | null>(null);
  const [messages, setMessages] = useState<string[]>([]);
  const [queueStatus, setQueueStatus] = useState('Queue: 0 messages');
  const [pluginStatus, setPluginStatus] = useState<string>('No plugin loaded');

  const [speedTest_sendCount, setSpeedTest_sendCount] = useState<number>(1);
  const [speedTestStatus, setSpeedTestStatus] = useState<string>('Not started');
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
    newChannel.startReceiving((rawData: Uint8Array) => {
      let decoder=new TextDecoder();
      let message=decoder.decode(rawData);
      setMessages(prev => [...prev, `Received: ${message}`]);
    });
  };

  const updateQueueStatus = (currentChannel: SharedMemoryChannel) => {
    setQueueStatus(`Queue: ${currentChannel.messageQueue.length} messages`);
   
  };

  const queueMessage = () => {
    const messageInput = document.getElementById('messageInput') as HTMLInputElement;
    const message = messageInput.value;
    if (!message || !channel) return;
    
    let encoder=new TextEncoder();
    let messageByte=encoder.encode(message);

    _this.startTime=Date.now();
    _this.sentCounter=0;
    let sendCount=speedTest_sendCount;
    for (let i = 0; i < sendCount; i++) {
      channel.send(messageByte);
    }
    _this.totalSize=sendCount*message.length;
    updateQueueStatus(channel);
  };

  const startReceiving = () => {
    if (!channel) return;

    channel.startReceiving((rawData: Uint8Array) => {
      let decoder=new TextDecoder();
      let message=decoder.decode(rawData);
      setMessages(prev => [...prev, `Received: ${message}`]);
    });
  };

  const stopReceiving = () => {
    if (!channel) return;
    channel.stopReceiving();
  };

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

  return (
    <div className="container">
      <div className="send-controls">
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
          placeholder="Enter message to send"
          onKeyPress={(e) => e.key === 'Enter' && queueMessage()}
        />
        <button onClick={queueMessage}>Send</button>
      </div>
      <div className="queue-status">{queueStatus}- {speedTestStatus}</div>
      <div className="controls">
        <button onClick={startReceiving}>Start Receiving</button>
        <button onClick={stopReceiving}>Stop Receiving</button>
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