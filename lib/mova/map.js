'use strict';

const zlib = require('zlib');

const HEADER_SIZE = 27;
const FRAME_I = 73;
const FRAME_P = 80;
const INVALID_POS = 32767;
const PIXEL_WALL = 255;
const PIXEL_FLOOR = 254;
const MAX_VIEW = 160;

function readI16(buf, offset) {
  return buf.readInt16LE(offset);
}

function looksLikeMapHeader(buf) {
  if (!buf || buf.length < HEADER_SIZE) {
    return false;
  }
  const frameType = buf.readInt8(4);
  if (frameType !== FRAME_I && frameType !== FRAME_P) {
    return false;
  }
  const width = readI16(buf, 19);
  const height = readI16(buf, 21);
  return width > 0 && width < 4096 && height > 0 && height < 4096;
}

function tryInflate(buf) {
  try {
    return zlib.inflateSync(buf);
  } catch (_err) {
    try {
      return zlib.inflateRawSync(buf);
    } catch (_err2) {
      try {
        return zlib.gunzipSync(buf);
      } catch (_err3) {
        return null;
      }
    }
  }
}

function inflateMapString(raw) {
  if (Buffer.isBuffer(raw)) {
    if (looksLikeMapHeader(raw)) {
      return raw;
    }
    const inflated = tryInflate(raw);
    if (inflated && inflated.length) {
      return inflated;
    }
    return decodeBase64Map(raw.toString('utf8'));
  }
  return decodeBase64Map(String(raw || ''));
}

function decodeBase64Map(text) {
  let payload = String(text || '').trim();
  if (!payload) {
    throw new Error('Empty MOVAhome map payload');
  }
  if (payload.includes(',')) {
    payload = payload.split(',')[0];
  }
  payload = payload.replace(/_/g, '/').replace(/-/g, '+');
  const buf = Buffer.from(payload, 'base64');
  try {
    return zlib.inflateSync(buf);
  } catch (_err) {
    try {
      return zlib.inflateRawSync(buf);
    } catch (_err2) {
      return buf;
    }
  }
}

function parseHeader(buf) {
  if (!buf || buf.length < HEADER_SIZE) {
    throw new Error('MOVAhome map header is too short');
  }
  const pixelSize = readI16(buf, 17) || 50;
  const width = readI16(buf, 19);
  const height = readI16(buf, 21);
  return {
    mapIndex: readI16(buf, 0),
    frameId: readI16(buf, 2),
    frameType: buf.readInt8(4),
    robot: {
      x: readI16(buf, 5),
      y: readI16(buf, 7),
      angle: readI16(buf, 9),
    },
    charger: {
      x: readI16(buf, 11),
      y: readI16(buf, 13),
      angle: readI16(buf, 15),
    },
    pixelSize,
    width,
    height,
    left: Math.round(readI16(buf, 23) / pixelSize),
    top: Math.round(readI16(buf, 25) / pixelSize),
  };
}

function isValidPoint(point) {
  return point
    && Number.isFinite(point.x)
    && Number.isFinite(point.y)
    && point.x !== INVALID_POS
    && point.y !== INVALID_POS;
}

function worldToCell(point, header) {
  if (!isValidPoint(point) || !header.pixelSize) {
    return null;
  }
  const x = Math.round(point.x / header.pixelSize - header.left);
  const y = Math.round(header.height - 1 - (point.y / header.pixelSize - header.top));
  return { x, y, angle: point.angle || 0 };
}

function classifyPixel(value) {
  const n = value & 0xff;
  if (n === 0) {
    return 0;
  }
  if (n === PIXEL_WALL || n === 251 || (n >= 128 && n < PIXEL_FLOOR)) {
    return 2;
  }
  return 1;
}

function parsePath(tr, header) {
  if (!tr || typeof tr !== 'string') {
    return [];
  }
  const points = [];
  const re = /([SL])(-?\d+),(-?\d+)/g;
  let current = { x: 0, y: 0 };
  let match;
  while ((match = re.exec(tr))) {
    const op = match[1];
    const dx = Number(match[2]);
    const dy = Number(match[3]);
    if (op === 'S') {
      current = { x: dx, y: dy };
    } else {
      current = { x: current.x + dx, y: current.y + dy };
    }
    const cell = worldToCell(current, header);
    if (cell) {
      points.push(cell);
    }
  }
  return points.slice(-400);
}

