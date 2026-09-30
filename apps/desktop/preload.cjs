const { contextBridge } = require('electron');
contextBridge.exposeInMainWorld('dbildoDesktop', { platform: process.platform });
