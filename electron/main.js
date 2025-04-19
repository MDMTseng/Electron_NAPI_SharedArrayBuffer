import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = process.env.NODE_ENV === 'development';

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      nodeIntegration: true,
      // contextIsolation: true,
      // preload: path.join(__dirname, 'preload.js'),
      contextIsolation: false,
      devTools: true
    }
  });

  // Load the app
//   if (isDev) {
//   } else {
//     mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
//   }
  mainWindow.loadURL('http://localhost:5174');
  
  // Only open DevTools in development mode
  if (isDev) {
    mainWindow.webContents.openDevTools();
    // Suppress Autofill error
    mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
      if (message.includes('Autofill.enable')) {
        event.preventDefault();
      }
    });
  }

  ipcMain.handle('get_native_api', async (event, filePath) => {
    return require('./build/Release/addon.node');
  });
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
}); 