function downsample(pixels, width, height) {
  const longest = Math.max(width, height, 1);
  const scale = longest > MAX_VIEW ? longest / MAX_VIEW : 1;
  const w = Math.max(1, Math.round(width / scale));
  const h = Math.max(1, Math.round(height / scale));
  const cells = new Array(w * h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const sx = Math.min(width - 1, Math.floor(x * scale));
      const sy = Math.min(height - 1, Math.floor(y * scale));
      cells[y * w + x] = classifyPixel(pixels[sy * width + sx]);
    }
  }
  return { cells, width: w, height: h, scale };
}

function scalePoint(point, scale, srcHeight, destHeight) {
  if (!point) {
    return null;
  }
  return {
    x: point.x / scale,
    y: destHeight - 1 - ((srcHeight - 1 - point.y) / scale),
    angle: point.angle || 0,
  };
}

function decodeMapPayload(raw, depth = 0) {
  const buf = inflateMapString(raw);
  const header = parseHeader(buf);
  const pixelCount = header.width * header.height;
  let extra = {};
  let pixels = null;
  if (header.frameType === FRAME_I && buf.length >= HEADER_SIZE + pixelCount && header.width > 0 && header.height > 0) {
    pixels = buf.subarray(HEADER_SIZE, HEADER_SIZE + pixelCount);
    const extraRaw = buf.subarray(HEADER_SIZE + pixelCount).toString('utf8').trim();
    if (extraRaw.startsWith('{')) {
      try {
        extra = JSON.parse(extraRaw);
      } catch (_err) {
        extra = {};
      }
    }
  }
  const robotPoint = (extra.robot && Array.isArray(extra.robot) && extra.robot.length >= 2)
    ? { x: extra.robot[0], y: extra.robot[1], angle: extra.robot[2] || header.robot.angle }
    : header.robot;
  const chargerPoint = (extra.charger && Array.isArray(extra.charger) && extra.charger.length >= 2)
    ? { x: extra.charger[0], y: extra.charger[1], angle: extra.charger[2] || header.charger.angle }
    : header.charger;

  return {
    header,
    frameType: header.frameType === FRAME_P ? 'P' : 'I',
    pixels,
    extra,
    robot: worldToCell(robotPoint, header),
    charger: worldToCell(chargerPoint, header),
    path: parsePath(extra.tr, header),
    rooms: collectRooms(extra, pixels, depth),
  };
}

function toViewModel(decoded, previous) {
  const source = (decoded && decoded.pixels)
    ? decoded
    : (previous && previous._source) || decoded;
  if (!source || !source.header) {
    return { ok: false, error: 'No map data' };
  }
  const header = source.header;
  const sampled = source.pixels
    ? downsample(source.pixels, header.width, header.height)
    : {
      cells: (previous && previous.cells) || [],
      width: (previous && previous.width) || 0,
      height: (previous && previous.height) || 0,
      scale: (previous && previous._scale) || 1,
    };

  const robotSrc = (decoded && decoded.robot) || source.robot;
  const chargerSrc = (decoded && decoded.charger) || source.charger;
  const pathSrc = (decoded && decoded.path && decoded.path.length)
    ? decoded.path
    : (source.path || []);
  const rooms = (decoded && Array.isArray(decoded.rooms) && decoded.rooms.length)
    ? decoded.rooms
    : ((previous && previous.rooms) || source.rooms || []);

  return {
    ok: sampled.cells.length > 0,
    width: sampled.width,
    height: sampled.height,
    cells: sampled.cells,
    robot: scalePoint(robotSrc, sampled.scale, header.height, sampled.height),
    charger: scalePoint(chargerSrc, sampled.scale, header.height, sampled.height),
    path: pathSrc.map((point) => scalePoint(point, sampled.scale, header.height, sampled.height)).filter(Boolean),
    rooms,
    frameType: (decoded && decoded.frameType) || source.frameType,
    _source: source,
    _scale: sampled.scale,
  };
}

function extractMapProperty(results, siid, piid) {
  if (!Array.isArray(results)) {
    return undefined;
  }
  const match = results.find((item) => item && item.siid === siid && item.piid === piid);
  if (!match) {
    return undefined;
  }
  if (match.value === undefined || match.value === null || match.value === '') {
    return undefined;
  }
  return match.value;
}

const ROOM_TYPE_KEYS = {
  0: 'room',
  1: 'living_room',
  2: 'primary_bedroom',
  3: 'study',
  4: 'kitchen',
  5: 'dining_room',
  6: 'bathroom',
  7: 'balcony',
  8: 'corridor',
  9: 'utility_room',
  10: 'closet',
  11: 'meeting_room',
  12: 'office',
  13: 'fitness_area',
  14: 'recreation_area',
  15: 'secondary_bedroom',
};

