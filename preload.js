'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  if (typeof callback !== 'function') throw new TypeError('callback must be a function');
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('api', {
  /** Ask the main process to re-scan hardware. Results arrive via onHardwareUpdate. */
  requestRefresh: () => ipcRenderer.invoke('hardware:request-refresh'),

  /**
   * Receive hardware snapshots: { devices, ports, error, reason, scannedAt, durationMs, watcher }.
   * `devices` is the flat device list and `ports` lists every port of every USB hub; both are null
   * when `error` is set. Returns an unsubscribe function.
   */
  onHardwareUpdate: (callback) => subscribe('hardware-data-updated', callback),

  /** Receive { scanning: boolean, reason } whenever a scan starts or finishes. Returns an unsubscribe function. */
  onScanStateChange: (callback) => subscribe('hardware-scan-state', callback),

  /** Open Windows Device Manager (devmgmt.msc). */
  openDeviceManager: () => ipcRenderer.invoke('system:open-device-manager'),

  /** Copy plain text to the system clipboard. */
  copyText: (text) => ipcRenderer.invoke('system:copy-text', String(text)),

  /** { admin: boolean } — whether Porter is running elevated. */
  getSystemInfo: () => ipcRenderer.invoke('system:info'),

  /** Restart Porter elevated (shows the Windows UAC prompt). Rejects if the user cancels. */
  relaunchAsAdmin: () => ipcRenderer.invoke('system:relaunch-as-admin'),

  // ---- Device Manager controls (enable/disable/restart/uninstall/scan/add driver need admin) ----

  /** action: 'enable' | 'disable' | 'restart' | 'uninstall'. Resolves { output, rebootRequired }. */
  deviceAction: (action, deviceId) => ipcRenderer.invoke('device:action', { action, deviceId }),

  /** Every property Windows stores for the device: [{ key, type, value }]. */
  getDeviceProperties: (deviceId) => ipcRenderer.invoke('device:properties', deviceId),

  /** Open Windows' own properties window for the device (Driver tab: update / roll back). */
  openPropertiesWindow: (deviceId) => ipcRenderer.invoke('device:properties-window', deviceId),

  /** Device Manager's "Scan for hardware changes". */
  scanForHardwareChanges: () => ipcRenderer.invoke('device:scan-hardware-changes'),

  /** Pick a .inf file and install it (Device Manager's "Add drivers"). */
  addDriver: () => ipcRenderer.invoke('driver:add'),
});
