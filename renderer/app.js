'use strict';

// ===========================================================================
// Config
// ===========================================================================

const HOST_KEY = '__HOST__';
const STORAGE = {
  aliases: 'porter.aliases.v1',
  collapsed: 'porter.collapsed.v1',
  showGhosts: 'porter.showDisconnected.v1',
  layout: 'porter.layout.v1',
  view: 'porter.view.v1',
  ports: 'porter.ports.v1',
  showAllPorts: 'porter.showAllPorts.v1',
};

const ANIM_MS = 380;

// ===========================================================================
// Layout engine
//
// Every node's origin (0,0) is the centre of its collapse dot, and the card is drawn relative
// to it using one of two anchors:
//   'top'  – dot sits on the middle of the card's top edge (branches in the top-down view)
//   'left' – dot sits just left of the card (left-to-right view, and stacked leaves)
// ===========================================================================

const CARD_GAP = 12; // dot → card distance for the 'left' anchor
const DOT_R = 6;

const LAYOUTS = {
  vertical: {
    cardW: 220, cardH: 46, depthAxis: 'y',
    gapX: 24,       // between sibling columns
    levelGap: 58,   // parent card bottom → children row top (the bus runs through the middle)
    indent: 30,     // stacked leaves are indented from their spine by this much
    stackGap: 12,   // between stacked leaf cards
  },
  horizontal: {
    cardW: 256, cardH: 46, depthAxis: 'x',
    nodeSize: [58, 320],
  },
};

function nodeGeometry(anchor, L) {
  const w = L.cardW, h = L.cardH;
  return anchor === 'top'
    ? { cardX: -w / 2, cardY: 0, textX: -w / 2 + 13, titleY: 19, subtitleY: 35, badgeX: w / 2 - 11, badgeY: 28,
        box: { x0: -w / 2, x1: w / 2, y0: -DOT_R - 2, y1: h } }
    : { cardX: CARD_GAP, cardY: -h / 2, textX: CARD_GAP + 13, titleY: -3, subtitleY: 13, badgeX: CARD_GAP + w - 11, badgeY: 4,
        box: { x0: -DOT_R - 2, x1: CARD_GAP + w, y0: -h / 2, y1: h / 2 } };
}

/**
 * Top-down layout. Only real fan-out points (controllers, root hubs, hubs — anything with
 * grandchildren) spread their children sideways. Everything else under a node — plain devices,
 * and devices whose children are all leaves (e.g. a composite device and its interfaces) — is
 * listed in one compact column hanging off a vertical spine, with interfaces indented one more
 * step, much like Device Manager. This keeps busy hubs from turning the diagram into a very
 * wide strip.
 */
function layoutVertical(root, L) {
  const w = L.cardW, h = L.cardH;
  const pos = new Map();
  const isListable = (n) => !n.children || n.children.every((c) => !c.children);

  (function measure(n) {
    const kids = n.children || [];
    const listed = kids.filter(isListable);
    const branches = kids.filter((k) => !isListable(k));
    branches.forEach(measure);

    n._items = [];
    if (listed.length) {
      const entries = [];
      for (const k of listed) {
        entries.push({ node: k, level: 0 });
        for (const c of k.children || []) entries.push({ node: c, level: 1 });
      }
      const levels = entries.some((e) => e.level === 1) ? 2 : 1;
      n._items.push({ entries, w: levels * L.indent + CARD_GAP + w, h: entries.length * (h + L.stackGap) - L.stackGap });
    }
    for (const b of branches) n._items.push({ branch: b, w: b._w, h: b._h });

    n._rowW = d3.sum(n._items, (i) => i.w) + L.gapX * Math.max(0, n._items.length - 1);
    n._w = Math.max(w, n._rowW);
    n._h = h + (n._items.length ? L.levelGap + d3.max(n._items, (i) => i.h) : 0);
  })(root);

  (function place(n, cx, top) {
    pos.set(n.data.key, { px: cx, py: top, anchor: 'top' });
    const rowTop = top + h + L.levelGap;
    let x = cx - n._rowW / 2;
    for (const item of n._items) {
      if (item.entries) {
        item.entries.forEach((e, i) => {
          const px = x + (e.level + 1) * L.indent;
          pos.set(e.node.data.key, { px, py: rowTop + i * (h + L.stackGap) + h / 2, anchor: 'left', spineX: px - L.indent / 2 });
        });
      } else {
        place(item.branch, x + item.w / 2, rowTop);
      }
      x += item.w + L.gapX;
    }
  })(root, 0, 0);

  return pos;
}

function layoutHorizontal(root, L) {
  d3.tree().nodeSize(L.nodeSize).separation((a, b) => (a.parent === b.parent ? 1 : 1.25))(root);
  return new Map(root.descendants().map((d) => [d.data.key, { px: d.y, py: d.x, anchor: 'left' }]));
}

/** Point where a node's outgoing connector starts. */
function linkStart(p, L) {
  if (p.anchor === 'top') return [p.px, p.py + L.cardH];
  return state.layout === 'horizontal'
    ? [p.px + CARD_GAP + L.cardW, p.py]
    : [p.px + L.indent / 2, p.py + L.cardH / 2]; // listed parent: its children's spine starts under its card
}

/**
 * Connector as a fixed 5-point orthogonal polyline, so every connector has the same path
 * structure and D3 can animate smoothly between any two of them.
 */
function linkPoints(s, t, L) {
  const [sx, sy] = linkStart(s, L);
  if (state.layout === 'horizontal') {
    const tx = t.px - DOT_R, mx = (sx + tx) / 2;
    return [[sx, sy], [mx, sy], [mx, t.py], [tx, t.py], [tx, t.py]];
  }
  const tx = t.px - DOT_R;
  if (s.anchor === 'left') return [[sx, sy], [sx, sy], [sx, t.py], [tx, t.py], [tx, t.py]];
  const my = sy + L.levelGap / 2;
  if (t.anchor === 'top') return [[sx, sy], [sx, my], [t.px, my], [t.px, t.py - DOT_R], [t.px, t.py - DOT_R]];
  return [[sx, sy], [sx, my], [t.spineX, my], [t.spineX, t.py], [tx, t.py]];
}

function roundedPath(pts, radius = 8) {
  const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
  const toward = (from, to, r) => {
    const d = dist(from, to);
    return d ? [from[0] + ((to[0] - from[0]) * r) / d, from[1] + ((to[1] - from[1]) * r) / d] : from;
  };
  let path = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const c = pts[i];
    const r = Math.min(radius, dist(pts[i - 1], c) / 2, dist(c, pts[i + 1]) / 2);
    const a = toward(c, pts[i - 1], r);
    const b = toward(c, pts[i + 1], r);
    path += `L${a[0]},${a[1]}Q${c[0]},${c[1]} ${b[0]},${b[1]}`;
  }
  const end = pts[pts.length - 1];
  return `${path}L${end[0]},${end[1]}`;
}

const FONT_STACK = '"Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif';

const PALETTE = {
  host:   { card: '#1e1b4b', stroke: '#818cf8', dot: '#818cf8', text: '#e0e7ff', sub: '#a5b4fc', link: '#4f46e5' },
  hub:    { card: '#0f172a', stroke: '#3b82f6', dot: '#3b82f6', text: '#e2e8f0', sub: '#93c5fd', link: '#1d4ed8' },
  device: { card: '#0f172a', stroke: '#22d3ee', dot: '#22d3ee', text: '#f1f5f9', sub: '#67e8f9', link: '#0e7490' },
  error:  { card: '#1c1917', stroke: '#f59e0b', dot: '#f59e0b', text: '#fef3c7', sub: '#fcd34d', link: '#b45309' },
  ghost:  { card: '#131c2e', stroke: '#475569', dot: '#64748b', text: '#94a3b8', sub: '#64748b', link: '#475569' },
  port:   { card: '#0b1a1f', stroke: '#2dd4bf', dot: '#2dd4bf', text: '#ccfbf1', sub: '#5eead4', link: '#0f766e' },
};