function looksLikeRoomName(text) {
  return Boolean(text) && text.length <= 40 && /^[\p{L}\p{N}\p{P}\p{Zs}]+$/u.test(text);
}

function decodeRoomName(value) {
  if (Array.isArray(value)) {
    return decodeRoomName(Buffer.from(value).toString('utf8'));
  }
  const text = String(value ?? '').trim();
  if (!text) {
    return '';
  }
  const base64ish = /^[A-Za-z0-9+/_-]+={0,2}$/.test(text) && text.length >= 4 && text.length % 4 === 0;
  if (!base64ish) {
    return looksLikeRoomName(text) ? text : '';
  }
  try {
    const buf = Buffer.from(text.replace(/_/g, '/').replace(/-/g, '+'), 'base64');
    const utf8 = buf.toString('utf8').replace(/\0/g, '').trim();
    if (looksLikeRoomName(utf8)) {
      return utf8;
    }
    if (buf.length % 2 === 0) {
      const utf16 = buf.toString('utf16le').replace(/\0/g, '').trim();
      if (looksLikeRoomName(utf16)) {
        return utf16;
      }
    }
  } catch (_err) {
    // not a room name
  }
  return '';
}

function nameFromRoomEntry(entry) {
  if (!entry || typeof entry !== 'object') {
    return '';
  }
  const candidates = [
    entry.name,
    entry.custom_name,
    entry.customName,
    entry.roomName,
    entry.nickname,
    entry.n,
  ];
  for (const candidate of candidates) {
    const decoded = decodeRoomName(candidate);
    if (decoded) {
      return decoded;
    }
  }
  return '';
}

function roomIsHidden(entry) {
  if (!entry || typeof entry !== 'object') {
    return false;
  }
  const value = entry.hidden ?? entry.hide ?? entry.ishide ?? entry.is_hide ?? entry.ishidden;
  return value === true || value === 1 || value === '1';
}

function asJsonObject(value) {
  if (!value) {
    return null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
      return null;
    }
    try {
      return JSON.parse(trimmed);
    } catch (_err) {
      return null;
    }
  }
  return typeof value === 'object' ? value : null;
}

function roomsFromSegInf(segInf) {
  const info = asJsonObject(segInf);
  if (!info || Array.isArray(info)) {
    return [];
  }
  const rooms = [];
  for (const key of Object.keys(info)) {
    const id = Number(key);
    if (!Number.isInteger(id) || id <= 0 || id >= 64) {
      continue;
    }
    const entry = info[key] && typeof info[key] === 'object' ? info[key] : {};
    const type = Number(entry.type);
    rooms.push({
      id,
      type: Number.isInteger(type) && type >= 0 ? type : 0,
      customName: nameFromRoomEntry(entry),
      hidden: roomIsHidden(entry),
      index: Number(entry.index) || id,
    });
  }
  return rooms;
}

function segmentIdsFromPixels(pixels, extra) {
  if (!pixels || !pixels.length) {
    return [];
  }
  if (extra && Number(extra.fsm) === 1) {
    return [];
  }
  let occupancy = 0;
  let segmented = 0;
  const ids = new Set();
  for (let i = 0; i < pixels.length; i += 1) {
    const pixel = pixels[i] & 0xff;
    if (pixel === 0) {
      continue;
    }
    if (pixel === PIXEL_FLOOR || pixel === PIXEL_WALL || pixel === 251) {
      occupancy += 1;
      continue;
    }
    const id = pixel & 0x3f;
    if (id > 0 && id < 61) {
      segmented += 1;
      ids.add(id);
    }
  }
  if (ids.size === 0 || (occupancy > 0 && occupancy >= segmented)) {
    return [];
  }
  return [...ids].sort((a, b) => a - b).map((id) => ({
    id,
    type: 0,
    customName: '',
    hidden: false,
    index: id,
  }));
}

