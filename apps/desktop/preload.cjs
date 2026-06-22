const { contextBridge, ipcRenderer } = require("electron");

window.addEventListener("DOMContentLoaded", () => {
  document.documentElement.dataset.synchropageDesktop = "true";
});

contextBridge.exposeInMainWorld("synchropageDesktop", {
  getStorageConfig: () => ipcRenderer.invoke("synchropage:storage-config:get"),
  chooseDataDirectory: () => ipcRenderer.invoke("synchropage:storage-config:choose-data-dir"),
  resetDataDirectory: () => ipcRenderer.invoke("synchropage:storage-config:reset-data-dir"),
  restart: () => ipcRenderer.invoke("synchropage:storage-config:restart")
});