// ===========================================================================
// Storage (localStorage can throw in locked-down profiles — never let it break the UI)
// ===========================================================================

function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function saveJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (err) {
    console.warn('Could not persist', key, err);
  }
}

const aliasStore = {
  map: (() => {
    const m = loadJSON(STORAGE.aliases, {});
    return m && typeof m === 'object' && !Array.isArray(m) ? m : {};
  })(),
  get(deviceId) { return this.map[normalizeId(deviceId)] || ''; },
  set(deviceId, alias) {
    const key = normalizeId(deviceId);
    const clean = String(alias || '').trim().slice(0, 64);
    if (clean) this.map[key] = clean; else delete this.map[key];
    saveJSON(STORAGE.aliases, this.map);
  },
};

function normalizeId(id) {
  return typeof id === 'string' ? id.trim().toUpperCase() : '';
}

// ===========================================================================
// Ports & sockets
//
// A port is identified by its hardware location path, e.g.
//   PCIROOT(0)#PCI(0201)#PCI(0000)#PCI(0C00)#PCI(0000)#USBROOT(0)#USB(12)
// which is exactly the location path of whatever device is plugged into it, and stays the same
// across reboots. A USB 3 socket is two ports (a USB 3 half and a USB 2 "companion"), so names
// belong to the *socket* and are stored under every port of it.
// ===========================================================================

const portStore = {
  map: (() => {
    const m = loadJSON(STORAGE.ports, {});
    return m && typeof m === 'object' && !Array.isArray(m) ? m : {};
  })(),
  get(socket) {
    if (!socket) return '';
    for (const p of socket.ports) if (this.map[p.key]) return this.map[p.key];
    return '';
  },
  set(socket, name) {
    const clean = String(name || '').trim().slice(0, 64);
    for (const p of socket.ports) {
      if (clean) this.map[p.key] = clean; else delete this.map[p.key];
    }
    saveJSON(STORAGE.ports, this.map);
  },
};

/** Prefer the PCIROOT(...) form of a device's location paths (the ACPI form is a second spelling). */
function primaryPath(paths) {
  const list = toArray(paths).filter((p) => typeof p === 'string' && p).map((p) => p.trim().toUpperCase());
  return list.find((p) => p.startsWith('PCIROOT')) || list[0] || '';
}

/** The port a device is plugged into, as a port key — or '' for interfaces and non-USB devices. */
function portKeyOf(paths) {
  const path = primaryPath(paths);
  return /#USB\(\d+\)$/.test(path) ? path : '';
}

const USB_SPEEDS = ['Low speed (1.5 Mbps)', 'Full speed (12 Mbps)', 'High speed (480 Mbps)', 'SuperSpeed (5 Gbps+)'];

function buildPortModel(rawDevices, rawPorts) {
  const hubPath = new Map();
  const hubName = new Map();
  for (const d of rawDevices) {
    const key = normalizeId(d.DeviceID);
    const path = primaryPath(d.LocationPaths);
    if (path) hubPath.set(key, path);
    hubName.set(key, friendlyName(d));
  }

  const ports = new Map();
  for (const raw of toArray(rawPorts)) {
    const hubKey = normalizeId(raw.Hub);
    const base = hubPath.get(hubKey);
    if (!base) continue;
    const key = `${base}#USB(${raw.Port})`;
    ports.set(key, {
      key,
      hubKey,
      hubName: hubName.get(hubKey) || raw.Hub,
      number: raw.Port,
      connectable: raw.Connectable,
      typeC: raw.TypeC,
      usb2: raw.Usb2,
      usb3: raw.Usb3,
      connected: raw.Connected,
      speed: raw.Speed,
      companionHubKey: normalizeId(raw.CompanionHub) || hubKey,
      companionPort: raw.CompanionPort,
      socket: null,
    });
  }

  for (const p of ports.values()) {
    if (p.socket) continue;
    const members = [p];
    const companionBase = p.companionPort && hubPath.get(p.companionHubKey);
    const companion = companionBase && ports.get(`${companionBase}#USB(${p.companionPort})`);
    if (companion && companion !== p && !companion.socket) members.push(companion);
    members.sort((a, b) => Number(b.usb3) - Number(a.usb3) || a.number - b.number); // USB 3 half first
    const socket = {
      key: members.map((m) => m.key).join('|'),
      ports: members,
      primary: members[0],
      usb3: members.some((m) => m.usb3),
      typeC: members.some((m) => m.typeC),
      connectable: members.some((m) => m.connectable),
    };
    for (const m of members) m.socket = socket;
  }

  return {
    ports,
    socketOf: (portKey) => (portKey && ports.get(portKey) ? ports.get(portKey).socket : null),
  };
}

/** "Port 1 (USB 3) + Port 6 (USB 2)" */
function socketPorts(socket) {
  return socket.ports.map((p) => `Port ${p.number} (${p.usb3 ? 'USB 3' : 'USB 2'})`).join(' + ');
}

/** "USB 3 · USB-C" */
function socketKind(socket) {
  return [socket.usb3 ? 'USB 3' : 'USB 2', socket.typeC ? 'USB-C' : ''].filter(Boolean).join(' · ');
}

// ===========================================================================
// Tree parser: flat PowerShell array  ->  parent/child hierarchy
// ===========================================================================

const GENERIC_USB_NAMES = /^(USB Composite Device|USB Input Device|USB Mass Storage Device|USB Serial Device|USB Audio Device|USB Video Device|USB Printing Support)$/i;

/**
 * Windows names many USB devices generically ("USB Composite Device"), while the device itself
 * reports its product name ("HyperX Pulsefire Core"). Prefer the latter for whole USB devices.
 */
function friendlyName(raw) {
  const name = raw.Name || String(raw.DeviceID);
  const reported = (raw.BusDescription || '').trim();
  const wholeUsbDevice = /^USB\\VID_[0-9A-F]{4}&PID_[0-9A-F]{4}\\/i.test(raw.DeviceID);
  return reported && wholeUsbDevice && GENERIC_USB_NAMES.test(name) ? reported : name;
}

function toArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

/** Human label + sort order for a node's position on its parent (port / interface number). */
function describeLocation(paths, locationInfo) {
  const last = (paths[0] || '').split('#').pop();
  let m = /^USB\((\d+)\)$/.exec(last);
  if (m) return { label: `Port ${Number(m[1])}`, order: Number(m[1]) };
  m = /^USBMI\((\d+)\)$/.exec(last);
  if (m) return { label: `Interface ${Number(m[1])}`, order: 1000 + Number(m[1]) };
  m = /Port_#0*(\d+)/i.exec(locationInfo || '');
  if (m) return { label: `Port ${Number(m[1])}`, order: Number(m[1]) };
  return { label: '', order: 9999 };
}

function classify(node) {
  if (node.synthetic) return 'host';
  if (node.isPort) return 'port';
  if (!node.present) return 'ghost';
  if (node.status !== 'OK') return 'error';
  const id = node.key;
  if (id.startsWith('PCI\\') || id.includes('ROOT_HUB') || /\bhub\b|host controller/i.test(node.name)) return 'hub';
  return 'device';
}

