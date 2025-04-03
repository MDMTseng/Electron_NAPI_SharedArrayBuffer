import { Throttle } from './throttle';
import { nativeAddon } from './nativeAddon';

export class SharedMemoryChannel {
    private RENDERER_TO_NATIVE_SIZE: number;
    private NATIVE_TO_RENDERER_SIZE: number;
    private sharedBuffer: ArrayBuffer | null;
    private control: Int32Array | null;
    private dataR2N: Uint8Array | null;
    private dataN2R: Uint8Array | null;
    private isProcessingQueue: boolean;
    private isReceiving: boolean;
    private encoder: TextEncoder;
    private decoder: TextDecoder;
    private onMessageCallback: ((message: string, rawData: Uint8Array) => void) | null;
    private recv_fast_check_interval: number;
    private recv_slow_check_interval: number;
    private binded_processSendQueue: () => void;
    // Make these public so they can be accessed by the React component
    public messageQueue: Uint8Array[];
    public onMessageQueueEmptyCallback: (() => void) | null;
    public queueUpdateThrottle: Throttle;

    constructor(rendererToNativeSize = 1024, nativeToRendererSize = 1024) {
        this.RENDERER_TO_NATIVE_SIZE = rendererToNativeSize;
        this.NATIVE_TO_RENDERER_SIZE = nativeToRendererSize;
        this.messageQueue = [];
        this.isProcessingQueue = false;
        this.isReceiving = false;
        this.encoder = new TextEncoder();
        this.decoder = new TextDecoder();
        this.onMessageCallback = null;
        this.recv_fast_check_interval = 1;
        this.recv_slow_check_interval = 10;
        this.onMessageQueueEmptyCallback = null;
        this.queueUpdateThrottle = new Throttle(100);
        this.sharedBuffer = null;
        this.control = null;
        this.dataR2N = null;
        this.dataN2R = null;
        this.initialize();


        this.binded_processSendQueue=this._processSendQueue.bind(this);
    }

    private initialize() {
        // console.log(`Current path: ${require('path').resolve(__dirname, './')}`);
    
        // Create shared buffer with space for both directions plus control array (16 bytes)
        this.sharedBuffer = new ArrayBuffer(16 + this.RENDERER_TO_NATIVE_SIZE + this.NATIVE_TO_RENDERER_SIZE);
        
        // Initialize the addon with the shared buffer and sizes
        nativeAddon.setSharedBuffer(this.sharedBuffer, this.RENDERER_TO_NATIVE_SIZE, this.NATIVE_TO_RENDERER_SIZE);

        // Set up the native callback
        nativeAddon.setMessageCallback((buffer: ArrayBuffer) => {
            console.log('buffer', buffer);
        });

        // Control array layout (16 bytes total):
        // [0] - R→N signal
        // [1] - R→N length
        // [2] - N→R message signal
        // [3] - N→R message length
        this.control = new Int32Array(this.sharedBuffer, 0, 16/(32/8));
        
        // Create views for the data regions
        this.dataR2N = new Uint8Array(this.sharedBuffer, 16, this.RENDERER_TO_NATIVE_SIZE);
        this.dataN2R = new Uint8Array(this.sharedBuffer, 16 + this.RENDERER_TO_NATIVE_SIZE, this.NATIVE_TO_RENDERER_SIZE);
    }

    public send(messageBytes: Uint8Array) {
        if (!this.sharedBuffer) return;
        // const messageBytes = this.encoder.encode(message);
        
        if (messageBytes.length > this.RENDERER_TO_NATIVE_SIZE) {
            throw new Error('Message too long');
        }

        this.messageQueue.push(messageBytes);

        if (!this.isProcessingQueue) {
            this.isProcessingQueue = true;
            // requestAnimationFrame(() => this._processSendQueue());
            setTimeout(this.binded_processSendQueue,0)
        }
    }

    private _processSendQueue() {
        if (!this.sharedBuffer || !this.isProcessingQueue) return;

        if (this.messageQueue.length === 0) {
            this.isProcessingQueue = false;
            return;
        }
        if(Atomics.load(this.control!, 0) !== 0)
        {
            setTimeout(this.binded_processSendQueue,0)
        }
        {
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
            Atomics.store(this.control!, 0, 1);
            this.messageQueue.splice(0, pack_last_idx + 1);

        }

        if(this.messageQueue.length==0)
        {
            if (this.onMessageQueueEmptyCallback) {
                this.onMessageQueueEmptyCallback();
            }
            this.isProcessingQueue = false;
        }
        if (this.isProcessingQueue) {
            setTimeout(this.binded_processSendQueue,0)
        }
    }

    public startReceiving(callback: (message: string) => void) {
        if (!this.sharedBuffer) return;
        this.onMessageCallback = (message: string) => callback(message);
        this.isReceiving = true;
        this._processReceiveQueue();
    }

    public stopReceiving() {
        this.isReceiving = false;
    }

    private _processReceiveQueue() {
        if (!this.sharedBuffer || !this.isReceiving) return;
        
        if (Atomics.load(this.control!, 2) === 1) {
            const length = this.control![3];
            if (length <= this.NATIVE_TO_RENDERER_SIZE) {
                const data = this.dataN2R!.slice(0, length);
                const message = this.decoder.decode(data);
                if (this.onMessageCallback) {
                    this.onMessageCallback(message, data);
                }
            }
            Atomics.store(this.control!, 2, 0);
            if (this.isReceiving) {
                setTimeout(() => this._processReceiveQueue(), this.recv_fast_check_interval);
            }
        } else if (this.isReceiving) {
            setTimeout(() => this._processReceiveQueue(), this.recv_slow_check_interval);
        }
    }

    public cleanup() {
        this.stopReceiving();
        this.isProcessingQueue = false;
        this.messageQueue = [];
        this.onMessageCallback = null;
        if (this.queueUpdateThrottle) {
            this.queueUpdateThrottle.cancel();
        }
        nativeAddon.cleanup();
        
        this.sharedBuffer = null;
        this.control = null;
        this.dataR2N = null;
        this.dataN2R = null;
    }
} 