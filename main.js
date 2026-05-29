const { app, BrowserWindow, ipcMain, Tray, Menu, globalShortcut, nativeImage, screen, shell } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow;
let appTray;
let isInteractive = false; // Starts in locked/click-through mode

function getAppPaths() {
  const baseDir = __dirname;
  const dataDir = path.join(baseDir, 'data');
  const historyDir = path.join(baseDir, 'history');
  
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  if (!fs.existsSync(historyDir)) {
    fs.mkdirSync(historyDir, { recursive: true });
  }
  
  return {
    baseDir,
    tasksPath: path.join(dataDir, 'tasks.json'),
    statePath: path.join(dataDir, 'state.json'),
    historyDir
  };
}

function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  
  // Design size for HUD
  const hudWidth = 850;
  const hudHeight = 720;
  
  mainWindow = new BrowserWindow({
    width: hudWidth,
    height: hudHeight,
    x: Math.floor((width - hudWidth) / 2),
    y: Math.floor((height - hudHeight) / 2),
    transparent: true,
    frame: false,
    alwaysOnTop: false,
    minimizable: true, // Required to catch the minimize event on Win+D
    focusable: false,   // Never gains keyboard focus, keeping it behind active apps permanently
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Pin behind all other windows at all times
  mainWindow.setAlwaysOnTop(false);

  // Prevent minimization on Win + D
  mainWindow.on('minimize', (e) => {
    e.preventDefault();
    setTimeout(() => {
      if (mainWindow) {
        mainWindow.restore();
      }
    }, 250); // Larger 250ms delay to let the OS complete the Win+D sweep
  });

  // Keep HUD unfocused when locked
  mainWindow.on('focus', () => {
    if (!isInteractive) {
      mainWindow.blur();
    }
  });

  // Enable click-through initially
  mainWindow.setIgnoreMouseEvents(true, { forward: true });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function toggleInteractivity() {
  isInteractive = !isInteractive;
  
  if (isInteractive) {
    mainWindow.setIgnoreMouseEvents(false);
    mainWindow.setAlwaysOnTop(false); // Do NOT keep on top, stay behind other normal windows
    mainWindow.focus();
    if (appTray) appTray.setToolTip('Streak System HUD (Interactive)');
    mainWindow.webContents.send('interactivity-changed', true);
  } else {
    mainWindow.setIgnoreMouseEvents(true, { forward: true });
    mainWindow.setAlwaysOnTop(false); // Remain behind other normal windows
    mainWindow.blur();
    if (appTray) appTray.setToolTip('Streak System HUD (Click-Through)');
    mainWindow.webContents.send('interactivity-changed', false);
  }
}

function createTray() {
  // 16x16 Pixel Art Green Checkmark in Base64
  const trayIconBase64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAYklEQVR42mNkQAP/gZgRyBggfBKMglEwCkbBKBgF9ASMDAwM34D4PxD/h9G4NDECMxD/B2IuNPF/yHbgw2A1DFs8sIEQDbgk8ZsAsgG4JPF3gGwBLk0MgNlAzMiAhwG4DADAaQ49v0k8rwAAAABJRU5ErkJggg==';
  const icon = nativeImage.createFromDataURL(trayIconBase64);
  
  appTray = new Tray(icon);
  
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Streak System HUD', enabled: false },
    { type: 'separator' },
    { 
      label: 'Toggle Interactivity', 
      click: () => {
        toggleInteractivity();
      } 
    },
    { type: 'separator' },
    { 
      label: 'Reset Window Position', 
      click: () => {
        if (mainWindow) {
          const { width, height } = screen.getPrimaryDisplay().workAreaSize;
          const hudWidth = 850;
          const hudHeight = 720;
          mainWindow.setBounds({
            width: hudWidth,
            height: hudHeight,
            x: Math.floor((width - hudWidth) / 2),
            y: Math.floor((height - hudHeight) / 2)
          });
        }
      } 
    },
    { 
      label: 'Quit HUD', 
      click: () => {
        app.quit();
      } 
    }
  ]);
  
  appTray.setToolTip('Streak System HUD (Click-Through)');
  appTray.setContextMenu(contextMenu);
}

// IPC Handlers
ipcMain.handle('get-paths', () => {
  return getAppPaths();
});

ipcMain.handle('read-file', async (event, filePath) => {
  if (fs.existsSync(filePath)) {
    return fs.readFileSync(filePath, 'utf-8');
  }
  return null;
});

ipcMain.handle('write-file', async (event, { filePath, content }) => {
  fs.writeFileSync(filePath, content, 'utf-8');
  return true;
});

ipcMain.handle('save-history-image', async (event, { fileName, dataUrl }) => {
  const { historyDir } = getAppPaths();
  const base64Data = dataUrl.replace(/^data:image\/png;base64,/, "");
  const targetPath = path.join(historyDir, fileName);
  fs.writeFileSync(targetPath, base64Data, 'base64');
  return targetPath;
});

ipcMain.on('set-ignore-mouse-events', (event, ignore, options) => {
  // Only override if we are in locked (non-interactive) mode
  if (!isInteractive) {
    if (ignore) {
      mainWindow.setIgnoreMouseEvents(true, { forward: true });
    } else {
      mainWindow.setIgnoreMouseEvents(false);
    }
  }
});

ipcMain.on('toggle-interactivity', () => {
  toggleInteractivity();
});

ipcMain.on('app-quit', () => {
  app.quit();
});

ipcMain.on('open-external', (event, url) => {
  shell.openExternal(url);
});

// App Lifecycle
app.whenReady().then(() => {
  getAppPaths(); // Initialize directories
  createWindow();
  createTray();
  
  // Configure startup execution
  try {
    const isDev = !app.isPackaged;
    app.setLoginItemSettings({
      openAtLogin: true,
      path: app.getPath('exe'),
      args: isDev ? [path.resolve(app.getAppPath())] : []
    });
  } catch (err) {
    console.error("Failed to set login item settings:", err);
  }
  
  // Register global hotkey
  globalShortcut.register('CommandOrControl+Shift+Alt+S', () => {
    toggleInteractivity();
  });
  
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

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});