/**
 * Finds the parent by LocationPaths prefix matching, the same way Device Manager's
 * "Devices by connection" view nests them:
 *   PCIROOT(0)#PCI(0801)#PCI(0004)                     host controller
 *   PCIROOT(0)#PCI(0801)#PCI(0004)#USBROOT(0)          root hub
 *   PCIROOT(0)#PCI(0801)#PCI(0004)#USBROOT(0)#USB(2)   device on port 2
 *   ...#USBROOT(0)#USB(2)#USBMI(0)                     interface 0 of that device
 * The longest proper prefix owned by another device is the parent. Several devices can own
 * the same path (the one plugged in now + ones Windows remembers from that port), so prefer
 * the one Windows reports as the actual parent, then a connected one.
 */
function findParentByLocation(node, ownersByPath) {
  for (const path of node.locationPaths) {
    const segments = path.split('#');
    for (let i = segments.length - 1; i > 0; i--) {
      const owners = ownersByPath.get(segments.slice(0, i).join('#'));
      if (!owners) continue;
      const pick =
        owners.find((o) => o.key === node.parentId && o !== node) ||
        owners.find((o) => o.present && o !== node) ||
        owners.find((o) => o !== node);
      if (pick) return pick;
      break;
    }
  }
  return null;
}

/**
 * Adds a card for every socket that has nothing plugged in right now and is either named or
 * (with "Show all ports") simply exists. Devices Windows remembers from that socket move under it.
 */
function attachPortNodes(nodes, portModel, showAll) {
  const portNodes = new Map();
  if (!portModel) return portNodes;

  const occupied = new Set();
  const ghostsByPort = new Map();
  for (const node of nodes.values()) {
    if (!node.portKey) continue;
    if (node.present) occupied.add(node.portKey);
    else {
      if (!ghostsByPort.has(node.portKey)) ghostsByPort.set(node.portKey, []);
      ghostsByPort.get(node.portKey).push(node);
    }
  }

  const sockets = new Set([...portModel.ports.values()].map((p) => p.socket));
  for (const socket of sockets) {
    if (socket.ports.some((p) => occupied.has(p.key) || p.connected)) continue;
    const name = portStore.get(socket);
    if (!name && !showAll) continue;
    const hub = nodes.get(socket.primary.hubKey);
    if (!hub) continue;

    const portNode = {
      key: `PORT:${socket.key}`,
      deviceId: '',
      name: name || `Port ${socket.primary.number}`,
      manufacturer: '',
      status: 'Empty',
      present: false,
      deviceClass: 'Port',
      locationInfo: '',
      locationPaths: [socket.primary.key],
      parentId: hub.key,
      portKey: socket.primary.key,
      portLabel: `Port ${socket.primary.number}`,
      portOrder: socket.primary.number,
      comPort: '',
      synthetic: false,
      isPort: true,
      socket,
      parent: hub,
      children: [],
    };

    for (const p of socket.ports) {
      for (const ghost of ghostsByPort.get(p.key) || []) {
        if (!ghost.parent) continue;
        ghost.parent.children = ghost.parent.children.filter((c) => c !== ghost);
        ghost.parent = portNode;
        portNode.children.push(ghost);
      }
    }
    hub.children.push(portNode);
    portNodes.set(portNode.key, portNode);
  }
  return portNodes;
}

function buildDeviceTree(flatDevices, portModel = null, showAllPorts = false) {
  const nodes = new Map();

  for (const raw of toArray(flatDevices)) {
    if (!raw || !raw.DeviceID) continue;
    const key = normalizeId(raw.DeviceID);
    if (nodes.has(key)) continue;

    const locationPaths = toArray(raw.LocationPaths)
      .filter((p) => typeof p === 'string' && p.trim())
      .map((p) => p.trim().toUpperCase());
    const location = describeLocation(locationPaths, raw.LocationInfo);
    const com = /\((COM\d+)\)/i.exec(raw.Name || '');

    nodes.set(key, {
      key,
      deviceId: String(raw.DeviceID),
      name: friendlyName(raw),
      manufacturer: raw.Manufacturer || '',
      status: raw.Status || 'Unknown',
      present: raw.Present === true,
      deviceClass: raw.Class || '',
      locationInfo: raw.LocationInfo || '',
      locationPaths,
      parentId: normalizeId(raw.Parent),
      portKey: portKeyOf(locationPaths),
      portLabel: location.label,
      portOrder: location.order,
      comPort: com ? com[1].toUpperCase() : '',
      synthetic: false,
      parent: null,
      children: [],
    });
  }

  const ownersByPath = new Map();
  for (const node of nodes.values()) {
    for (const path of node.locationPaths) {
      if (!ownersByPath.has(path)) ownersByPath.set(path, []);
      ownersByPath.get(path).push(node);
    }
  }

  // 1) LocationPaths prefix match, 2) Windows' own Parent property, 3) top level.
  for (const node of nodes.values()) {
    let parent = findParentByLocation(node, ownersByPath) || nodes.get(node.parentId) || null;
    if (parent === node) parent = null;
    node.parent = parent;
  }

  // Guard against cycles in inconsistent PnP data.
  for (const node of nodes.values()) {
    const seen = new Set();
    for (let p = node.parent; p; p = p.parent) {
      if (p === node) { node.parent = null; break; }
      if (seen.has(p)) break;
      seen.add(p);
    }
  }

  const host = {
    key: HOST_KEY,
    deviceId: HOST_KEY,
    name: 'This PC',
    manufacturer: '',
    status: 'OK',
    present: true,
    deviceClass: 'Host',
    locationInfo: '',
    locationPaths: [],
    parentId: '',
    portLabel: '',
    portOrder: 0,
    comPort: '',
    synthetic: true,
    parent: null,
    children: [],
  };

  for (const node of nodes.values()) {
    (node.parent || host).children.push(node);
  }

  const portNodes = attachPortNodes(nodes, portModel, showAllPorts);

  const byPosition = (a, b) =>
    a.portOrder - b.portOrder ||
    Number(b.present) - Number(a.present) ||
    a.name.localeCompare(b.name);

  // Post-order: sort children and record whether anything connected lives in each subtree.
  (function finalize(node) {
    node.children.sort(byPosition);
    node.kind = classify(node);
    node.hasLive = node.present;
    for (const child of node.children) {
      finalize(child);
      if (child.hasLive) node.hasLive = true;
    }
  })(host);

  return { root: host, nodes, portNodes };
}

// ===========================================================================
// App state
// ===========================================================================

const state = {
  tree: null,
  nodes: new Map(),
  collapsed: new Set(toArray(loadJSON(STORAGE.collapsed, [])).filter((k) => typeof k === 'string')),
  showGhosts: loadJSON(STORAGE.showGhosts, true) !== false,
  layout: LAYOUTS[loadJSON(STORAGE.layout, 'vertical')] ? loadJSON(STORAGE.layout, 'vertical') : 'vertical',
  positions: new Map(), // key -> screen position { px, py } from the last render
  visible: [],
  hasFitted: false,
  view: loadJSON(STORAGE.view, 'topology') === 'devices' ? 'devices' : 'topology',
  admin: false,
  lastPayload: null,
  portModel: null,
  portNodes: new Map(),
  showAllPorts: loadJSON(STORAGE.showAllPorts, false) === true,
  finder: null, // { baseline: Map(portKey -> device key) } while "Find port" is waiting
};

