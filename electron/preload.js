// preload.js
const { contextBridge } = require('electron');

console.log(__dirname);
const nativeAddon = require('../build/Release/addon.node'); // adjust path as needed

contextBridge.exposeInMainWorld('get_nativeApi', {
  get: () => nativeAddon
});