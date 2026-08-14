'use strict';

const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('deepseekDesktop', {
  version: '1.0.0',
  platform: process.platform,
});