/** The USB topology view shows USB controllers/hubs/devices and serial ports; the Devices view shows everything. */
function isTopologyDevice(raw) {
  return raw.Class === 'USB' || raw.Class === 'Ports' || /^(USB|USBSTOR|FTDIBUS)\\/i.test(raw.DeviceID);
}

const currentLayout = () => LAYOUTS[state.layout];

function visibleChildren(node) {
  return state.showGhosts ? node.children : node.children.filter((c) => c.hasLive || c.isPort);
}

/** Tree lookup that also covers the synthetic socket cards. */
function treeNode(key) {
  return state.nodes.get(key) || state.portNodes.get(key) || null;
}

/** "Rear USB-C · Port 1" for a device, using the socket name when there is one. */
function portText(node) {
  const socket = state.portModel && state.portModel.socketOf(node.portKey);
  const name = portStore.get(socket);
  return name ? `${name} · ${node.portLabel}` : node.portLabel;
}

function saveCollapsed() {
  saveJSON(STORAGE.collapsed, [...state.collapsed]);
}

// ===========================================================================
// D3 diagram
// ===========================================================================

const d3ok = typeof window.d3 !== 'undefined';
let svg, viewport, linkLayer, nodeLayer, zoom;
const measureCtx = document.createElement('canvas').getContext('2d');

function fitText(text, font, maxWidth) {
  measureCtx.font = font;
  if (measureCtx.measureText(text).width <= maxWidth) return text;
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (measureCtx.measureText(text.slice(0, mid) + '…').width <= maxWidth) lo = mid; else hi = mid - 1;
  }
  return text.slice(0, lo).trimEnd() + '…';
}

function initDiagram() {
  svg = d3.select('#diagram').append('svg').style('font-family', FONT_STACK);

  const defs = svg.append('defs');
  const glow = defs.append('filter').attr('id', 'glow').attr('x', '-100%').attr('y', '-100%').attr('width', '300%').attr('height', '300%');
  glow.append('feGaussianBlur').attr('stdDeviation', 3).attr('result', 'blur');
  const merge = glow.append('feMerge');
  merge.append('feMergeNode').attr('in', 'blur');
  merge.append('feMergeNode').attr('in', 'SourceGraphic');

  const grid = defs.append('pattern').attr('id', 'grid').attr('width', 22).attr('height', 22).attr('patternUnits', 'userSpaceOnUse');
  grid.append('circle').attr('cx', 1).attr('cy', 1).attr('r', 0.8).attr('fill', '#334155').attr('opacity', 0.55);
  svg.append('rect').attr('width', '100%').attr('height', '100%').attr('fill', 'url(#grid)');

  viewport = svg.append('g');
  linkLayer = viewport.append('g').attr('fill', 'none');
  nodeLayer = viewport.append('g');

  zoom = d3.zoom()
    .scaleExtent([0.15, 2.5])
    .on('start', hideTooltip)
    .on('zoom', (event) => viewport.attr('transform', event.transform));
  svg.call(zoom).on('dblclick.zoom', null);
}

function render() {
  if (!d3ok || !state.tree) return;

  const L = currentLayout();
  const root = d3.hierarchy(state.tree, (d) => {
    if (!d.synthetic && state.collapsed.has(d.key)) return null;
    const kids = visibleChildren(d);
    return kids.length ? kids : null;
  });
  const next = state.layout === 'horizontal' ? layoutHorizontal(root, L) : layoutVertical(root, L);

  const nodes = root.descendants();
  const links = root.links();
  const prev = state.positions;

  // New nodes grow out of their nearest previously-visible ancestor; removed ones shrink into
  // their nearest still-visible ancestor.
  const enterFrom = (d) => {
    for (let p = d.parent; p; p = p.parent) if (prev.has(p.data.key)) return prev.get(p.data.key);
    return next.get(d.data.key);
  };
  const exitTo = (d) => {
    for (let p = d.parent; p; p = p.parent) if (next.has(p.data.key)) return next.get(p.data.key);
    return prev.get(d.data.key);
  };
  const translate = (p) => `translate(${p.px},${p.py})`;
  const linkFromParent = (d) => roundedPath(linkPoints(next.get(d.source.data.key), next.get(d.target.data.key), L));
  const collapsedLink = (p) => { const a = linkStart(p, L); return roundedPath([a, a, a, a, a]); };

  const t = svg.transition('layout').duration(ANIM_MS).ease(d3.easeCubicOut);

  // ---- links ----
  const linkSel = linkLayer.selectAll('path.link').data(links, (d) => d.target.data.key);

  linkSel.enter().append('path')
    .attr('class', 'link')
    .attr('d', (d) => collapsedLink(enterFrom(d.target)))
    .attr('stroke-opacity', 0)
    .merge(linkSel)
    .attr('stroke', (d) => PALETTE[d.target.data.kind].link)
    .attr('stroke-width', (d) => (d.target.data.present ? 1.6 : 1.2))
    .attr('stroke-dasharray', (d) => (d.target.data.present ? null : '3 5'))
    .transition(t)
    .attr('d', linkFromParent)
    .attr('stroke-opacity', (d) => (d.target.data.present ? 0.9 : 0.55));

  linkSel.exit()
    .transition(t)
    .attr('d', (d) => collapsedLink(exitTo(d.target)))
    .attr('stroke-opacity', 0)
    .remove();

  // ---- nodes ----
  const nodeSel = nodeLayer.selectAll('g.node').data(nodes, (d) => d.data.key);

  const enter = nodeSel.enter().append('g')
    .attr('class', 'node')
    .attr('transform', (d) => translate(enterFrom(d)))
    .style('opacity', 0);

  enter.append('rect').attr('class', 'card').attr('rx', 9)
    .on('click', (event, d) => {
      event.stopPropagation();
      if (d.data.isPort) openPortDialog(d.data.socket);
      else if (!d.data.synthetic) openAliasDialog(d.data);
    })
    .on('contextmenu', (event, d) => {
      // Right-click a device card to name the socket it's plugged into.
      const socket = state.portModel && state.portModel.socketOf(d.data.portKey);
      if (!socket) return;
      event.preventDefault();
      openPortDialog(socket);
    })
    .on('mouseenter', (event, d) => showTooltip(event, d.data))
    .on('mousemove', positionTooltip)
    .on('mouseleave', hideTooltip);

  enter.append('text').attr('class', 'title').attr('font-size', 12.5).attr('font-weight', 600);
  enter.append('text').attr('class', 'subtitle').attr('font-size', 10.5);
  enter.append('text').attr('class', 'badge').attr('text-anchor', 'end').attr('font-size', 11).attr('font-weight', 600);

  enter.append('circle').attr('class', 'hit').attr('r', 13).attr('fill', 'transparent')
    .on('click', (event, d) => { event.stopPropagation(); toggleNode(d.data); });
  enter.append('circle').attr('class', 'dot').attr('r', 6).style('pointer-events', 'none');

  const merged = enter.merge(nodeSel);
  merged.each(function (d) { styleNode(d3.select(this), d, nodeGeometry(next.get(d.data.key).anchor, L), L); });
  merged.transition(t)
    .attr('transform', (d) => translate(next.get(d.data.key)))
    .style('opacity', 1);

  nodeSel.exit()
    .transition(t)
    .attr('transform', (d) => translate(exitTo(d)))
    .style('opacity', 0)
    .remove();

  state.positions = next;
  state.visible = nodes;

  document.getElementById('overlay').classList.toggle('hidden', root.children != null);
  if (!root.children) {
    showOverlay('No USB or serial devices found', state.showGhosts
      ? 'Plug something in — the diagram updates automatically.'
      : 'Nothing is connected right now. Turn on "Show disconnected" to see remembered devices.', false);
  }
}

