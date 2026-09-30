'use strict';

const { app, BrowserWindow, clipboard, dialog, ipcMain, session, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { execFile, spawn } = require('node:child_process');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const IPC = {
  REQUEST_REFRESH: 'hardware:request-refresh',
  DATA_UPDATED: 'hardware-data-updated',
  SCAN_STATE: 'hardware-scan-state',
  OPEN_DEVICE_MANAGER: 'system:open-device-manager',
  COPY_TEXT: 'system:copy-text',
  SYSTEM_INFO: 'system:info',
  RELAUNCH_AS_ADMIN: 'system:relaunch-as-admin',
  DEVICE_ACTION: 'device:action',
  DEVICE_PROPERTIES: 'device:properties',
  DEVICE_PROPERTIES_WINDOW: 'device:properties-window',
  SCAN_HARDWARE_CHANGES: 'device:scan-hardware-changes',
  ADD_DRIVER: 'driver:add',
};

// Device Manager actions, mapped to pnputil verbs. All of them need administrator rights.
const DEVICE_ACTIONS = {
  enable: '/enable-device',
  disable: '/disable-device',
  restart: '/restart-device',
  uninstall: '/remove-device',
};

const SYSTEM32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
const PNPUTIL = path.join(SYSTEM32, 'pnputil.exe');
const ERROR_SUCCESS_REBOOT_REQUIRED = 3010;

const PNP_DEBOUNCE_MS = 750; // collapse bursts (a hub unplug fires one event per child)
const PNP_SETTLE_MS = 3000; // second pass once drivers have finished binding (COM ports appear late)
const SCAN_TIMEOUT_MS = 60_000;
const WATCHER_MAX_RESTARTS = 5;

const SCAN_SCRIPT = fs.readFileSync(path.join(__dirname, 'scripts', 'scan-devices.ps1'), 'utf8');
const WATCH_SCRIPT = fs.readFileSync(path.join(__dirname, 'scripts', 'watch-pnp.ps1'), 'utf8');
const PROPERTIES_SCRIPT = fs.readFileSync(path.join(__dirname, 'scripts', 'device-properties.ps1'), 'utf8');

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let mainWindow = null;
let watchers = [];
let scanning = false;
let rescanQueued = false;
let lastPayload = null;
let debounceTimer = null;
let settleTimer = null;
let quitting = false;
let isAdmin = false;

// ---------------------------------------------------------------------------
// PowerShell helpers
// ---------------------------------------------------------------------------

function powerShellArgs(script) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded];
}

// Command lines are limited to ~32K characters, which the scan script outgrows once encoded, so
// longer scripts are streamed over stdin to this small loader and run in memory (no temp files).
const STDIN_LOADER = powerShellArgs(
  '$s = [IO.StreamReader]::new([Console]::OpenStandardInput(), [Text.Encoding]::UTF8).ReadToEnd(); & ([ScriptBlock]::Create($s))',
);

/** Runs a script. Values the script needs go through `env`, never into the script text. */
function runPowerShell(script, env = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'powershell.exe',
      STDIN_LOADER,
      {
        windowsHide: true,
        timeout: SCAN_TIMEOUT_MS,
        maxBuffer: 64 * 1024 * 1024,
        encoding: 'utf8',
        env: { ...process.env, ...env },
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = (stderr || '').replace(/#< CLIXML[\s\S]*$/, '').trim().split(/\r?\n/).slice(0, 3).join(' ');
          reject(new Error(error.killed ? 'PowerShell timed out' : `PowerShell failed: ${detail || error.message}`));
          return;
        }
        resolve(stdout);
      },
    );
    child.stdin.on('error', () => {}); // surfaced through the exit callback instead
    child.stdin.end(script, 'utf8');
  });
}

function parseJsonArray(stdout, what) {
  const text = stdout.replace(/^﻿/, '').trim();
  if (!text) return [];
  try {
    return asArray(JSON.parse(text));
  } catch {
    throw new Error(`${what} returned malformed JSON`);
  }
}

/** Runs pnputil and resolves with its output; exit code 3010 means "done, restart required". */
function runPnputil(args) {
  return new Promise((resolve, reject) => {
    execFile(PNPUTIL, args, { windowsHide: true, timeout: 120_000, encoding: 'utf8' }, (error, stdout, stderr) => {
      const output = `${stdout || ''}${stderr || ''}`.trim();
      const code = error ? error.code : 0;
      if (code === 0 || code === ERROR_SUCCESS_REBOOT_REQUIRED) {
        resolve({ output, rebootRequired: code === ERROR_SUCCESS_REBOOT_REQUIRED || /reboot|restart/i.test(output) });
        return;
      }
      const lines = output.split(/\r?\n/).filter((l) => l.trim() && !/^Microsoft PnP Utility/i.test(l));
      reject(new Error(lines.slice(-2).join(' ') || `pnputil failed (exit code ${code})`));
    });
  });
}

