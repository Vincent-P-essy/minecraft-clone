/**
 * Intentionally empty of privileges: the game is a plain web page and gets
 * no bridge into Node or Electron. The only thing exposed is a read-only
 * flag the page can use to tell it's running in the desktop shell.
 */
const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("desktopShell", Object.freeze({ platform: process.platform }));