function styleNode(g, d, geo, L) {
  const data = d.data;
  const pal = PALETTE[data.kind];
  const kids = visibleChildren(data);
  const expandable = !data.synthetic && kids.length > 0;
  const collapsed = expandable && state.collapsed.has(data.key);
  const alias = data.synthetic || data.isPort ? '' : aliasStore.get(data.deviceId);
  const ghost = data.kind === 'ghost';
  const port = data.kind === 'port';
  const portName = port ? portStore.get(data.socket) : '';

  g.classed('is-ghost', ghost || port);

  g.select('.card')
    .attr('x', geo.cardX).attr('y', geo.cardY).attr('width', L.cardW).attr('height', L.cardH)
    .attr('fill', pal.card)
    .attr('fill-opacity', ghost ? 0.55 : 1)
    .attr('stroke', pal.stroke)
    .attr('stroke-opacity', ghost ? 0.7 : port ? 0.75 : 0.9)
    .attr('stroke-width', data.kind === 'device' ? 1.5 : 1.2)
    .attr('stroke-dasharray', ghost ? '4 4' : port ? '6 4' : null)
    .style('cursor', data.synthetic ? 'default' : 'pointer');

  const badge = collapsed ? `+${kids.length}` : '';
  const textMax = L.cardW - 26 - (badge ? 34 : 0);
  g.select('.title')
    .attr('x', geo.textX).attr('y', geo.titleY)
    .attr('fill', alias || portName ? '#a5f3fc' : pal.text)
    .text(fitText(port ? portName || `Empty port ${data.socket.primary.number}` : alias || data.name, `600 12.5px ${FONT_STACK}`, textMax));

  const meta = [];
  if (port) {
    meta.push(portName ? `Empty · ${data.portLabel}` : 'Empty', socketKind(data.socket));
  } else if (alias) {
    meta.push(data.name);
  } else {
    if (data.portLabel) meta.push(data.portKey ? portText(data) : data.portLabel);
    if (data.comPort) meta.push(data.comPort);
    if (data.synthetic) meta.push(`${kids.length} top-level ${kids.length === 1 ? 'device' : 'devices'}`);
    else meta.push(data.deviceClass || 'Device');
  }
  if (ghost) meta.push('Disconnected');
  else if (data.kind === 'error') meta.push(data.status);
  g.select('.subtitle')
    .attr('x', geo.textX).attr('y', geo.subtitleY)
    .attr('fill', pal.sub)
    .attr('fill-opacity', ghost ? 0.9 : 0.85)
    .text(fitText(meta.join('  ·  '), `10.5px ${FONT_STACK}`, textMax));

  g.select('.badge').attr('x', geo.badgeX).attr('y', geo.badgeY).attr('fill', pal.stroke).text(badge);

  g.select('.hit').style('cursor', expandable ? 'pointer' : 'default');

  const dot = g.select('.dot');
  if (port) {
    dot.attr('r', 5.5).attr('fill', '#0b1a1f').attr('stroke', pal.dot).attr('stroke-width', 1.6)
      .attr('stroke-dasharray', null).attr('filter', null);
  } else if (ghost) {
    dot.attr('r', 5).attr('fill', '#0f172a').attr('stroke', pal.dot).attr('stroke-width', 1.4)
      .attr('stroke-dasharray', '1.5 2.2').attr('filter', null);
  } else if (expandable && !collapsed) {
    dot.attr('r', 6).attr('fill', '#0f172a').attr('stroke', pal.dot).attr('stroke-width', 2)
      .attr('stroke-dasharray', null).attr('filter', data.kind === 'device' ? 'url(#glow)' : null);
  } else {
    dot.attr('r', 6).attr('fill', pal.dot).attr('stroke', pal.dot).attr('stroke-width', 2)
      .attr('stroke-dasharray', null).attr('filter', data.kind === 'device' || data.kind === 'host' ? 'url(#glow)' : null);
  }
}

function toggleNode(data) {
  if (data.synthetic || visibleChildren(data).length === 0) return;
  if (state.collapsed.has(data.key)) state.collapsed.delete(data.key); else state.collapsed.add(data.key);
  saveCollapsed();
  hideTooltip();
  render();
}

/**
 * Zooms so the whole tree fits. `minScale` keeps text legible on big trees: when the tree
 * can't fit at that scale, it is anchored at the host node's edge along the depth axis and
 * centred on the host along the sibling axis, and the user pans from there.
 */
function fitToView(animate = true, minScale = 0.15) {
  if (!d3ok || !state.visible.length) return false;
  const L = currentLayout();
  const pts = state.visible.map((d) => state.positions.get(d.data.key));
  const boxes = pts.map((p) => {
    const b = nodeGeometry(p.anchor, L).box;
    return { x0: p.px + b.x0, x1: p.px + b.x1, y0: p.py + b.y0, y1: p.py + b.y1 };
  });
  const host = pts[0];
  const minX = d3.min(boxes, (b) => b.x0) - 24;
  const maxX = d3.max(boxes, (b) => b.x1) + 24;
  const minY = d3.min(boxes, (b) => b.y0) - 24;
  const maxY = d3.max(boxes, (b) => b.y1) + 24;
  const { width, height } = svg.node().getBoundingClientRect();
  if (!width || !height) return false; // view is hidden

  const scale = Math.max(minScale, Math.min(1.1, Math.min(width / (maxX - minX), height / (maxY - minY))));
  const overflowX = scale * (maxX - minX) > width;
  const overflowY = scale * (maxY - minY) > height;
  const tx = !overflowX ? width / 2 - (scale * (minX + maxX)) / 2
    : L.depthAxis === 'x' ? -scale * minX : width / 2 - scale * host.px;
  const ty = !overflowY ? height / 2 - (scale * (minY + maxY)) / 2
    : L.depthAxis === 'y' ? -scale * minY : height / 2 - scale * host.py;
  const transform = d3.zoomIdentity.translate(tx, ty).scale(scale);

  if (animate) svg.transition('fit').duration(550).ease(d3.easeCubicInOut).call(zoom.transform, transform);
  else svg.call(zoom.transform, transform);
  return true;
}

/** Switches to the topology view, expands the path to a device and centres it with a highlight. */
function focusInTopology(key) {
  const node = treeNode(key);
  if (!node) return false;
  for (let p = node.parent; p; p = p.parent) state.collapsed.delete(p.key);
  saveCollapsed();
  if (!node.present && !node.isPort && !state.showGhosts) {
    state.showGhosts = true;
    saveJSON(STORAGE.showGhosts, true);
    document.getElementById('toggleGhosts').checked = true;
  }
  setView('topology');
  render();

  const p = state.positions.get(key);
  if (!p) return false;
  const { width, height } = svg.node().getBoundingClientRect();
  const box = nodeGeometry(p.anchor, currentLayout()).box;
  const cx = p.px + (box.x0 + box.x1) / 2;
  const cy = p.py + (box.y0 + box.y1) / 2;
  svg.transition('fit').duration(600).ease(d3.easeCubicInOut)
    .call(zoom.transform, d3.zoomIdentity.translate(width / 2 - cx, height / 2 - cy).scale(1));

  nodeLayer.selectAll('g.node').classed('is-focus', (d) => d.data.key === key);
  setTimeout(() => nodeLayer.selectAll('g.node.is-focus').classed('is-focus', false), 2500);
  return true;
}