function mergeRooms(...lists) {
  const byId = new Map();
  for (const list of lists) {
    for (const room of list || []) {
      const id = Number(room && room.id);
      if (!Number.isInteger(id) || id <= 0 || id >= 64) {
        continue;
      }
      const prev = byId.get(id);
      if (!prev) {
        byId.set(id, {
          id,
          type: Number(room.type) || 0,
          customName: room.customName || '',
          hidden: Boolean(room.hidden),
          index: Number(room.index) || id,
        });
        continue;
      }
      if (!prev.customName && room.customName) {
        prev.customName = room.customName;
      }
      if (!prev.type && room.type) {
        prev.type = Number(room.type) || 0;
      }
      if (room.hidden) {
        prev.hidden = true;
      }
    }
  }
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

function hiddenRoomIds(extra) {
  let list = extra && extra.delsr;
  if (typeof list === 'string') {
    try {
      list = JSON.parse(list);
    } catch (_err) {
      list = [];
    }
  }
  if (!Array.isArray(list)) {
    return new Set();
  }
  return new Set(list.map(Number).filter((id) => Number.isInteger(id) && id > 0 && id < 64));
}

function collectRooms(extra, pixels, depth) {
  const fromInfo = roomsFromSegInf(extra && extra.seg_inf);
  let fromNested = [];
  if (depth < 1 && extra && extra.rism) {
    try {
      const nested = decodeNestedMap(extra.rism, depth + 1);
      fromNested = (nested && nested.rooms) || [];
    } catch (_err) {
      fromNested = [];
    }
  }
  const fromPixels = fromInfo.length || fromNested.length
    ? []
    : segmentIdsFromPixels(pixels, extra);
  const rooms = mergeRooms(fromNested, fromInfo, fromPixels);
  const hidden = hiddenRoomIds(extra);
  for (const room of rooms) {
    if (hidden.has(room.id)) {
      room.hidden = true;
    }
  }
  return rooms;
}

function decodeNestedMap(value, depth) {
  if (!value) {
    return null;
  }
  if (typeof value === 'object') {
    return {
      extra: value,
      pixels: null,
      rooms: collectRooms(value, null, depth),
    };
  }
  return decodeMapPayload(value, depth);
}

function describeMapExtra(extra) {
  if (!extra || typeof extra !== 'object') {
    return null;
  }
  const info = asJsonObject(extra.seg_inf);
  const seg = [];
  if (info && !Array.isArray(info)) {
    for (const key of Object.keys(info).slice(0, 30)) {
      const entry = info[key];
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        seg.push({ key, value: String(entry).slice(0, 80) });
        continue;
      }
      const fields = {};
      for (const field of Object.keys(entry)) {
        const value = entry[field];
        if (value == null || typeof value === 'number' || typeof value === 'boolean') {
          fields[field] = value;
        } else if (typeof value === 'string') {
          fields[field] = value.slice(0, 80);
        } else if (Array.isArray(value)) {
          fields[field] = `array:${value.length}`;
        } else {
          fields[field] = typeof value;
        }
      }
      seg.push({ key, fields });
    }
  }
  const names = [];
  collectNameStrings(extra, names, 0);
  const extraFields = {};
  for (const key of ['room_id_type', 'delsr', 'cleanareaorder', 'cb_a', 'ar_match']) {
    if (extra[key] !== undefined) {
      extraFields[key] = JSON.stringify(extra[key]).slice(0, 700);
    }
  }
  return {
    keys: Object.keys(extra),
    rism: typeof extra.rism === 'string' ? extra.rism.length : (extra.rism ? typeof extra.rism : 0),
    seg,
    names: [...new Set(names)].slice(0, 40),
    extraFields,
  };
}

