import * as path from 'path';

function getAddonPath() {
    // In development, we need to handle the path differently due to Vite's dev server
    const isDev = process.env.NODE_ENV === 'development';
    
    // if (isDev) {
    //     // When running in dev mode, we need to go up from the electron.asar
    //     return path.resolve(__dirname, '../../../../build/Release/addon');
    // } else {
    //     // In production, the path will be relative to the app root
    //     return path.resolve(__dirname, '../build/Release/addon');
    // }

    //TODO:HACK hard code addon path
    console.log(__dirname);
    return "/Users/mdm/workspace/LittleJourney/PluginRemote/ElectronSharedBuffer/build/Release/addon";
}

let addon: any;

try {
    addon = require(getAddonPath());
    // addon = window.get_nativeApi.get();
} catch (error) {
    console.error('Failed to load native addon:', error);
    // Provide mock implementations for development/testing
    addon = {
        setSharedBuffer: () => console.log('Mock: setSharedBuffer called'),
        setMessageCallback: () => console.log('Mock: setMessageCallback called'),
        startSendingData: () => console.log('Mock: startSendingData called'),
        stopSendingData: () => console.log('Mock: stopSendingData called'),
        triggerTestCallback: () => console.log('Mock: triggerTestCallback called'),
        cleanup: () => console.log('Mock: cleanup called'),
    };
}

export const nativeAddon = {
    setSharedBuffer: (
        buffer: ArrayBuffer,
        rendererToNativeSize: number,
        nativeToRendererSize: number
    ) => addon.setSharedBuffer(buffer, rendererToNativeSize, nativeToRendererSize),

    setMessageCallback: (callback: (buffer: ArrayBuffer) => void) => 
        addon.setMessageCallback(callback),

    startSendingData: (interval: number) => addon.startSendingData(interval),

    stopSendingData: () => addon.stopSendingData(),

    triggerTestCallback: () => addon.triggerTestCallback(),

    cleanup: () => addon.cleanup(),
}; 