// ===========================================================================
// Tooltip
// ===========================================================================

const tooltip = document.getElementById('tooltip');

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function showTooltip(event, data) {
  const alias = data.synthetic || data.isPort ? '' : aliasStore.get(data.deviceId);
  const socket = data.isPort ? data.socket : state.portModel && state.portModel.socketOf(data.portKey);
  const portName = portStore.get(socket);
  tooltip.replaceChildren();

  const head = el('div', 'flex items-start justify-between gap-3');
  const titles = el('div', 'min-w-0');
  const title = data.isPort ? portName || `Empty port ${socket.primary.number}` : alias || data.name;
  titles.append(el('div', 'truncate text-[13px] font-semibold text-slate-100', title));
  if (alias) titles.append(el('div', 'truncate text-[11px] text-slate-400', data.name));
  head.append(titles);

  const pill = {
    ghost: ['Disconnected', 'bg-slate-700/60 text-slate-300 ring-slate-600'],
    error: [data.status, 'bg-amber-500/15 text-amber-300 ring-amber-500/40'],
    host: ['Host', 'bg-indigo-500/15 text-indigo-300 ring-indigo-500/40'],
    port: ['Empty port', 'bg-teal-500/15 text-teal-300 ring-teal-500/40'],
  }[data.kind] || ['Connected', 'bg-cyan-500/15 text-cyan-300 ring-cyan-500/40'];
  head.append(el('span', `shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ${pill[1]}`, pill[0]));
  tooltip.append(head);

  const grid = el('dl', 'mt-3 grid grid-cols-[88px_1fr] gap-x-3 gap-y-1.5');
  const row = (label, value, mono) => {
    grid.append(el('dt', 'text-slate-500', label));
    grid.append(el('dd', mono ? 'break-all font-mono text-[10.5px] leading-snug text-slate-300' : 'text-slate-200', value || '—'));
  };
  const footer = (text) => el('p', 'mt-3 border-t border-slate-800 pt-2 text-[10.5px] text-slate-500', text);

  if (data.synthetic) {
    tooltip.append(el('p', 'mt-2 text-slate-400', `${state.nodes.size} USB / serial devices known to Windows.`));
  } else if (data.isPort) {
    row('Hub', socket.primary.hubName);
    row('Ports', socketPorts(socket));
    row('Connector', socketKind(socket));
    row('Firmware', socket.connectable ? 'Marked as user-connectable' : 'Marked as internal');
    tooltip.append(grid, footer(portName ? 'Click to rename this port' : 'Click to name this port'));
  } else {
    row('Manufacturer', data.manufacturer);
    row('DeviceID', data.deviceId, true);
    row('Status', data.present ? data.status : `${data.status} (not present)`);
    row('Class', data.deviceClass);
    if (data.comPort) row('Serial port', data.comPort);
    if (socket) {
      row('Port', [portName, socketPorts(socket)].filter(Boolean).join(' — '));
      row('Connector', socketKind(socket));
      const speed = data.present && socket.ports.find((p) => p.key === data.portKey);
      if (speed && speed.connected) row('Speed', USB_SPEEDS[speed.speed] || '');
    } else {
      row('Location', [data.portLabel, data.locationInfo].filter(Boolean).join(' — '));
    }
    tooltip.append(grid, footer(socket ? 'Click to set an alias · right-click to name its port' : 'Click to set an alias'));
  }

  tooltip.classList.remove('hidden');
  positionTooltip(event);
}

function positionTooltip(event) {
  if (tooltip.classList.contains('hidden')) return;
  const pad = 16;
  const { width, height } = tooltip.getBoundingClientRect();
  let x = event.clientX + pad;
  let y = event.clientY + pad;
  if (x + width > window.innerWidth - 8) x = event.clientX - width - pad;
  if (y + height > window.innerHeight - 8) y = window.innerHeight - height - 8;
  tooltip.style.transform = `translate(${Math.max(8, x)}px, ${Math.max(8, y)}px)`;
}

function hideTooltip() {
  tooltip.classList.add('hidden');
}

// ===========================================================================
// Naming dialog — device aliases and port names (window.prompt() doesn't exist in Electron)
// ===========================================================================

const aliasModal = document.getElementById('aliasModal');
const aliasForm = document.getElementById('aliasForm');
const aliasInput = document.getElementById('aliasInput');
const aliasRemove = document.getElementById('aliasRemove');
let aliasTarget = null; // { save(value) -> toast text }

function openNameDialog({ title, subtitle, detail, current, label, placeholder, hint, save }) {
  hideTooltip();
  aliasTarget = { save };
  document.getElementById('aliasTitle').textContent = title;
  document.getElementById('aliasDeviceName').textContent = subtitle;
  document.getElementById('aliasDeviceId').textContent = detail;
  document.getElementById('aliasLabel').textContent = label;
  document.getElementById('aliasHint').textContent = hint;
  aliasInput.placeholder = placeholder;
  aliasInput.value = current;
  aliasRemove.classList.toggle('invisible', !current);
  aliasModal.classList.remove('hidden');
  aliasModal.classList.add('flex');
  aliasModal.setAttribute('aria-hidden', 'false');
  requestAnimationFrame(() => { aliasInput.focus(); aliasInput.select(); });
}

function openAliasDialog(data) {
  openNameDialog({
    title: 'Name this device',
    subtitle: data.name,
    detail: data.deviceId,
    current: aliasStore.get(data.deviceId),
    label: 'Alias',
    placeholder: 'e.g. Arduino Mega — bench 2',
    hint: 'Stored on this computer and tied to the device ID, so it survives unplugging and replugging. Leave empty to remove.',
    save: (value) => {
      aliasStore.set(data.deviceId, value);
      return value ? `Saved alias “${value}”` : `Alias removed from ${data.name}`;
    },
  });
}

/** Name a physical socket. `found` is the Port finder's description of what just happened. */
function openPortDialog(socket, found = '') {
  openNameDialog({
    title: found ? 'Port found — give it a name' : 'Name this port',
    subtitle: found || `${socket.primary.hubName}`,
    detail: `${socketPorts(socket)} · ${socketKind(socket)}${found ? ` · on ${socket.primary.hubName}` : ''}`,
    current: portStore.get(socket),
    label: 'Port name',
    placeholder: 'e.g. Rear panel — top left',
    hint: 'Names the physical socket (both its USB 2 and USB 3 halves). It stays even when nothing is plugged in. Leave empty to remove.',
    save: (value) => {
      portStore.set(socket, value);
      return value ? `Port named “${value}”` : 'Port name removed';
    },
  });
}

function closeAliasDialog() {
  aliasModal.classList.add('hidden');
  aliasModal.classList.remove('flex');
  aliasModal.setAttribute('aria-hidden', 'true');
  aliasTarget = null;
}

function commitAlias(value) {
  if (!aliasTarget) return;
  const message = aliasTarget.save(String(value).trim());
  closeAliasDialog();
  rebuildTree();
  DevicesView.refresh();
  toast(message);
}

aliasForm.addEventListener('submit', (e) => { e.preventDefault(); commitAlias(aliasInput.value); });
aliasRemove.addEventListener('click', () => commitAlias(''));
document.getElementById('aliasCancel').addEventListener('click', closeAliasDialog);
aliasModal.addEventListener('mousedown', (e) => { if (e.target === aliasModal) closeAliasDialog(); });

// ===========================================================================
// Chrome: header, overlay, toast
// ===========================================================================