/** `net session` only succeeds for an elevated administrator. */
function detectAdmin() {
  return new Promise((resolve) => {
    execFile(path.join(SYSTEM32, 'net.exe'), ['session'], { windowsHide: true, timeout: 10_000 }, (error) => resolve(!error));
  });
}

// ---------------------------------------------------------------------------
// Hardware discovery
// ---------------------------------------------------------------------------

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

const str = (value) => (typeof value === 'string' ? value : '');

function normalizeDevice(raw) {
  return {
    Name: str(raw.Name) || String(raw.DeviceID),
    DeviceID: String(raw.DeviceID),
    Manufacturer: str(raw.Manufacturer),
    Present: raw.Present === true,
    Status: str(raw.Status) || 'Unknown',
    ProblemCode: Number.isInteger(raw.ProblemCode) ? raw.ProblemCode : 0,
    Class: str(raw.Class),
    ClassTitle: str(raw.ClassTitle),
    Enumerator: str(raw.Enumerator),
    HardwareId: str(raw.HardwareId),
    BusDescription: str(raw.BusDescription),
    DriverVersion: str(raw.DriverVersion),
    DriverProvider: str(raw.DriverProvider),
    DriverDate: str(raw.DriverDate),
    LocationPaths: asArray(raw.LocationPaths).filter((p) => typeof p === 'string' && p.length > 0),
    LocationInfo: str(raw.LocationInfo),
    Parent: str(raw.Parent),
    MonitorModel: str(raw.MonitorModel),
    VideoOutput: Number.isFinite(raw.VideoOutput) ? raw.VideoOutput : null,
  };
}

function normalizePort(raw) {
  const int = (v) => (Number.isInteger(v) ? v : 0);
  return {
    Hub: String(raw.Hub),
    Port: int(raw.Port),
    Connectable: raw.Connectable === true,
    TypeC: raw.TypeC === true,
    Usb2: raw.Usb2 === true,
    Usb3: raw.Usb3 === true,
    CompanionPort: int(raw.CompanionPort),
    CompanionHub: str(raw.CompanionHub),
    Connected: raw.Connected === true,
    Speed: int(raw.Speed),
  };
}

