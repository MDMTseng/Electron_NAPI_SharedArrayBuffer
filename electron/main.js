import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Mode and path will be determined by BIOS selection
let appMode = null; // 'dev' or 'prod'
let baseArtifactPath = null; // Base path for artifacts (derived in prod, null in dev)
let devServerPort = 5173; // Default dev port, can be overridden by BIOS
let currentArtifactPath = null; // Use path from config

let mainWindow = null;
let biosWindow = null;

function createBiosWindow() {
  biosWindow = new BrowserWindow({
    width: 600,
    height: 550, // Adjusted height
    webPreferences: {
      nodeIntegration: true, 
      contextIsolation: false, 
    },
    autoHideMenuBar: true,
  });

  biosWindow.loadFile('bios.html');

  biosWindow.on('closed', () => {
    biosWindow = null;
    if (!mainWindow) {
      app.quit();
    }
  });
}


let current_config = null;
// Updated to accept config object (mode, devServerPort, artifactPath)
function createMainWindow(config) {
  console.log(`Creating main window. Config:`, config);
  if (biosWindow) {
    biosWindow.close();
  }
  
  current_config=config;
  // Store config details globally
  appMode = config.mode;
  currentArtifactPath = config.artifactPath; // Use path from config
  if (config.devServerPort) {
      devServerPort = config.devServerPort;
  }

  const isDevMode = (appMode === 'dev');

  mainWindow = new BrowserWindow({
    width: 1000,
    height: 800,
    webPreferences: {
      nodeIntegration: true, 
      contextIsolation: false, 
      devTools: true, // Always enable DevTools access
    }
  });

  let loadUrl;
  if (devServerPort && !isNaN(devServerPort)) {
    loadUrl = `http://localhost:${devServerPort}`;
    console.log(`Loading DEV URL: ${loadUrl}`);
  } else { // Production mode
    if (!currentArtifactPath) { // Check the path RECEIVED from BIOS
      console.error('ERROR: Artifact path is required in production mode!');
      app.quit();
      return;
    }
    // Construct file path URL using the user-provided artifact path
    const indexPath = path.join(currentArtifactPath, 'frontend', 'index.html');
    loadUrl = `file://${indexPath}`;
    console.log(`Loading PROD URL: ${loadUrl}`);
  }

  mainWindow.loadURL(loadUrl).catch(err => {
      console.error(`Failed to load URL ${loadUrl}:`, err);
  });

  // Send relevant config to renderer once it's ready
  mainWindow.webContents.on('did-finish-load', () => {
      // Send the artifact path received from BIOS
      const rendererConfig = { 
          mode: appMode, 
          artifactPath: currentArtifactPath // Send user-provided path (null in dev)
      };
      console.log('Main window finished loading. Sending config:', rendererConfig);
      mainWindow?.webContents.send('set-app-config', rendererConfig);
  });

  if (isDevMode) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
    if (!biosWindow) {
        app.quit();
    }
  });
}

// Listen for the signal with config object from bios.html
ipcMain.on('launch-main-app', (event, config) => {
  console.log(`Received launch request with config:`, config);
  if (!mainWindow) { 
    createMainWindow(config); // Pass the config object
  } else {
      console.warn('Main window already exists. Ignoring launch request.');
  }
});

ipcMain.on('get-current-config', (event, config) => {
  console.log('Getting current config:', current_config);
  event.reply('current-config', current_config);
  event.returnValue = current_config;
});



// --- Native addon loading (uses currentArtifactPath set from BIOS) ---
ipcMain.handle('get_native_api', async (event) => {
  let addonPath;
  if (appMode === 'dev') { 
    addonPath = path.join(__dirname, '..', 'build', 'Release', 'addon.node');
  } else if (appMode === 'prod') {
    if (!currentArtifactPath) { // Check path received from BIOS
        console.error("Cannot get native API: Artifact path not provided in production mode.");
        throw new Error("Artifact path not configured.");
    }
    // Path relative to the USER-PROVIDED artifact distribution directory
    addonPath = path.join(currentArtifactPath, 'native', 'addon.node');
  } else {
      console.error("Cannot get native API: App mode not set.");
      throw new Error("App mode not configured.");
  }
  
  console.log(`Loading native addon from: ${addonPath}`);
  try {
      const addon = require(addonPath);
      return addon;
  } catch (error) {
      console.error(`Failed to load native addon from ${addonPath}:`, error);
      throw new Error(`Failed to load native addon: ${error.message}`);
  }
});

app.whenReady().then(() => {
  createBiosWindow();

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) {
        if (!mainWindow) createBiosWindow(); 
    }
  });
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});