import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import path from 'path';
import fs from 'fs';
import http from 'http';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_DEV_PORT = 5173;

/** Parse --config=/path/to/config.json from argv (for Playwright E2E). */
function getConfigPathFromArgs() {
  for (const arg of process.argv) {
    if (arg.startsWith('--config=')) return arg.slice('--config='.length);
  }
  return null;
}

/** True if something accepts HTTP on 127.0.0.1:port (e.g. Vite dev server). */
function probeDevServer(port, timeoutMs = 500) {
  return new Promise((resolve) => {
    const req = http.get(
      `http://127.0.0.1:${port}/`,
      { timeout: timeoutMs },
      (res) => {
        res.resume();
        resolve(true);
      }
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

function defaultProdArtifactPath() {
  // Check for XAppHub_APP sibling repo first (the production app)
  const xapphub = process.env.XAPPHUB_PATH || path.join(__dirname, '..', '..', 'XAppHub_APP');
  if (fs.existsSync(path.join(xapphub, 'frontend', 'dist', 'index.html'))) {
    return xapphub;
  }
  // Fall back to this repo's own APP/dist
  return path.join(__dirname, '..', 'APP', 'dist');
}

/**
 * Ensure XAppHub dev artifacts are accessible at the paths the frontend expects:
 *   ${artifactPath}/native/addon.node
 *   ${artifactPath}/backend/libdlib.dll (or .so/.dylib)
 */
function ensureXAppHubLinks(artifactPath) {
  if (!artifactPath) return;
  const pairs = [
    [path.join(artifactPath, 'native', 'build', 'Release', 'addon.node'),
     path.join(artifactPath, 'native', 'addon.node')],
    [path.join(artifactPath, 'backend', 'build', 'Release', 'libdlib.dll'),
     path.join(artifactPath, 'backend', 'libdlib.dll')],
  ];
  for (const [src, dst] of pairs) {
    if (fs.existsSync(src) && !fs.existsSync(dst)) {
      try { fs.copyFileSync(src, dst); console.log(`Linked: ${path.basename(dst)}`); }
      catch (e) { console.warn(`Cannot link ${dst}: ${e.message}`); }
    }
  }
  // Add OpenCV to PATH if present
  const opencvBin = process.env.OPENCV_BIN || 'C:\\opencv\\opencv\\build\\x64\\vc16\\bin';
  if (fs.existsSync(opencvBin) && !(process.env.PATH || '').includes(opencvBin)) {
    process.env.PATH = opencvBin + ';' + (process.env.PATH || '');
    console.log('Added OpenCV to PATH');
  }
}

/** When set (e.g. E2E tests), always show BIOS and skip dev-server / dist auto-detect. */
function shouldForceBios() {
  return (
    process.env.ELECTRON_FORCE_BIOS === '1' ||
    process.env.XINSP_SKIP_AUTO_LAUNCH === '1'
  );
}

/**
 * Skip BIOS when dev server is up, or when a built APP/dist exists next to the framework.
 */
async function tryAutoLaunchFromEnvironment() {
  // Resolve XAppHub path for artifactPath (needed for addon + backend DLL)
  const xapphub = process.env.XAPPHUB_PATH || path.join(__dirname, '..', '..', 'XAppHub_APP');
  const xapphubExists = fs.existsSync(path.join(xapphub, 'native'));

  if (await probeDevServer(DEFAULT_DEV_PORT)) {
    if (!mainWindow) {
      // Dev mode: Vite running, point artifactPath to XAppHub root (if it exists)
      const artifactPath = xapphubExists ? xapphub : null;
      ensureXAppHubLinks(artifactPath);
      createMainWindow({
        mode: 'dev',
        devServerPort: DEFAULT_DEV_PORT,
        artifactPath,
      });
    }
    return true;
  }
  const artifact = defaultProdArtifactPath();
  const indexHtml = fs.existsSync(path.join(artifact, 'frontend', 'dist', 'index.html'))
    ? path.join(artifact, 'frontend', 'dist', 'index.html')
    : path.join(artifact, 'frontend', 'index.html');
  if (fs.existsSync(indexHtml)) {
    if (!mainWindow) {
      ensureXAppHubLinks(artifact);
      createMainWindow({
        mode: 'prod',
        artifactPath: artifact,
        devServerPort: null,
      });
    }
    return true;
  }
  return false;
}

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
  // If --config was passed, add it to the config so renderer can auto-load
  const autoConfig = getConfigPathFromArgs();
  if (autoConfig) {
    current_config.autoLoadConfig = autoConfig;
  }
  // Store config details globally
  appMode = config.mode;
  currentArtifactPath = config.artifactPath;
  // Ensure XAppHub dev artifacts are linked for the frontend
  ensureXAppHubLinks(currentArtifactPath);
  // Prod must not reuse the default 5173 from a previous dev session (would load http instead of file://).
  if (appMode === 'prod') {
    devServerPort = null;
  } else if (config.devServerPort) {
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
    // XAppHub: frontend/dist/index.html; old layout: frontend/index.html
    const distPath = path.join(currentArtifactPath, 'frontend', 'dist', 'index.html');
    const indexPath = fs.existsSync(distPath) ? distPath : path.join(currentArtifactPath, 'frontend', 'index.html');
    loadUrl = `file://${indexPath}`;
    console.log(`Loading PROD URL: ${loadUrl}`);
  }

  mainWindow.loadURL(loadUrl).catch(err => {
      console.error(`Failed to load URL ${loadUrl}:`, err);
  });

  // Send relevant config to renderer once it's ready
  mainWindow.webContents.on('did-finish-load', () => {
      const rendererConfig = {
          mode: appMode,
          artifactPath: currentArtifactPath,
      };

      // If --config was passed, tell the renderer to auto-load it
      const autoConfig = getConfigPathFromArgs();
      if (autoConfig) {
          rendererConfig.autoLoadConfig = autoConfig;
          console.log(`Auto-loading config: ${autoConfig}`);
      }
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



// --- Folder picker dialog for project save/load ---
ipcMain.handle('show-open-dialog', async (event, options) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  return dialog.showOpenDialog(win, options);
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

app.whenReady().then(async () => {
  if (shouldForceBios()) {
    createBiosWindow();
  } else {
    const auto = await tryAutoLaunchFromEnvironment();
    if (!auto) {
      createBiosWindow();
    }
  }

  app.on('activate', async function () {
    if (BrowserWindow.getAllWindows().length === 0) {
      if (!mainWindow) {
        if (shouldForceBios()) {
          createBiosWindow();
        } else {
          const ok = await tryAutoLaunchFromEnvironment();
          if (!ok) {
            createBiosWindow();
          }
        }
      }
    }
  });
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});