function collectNameStrings(value, found, depth) {
  if (depth > 4 || found.length > 40 || value == null) {
    return;
  }
  if (typeof value === 'string') {
    if (value.length > 160) {
      return;
    }
    const decoded = decodeRoomName(value);
    if (decoded && decoded.length > 1 && decoded !== value) {
      found.push(decoded);
    } else if (looksLikeRoomName(value) && /[A-Za-zÀ-ÿ]{3,}/.test(value)) {
      found.push(value);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.slice(0, 40).forEach((item) => collectNameStrings(item, found, depth + 1));
    return;
  }
  if (typeof value === 'object') {
    for (const key of Object.keys(value)) {
      if (key === 'rism' || key === 'tr') {
        continue;
      }
      collectNameStrings(value[key], found, depth + 1);
    }
  }
}

function parseRoomTagText(text) {
  const source = String(text || '');
  const ids = [];
  const pattern = /mova-room:(\d+)/g;
  let match = pattern.exec(source);
  while (match) {
    ids.push(Number(match[1]));
    match = pattern.exec(source);
  }
  const leftover = source
    .replace(/mova-room:\d+/g, '')
    .replace(/[\s,;.\u00a0\u200b\u200c\u200d\ufeff\u2060]+/g, '');
  return {
    empty: ids.length === 0 && leftover.length === 0,
    ids,
    invalid: leftover ? [leftover] : [],
  };
}

function splitRoomQuery(text) {
  return String(text || '')
    .split(/[,;\n|]+|(?:\s+en\s+)|(?:\s+and\s+)/i)
    .map((part) => part.trim())
    .filter(Boolean);
}

function matchRoomNames(rooms, text) {
  const wanted = splitRoomQuery(text);
  const list = Array.isArray(rooms) ? rooms : [];
  const matches = [];
  const missing = [];
  const ambiguous = [];
  for (const query of wanted) {
    const hits = list.filter((room) => String(room.name || '').toLowerCase() === query.toLowerCase());
    if (hits.length === 1) {
      matches.push(hits[0]);
    } else if (hits.length === 0) {
      missing.push(query);
    } else {
      ambiguous.push(query);
    }
  }
  return {
    ok: wanted.length > 0 && missing.length === 0 && ambiguous.length === 0,
    empty: wanted.length === 0,
    matches,
    missing,
    ambiguous,
  };
}

function formatRoomList(rooms, nameForType) {
  const list = Array.isArray(rooms) ? rooms : [];
  const named = list.map((room) => {
    const custom = room.customName && String(room.customName).trim();
    const type = Number(room.type) || 0;
    const typeKey = ROOM_TYPE_KEYS[type] || ROOM_TYPE_KEYS[0];
    const base = custom || (typeof nameForType === 'function' ? nameForType(typeKey, room) : typeKey) || String(room.id);
    return {
      id: room.id,
      type,
      customName: custom || '',
      hidden: Boolean(room.hidden),
      base,
    };
  });
  const counts = {};
  for (const room of named) {
    counts[room.base] = (counts[room.base] || 0) + 1;
  }
  return named.map((room) => ({
    id: room.id,
    type: room.type,
    customName: room.customName,
    hidden: room.hidden,
    name: counts[room.base] > 1 ? `${room.base} (${room.id})` : room.base,
  }));
}

function resolveRoomId(roomArg) {
  if (roomArg && typeof roomArg === 'object') {
    const id = Number(roomArg.id);
    if (Number.isInteger(id) && id > 0 && id < 64) {
      return id;
    }
  }
  if (typeof roomArg === 'number' && Number.isInteger(roomArg) && roomArg > 0 && roomArg < 64) {
    return roomArg;
  }
  if (typeof roomArg === 'string' && /^\d+$/.test(roomArg.trim())) {
    const id = Number(roomArg.trim());
    if (id > 0 && id < 64) {
      return id;
    }
  }
  return null;
}

function filenameFrom(value) {
  if (!value) {
    return '';
  }
  if (typeof value === 'string') {
    return value.split(',')[0];
  }
  if (typeof value === 'object') {
    return value.obj_name || value.object_name || value.filename || value.objectName || '';
  }
  return String(value);
}

function objectNameFromValue(value) {
  if (!value) {
    return '';
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        const name = objectNameFromValue(parsed);
        if (name) {
          return name;
        }
        if (parsed && typeof parsed === 'object') {
          return '';
        }
      } catch (_err) {
        return trimmed.split(',')[0];
      }
    }
    return trimmed.split(',')[0];
  }
  if (Array.isArray(value)) {
    return objectNameFromMapList(value);
  }
  if (typeof value === 'object') {
    return filenameFrom(value) || objectNameFromMapList(value);
  }
  return String(value);
}

function objectNameFromMapList(value) {
  if (!value) {
    return '';
  }
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch (_err) {
      return '';
    }
  }
  const list = Array.isArray(parsed)
    ? parsed
    : (parsed && (parsed.maps || parsed.list || parsed.records)) || [];
  if (!Array.isArray(list) || list.length === 0) {
    return filenameFrom(parsed);
  }
  const current = list.find((item) => item && (item.current || item.active || item.selected || item.isCurrent)) || list[0];
  if (typeof current === 'string') {
    return current.split(',')[0];
  }
  return filenameFrom(current);
}