const btnRescan = document.getElementById('btnRescan');
let toastTimer = null;

function toast(message, kind = 'info') {
  const box = document.getElementById('toast');
  box.textContent = message;
  box.className = 'pointer-events-none fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-lg px-4 py-2.5 text-xs font-medium shadow-xl ring-1 ' +
    (kind === 'error'
      ? 'bg-rose-950/95 text-rose-200 ring-rose-500/40'
      : 'bg-slate-900/95 text-slate-200 ring-slate-700');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => box.classList.add('hidden'), kind === 'error' ? 7000 : 3000);
}

function showOverlay(title, text, spinning) {
  document.getElementById('overlay').classList.remove('hidden');
  document.getElementById('overlayTitle').textContent = title;
  document.getElementById('overlayText').textContent = text;
  document.getElementById('overlaySpinner').classList.toggle('hidden', !spinning);
}

function setScanning(scanning) {
  btnRescan.disabled = scanning;
  document.getElementById('rescanIcon').classList.toggle('animate-spin', scanning);
  document.getElementById('rescanLabel').textContent = scanning ? 'Scanning…' : 'Force Rescan';
}

function setStat(slot, value, label, dotClass) {
  document.getElementById(`stat${slot}`).textContent = value;
  document.getElementById(`stat${slot}Label`).textContent = label;
  if (dotClass) document.getElementById(`stat${slot}Dot`).className = `h-1.5 w-1.5 rounded-full ${dotClass}`;
}

function updateStats() {
  if (state.view === 'devices') {
    const s = DevicesView.stats();
    setStat('A', s.connected, 'connected');
    setStat('B', s.disconnected, 'remembered');
    setStat('C', s.problems, s.problems === 1 ? 'problem' : 'problems', s.problems ? 'bg-amber-400' : 'bg-emerald-400');
    return;
  }
  let connected = 0, ghosts = 0, serial = 0;
  for (const n of state.nodes.values()) {
    if (n.present) connected++; else ghosts++;
    if (n.present && n.deviceClass === 'Ports') serial++;
  }
  setStat('A', connected, 'USB connected');
  setStat('B', ghosts, 'remembered');
  setStat('C', serial, 'serial ports', 'bg-sky-400');
}