async function discoverHardware() {
  const stdout = await runPowerShell(SCAN_SCRIPT);
  const text = stdout.replace(/^﻿/, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Hardware scan returned malformed JSON');
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('Hardware scan returned no data');

  return {
    devices: asArray(parsed.Devices).filter((d) => d && typeof d === 'object' && d.DeviceID).map(normalizeDevice),
    ports: asArray(parsed.Ports).filter((p) => p && typeof p === 'object' && p.Hub && p.Port > 0).map(normalizePort),
  };
}

// ---------------------------------------------------------------------------
// Scan scheduling & IPC push
// ---------------------------------------------------------------------------

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function watcherLabel() {
  return watchers.length ? watchers.map((w) => w.name).join(' + ') : 'none';
}

function requestScan(reason) {
  if (scanning) {
    rescanQueued = true;
    return;
  }
  scanning = true;
  send(IPC.SCAN_STATE, { scanning: true, reason });

  const startedAt = Date.now();
  discoverHardware()
    .then(({ devices, ports }) => {
      lastPayload = {
        devices,
        ports,
        error: null,
        reason,
        scannedAt: Date.now(),
        durationMs: Date.now() - startedAt,
        watcher: watcherLabel(),
      };
      send(IPC.DATA_UPDATED, lastPayload);
    })
    .catch((err) => {
      console.error('[porter] scan failed:', err);
      send(IPC.DATA_UPDATED, {
        devices: null,
        ports: null,
        error: err.message,
        reason,
        scannedAt: Date.now(),
        durationMs: Date.now() - startedAt,
        watcher: watcherLabel(),
      });
    })
    .finally(() => {
      scanning = false;
      send(IPC.SCAN_STATE, { scanning: false, reason });
      if (rescanQueued && !quitting) {
        rescanQueued = false;
        requestScan('queued');
      }
    });
}

function onPnpEvent(kind) {
  if (quitting) return;
  clearTimeout(debounceTimer);
  clearTimeout(settleTimer);
  debounceTimer = setTimeout(() => requestScan(`pnp-${kind}`), PNP_DEBOUNCE_MS);
  settleTimer = setTimeout(() => requestScan('pnp-settle'), PNP_SETTLE_MS);
}

// ---------------------------------------------------------------------------
// Plug-and-Play watchers
//
// usb-detection reacts to USB changes instantly. The WMI watcher also catches everything else
// (monitors, Bluetooth, PCIe, ...). Both feed the same debounce, so duplicate events are free.
// ---------------------------------------------------------------------------

function startUsbDetection() {
  let usbDetect;
  try {
    usbDetect = require('usb-detection');
  } catch (err) {
    console.warn('[porter] usb-detection unavailable (WMI events will still work):', err.message);
    return null;
  }

  try {
    usbDetect.startMonitoring();
  } catch (err) {
    console.warn('[porter] usb-detection failed to start (WMI events will still work):', err.message);
    return null;
  }

  usbDetect.on('add', () => onPnpEvent('add'));
  usbDetect.on('remove', () => onPnpEvent('remove'));

  return {
    name: 'usb-detection',
    stop() {
      try {
        usbDetect.stopMonitoring();
      } catch {
        // already stopped
      }
    },
  };
}

function startWmiWatcher() {
  let child = null;
  let restarts = 0;
  let stopped = false;

  const launch = () => {
    child = spawn('powershell.exe', powerShellArgs(WATCH_SCRIPT), {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PORTER_PARENT_PID: String(process.pid) },
    });

    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      if (line.startsWith('ready')) restarts = 0;
      else if (line.startsWith('change')) onPnpEvent('wmi');
    });
    child.stderr.on('data', (chunk) => console.warn('[porter] WMI watcher:', chunk.toString().trim()));

    child.on('exit', (code) => {
      child = null;
      if (stopped || quitting) return;
      if (restarts >= WATCHER_MAX_RESTARTS) {
        console.error(`[porter] WMI watcher exited (code ${code}); giving up after ${restarts} restarts`);
        watchers = watchers.filter((w) => w.name !== 'WMI');
        return;
      }
      restarts += 1;
      setTimeout(() => !stopped && !quitting && launch(), 2000 * restarts);
    });
  };

  launch();

  return {
    name: 'WMI',
    stop() {
      stopped = true;
      if (child) child.kill();
    },
  };
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function isTrustedSender(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents) return false;
  try {
    return new URL(event.senderFrame.url).protocol === 'file:';
  } catch {
    return false;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    backgroundColor: '#0f172a',
    autoHideMenuBar: true,
    title: 'Porter',
    // Packaged builds take the icon from the .exe; when running from source use build/icon.png.
    ...(app.isPackaged ? {} : { icon: path.join(__dirname, 'build', 'icon.png') }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

ipcMain.handle(IPC.REQUEST_REFRESH, (event) => {
  if (!isTrustedSender(event)) throw new Error('Untrusted IPC sender');
  // Hand back whatever we already have so a reloaded renderer paints instantly.
  if (lastPayload) send(IPC.DATA_UPDATED, lastPayload);
  requestScan('manual');
  return { accepted: true };
});

ipcMain.handle(IPC.OPEN_DEVICE_MANAGER, async (event) => {
  if (!isTrustedSender(event)) throw new Error('Untrusted IPC sender');
  const devmgmt = path.join(SYSTEM32, 'devmgmt.msc');
  const error = await shell.openPath(devmgmt);
  if (error) throw new Error(error);
  return { opened: true };
});

ipcMain.handle(IPC.COPY_TEXT, (event, text) => {
  if (!isTrustedSender(event)) throw new Error('Untrusted IPC sender');
  if (typeof text !== 'string' || text.length > 10_000) throw new Error('Invalid clipboard text');
  clipboard.writeText(text);
  return { copied: true };
});

// ---- Device Manager controls ----------------------------------------------

const adminCheck = detectAdmin().then((admin) => (isAdmin = admin));

function requireAdmin() {
  if (!isAdmin) throw new Error('Administrator rights required — use "Run as administrator"');
}

/** Only act on instance IDs that came from our own last scan. */
function knownDeviceId(id) {
  if (typeof id !== 'string' || !id || id.length > 512 || /[\0\r\n"]/.test(id)) return null;
  const upper = id.toUpperCase();
  const match = lastPayload && lastPayload.devices && lastPayload.devices.find((d) => d.DeviceID.toUpperCase() === upper);
  return match ? match.DeviceID : null;
}

function requireKnownDevice(id) {
  const deviceId = knownDeviceId(id);
  if (!deviceId) throw new Error('Unknown device — rescan and try again');
  return deviceId;
}

ipcMain.handle(IPC.SYSTEM_INFO, async (event) => {
  if (!isTrustedSender(event)) throw new Error('Untrusted IPC sender');
  return { admin: await adminCheck };
});

ipcMain.handle(IPC.RELAUNCH_AS_ADMIN, async (event) => {
  if (!isTrustedSender(event)) throw new Error('Untrusted IPC sender');
  if (await adminCheck) return { relaunching: false };

  // When run from source (`npm start`) Electron needs the app folder; a packaged build doesn't.
  const appArgs = app.isPackaged ? '' : `"${app.getAppPath().replace(/"/g, '')}"`;
  const script = [
    '$ErrorActionPreference = "Stop"',
    'if ($env:PORTER_ARGS) { Start-Process -FilePath $env:PORTER_EXE -ArgumentList $env:PORTER_ARGS -Verb RunAs }',
    'else { Start-Process -FilePath $env:PORTER_EXE -Verb RunAs }',
  ].join('\n');

  // Let the elevated copy take the single-instance lock.
  app.releaseSingleInstanceLock();
  try {
    // The portable build runs from a temporary copy that is deleted on exit; relaunch the real .exe.
    const exe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
    await runPowerShell(script, { PORTER_EXE: exe, PORTER_ARGS: appArgs });
  } catch (err) {
    app.requestSingleInstanceLock();
    throw new Error(/cancel/i.test(err.message) ? 'Cancelled — administrator rights were not granted' : err.message);
  }
  setImmediate(() => app.quit());
  return { relaunching: true };
});

ipcMain.handle(IPC.DEVICE_ACTION, async (event, request) => {
  if (!isTrustedSender(event)) throw new Error('Untrusted IPC sender');
  const { action, deviceId } = request || {};
  if (typeof action !== 'string' || !Object.hasOwn(DEVICE_ACTIONS, action)) throw new Error('Unknown action');
  requireAdmin();
  const id = requireKnownDevice(deviceId);

  const result = await runPnputil([DEVICE_ACTIONS[action], id]);
  requestScan(`action-${action}`);
  return result;
});

ipcMain.handle(IPC.SCAN_HARDWARE_CHANGES, async (event) => {
  if (!isTrustedSender(event)) throw new Error('Untrusted IPC sender');
  requireAdmin();
  const result = await runPnputil(['/scan-devices']);
  requestScan('hardware-changes');
  return result;
});

ipcMain.handle(IPC.ADD_DRIVER, async (event) => {
  if (!isTrustedSender(event)) throw new Error('Untrusted IPC sender');
  requireAdmin();
  const choice = await dialog.showOpenDialog(mainWindow, {
    title: 'Add a driver — choose its .inf file',
    filters: [{ name: 'Driver setup information', extensions: ['inf'] }],
    properties: ['openFile'],
  });
  if (choice.canceled || !choice.filePaths.length) return { canceled: true };

  const result = await runPnputil(['/add-driver', choice.filePaths[0], '/install']);
  requestScan('driver-added');
  return { ...result, file: path.basename(choice.filePaths[0]) };
});

ipcMain.handle(IPC.DEVICE_PROPERTIES, async (event, deviceId) => {
  if (!isTrustedSender(event)) throw new Error('Untrusted IPC sender');
  const id = requireKnownDevice(deviceId);
  const stdout = await runPowerShell(PROPERTIES_SCRIPT, { PORTER_DEVICE_ID: id });
  return parseJsonArray(stdout, 'Device properties')
    .filter((p) => p && typeof p.Key === 'string')
    .map((p) => ({ key: p.Key, type: String(p.Type || ''), value: String(p.Value ?? '') }));
});

// Windows' own Device Manager properties window (General / Driver / Details / Events tabs).
ipcMain.handle(IPC.DEVICE_PROPERTIES_WINDOW, (event, deviceId) => {
  if (!isTrustedSender(event)) throw new Error('Untrusted IPC sender');
  const id = requireKnownDevice(deviceId);
  spawn(path.join(SYSTEM32, 'rundll32.exe'), ['devmgr.dll,DeviceProperties_RunDLL', '/DeviceID', id], {
    detached: true,
    stdio: 'ignore',
  }).unref();
  return { opened: true };
});

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    app.setAppUserModelId('com.porter.app');
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));

    createWindow();
    watchers = [startUsbDetection(), startWmiWatcher()].filter(Boolean);
  });

  app.on('window-all-closed', () => app.quit());

  app.on('will-quit', () => {
    quitting = true;
    clearTimeout(debounceTimer);
    clearTimeout(settleTimer);
    for (const w of watchers) w.stop();
    watchers = [];
  });
}
