const { app, BrowserWindow } = require('electron');
const path = require('path');
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
      
    }
  });

  // Load the app
//   if (isDev) {
//   } else {
//     mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
//   }
  mainWindow.loadURL('http://localhost:5173');
  mainWindow.webContents.openDevTools();



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