function updateLiveStatus(payload) {
  const time = new Date(payload.scannedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  document.getElementById('lastScan').textContent = `Updated ${time} · ${(payload.durationMs / 1000).toFixed(1)} s`;

  const live = payload.watcher && payload.watcher !== 'none';
  document.getElementById('liveLabel').textContent = live ? `Live · ${payload.watcher}` : 'Manual refresh only';
  document.getElementById('livePing').classList.toggle('hidden', !live);
  document.getElementById('liveCore').className = `relative inline-flex h-2 w-2 rounded-full ${live ? 'bg-emerald-400' : 'bg-amber-400'}`;
}

function setView(view) {
  state.view = view;
  saveJSON(STORAGE.view, view);
  hideTooltip();

  const topology = view === 'topology';
  document.getElementById('viewTopology').classList.toggle('hidden', !topology);
  document.getElementById('viewDevices').classList.toggle('hidden', topology);
  document.getElementById('viewDevices').classList.toggle('flex', !topology);
  document.getElementById('topologyControls').classList.toggle('hidden', !topology);

  for (const tab of document.querySelectorAll('[data-view]')) {
    const active = tab.dataset.view === view;
    tab.setAttribute('aria-selected', String(active));
    tab.classList.toggle('bg-cyan-500', active);
    tab.classList.toggle('text-slate-950', active);
    tab.classList.toggle('text-slate-300', !active);
    tab.classList.toggle('hover:text-white', !active);
  }

  // The diagram can't measure itself while hidden, so do the first fit when it becomes visible.
  if (topology && !state.hasFitted && state.visible.length > 1) state.hasFitted = fitToView(false, 0.6);
  updateStats();
}

// ===========================================================================
// Confirm dialog + administrator helpers
// ===========================================================================

const confirmModal = document.getElementById('confirmModal');
let confirmResolve = null;

/** Promise<boolean>. `danger` styles the confirm button red; `warning` adds an amber callout. */
function confirmDialog({ title, message, warning = '', confirmLabel = 'Continue', danger = false }) {
  if (confirmResolve) confirmResolve(false);
  hideTooltip();
  document.getElementById('confirmTitle').textContent = title;
  document.getElementById('confirmMessage').textContent = message;
  const warn = document.getElementById('confirmWarning');
  warn.textContent = warning;
  warn.classList.toggle('hidden', !warning);
  const ok = document.getElementById('confirmOk');
  ok.textContent = confirmLabel;
  ok.className = `rounded-lg px-4 py-2 text-xs font-semibold focus:outline-none focus-visible:ring-2 ${
    danger ? 'bg-rose-500 text-white hover:bg-rose-400 focus-visible:ring-rose-200' : 'bg-cyan-500 text-slate-950 hover:bg-cyan-400 focus-visible:ring-cyan-200'}`;
  confirmModal.classList.remove('hidden');
  confirmModal.classList.add('flex');
  confirmModal.setAttribute('aria-hidden', 'false');
  requestAnimationFrame(() => document.getElementById(danger ? 'confirmCancel' : 'confirmOk').focus());
  return new Promise((resolve) => { confirmResolve = resolve; });
}

function closeConfirm(result) {
  confirmModal.classList.add('hidden');
  confirmModal.classList.remove('flex');
  confirmModal.setAttribute('aria-hidden', 'true');
  if (confirmResolve) confirmResolve(result);
  confirmResolve = null;
}

document.getElementById('confirmOk').addEventListener('click', () => closeConfirm(true));
document.getElementById('confirmCancel').addEventListener('click', () => closeConfirm(false));
confirmModal.addEventListener('mousedown', (e) => { if (e.target === confirmModal) closeConfirm(false); });

async function relaunchAsAdmin() {
  try {
    await window.api.relaunchAsAdmin();
  } catch (err) {
    toast(err.message, 'error');
  }
}

/** Runs `fn` when elevated; otherwise offers to restart Porter as administrator. */
async function withAdmin(what, fn) {
  if (state.admin) return fn();
  const ok = await confirmDialog({
    title: 'Administrator rights needed',
    message: `${what} needs Porter to run as administrator. Restart Porter as administrator now? Windows will ask for permission.`,
    confirmLabel: 'Restart as administrator',
  });
  if (ok) await relaunchAsAdmin();
  return undefined;
}

function updateAdminUi() {
  document.title = state.admin ? 'Porter (Administrator)' : 'Porter';
  document.getElementById('adminBadge').classList.toggle('hidden', !state.admin);
  document.getElementById('adminBadge').classList.toggle('inline-flex', state.admin);
  document.getElementById('btnRunAsAdmin').classList.toggle('hidden', state.admin);
  document.getElementById('btnRunAsAdmin').classList.toggle('inline-flex', !state.admin);
  DevicesView.refresh();
}

async function copyText(text) {
  try {
    await window.api.copyText(text);
    toast('Copied to clipboard');
  } catch (err) {
    toast(`Could not copy: ${err.message}`, 'error');
  }
}

// ===========================================================================
// Wiring
// ===========================================================================

function applyHardwareSnapshot(payload) {
  if (!payload) return;
  if (payload.error || !Array.isArray(payload.devices)) {
    toast(`Scan failed: ${payload.error || 'no data'}`, 'error');
    if (!state.tree) showOverlay('Hardware scan failed', payload.error || 'No data returned.', false);
    return;
  }

  state.lastPayload = payload;
  state.portModel = buildPortModel(payload.devices, payload.ports);
  rebuildTree();
  DevicesView.update(payload.devices);

  updateLiveStatus(payload);
  updateStats();

  if (!state.hasFitted && state.view === 'topology' && state.visible.length > 1) {
    state.hasFitted = fitToView(false, 0.6);
  }
  if (state.finder) checkFinder();
}

/** Rebuilds the USB tree from the last scan (after names or the "Show all ports" toggle change). */
function rebuildTree() {
  const payload = state.lastPayload;
  if (!payload) return;
  const { root, nodes, portNodes } = buildDeviceTree(payload.devices.filter(isTopologyDevice), state.portModel, state.showAllPorts);
  state.tree = root;
  state.nodes = nodes;
  state.portNodes = portNodes;
  render();
}

// ===========================================================================
// Port finder — plug something in (or unplug it) and Porter tells you which socket that was
// ===========================================================================

/** port key -> key of the device plugged into it right now */
function portOccupancy() {
  const map = new Map();
  for (const node of state.nodes.values()) {
    if (node.present && node.portKey) map.set(node.portKey, node.key);
  }
  return map;
}

function startFinder() {
  if (!state.lastPayload) return;
  state.finder = { baseline: portOccupancy() };
  setView('topology');
  document.getElementById('finderBanner').classList.remove('hidden');
  document.getElementById('finderBanner').classList.add('flex');
  document.getElementById('btnFindPort').classList.add('ring-2', 'ring-teal-400');
}

function stopFinder() {
  state.finder = null;
  document.getElementById('finderBanner').classList.add('hidden');
  document.getElementById('finderBanner').classList.remove('flex');
  document.getElementById('btnFindPort').classList.remove('ring-2', 'ring-teal-400');
}

function checkFinder() {
  const before = state.finder.baseline;
  const now = portOccupancy();
  const changed = [];
  for (const key of new Set([...before.keys(), ...now.keys()])) {
    if (before.get(key) !== now.get(key)) changed.push(key);
  }
  if (!changed.length) return;

  // Plugging in a hub also fills the hub's own ports; the socket you used is the shallowest one.
  changed.sort((a, b) => a.split('#').length - b.split('#').length);
  const portKey = changed[0];
  const socket = state.portModel.socketOf(portKey);
  if (!socket) return;
  stopFinder();

  const pluggedKey = now.get(portKey);
  const unpluggedKey = before.get(portKey);
  const plugged = pluggedKey && treeNode(pluggedKey);
  const unplugged = unpluggedKey && treeNode(unpluggedKey);
  const who = (node) => aliasStore.get(node.deviceId) || node.name;
  const found = plugged
    ? `You plugged “${who(plugged)}” into this port.`
    : unplugged ? `You unplugged “${who(unplugged)}” from this port.` : 'This port changed.';

  // Make sure the socket has a card to look at even when it's now empty and unnamed.
  if (!plugged && !state.showAllPorts && !portStore.get(socket)) {
    state.showAllPorts = true;
    saveJSON(STORAGE.showAllPorts, true);
    document.getElementById('toggleAllPorts').checked = true;
    rebuildTree();
  }
  focusInTopology(plugged ? plugged.key : `PORT:${socket.key}`);
  openPortDialog(socket, found);
}

function rescan() {
  if (!window.api) return;
  setScanning(true);
  window.api.requestRefresh().catch((err) => {
    setScanning(false);
    toast(`Could not start scan: ${err.message}`, 'error');
  });
}

function boot() {
  if (!d3ok) {
    showOverlay('D3.js failed to load', 'node_modules/d3 is missing — run npm install and restart.', false);
    return;
  }
  if (!window.api) {
    showOverlay('Bridge unavailable', 'window.api is missing — preload.js did not run.', false);
    return;
  }

  initDiagram();
  DevicesView.init();

  for (const tab of document.querySelectorAll('[data-view]')) {
    tab.addEventListener('click', () => setView(tab.dataset.view));
  }
  setView(state.view);

  const ghostToggle = document.getElementById('toggleGhosts');
  ghostToggle.checked = state.showGhosts;
  ghostToggle.addEventListener('change', () => {
    state.showGhosts = ghostToggle.checked;
    saveJSON(STORAGE.showGhosts, state.showGhosts);
    render();
  });

  const allPortsToggle = document.getElementById('toggleAllPorts');
  allPortsToggle.checked = state.showAllPorts;
  allPortsToggle.addEventListener('change', () => {
    state.showAllPorts = allPortsToggle.checked;
    saveJSON(STORAGE.showAllPorts, state.showAllPorts);
    rebuildTree();
  });

  document.getElementById('btnFindPort').addEventListener('click', () => (state.finder ? stopFinder() : startFinder()));
  document.getElementById('finderCancel').addEventListener('click', stopFinder);

  document.getElementById('btnExpand').addEventListener('click', () => {
    state.collapsed.clear();
    saveCollapsed();
    render();
    setTimeout(() => fitToView(), ANIM_MS);
  });

  document.getElementById('btnCollapse').addEventListener('click', () => {
    for (const node of state.nodes.values()) {
      if (node.children.length && node.parent) state.collapsed.add(node.key); // keep controllers open
    }
    saveCollapsed();
    render();
    setTimeout(() => fitToView(), ANIM_MS);
  });

  const layoutButtons = document.querySelectorAll('[data-layout]');
  const syncLayoutButtons = () => {
    for (const btn of layoutButtons) {
      const active = btn.dataset.layout === state.layout;
      btn.setAttribute('aria-pressed', String(active));
      btn.classList.toggle('bg-slate-700', active);
      btn.classList.toggle('text-white', active);
      btn.classList.toggle('text-slate-400', !active);
      btn.classList.toggle('hover:text-white', !active);
    }
  };
  syncLayoutButtons();
  for (const btn of layoutButtons) {
    btn.addEventListener('click', () => {
      if (btn.dataset.layout === state.layout) return;
      state.layout = btn.dataset.layout;
      saveJSON(STORAGE.layout, state.layout);
      syncLayoutButtons();
      hideTooltip();
      render();
      fitToView(true, 0.6);
    });
  }

  document.getElementById('btnFit').addEventListener('click', () => fitToView());
  btnRescan.addEventListener('click', rescan);

  document.getElementById('btnRunAsAdmin').addEventListener('click', relaunchAsAdmin);
  window.api.getSystemInfo()
    .then((info) => { state.admin = info.admin === true; updateAdminUi(); })
    .catch(() => updateAdminUi());

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !confirmModal.classList.contains('hidden')) closeConfirm(false);
    else if (e.key === 'Escape' && !aliasModal.classList.contains('hidden')) closeAliasDialog();
    else if (e.key === 'Escape' && state.finder) stopFinder();
    else if (e.key === 'Escape' && state.view === 'devices') DevicesView.closeDetail();
    if (e.key === 'F5') { e.preventDefault(); if (!btnRescan.disabled) rescan(); }
    if (e.key === 'f' && e.ctrlKey && state.view === 'devices') { e.preventDefault(); DevicesView.focusSearch(); }
  });
  window.addEventListener('blur', hideTooltip);

  window.api.onScanStateChange(({ scanning }) => setScanning(scanning));
  window.api.onHardwareUpdate(applyHardwareSnapshot);

  rescan();
}

// devices.js loads after this file; boot once every script has run.
document.addEventListener('DOMContentLoaded', boot);

