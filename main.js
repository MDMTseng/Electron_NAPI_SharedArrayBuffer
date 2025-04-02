const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

try {
  if (process.env.NODE_ENV === 'development') {
    require('electron-reloader')(module, {
      debug: true,
      watchRenderer: true
    });
  }
} catch (err) {
  console.error('Error setting up electron-reloader:', err);
}

function createWindow() {
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  win.loadFile('bios.html');

  // Handle webui:load event
  ipcMain.handle('webui:load', async (event, filePath) => {
    try {
      // Validate the file path
      if (!filePath || typeof filePath !== 'string') {
        throw new Error('Invalid file path');
      }

      // Load the file
      await win.loadFile(filePath);
      return { success: true };
    } catch (error) {
      console.error('Error loading file:', error);
      return { success: false, error: error.message };
    }
  });
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
}); 