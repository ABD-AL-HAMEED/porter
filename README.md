# Porter

A Windows desktop app that shows the hardware plugged into your PC — live.

- **USB topology** — an interactive diagram of every USB controller, hub, port and device, nested exactly
  like the physical connections. Updates by itself when you plug or unplug something. Empty ports show the
  last device Windows remembers there.
- **Port finder & port names** — click **Find port**, plug something into (or unplug it from) a socket, and
  Porter shows you which port that was and lets you name it ("Rear panel — top left", "Case front USB-C").
  Names belong to the physical socket (both halves of a USB 3 port), survive reboots and stay visible when
  the socket is empty. Each port shows whether it's USB 2 or USB 3, USB-C, and the speed of what's plugged in.
  Right-click any device in the tree to name the port it's in.
- **Devices** — every device Windows knows about, grouped like Device Manager (Monitors, Bluetooth, Audio,
  Disk drives, Storage controllers, Network adapters, …) in sortable, searchable tables. Shows how each
  device is connected (USB, Bluetooth, PCIe, SATA, NVMe, HDMI, DisplayPort, DVI, onboard audio …), its
  driver version and date, and any Device Manager problem codes. Monitors show their real model name.
  With **Group by device**, a device's functions are listed under the physical product they belong to — the
  "HID-compliant mouse" shows up as your *HyperX Pulsefire Core*, a headset's Bluetooth services sit under
  the headset.
- **Device Manager controls** (run as administrator) — enable, disable, restart or uninstall a device,
  remove devices Windows remembers but that are gone, *Scan for hardware changes*, install a driver from its
  `.inf` file, and open Windows' own properties window (update / roll back driver). Every device also has an
  **All properties** list (Device Manager's *Details* tab). Porter asks before anything risky and warns when
  a device is your keyboard, mouse, display, disk or a USB controller.
- **Your own names** — give any device an alias ("Bench Arduino", "Desk hub"). Aliases are saved on your
  computer and survive unplugging.
- **Export** the current table to CSV, copy device IDs, or jump to Windows Device Manager.

Everything runs locally and Porter makes no network requests. Without administrator rights it only reads
device information; changes are possible only after you restart it with **Run as administrator** (Windows
asks for permission).

## Requirements

- **Windows 10 or 11** (64-bit)
- **Node.js 22.12 or newer** (the LTS version is recommended) — this also installs **npm**

## Install and run

1. **Install Node.js.** Download the Windows installer (LTS) from <https://nodejs.org> and run it with the
   default options. Then open a *new* PowerShell window and check it worked:

   ```powershell
   node --version
   npm --version
   ```

   Both should print a version number.

2. **Download Porter.** On this GitHub page click **Code → Download ZIP** and extract it (or
   `git clone` the repository).

3. **Install the dependencies.** Open PowerShell in the extracted folder (in File Explorer, click the
   address bar, type `powershell`, press Enter) and run:

   ```powershell
   npm install
   ```

   This downloads Electron (~100 MB) and builds the styles. It takes a minute or two the first time.

4. **Start the app:**

   ```powershell
   npm start
   ```

Next time, only step 4 is needed.

## Good to know

- **Instant USB events (optional).** Porter uses the native `usb-detection` module for instant USB
  plug/unplug events. It is compiled during `npm install`, which needs the
  [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) ("Desktop
  development with C++"). Without them the install still succeeds and Porter uses Windows' own device
  events instead — the header shows which one is active (`Live · usb-detection + WMI` or `Live · WMI`).
- **npm warnings** such as "install scripts blocked" or "deprecated prebuild-install" are expected and
  harmless.
- **Administrator mode.** Click **Run as administrator** in the Devices view (or start your terminal as
  administrator before `npm start`). Device changes use Windows' built-in `pnputil`. Disabling or
  uninstalling the wrong device can disconnect your keyboard, mouse or display — use with care.
- **Aliases** are stored in `%APPDATA%\Porter`. Devices without a serial number (many hubs, mice and
  keyboards) get their Windows ID from the port they're plugged into, so their alias follows them only on
  the same port.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| `node` or `npm` is "not recognized" | Close and reopen PowerShell after installing Node.js. If it still fails, reinstall Node.js and keep "Add to PATH" ticked. |
| `node --version` prints nothing | Make sure there's no file simply called `node` or `npm` (no extension) in `C:\Windows\System32`. |
| "running scripts is disabled on this system" | Run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once, or use Command Prompt instead of PowerShell. |
| Window says "Hardware scan failed" | Click **Force Rescan** (or press F5). If it keeps failing, run `npm start` from a terminal and check the error printed there. |
| Blank window / "D3.js failed to load" | Run `npm install` again in the project folder. |

## How it works

| File | Role |
| --- | --- |
| `main.js` | Electron main process: runs the scan, listens for Plug-and-Play events, pushes results to the window. |
| `preload.js` | The small, secure API (`window.api`) the window is allowed to use. |
| `scripts/scan-devices.ps1` | Lists every device via PowerShell and the Windows Configuration Manager API (parents, location paths, drivers, monitor names). |
| `scripts/watch-pnp.ps1` | Reports device changes of any kind (monitors, Bluetooth, …). |
| `scripts/device-properties.ps1` | Reads every property of one device for the *All properties* list. |
| `index.html`, `renderer/app.js` | The window, the USB topology diagram (D3.js) and the alias editor. |
| `renderer/devices.js` | The Device Manager-style tables. |
| `tailwind.css` | Styles, compiled to `styles.css` with Tailwind CSS. |

The window runs with context isolation and the Chromium sandbox, has no Node.js access, and loads no
remote content.
