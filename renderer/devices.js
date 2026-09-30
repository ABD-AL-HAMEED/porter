'use strict';

// ===========================================================================
// Devices view — every device Windows knows about, grouped the way Device Manager groups them,
// with filters, sorting, search, a details panel, CSV export and (as administrator) Device
// Manager's enable / disable / restart / uninstall / scan / add-driver controls.
// Uses helpers from app.js (el, aliasStore, normalizeId, friendlyName, toast, withAdmin, ...).
// ===========================================================================

const DevicesView = (() => {
  const STORAGE_KEY = 'porter.devices.v1';

  // DISPLAYCONFIG_VIDEO_OUTPUT_TECHNOLOGY, reported by WmiMonitorConnectionParams.
  const VIDEO_OUTPUTS = {
    0: 'VGA', 1: 'S-Video', 2: 'Composite', 3: 'Component', 4: 'DVI', 5: 'HDMI', 6: 'LVDS', 8: 'D-Jpn',
    9: 'SDI', 10: 'DisplayPort', 11: 'Embedded DisplayPort', 12: 'UDI', 13: 'Embedded UDI', 14: 'SDTV',
    15: 'Miracast', 16: 'Wired display', 17: 'Virtual display', 2147483648: 'Built-in panel',
  };

  // Device Manager problem codes (CM_PROB_*).
  const PROBLEMS = {
    1: 'Not configured correctly', 3: 'Driver may be corrupted', 10: 'Device cannot start',
    12: 'Not enough free resources', 14: 'Restart required', 18: 'Drivers need reinstalling',
    19: 'Registry configuration is damaged', 21: 'Being removed', 22: 'Disabled',
    24: 'Not present or not working', 28: 'No driver installed', 29: 'Disabled in firmware',
    31: 'Not working properly', 32: 'Driver service disabled', 37: 'Driver failed to initialize',
    39: 'Driver is corrupted or missing', 43: 'Stopped after reporting a problem', 45: 'Not connected',
    47: 'Prepared for safe removal', 48: 'Driver blocked', 52: 'Driver signature could not be verified',
  };
  const CM_PROB_DISABLED = 22;

  // Buses that end the walk up the parent chain as purely software / virtual.
  const VIRTUAL_BUSES = new Set(['ROOT', 'SW', 'UMB', 'HTREE', 'COMPOSITEBUS', 'VMBUS', 'SWD']);
  // Classes that are never physical hardware on their own.
  const VIRTUAL_CLASSES = new Set(['VolumeSnapshot', 'SoftwareComponent', 'SoftwareDevice', 'PrintQueue',
    'AudioProcessingObject', 'LegacyDriver', 'Volume']);
  // Software enumerators whose devices still represent real hardware further up the tree
  // (audio endpoints, portable devices, HID collections, volumes, BLE services).
  const PASS_THROUGH = [/^SWD\\MMDEVAPI\\/, /^SWD\\WPDBUSENUM\\/, /^HID\\/, /^STORAGE\\/, /^BTHLEDEVICE\\/];
  // Disabling or removing these can take away input, display, storage or the system itself.
  const CRITICAL_CLASSES = new Set(['Keyboard', 'Mouse', 'HIDClass', 'Display', 'Monitor', 'DiskDrive', 'HDC',
    'SCSIAdapter', 'System', 'Processor', 'Computer', 'USB', 'Net', 'Firmware']);

  const CONNECTION_STYLE = {
    USB: 'bg-cyan-500/10 text-cyan-300 ring-cyan-500/30',
    Bluetooth: 'bg-blue-500/10 text-blue-300 ring-blue-500/30',
    PCIe: 'bg-violet-500/10 text-violet-300 ring-violet-500/30',
    Motherboard: 'bg-indigo-500/10 text-indigo-300 ring-indigo-500/30',
    SATA: 'bg-amber-500/10 text-amber-300 ring-amber-500/30',
    NVMe: 'bg-amber-500/10 text-amber-300 ring-amber-500/30',
    'Onboard audio': 'bg-pink-500/10 text-pink-300 ring-pink-500/30',
    'HDMI / DP audio': 'bg-pink-500/10 text-pink-300 ring-pink-500/30',
    Software: 'bg-slate-700/40 text-slate-400 ring-slate-600/50',
  };
  const DISPLAY_STYLE = 'bg-emerald-500/10 text-emerald-300 ring-emerald-500/30';

  const GROUPS = [
    { id: 'all', label: 'All devices', match: () => true },
    { id: 'g:board', label: 'Motherboard & PCIe', match: (r) => r.connection === 'Motherboard' || r.connection === 'PCIe' },
    { id: 'g:display', label: 'Monitors & graphics', match: (r) => r.cls === 'Monitor' || r.cls === 'Display' },
    { id: 'g:audio', label: 'Audio', match: (r) => r.cls === 'MEDIA' || r.cls === 'AudioEndpoint' },
    { id: 'g:bluetooth', label: 'Bluetooth', match: (r) => r.cls === 'Bluetooth' || r.connection === 'Bluetooth' },
    { id: 'g:storage', label: 'Storage', match: (r) => ['DiskDrive', 'SCSIAdapter', 'HDC', 'CDROM', 'Volume'].includes(r.cls) },
    { id: 'g:network', label: 'Network', match: (r) => r.cls === 'Net' },
    { id: 'g:input', label: 'Keyboards, mice & HID', match: (r) => ['Keyboard', 'Mouse', 'HIDClass'].includes(r.cls) },
    { id: 'g:usb', label: 'USB', match: (r) => r.connection === 'USB' || r.cls === 'USB' },
  ];

  const COLUMNS = [
    { key: 'name', label: 'Device', sort: (r) => displayName(r).toLowerCase() },
    { key: 'category', label: 'Category', sort: (r) => r.category.toLowerCase(), multiOnly: true },
    { key: 'connection', label: 'Connection', sort: (r) => r.connection.toLowerCase() },
    { key: 'manufacturer', label: 'Manufacturer', sort: (r) => r.manufacturer.toLowerCase() },
    { key: 'status', label: 'Status', sort: (r) => ({ problem: 0, ok: 1, disconnected: 2 })[r.health] },
    { key: 'driver', label: 'Driver', sort: (r) => r.driverDate || '' },
  ];

  const DETAIL_DEFAULT_WIDTH = 360;
  const DETAIL_MIN_WIDTH = 280;

  const saved = loadJSON(STORAGE_KEY, {}) || {};
  const view = {
    records: new Map(),
    group: typeof saved.group === 'string' ? saved.group : 'all',
    filters: {
      groupByDevice: saved.groupByDevice !== false,
      physicalOnly: saved.physicalOnly !== false,
      includeDisconnected: saved.includeDisconnected === true,
      problemsOnly: saved.problemsOnly === true,
    },
    sort: saved.sort && COLUMNS.some((c) => c.key === saved.sort.key) ? saved.sort : { key: 'name', dir: 1 },
    expanded: new Set(Array.isArray(saved.expanded) ? saved.expanded.filter((k) => typeof k === 'string') : []),
    detailWidth: Number.isFinite(saved.detailWidth) ? saved.detailWidth : DETAIL_DEFAULT_WIDTH,
    search: '',
    selected: null,
    rows: [],
    properties: new Map(), // key -> 'loading' | [{ key, type, value }] | Error
    busy: false,
  };

  const $ = (id) => document.getElementById(id);

  function persist() {
    saveJSON(STORAGE_KEY, { group: view.group, sort: view.sort, expanded: [...view.expanded], detailWidth: view.detailWidth, ...view.filters });
  }

  // -------------------------------------------------------------------------
  // Records
  // -------------------------------------------------------------------------

  function displayName(r) {
    return aliasStore.get(r.deviceId) || r.name;
  }

  /** The socket a device — or the physical product it belongs to — is plugged into. */
  function socketOfRecord(r) {
    if (!state.portModel) return null;
    const product = r.product && r.product !== r ? r.product : null;
    return state.portModel.socketOf(r.portKey) || (product && state.portModel.socketOf(product.portKey)) || null;
  }

  const portName = (r) => portStore.get(socketOfRecord(r));

  function toRecord(raw) {
    const id = String(raw.DeviceID);
    const cls = raw.Class || '';
    const present = raw.Present === true;
    const problemCode = raw.ProblemCode || 0;
    const problem = present && (problemCode !== 0 || raw.Status === 'Error' || raw.Status === 'Degraded');
    return {
      key: normalizeId(id),
      deviceId: id,
      name: raw.MonitorModel || friendlyName(raw), // monitors: real model name instead of "Generic PnP Monitor"
      windowsName: raw.Name || id,
      manufacturer: raw.Manufacturer || '',
      present,
      status: raw.Status || 'Unknown',
      problemCode,
      disabled: problemCode === CM_PROB_DISABLED,
      health: !present ? 'disconnected' : problem ? 'problem' : 'ok',
      cls,
      category: raw.ClassTitle || cls || 'Other devices',
      enumerator: (raw.Enumerator || id.split('\\')[0] || '').toUpperCase(),
      hardwareId: raw.HardwareId || '',
      busDescription: raw.BusDescription || '',
      driverProvider: raw.DriverProvider || '',
      driverVersion: raw.DriverVersion || '',
      driverDate: raw.DriverDate || '',
      locationInfo: raw.LocationInfo || '',
      portKey: portKeyOf(raw.LocationPaths),
      parentId: normalizeId(raw.Parent),
      monitorModel: raw.MonitorModel || '',
      videoOutput: raw.VideoOutput,
      children: [],
      product: null,
      connection: '',
      virtual: false,
    };
  }

  /** The bus a device sits on directly, or null when it only makes sense via its parent. */
  function ownConnection(r) {
    const id = r.key;
    const e = r.enumerator;
    if (PASS_THROUGH.some((re) => re.test(id))) return null;
    if (e.startsWith('{') || VIRTUAL_BUSES.has(e)) return 'Software';
    if (e === 'DISPLAY') return VIDEO_OUTPUTS[r.videoOutput] || 'Display';
    if (/^(USB|USBSTOR|USBPRINT|FTDIBUS)$/.test(e)) return 'USB';
    if (e.startsWith('BTH')) return 'Bluetooth';
    if (e === 'PCI') return 'PCIe';
    if (e === 'HDAUDIO') return /VEN_(10DE|1002|8086)/.test(id) ? 'HDMI / DP audio' : 'Onboard audio';
    if (e === 'SCSI' || e === 'NVME' || e === 'IDE') return /NVME/.test(id + r.hardwareId.toUpperCase()) ? 'NVMe' : 'SATA';
    if (e === 'ACPI' || e === 'ACPI_HAL' || e === 'UEFI') return 'Motherboard';
    return null;
  }

  /**
   * The physical product a device belongs to: the whole USB device (not one of its interfaces) or
   * the Bluetooth device. "HID-compliant mouse" → "HyperX Pulsefire Core". Null for devices that
   * aren't part of a pluggable product (chipset, PCIe cards, ...).
   */
  function findProduct(r, records, bluetoothByAddress) {
    const seen = new Set();
    for (let n = r; n && !seen.has(n); n = records.get(n.parentId)) {
      seen.add(n);
      const id = n.key;
      if (/^BTH(ENUM|LE)\\DEV_/.test(id)) return n;
      // Classic Bluetooth services (A2DP, HID, ...) hang off the radio, not the device; their
      // instance ID carries the device's address: ...&E8EECCE173E2_C00000000
      const address = id.startsWith('BTHENUM\\') && /&([0-9A-F]{12})_C[0-9A-F]+$/.exec(id);
      if (address) return bluetoothByAddress.get(address[1]) || null;
      if (id.startsWith('BTH\\')) return null; // reached the Bluetooth radio's enumerator
      if (/^USB\\VID_[0-9A-F]{4}&PID_[0-9A-F]{4}\\/.test(id)) return n;
      if (/^(USB\\ROOT_HUB|PCI\\|ACPI\\|ROOT\\)/.test(id)) return null;
    }
    return null;
  }

  function buildRecords(rawDevices) {
    const records = new Map();
    for (const raw of rawDevices) {
      const r = toRecord(raw);
      if (!records.has(r.key)) records.set(r.key, r);
    }
    const bluetoothByAddress = new Map();
    for (const r of records.values()) {
      const parent = records.get(r.parentId);
      if (parent && parent !== r) parent.children.push(r);
      const bt = /^BTH(?:ENUM|LE)\\DEV_([0-9A-F]{12})/.exec(r.key);
      if (bt) bluetoothByAddress.set(bt[1], r);
    }

    // Walk up the parent chain until something reports a real bus. A SCSI disk behind a USB
    // bridge (UASP) is still a USB device.
    const resolve = (r) => {
      let own = null;
      const seen = new Set();
      for (let n = r; n && !seen.has(n); n = records.get(n.parentId)) {
        seen.add(n);
        const c = ownConnection(n);
        if (c === 'SATA' && own === null) { own = c; continue; }
        if (c === 'USB' && own === 'SATA') return 'USB';
        if (c && own === 'SATA') return own;
        if (c) return c;
      }
      return own || 'Other';
    };

    for (const r of records.values()) {
      r.connection = resolve(r);
      r.virtual = r.connection === 'Software' || VIRTUAL_CLASSES.has(r.cls);
      r.product = findProduct(r, records, bluetoothByAddress);
    }
    for (const r of records.values()) r.children.sort((a, b) => displayName(a).localeCompare(displayName(b)));
    return records;
  }

  const productOf = (r) => (r.product && r.product !== r ? r.product : null);

  // -------------------------------------------------------------------------
  // Filtering & grouping
  // -------------------------------------------------------------------------

  function passesFilters(r) {
    const f = view.filters;
    if (f.physicalOnly && r.virtual) return false;
    if (!f.includeDisconnected && !r.present) return false;
    if (f.problemsOnly && r.health !== 'problem') return false;
    if (view.search) {
      const product = productOf(r);
      const hay = [displayName(r), r.windowsName, r.manufacturer, r.category, r.connection, r.deviceId,
        r.hardwareId, r.driverProvider, r.busDescription, product ? displayName(product) : '', portName(r)].join(' ').toLowerCase();
      if (!view.search.split(/\s+/).every((token) => hay.includes(token))) return false;
    }
    return true;
  }

  function currentGroup() {
    if (view.group.startsWith('c:')) {
      const title = view.group.slice(2);
      return { id: view.group, label: title, match: (r) => r.category === title, single: true };
    }
    return GROUPS.find((g) => g.id === view.group) || GROUPS[0];
  }

  /**
   * Turns the matching devices into table items. With "Group by device" on, functions that belong
   * to the same physical product are collected under it:
   *   - a product with one matching function becomes one row named after the product
   *   - a product with several becomes an expandable group
   */
  function buildItems(rows) {
    if (!view.filters.groupByDevice) return rows.map((r) => ({ key: r.key, header: r, product: null, members: [] }));
    const items = new Map();
    for (const r of rows) {
      const product = productOf(r);
      const key = product ? product.key : r.key;
      let item = items.get(key);
      if (!item) {
        item = { key, header: null, product: null, members: [] };
        items.set(key, item);
      }
      if (product) {
        item.product = product;
        item.members.push(r);
      } else {
        item.header = r; // the product itself (or a device without one) is in the list too
        item.product = item.product || r;
      }
    }
    return [...items.values()];
  }

  const itemRecord = (item) => item.header || (item.members.length === 1 ? item.members[0] : item.product);
  const itemTitle = (item) => displayName(item.header || item.product || item.members[0]);

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  function pill(text, classes) {
    return el('span', `inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[10.5px] font-medium ring-1 ${classes}`, text);
  }

  function statusPill(r) {
    if (r.health === 'disconnected') return pill('Disconnected', 'bg-slate-700/40 text-slate-400 ring-slate-600/50');
    if (r.health === 'problem') {
      const text = r.problemCode ? `Code ${r.problemCode} · ${PROBLEMS[r.problemCode] || 'Problem'}` : r.status;
      return pill(text, r.disabled ? 'bg-slate-600/30 text-slate-300 ring-slate-500/50' : 'bg-amber-500/10 text-amber-300 ring-amber-500/40');
    }
    return pill('Working', 'bg-emerald-500/10 text-emerald-300 ring-emerald-500/30');
  }

  function connectionPill(r) {
    const isDisplay = r.enumerator === 'DISPLAY' && r.connection !== 'Software';
    return pill(r.connection, isDisplay ? DISPLAY_STYLE : CONNECTION_STYLE[r.connection] || 'bg-slate-700/40 text-slate-300 ring-slate-600/50');
  }

  function renderSidebar(base) {
    const item = (id, label, count) => {
      const active = id === view.group;
      const btn = el('button', `flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 ${
        active ? 'bg-cyan-500/15 text-cyan-200 ring-1 ring-cyan-500/30' : 'text-slate-300 hover:bg-slate-700/60 hover:text-white'}`);
      btn.type = 'button';
      btn.append(el('span', 'truncate', label), el('span', `shrink-0 tabular-nums ${active ? 'text-cyan-300' : 'text-slate-500'}`, String(count)));
      btn.addEventListener('click', () => selectGroup(id));
      return btn;
    };

    $('groupList').replaceChildren(...GROUPS.map((g) => item(g.id, g.label, base.filter(g.match).length)));

    const byCategory = new Map();
    for (const r of base) byCategory.set(r.category, (byCategory.get(r.category) || 0) + 1);
    const selectedTitle = view.group.startsWith('c:') ? view.group.slice(2) : null;
    if (selectedTitle && !byCategory.has(selectedTitle)) byCategory.set(selectedTitle, 0);
    const categories = [...byCategory.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    $('categoryList').replaceChildren(...categories.map(([title, count]) => item(`c:${title}`, title, count)));
  }

  function renderHead(columns) {
    const tr = el('tr');
    for (const col of columns) {
      const th = el('th', 'border-b border-slate-700/70 px-4 py-2 font-medium text-slate-400');
      const btn = el('button', 'inline-flex items-center gap-1 hover:text-white focus:outline-none focus-visible:text-white');
      btn.type = 'button';
      btn.append(el('span', null, col.label));
      if (view.sort.key === col.key) btn.append(el('span', 'text-cyan-300', view.sort.dir === 1 ? '▲' : '▼'));
      btn.addEventListener('click', () => {
        view.sort = { key: col.key, dir: view.sort.key === col.key ? -view.sort.dir : 1 };
        persist();
        refresh();
      });
      th.append(btn);
      tr.append(th);
    }
    $('devHead').replaceChildren(tr);
  }

  /**
   * One table row. `r` supplies every column; `opts` can override the name cell:
   *   title / sub      – text lines
   *   depth            – 1 for a function listed under its product
   *   toggle           – { expanded, count } for an expandable product row
   *   categoryText     – category cell override for product rows
   */
  function renderRow(r, columns, opts = {}) {
    const selected = view.selected === r.key;
    const tr = el('tr', `cursor-pointer transition-colors ${selected ? 'bg-cyan-500/10' : 'hover:bg-slate-700/40'} ${r.present ? '' : 'opacity-60'}`);
    const td = (child, extra = '') => {
      const cell = el('td', `border-b border-slate-700/40 px-4 py-2 align-middle ${extra}`);
      if (child) cell.append(child);
      tr.append(cell);
    };

    for (const col of columns) {
      if (col.key === 'name') {
        const alias = aliasStore.get(r.deviceId);
        const wrap = el('div', `flex min-w-[240px] max-w-[420px] items-center gap-2 ${opts.depth ? 'pl-7' : ''}`);
        if (opts.toggle) {
          const chevron = el('button', 'grid h-5 w-5 shrink-0 place-items-center rounded text-slate-400 hover:bg-slate-600/60 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400',
            opts.toggle.expanded ? '▾' : '▸');
          chevron.type = 'button';
          chevron.title = opts.toggle.expanded ? 'Hide functions' : 'Show functions';
          chevron.addEventListener('click', (e) => { e.stopPropagation(); toggleExpanded(opts.toggle.key); });
          wrap.append(chevron);
        } else if (opts.depth) {
          wrap.append(el('span', 'h-4 w-3 shrink-0 rounded-bl border-b border-l border-slate-600'));
        }
        const box = el('div', 'min-w-0');
        const title = opts.title || alias || r.name;
        const titleIsAlias = opts.title ? opts.titleIsAlias : Boolean(alias);
        box.append(el('div', `truncate font-medium ${titleIsAlias ? 'text-cyan-200' : 'text-slate-100'}`, title));
        const sub = opts.sub !== undefined ? opts.sub : alias ? r.name : r.monitorModel ? r.windowsName : '';
        if (sub) box.append(el('div', 'truncate text-[10.5px] text-slate-500', sub));
        wrap.append(box);
        if (opts.toggle) wrap.append(pill(String(opts.toggle.count), 'ml-auto bg-slate-700/60 text-slate-300 ring-slate-600/60'));
        td(wrap);
      } else if (col.key === 'category') {
        td(el('span', 'whitespace-nowrap text-slate-300', opts.categoryText || r.category));
      } else if (col.key === 'connection') {
        td(connectionPill(r));
      } else if (col.key === 'manufacturer') {
        td(el('div', 'max-w-[200px] truncate text-slate-300', r.manufacturer || '—'));
      } else if (col.key === 'status') {
        td(statusPill(r));
      } else if (col.key === 'driver') {
        const box = el('div', 'max-w-[220px]');
        box.append(el('div', 'truncate text-slate-300', r.driverProvider || '—'));
        const meta = [r.driverVersion && `v${r.driverVersion}`, r.driverDate].filter(Boolean).join(' · ');
        if (meta) box.append(el('div', 'truncate text-[10.5px] text-slate-500', meta));
        td(box);
      }
    }

    tr.addEventListener('click', () => select(r.key));
    tr.addEventListener('dblclick', () => openAliasDialog(r));
    return tr;
  }

  function renderItems(items, columns) {
    const out = [];
    for (const item of items) {
      if (!item.members.length) {
        out.push(renderRow(item.header, columns));
        continue;
      }
      const product = item.product;
      const productAlias = aliasStore.get(product.deviceId);
      const productTitle = productAlias || product.name;

      // One function of a product: show it under the product's name.
      if (!item.header && item.members.length === 1) {
        const m = item.members[0];
        const mAlias = aliasStore.get(m.deviceId);
        out.push(renderRow(m, columns, { title: mAlias || productTitle, titleIsAlias: Boolean(mAlias || productAlias), sub: mAlias ? `${productTitle} · ${m.name}` : m.name }));
        continue;
      }

      // Several functions: an expandable product row.
      const expanded = view.expanded.has(item.key);
      const headerRecord = item.header || product;
      const names = [...new Set(item.members.map((m) => displayName(m)))];
      const categories = [...new Set(item.members.map((m) => m.category))];
      out.push(renderRow(headerRecord, columns, {
        title: productTitle,
        titleIsAlias: Boolean(productAlias),
        sub: item.header ? `${product.name !== productTitle ? `${product.name} · ` : ''}${names.slice(0, 3).join(', ')}${names.length > 3 ? '…' : ''}`
          : `${names.slice(0, 3).join(', ')}${names.length > 3 ? '…' : ''}`,
        toggle: { key: item.key, expanded, count: item.members.length },
        categoryText: item.header ? undefined : categories.join(', '),
      }));
      if (expanded) {
        for (const m of [...item.members].sort((a, b) => displayName(a).localeCompare(displayName(b)))) {
          out.push(renderRow(m, columns, { depth: 1 }));
        }
      }
    }
    return out;
  }

  // ---- Details panel --------------------------------------------------------

  const BUTTON = 'rounded-lg px-3 py-1.5 text-xs text-slate-300 ring-1 ring-slate-700 hover:bg-slate-700 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 disabled:cursor-not-allowed disabled:opacity-40';
  const BUTTON_PRIMARY = 'rounded-lg bg-cyan-500 px-3 py-1.5 text-xs font-semibold text-slate-950 hover:bg-cyan-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-200';
  const BUTTON_DANGER = 'rounded-lg px-3 py-1.5 text-xs text-rose-300 ring-1 ring-rose-500/40 hover:bg-rose-500/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-400 disabled:cursor-not-allowed disabled:opacity-40';

  function button(label, className, fn, { disabled = false, title = '' } = {}) {
    const b = el('button', className, label);
    b.type = 'button';
    b.disabled = disabled || view.busy;
    if (title) b.title = title;
    b.addEventListener('click', fn);
    return b;
  }

  function sectionTitle(text) {
    return el('h4', 'mb-2 text-[10.5px] font-semibold uppercase tracking-wider text-slate-500', text);
  }

  function renderDetail() {
    const panel = $('devDetail');
    const resizer = $('devResizer');
    const r = view.selected && view.records.get(view.selected);
    panel.classList.toggle('hidden', !r);
    panel.classList.toggle('flex', Boolean(r));
    resizer.classList.toggle('hidden', !r);
    resizer.classList.toggle('flex', Boolean(r));
    if (!r) return;
    applyDetailWidth();

    const alias = aliasStore.get(r.deviceId);
    const product = productOf(r);

    // Header
    const head = el('div', 'flex items-start gap-3 border-b border-slate-700/70 p-4');
    const titles = el('div', 'min-w-0 flex-1');
    titles.append(el('h3', `break-words text-sm font-semibold ${alias ? 'text-cyan-200' : 'text-slate-100'}`, alias || r.name));
    const subtitle = [alias ? r.name : r.name !== r.windowsName ? r.windowsName : '', product ? `part of ${displayName(product)}` : '']
      .filter(Boolean).join(' · ');
    if (subtitle) titles.append(el('p', 'mt-0.5 break-words text-[11px] text-slate-400', subtitle));
    const status = el('div', 'mt-2 flex flex-wrap gap-1.5');
    status.append(statusPill(r), connectionPill(r));
    titles.append(status);
    const close = button('✕', 'rounded-md p-1 text-slate-400 hover:bg-slate-700 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400', closeDetail, { title: 'Close (Esc)' });
    close.disabled = false;
    head.append(titles, close);

    // Everyday actions
    const actions = el('div', 'flex flex-wrap gap-2 border-b border-slate-700/70 px-4 py-3');
    actions.append(button(alias ? 'Rename' : 'Set alias', BUTTON_PRIMARY, () => openAliasDialog(r)));
    actions.append(button('Copy device ID', BUTTON, () => copyText(r.deviceId)));
    const topologyKey = state.nodes.has(r.key) ? r.key : product && state.nodes.has(product.key) ? product.key : null;
    if (topologyKey) actions.append(button('Show in USB topology', BUTTON, () => focusInTopology(topologyKey)));
    actions.append(button('Windows properties…', BUTTON, () => openPropertiesWindow(r),
      { title: "Windows' own properties window: General, Driver (update / roll back), Details, Events" }));

    // Device Manager controls
    const control = el('div', 'flex flex-col gap-2 border-b border-slate-700/70 px-4 py-3');
    const controlHead = el('div', 'flex items-center justify-between');
    controlHead.append(sectionTitle('Device control'));
    if (!state.admin) controlHead.append(el('span', 'mb-2 text-[10.5px] text-amber-300/80', 'needs administrator'));
    control.append(controlHead);
    const controls = el('div', 'flex flex-wrap gap-2');
    if (r.present) {
      controls.append(r.disabled
        ? button('Enable', BUTTON, () => deviceAction(r, 'enable'))
        : button('Disable', BUTTON, () => deviceAction(r, 'disable')));
      controls.append(button('Restart', BUTTON, () => deviceAction(r, 'restart'), { disabled: r.disabled }));
    }
    controls.append(button(r.present ? 'Uninstall device' : 'Remove from Windows', BUTTON_DANGER, () => deviceAction(r, 'uninstall')));
    control.append(controls);
    if (view.busy) control.append(el('p', 'text-[11px] text-slate-400', 'Working…'));

    // Details
    const body = el('div', 'flex flex-col gap-5 p-4 text-xs');
    const section = (title, rows) => {
      const visible = rows.filter(([, v]) => v);
      if (!visible.length) return;
      const wrap = el('div');
      wrap.append(sectionTitle(title));
      const dl = el('dl', 'grid grid-cols-[104px_1fr] gap-x-3 gap-y-1.5');
      for (const [label, value, mono] of visible) {
        dl.append(el('dt', 'text-slate-500', label));
        dl.append(el('dd', mono ? 'break-all font-mono text-[10.5px] leading-snug text-slate-300' : 'break-words text-slate-200', value));
      }
      wrap.append(dl);
      body.append(wrap);
    };

    section('General', [
      ['Category', r.category],
      ['Connection', r.connection],
      ['Manufacturer', r.manufacturer],
      ['Status', r.health === 'problem' && r.problemCode
        ? `${r.status} — code ${r.problemCode}: ${PROBLEMS[r.problemCode] || 'see Device Manager'}`
        : r.present ? r.status : 'Not connected (remembered by Windows)'],
      ['Location', r.locationInfo],
      ['Reported as', r.busDescription && r.busDescription !== r.windowsName && r.busDescription !== r.name ? r.busDescription : ''],
      ['Windows name', r.windowsName !== r.name ? r.windowsName : ''],
    ]);
    const socket = socketOfRecord(r);
    if (socket) {
      const wrap = el('div');
      const headRow = el('div', 'flex items-center justify-between');
      headRow.append(sectionTitle('Port'));
      headRow.append(button(portStore.get(socket) ? 'Rename port' : 'Name port',
        'mb-2 rounded-md px-2 py-1 text-[11px] text-teal-300 ring-1 ring-teal-500/40 hover:bg-teal-500/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-400',
        () => openPortDialog(socket)));
      wrap.append(headRow);
      const dl = el('dl', 'grid grid-cols-[104px_1fr] gap-x-3 gap-y-1.5');
      const rows = [
        ['Name', portStore.get(socket) || 'Not named yet'],
        ['Socket', socketPorts(socket)],
        ['Connector', socketKind(socket)],
        ['Hub', socket.primary.hubName],
      ];
      const live = socket.ports.find((p) => p.connected && (p.key === r.portKey || (productOf(r) && p.key === productOf(r).portKey)));
      if (live) rows.push(['Speed', USB_SPEEDS[live.speed] || '']);
      for (const [label, value] of rows) {
        dl.append(el('dt', 'text-slate-500', label));
        dl.append(el('dd', `break-words ${label === 'Name' && !portStore.get(socket) ? 'text-slate-500' : 'text-slate-200'}`, value));
      }
      wrap.append(dl);
      body.append(wrap);
    }

    if (r.monitorModel || r.enumerator === 'DISPLAY') {
      section('Monitor', [
        ['Model', r.monitorModel],
        ['Connector', VIDEO_OUTPUTS[r.videoOutput] || ''],
      ]);
    }
    section('Driver', [
      ['Provider', r.driverProvider],
      ['Version', r.driverVersion],
      ['Date', r.driverDate],
      ['Class', r.cls],
    ]);
    section('Identity', [
      ['Device ID', r.deviceId, true],
      ['Hardware ID', r.hardwareId, true],
    ]);

    // Relationships
    const parent = view.records.get(r.parentId);
    if (product || parent || r.children.length) {
      const wrap = el('div');
      wrap.append(sectionTitle('Connections'));
      const link = (rec, prefix) => {
        const b = el('button', 'flex w-full items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-slate-700/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400');
        b.type = 'button';
        b.append(el('span', 'w-14 shrink-0 text-[10.5px] text-slate-500', prefix), el('span', `truncate ${rec.present ? 'text-slate-200' : 'text-slate-500'}`, displayName(rec)));
        b.addEventListener('click', () => select(rec.key, true));
        wrap.append(b);
      };
      if (product && product !== parent) link(product, 'Device');
      if (parent) link(parent, 'Parent');
      r.children.slice(0, 30).forEach((c) => link(c, 'Child'));
      if (r.children.length > 30) wrap.append(el('p', 'px-2 pt-1 text-[10.5px] text-slate-500', `+ ${r.children.length - 30} more`));
      body.append(wrap);
    }

    // All properties (Device Manager's "Details" tab)
    const all = el('div');
    all.append(sectionTitle('All properties'));
    const props = view.properties.get(r.key);
    if (!props) {
      all.append(button('Load all properties', BUTTON, () => loadProperties(r)));
    } else if (props === 'loading') {
      all.append(el('p', 'text-slate-400', 'Loading…'));
    } else if (props instanceof Error) {
      all.append(el('p', 'text-rose-300', props.message), button('Try again', `${BUTTON} mt-2`, () => loadProperties(r)));
    } else {
      const dl = el('dl', 'flex flex-col gap-2');
      for (const p of props) {
        const row = el('div');
        row.append(el('dt', 'text-[10.5px] text-slate-500', p.key.replace(/^DEVPKEY_/, '').replace(/_/g, ' ')));
        row.append(el('dd', 'whitespace-pre-wrap break-all font-mono text-[10.5px] leading-snug text-slate-300', p.value));
        dl.append(row);
      }
      all.append(dl);
    }
    body.append(all);

    panel.replaceChildren(head, actions, control, body);
  }

  function refresh() {
    if (!view.records.size) return;
    const base = [...view.records.values()].filter(passesFilters);
    const group = currentGroup();
    const columns = COLUMNS.filter((c) => !(c.multiOnly && group.single));
    const col = COLUMNS.find((c) => c.key === view.sort.key) || COLUMNS[0];

    view.rows = base.filter(group.match);
    const items = buildItems(view.rows).sort((a, b) => {
      const x = col.key === 'name' ? itemTitle(a).toLowerCase() : col.sort(itemRecord(a));
      const y = col.key === 'name' ? itemTitle(b).toLowerCase() : col.sort(itemRecord(b));
      return (x < y ? -1 : x > y ? 1 : itemTitle(a).localeCompare(itemTitle(b))) * view.sort.dir;
    });

    renderSidebar(base);
    renderHead(columns);
    $('devBody').replaceChildren(...renderItems(items, columns));
    $('devEmpty').classList.toggle('hidden', view.rows.length > 0);
    $('devTitle').textContent = group.label;
    const hidden = view.records.size - base.length;
    $('devCount').textContent = `${view.rows.length} ${view.rows.length === 1 ? 'device' : 'devices'}` +
      (hidden ? ` · ${hidden} hidden by filters` : '');

    for (const btn of document.querySelectorAll('[data-filter]')) {
      const on = view.filters[btn.dataset.filter];
      btn.setAttribute('aria-pressed', String(on));
      btn.classList.toggle('bg-slate-700', on);
      btn.classList.toggle('text-white', on);
      btn.classList.toggle('text-slate-400', !on);
      btn.classList.toggle('hover:text-white', !on);
    }

    renderDetail();
    if (state.view === 'devices') updateStats();
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  function selectGroup(id) {
    view.group = id;
    persist();
    refresh();
  }

  function toggleExpanded(key) {
    if (view.expanded.has(key)) view.expanded.delete(key); else view.expanded.add(key);
    persist();
    refresh();
  }

  function select(key, reveal) {
    view.selected = key;
    // Selecting a function inside a collapsed product opens the product so the row is visible.
    const r = view.records.get(key);
    const product = r && productOf(r);
    if (reveal && product && view.filters.groupByDevice) view.expanded.add(product.key);
    refresh();
    if (reveal) {
      const row = [...$('devBody').children].find((tr) => tr.classList.contains('bg-cyan-500/10'));
      if (row) row.scrollIntoView({ block: 'nearest' });
    }
  }

  function closeDetail() {
    if (!view.selected) return;
    view.selected = null;
    refresh();
  }

  async function loadProperties(r) {
    view.properties.set(r.key, 'loading');
    refresh();
    try {
      const props = await window.api.getDeviceProperties(r.deviceId);
      view.properties.set(r.key, props.sort((a, b) => a.key.localeCompare(b.key)));
    } catch (err) {
      view.properties.set(r.key, new Error(err.message || String(err)));
    }
    refresh();
  }

  async function openPropertiesWindow(r) {
    try {
      await window.api.openPropertiesWindow(r.deviceId);
    } catch (err) {
      toast(`Could not open properties: ${err.message}`, 'error');
    }
  }

  /** Everything below a device (its interfaces, collections, endpoints, ...). */
  function descendants(r, out = new Set()) {
    for (const c of r.children) {
      if (!out.has(c)) {
        out.add(c);
        descendants(c, out);
      }
    }
    return out;
  }

  function riskWarning(r) {
    const product = productOf(r);
    const below = [...descendants(r)];
    const providesInput = below.some((d) => d.cls === 'Keyboard' || d.cls === 'Mouse');
    const isHubOrController = r.cls === 'USB' && (/ROOT_HUB|^PCI\\/.test(r.key) || /\bhub\b|controller/i.test(r.windowsName));

    if (isHubOrController) return 'This is a USB controller or hub. Everything plugged into it — possibly your keyboard and mouse — will disconnect.';
    if (['Keyboard', 'Mouse'].includes(r.cls) || providesInput) {
      return `This ${r.cls === 'Keyboard' || r.cls === 'Mouse' ? 'is' : 'includes'} a keyboard or mouse${product ? ` (${displayName(product)})` : ''}. If it's the one you're using, it will stop responding.`;
    }
    if (!CRITICAL_CLASSES.has(r.cls)) return '';
    if (r.cls === 'HIDClass') return `This is part of an input device${product ? ` (${displayName(product)})` : ''}. Some of its buttons or controls may stop working.`;
    if (r.cls === 'Display' || r.cls === 'Monitor') return 'This is a display device. Your screen may go black or change resolution.';
    if (['DiskDrive', 'HDC', 'SCSIAdapter'].includes(r.cls)) return 'This is a storage device or controller. If Windows or your programs are on it, the PC can crash.';
    if (r.cls === 'Net') return 'This is a network adapter. You may lose your network / internet connection.';
    if (r.cls === 'USB') return '';
    return `This is a core system device ("${r.category}"). Changing it can make Windows unstable until you restart.`;
  }

  async function deviceAction(r, action) {
    const name = displayName(r);
    await withAdmin(`${action[0].toUpperCase()}${action.slice(1)} "${name}"`, async () => {
      if (action !== 'enable') {
        const text = {
          disable: [`Disable "${name}"?`, 'The device stops working until you enable it again.', 'Disable'],
          restart: [`Restart "${name}"?`, 'Windows stops and starts the device. It disconnects for a moment.', 'Restart'],
          uninstall: r.present
            ? [`Uninstall "${name}"?`, 'Windows removes the device. While it is still connected it comes back after "Scan for hardware changes" or a restart. Its driver package stays installed.', 'Uninstall']
            : [`Remove "${name}" from Windows?`, 'This removes a device Windows remembers but that is not connected. It is recreated automatically if you plug it in again.', 'Remove'],
        }[action];
        const ok = await confirmDialog({
          title: text[0],
          message: text[1],
          warning: r.present ? riskWarning(r) : '',
          confirmLabel: text[2],
          danger: action !== 'restart',
        });
        if (!ok) return;
      }

      view.busy = true;
      refresh();
      try {
        const result = await window.api.deviceAction(action, r.deviceId);
        const done = { enable: 'Enabled', disable: 'Disabled', restart: 'Restarted', uninstall: 'Removed' }[action];
        toast(`${done} "${name}"${result.rebootRequired ? ' — restart Windows to finish' : ''}`);
        if (action === 'uninstall' && view.selected === r.key) view.selected = null;
      } catch (err) {
        toast(`${action[0].toUpperCase()}${action.slice(1)} failed: ${err.message}`, 'error');
      } finally {
        view.busy = false;
        refresh();
      }
    });
  }

  function scanForHardwareChanges() {
    withAdmin('Scanning for hardware changes', async () => {
      try {
        await window.api.scanForHardwareChanges();
        toast('Scanned for hardware changes');
      } catch (err) {
        toast(`Scan failed: ${err.message}`, 'error');
      }
    });
  }

  function addDriver() {
    withAdmin('Adding a driver', async () => {
      try {
        const result = await window.api.addDriver();
        if (result.canceled) return;
        toast(`Installed driver ${result.file}${result.rebootRequired ? ' — restart Windows to finish' : ''}`);
      } catch (err) {
        toast(`Driver install failed: ${err.message}`, 'error');
      }
    });
  }

  function exportCsv() {
    const header = ['Name', 'Alias', 'Physical device', 'Port', 'Category', 'Connection', 'Manufacturer', 'Status', 'Connected',
      'Problem code', 'Driver provider', 'Driver version', 'Driver date', 'Location', 'Device ID', 'Hardware ID'];
    const quote = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = view.rows.map((r) => {
      const product = productOf(r);
      return [r.name, aliasStore.get(r.deviceId), product ? displayName(product) : '', portName(r), r.category, r.connection,
        r.manufacturer, r.status, r.present ? 'Yes' : 'No', r.problemCode || '', r.driverProvider, r.driverVersion,
        r.driverDate, r.locationInfo, r.deviceId, r.hardwareId].map(quote).join(',');
    });
    const csv = '﻿' + [header.map(quote).join(','), ...lines].join('\r\n');

    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = el('a');
    a.href = url;
    a.download = `porter-devices-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    toast(`Exported ${view.rows.length} devices`);
  }

  // ---- Resizable details panel -----------------------------------------------

  function clampDetailWidth(width) {
    const container = $('viewDevices').getBoundingClientRect().width || window.innerWidth;
    const max = Math.max(DETAIL_MIN_WIDTH, Math.min(900, container - 256 - 420)); // keep sidebar + a usable table
    return Math.round(Math.min(max, Math.max(DETAIL_MIN_WIDTH, width)));
  }

  function applyDetailWidth() {
    $('devDetail').style.width = `${clampDetailWidth(view.detailWidth)}px`;
    $('devResizer').setAttribute('aria-valuenow', String(clampDetailWidth(view.detailWidth)));
  }

  function initResizer() {
    const handle = $('devResizer');
    const panel = $('devDetail');

    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      const right = panel.getBoundingClientRect().right;
      document.body.classList.add('cursor-col-resize', 'select-none');
      const move = (ev) => {
        view.detailWidth = clampDetailWidth(right - ev.clientX);
        applyDetailWidth();
      };
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
        document.body.classList.remove('cursor-col-resize', 'select-none');
        persist();
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
    });

    handle.addEventListener('dblclick', () => {
      view.detailWidth = DETAIL_DEFAULT_WIDTH;
      applyDetailWidth();
      persist();
    });

    // Keyboard: ←/→ widen/narrow the panel.
    handle.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      view.detailWidth = clampDetailWidth(view.detailWidth + (e.key === 'ArrowLeft' ? 24 : -24));
      applyDetailWidth();
      persist();
    });

    window.addEventListener('resize', () => { if (view.selected) applyDetailWidth(); });
  }

  function init() {
    initResizer();
    let searchTimer = null;
    $('devSearch').addEventListener('input', (e) => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        view.search = e.target.value.trim().toLowerCase();
        refresh();
      }, 120);
    });

    for (const btn of document.querySelectorAll('[data-filter]')) {
      btn.addEventListener('click', () => {
        view.filters[btn.dataset.filter] = !view.filters[btn.dataset.filter];
        persist();
        refresh();
      });
    }

    $('btnExportCsv').addEventListener('click', exportCsv);
    $('btnScanChanges').addEventListener('click', scanForHardwareChanges);
    $('btnAddDriver').addEventListener('click', addDriver);
    $('btnDeviceManager').addEventListener('click', () => {
      window.api.openDeviceManager().catch((err) => toast(`Could not open Device Manager: ${err.message}`, 'error'));
    });
  }

  return {
    init,
    refresh,
    closeDetail,
    focusSearch: () => { $('devSearch').focus(); $('devSearch').select(); },
    update(rawDevices) {
      view.records = buildRecords(rawDevices);
      view.properties.clear();
      if (view.selected && !view.records.has(view.selected)) view.selected = null;
      refresh();
    },
    stats() {
      let connected = 0, disconnected = 0, problems = 0;
      for (const r of view.records.values()) {
        if (view.filters.physicalOnly && r.virtual) continue;
        if (r.present) connected++; else disconnected++;
        if (r.health === 'problem') problems++;
      }
      return { connected, disconnected, problems };
    },
  };
})();