function collectObjectNames(value, found = []) {
  if (!value) {
    return found;
  }
  if (typeof value === 'string') {
    const name = objectNameFromValue(value);
    if (name && name.includes('/') && !/^https?:\/\//.test(name) && !found.includes(name)) {
      found.push(name);
    }
    return found;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectObjectNames(item, found));
    return found;
  }
  if (typeof value === 'object') {
    const direct = filenameFrom(value);
    if (direct && direct.includes('/') && !/^https?:\/\//.test(direct) && !found.includes(direct)) {
      found.push(direct);
    }
    Object.keys(value).forEach((key) => {
      if (key === 'url' || key === 'md5') {
        return;
      }
      collectObjectNames(value[key], found);
    });
  }
  return found;
}

function decodeSavedMapContainer(raw) {
  let buf = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw || ''), 'utf8');
  if (!looksLikeMapHeader(buf)) {
    const inflated = tryInflate(buf);
    if (inflated && inflated.length) {
      buf = inflated;
    }
  }
  if (looksLikeMapHeader(buf)) {
    return decodeMapPayload(buf);
  }
  const text = buf.toString('utf8').trim();
  const jsonText = text.startsWith('{') || text.startsWith('[')
    ? text
    : (text.match(/[{[][\s\S]*[}\]]/) || [])[0];
  if (!jsonText) {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (_err) {
    return null;
  }
  const entries = [];
  if (Array.isArray(parsed)) {
    entries.push(...parsed);
  } else if (parsed && typeof parsed === 'object') {
    if (Array.isArray(parsed.mapstr)) {
      entries.push(...parsed.mapstr);
    }
    if (Array.isArray(parsed.maps)) {
      entries.push(...parsed.maps);
    }
    if (parsed.map) {
      entries.push(parsed);
    }
  }
  const currentId = currentSavedMapId(parsed);
  let fallback = null;
  for (const entry of entries) {
    const payload = typeof entry === 'string'
      ? entry
      : entry && (entry.map || entry.mapstr || entry.mapData || entry.data);
    if (!payload) {
      continue;
    }
    try {
      const decoded = decodeMapPayload(payload);
      if (!decoded || !decoded.pixels) {
        continue;
      }
      const entryId = Number(entry && (entry.id ?? entry.mapid ?? entry.map_id));
      const mapId = decoded.header && decoded.header.mapIndex;
      if (currentId != null && (mapId === currentId || entryId === currentId)) {
        return decoded;
      }
      if (!fallback) {
        fallback = decoded;
      }
    } catch (_err) {
      // try next saved map
    }
  }
  return fallback;
}

function currentSavedMapId(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const value = parsed.curr_id ?? parsed.currId ?? parsed.current_map_id ?? parsed.mapid;
  const id = Number(value);
  return Number.isInteger(id) ? id : null;
}

function objectNamesFromMapFile(raw) {
  let buf = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw || ''), 'utf8');
  if (!looksLikeMapHeader(buf)) {
    const inflated = tryInflate(buf);
    if (inflated && inflated.length) {
      buf = inflated;
    }
  }
  if (looksLikeMapHeader(buf)) {
    return [];
  }
  const text = buf.toString('utf8').trim();
  const start = text.startsWith('{') || text.startsWith('[')
    ? text
    : (text.match(/[{[][\s\S]*[}\]]/) || [])[0];
  if (!start) {
    return [];
  }
  try {
    return collectObjectNames(JSON.parse(start));
  } catch (_err) {
    return [];
  }
}

function serializeMapView(view, extra = {}) {
  const debugFields = {};
  if (view && view.debug) {
    debugFields.debug = view.debug;
  }
  if (view && view.objectName) {
    debugFields.objectName = view.objectName;
  }
  if (!view || !view.ok) {
    return {
      ok: false,
      error: (view && view.error) || 'No map data',
      ...debugFields,
      ...extra,
    };
  }
  return {
    ok: true,
    width: view.width,
    height: view.height,
    cells: view.cells,
    robot: view.robot || null,
    charger: view.charger || null,
    path: Array.isArray(view.path) ? view.path : [],
    frameType: view.frameType || 'I',
    ...debugFields,
    ...extra,
  };
}

module.exports = {
  HEADER_SIZE,
  FRAME_I,
  FRAME_P,
  inflateMapString,
  parseHeader,
  decodeMapPayload,
  toViewModel,
  extractMapProperty,
  objectNameFromValue,
  objectNameFromMapList,
  objectNamesFromMapFile,
  decodeSavedMapContainer,
  serializeMapView,
  worldToCell,
  formatRoomList,
  matchRoomNames,
  parseRoomTagText,
  resolveRoomId,
  mergeRooms,
  describeMapExtra,
  ROOM_TYPE_KEYS,
};
