window.EFTForge = window.EFTForge || {};

/* exported collectSlotPairs, createSlotParentResolver, _pairsKey, convertBuildCode, extractBuildCode --called from other modules or index.html attributes */

/* ============================================================
   BUILD CODES
   Share codes: encode a build to text and back, in both the
   original (format 1) and the compact catalog-based (format 2)
   forms. Pure functions, no DOM; tests/build-code.test.js runs
   them directly.
============================================================ */

/* ===========================
   BUILD SERIALIZATION
=========================== */

// BFS walk → [[slotId, itemId], ...] in parents-before-children order
function collectSlotPairs(node) {
    const pairs = [];
    const queue = [node];
    while (queue.length > 0) {
        const current = queue.shift();
        for (const slotId in current.children) {
            pairs.push([slotId, current.children[slotId].item.id]);
            queue.push(current.children[slotId]);
        }
    }
    return pairs;
}

// Resolves which tree node a pair's slot belongs to while we rebuild a tree from
// pairs. A part installed twice gives two nodes the same slot IDs, so we keep
// every owner in the order it was attached and hand each pair the first one
// whose slot is still empty. collectSlotPairs emits copies and their children in
// the same breadth-first order, so that puts every part back where it was.
// slotsOf(itemId) returns that item's slots, or undefined if they aren't known.
function createSlotParentResolver(root, slotsOf) {
    const owners = {};
    function addNode(node) {
        for (const slot of slotsOf(node.item.id) || []) {
            (owners[slot.id] = owners[slot.id] || []).push(node);
        }
    }
    (function walk(node) {
        addNode(node);
        for (const slotId in node.children) walk(node.children[slotId]);
    }(root));
    return {
        addNode,
        parentFor: slotId => (owners[slotId] || []).find(node => !node.children[slotId]) || null,
    };
}

// Canonical sort key for a set of [slotId, itemId] pairs - order-independent
function _pairsKey(pairs) {
    return pairs.map(p => p[0] + ":" + p[1]).sort().join(",");
}

// Pack Tarkov's 24-character hex IDs as bytes and reuse the shared prefix of
// each preceding slot or item ID. Keep a string escape for nonstandard IDs.
function _writeBuildId(bytes, id, previous) {
    if (!/^[0-9a-f]{24}$/.test(id)) {
        const raw = new TextEncoder().encode(id);
        if (raw.length > 65535) throw new Error("Build ID too long");
        bytes.push(255, raw.length >> 8, raw.length & 255);
        for (const byte of raw) bytes.push(byte);
        return;
    }
    let shared = 0;
    while (shared < 24 && id[shared] === previous[shared]) shared++;
    bytes.push(shared);
    for (let i = shared; i < 24; i += 2) {
        bytes.push(parseInt(id[i], 16) * 16 + (i + 1 < 24 ? parseInt(id[i + 1], 16) : 0));
    }
}

function _readBuildId(bytes, cursor, previous) {
    if (cursor.index >= bytes.length) throw new Error("Truncated build code");
    const shared = bytes[cursor.index++];
    if (shared === 255) {
        if (cursor.index + 2 > bytes.length) throw new Error("Truncated build code");
        const size = bytes[cursor.index++] * 256 + bytes[cursor.index++];
        if (cursor.index + size > bytes.length) throw new Error("Truncated build code");
        const id = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(cursor.index, cursor.index + size));
        cursor.index += size;
        return id;
    }
    if (shared > 24 || shared > previous.length) throw new Error("Invalid build ID prefix");
    const size = Math.ceil((24 - shared) / 2);
    if (cursor.index + size > bytes.length) throw new Error("Truncated build code");
    let id = previous.slice(0, shared);
    for (let i = 0; i < size; i++) id += bytes[cursor.index++].toString(16).padStart(2, "0");
    return id.slice(0, 24);
}

function _buildCodeToBase64(bytes) {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function _buildCodeFromBase64(code) {
    if (!/^[A-Za-z0-9_-]+$/.test(code)) throw new Error("Invalid build code alphabet");
    const binary = atob(code.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    if (_buildCodeToBase64(bytes) !== code) throw new Error("Invalid build code padding");
    return bytes;
}

// Refer to immutable item and slot dictionaries instead of repeating full IDs.
// Use each slot's frozen candidate list to store most attachments in a few bits.
const _buildCodeCatalogCache = new Map();

function _getBuildCodeCatalog(version) {
    const data = EFTForge.buildCodeCatalogs?.[version];
    if (!data) return null;
    if (!_buildCodeCatalogCache.has(version)) {
        const items = new Map(data.items.map((id, index) => [id, index]));
        const slots = new Map();
        for (const [parent, rows] of Object.entries(data.slots)) {
            rows.forEach(([id], index) => slots.set(id, { parent: Number(parent), index }));
        }
        _buildCodeCatalogCache.set(version, { data, items, slots });
    }
    return _buildCodeCatalogCache.get(version);
}

function _buildCodeBits(choices) {
    return Math.ceil(Math.log2(Math.max(1, choices)));
}

function _buildCodeChecksum(bytes) {
    let crc = 0xffff;
    for (const byte of bytes) {
        crc ^= byte << 8;
        for (let bit = 0; bit < 8; bit++) crc = ((crc << 1) ^ ((crc & 0x8000) ? 0x1021 : 0)) & 0xffff;
    }
    return crc;
}

function _encodeDictionaryBuildCode(payload) {
    const version = 1;
    const catalog = _getBuildCodeCatalog(version);
    if (!catalog || payload.p.length > 255) return null;
    const { data, items, slots } = catalog;
    const ids = [payload.g, ...payload.p.map(pair => pair[1]), payload.a, payload.ua].filter(Boolean);
    if (ids.some(id => !items.has(id))) return null;
    const bytes = [version];
    let position = 8;
    const write = (value, width) => {
        for (let bit = width - 1; bit >= 0; bit--) {
            if (position % 8 === 0) bytes.push(0);
            bytes[position >> 3] |= ((value >>> bit) & 1) << (7 - position % 8);
            position++;
        }
    };
    const itemBits = _buildCodeBits(data.items.length);
    const flags = (payload.a ? 1 : 0) | (payload.ua ? 2 : 0);
    write(flags, 2);
    write(payload.p.length, 8);
    write(items.get(payload.g), itemBits);
    const parents = [items.get(payload.g)];
    for (const [slotId, itemId] of payload.p) {
        const slot = slots.get(slotId);
        if (!slot) return null;
        const parent = parents.indexOf(slot.parent);
        if (parent < 0) return null;
        const rows = data.slots[slot.parent];
        const candidates = rows[slot.index][1];
        const item = items.get(itemId);
        const choice = candidates.indexOf(item);
        write(parent, _buildCodeBits(parents.length));
        write(slot.index, _buildCodeBits(rows.length));
        write(choice < 0 ? candidates.length : choice, _buildCodeBits(candidates.length + 1));
        // Preserve known items even when the frozen slot list did not allow them.
        if (choice < 0) write(item, itemBits);
        parents.push(item);
    }
    if (flags & 1) write(items.get(payload.a), itemBits);
    if (flags & 2) write(items.get(payload.ua), itemBits);
    const crc = _buildCodeChecksum(bytes);
    bytes.push(crc >> 8, crc & 255);
    return "3." + _buildCodeToBase64(bytes);
}

function _decodeDictionaryBuildCode(code) {
    const bytes = _buildCodeFromBase64(code.slice(2));
    if (bytes.length < 4) throw new Error("Truncated build code");
    const end = bytes.length - 2;
    if (_buildCodeChecksum(bytes.subarray(0, end)) !== bytes[end] * 256 + bytes[end + 1]) {
        throw new Error("Build code checksum mismatch");
    }
    const catalog = _getBuildCodeCatalog(bytes[0]);
    if (!catalog) throw new Error("Unknown build code catalog");
    const { data } = catalog;
    let position = 8;
    const read = width => {
        if (position + width > end * 8) throw new Error("Truncated build code");
        let value = 0;
        for (let bit = 0; bit < width; bit++, position++) {
            value = value * 2 + ((bytes[position >> 3] >> (7 - position % 8)) & 1);
        }
        return value;
    };
    const itemBits = _buildCodeBits(data.items.length);
    const readItem = () => {
        const item = read(itemBits);
        if (item >= data.items.length) throw new Error("Invalid item index");
        return item;
    };
    const flags = read(2), count = read(8), gun = readItem();
    const payload = { v: 1, g: data.items[gun], p: [] };
    const parents = [gun];
    for (let i = 0; i < count; i++) {
        const parent = read(_buildCodeBits(parents.length));
        if (parent >= parents.length) throw new Error("Invalid parent index");
        const rows = data.slots[parents[parent]];
        if (!rows?.length) throw new Error("Missing parent slots");
        const slot = rows[read(_buildCodeBits(rows.length))];
        if (!slot) throw new Error("Invalid slot index");
        const choice = read(_buildCodeBits(slot[1].length + 1));
        if (choice > slot[1].length) throw new Error("Invalid attachment index");
        const item = choice === slot[1].length ? readItem() : slot[1][choice];
        payload.p.push([slot[0], data.items[item]]);
        parents.push(item);
    }
    if (flags & 1) payload.a = data.items[readItem()];
    if (flags & 2) payload.ua = data.items[readItem()];
    const remaining = end * 8 - position;
    if (remaining > 7 || read(remaining) !== 0) throw new Error("Trailing build code data");
    return payload;
}

function encodeBuildCode(payload, format = 3) {
    if (payload.v !== 1 || typeof payload.g !== "string" || !Array.isArray(payload.p) ||
            !payload.p.every(pair => Array.isArray(pair) && pair.length === 2 &&
                pair.every(id => typeof id === "string")) ||
            (payload.a != null && typeof payload.a !== "string") ||
            (payload.ua != null && typeof payload.ua !== "string")) throw new Error("Invalid build payload");
    if (format === 1) return LZString.compressToEncodedURIComponent(JSON.stringify(payload));
    if (format === 3) {
        const compact = _encodeDictionaryBuildCode(payload);
        // Keep new or removed IDs lossless until a later dictionary includes them.
        const complete = encodeBuildCode(payload, 2);
        return compact && compact.length < complete.length ? compact : complete;
    }
    if (format !== 2) throw new Error("Unknown build code format");
    if (payload.p.length > 65535) throw new Error("Too many attachments");
    const flags = (payload.a ? 1 : 0) | (payload.ua ? 2 : 0);
    const bytes = [flags, payload.p.length >> 8, payload.p.length & 255];
    _writeBuildId(bytes, payload.g, "");
    let lastSlot = payload.g, lastItem = payload.g;
    for (const [slot, item] of payload.p) {
        _writeBuildId(bytes, slot, lastSlot);
        _writeBuildId(bytes, item, lastItem);
        lastSlot = slot;
        lastItem = item;
    }
    if (flags & 1) _writeBuildId(bytes, payload.a, lastItem);
    if (flags & 2) _writeBuildId(bytes, payload.ua, lastItem);
    return "2." + _buildCodeToBase64(bytes);
}

function _decodeCompactBuildCode(code) {
    const bytes = _buildCodeFromBase64(code.slice(2));
    if (bytes.length < 4 || bytes[0] & ~3) throw new Error("Invalid build code header");
    const flags = bytes[0], count = bytes[1] * 256 + bytes[2];
    const cursor = { index: 3 };
    const gun = _readBuildId(bytes, cursor, "");
    const payload = { v: 1, g: gun, p: [] };
    let lastSlot = gun, lastItem = gun;
    for (let i = 0; i < count; i++) {
        const slot = _readBuildId(bytes, cursor, lastSlot);
        const item = _readBuildId(bytes, cursor, lastItem);
        payload.p.push([slot, item]);
        lastSlot = slot;
        lastItem = item;
    }
    if (flags & 1) payload.a = _readBuildId(bytes, cursor, lastItem);
    if (flags & 2) payload.ua = _readBuildId(bytes, cursor, lastItem);
    if (cursor.index !== bytes.length) throw new Error("Trailing build code data");
    return payload;
}

function convertBuildCode(code, format = 3) {
    const payload = decodeBuildCode(code);
    if (!payload) return null;
    try {
        return encodeBuildCode(payload, format);
    } catch {
        return null;
    }
}

// Pull the share code out of whatever the user pasted: a bare code comes back
// as is, a link carrying ?build= comes back as just its decoded code. No code
// format uses "?", "&" or "=", so a bare code never matches the link pattern.
function extractBuildCode(text) {
    const trimmed = String(text ?? "").trim();
    const match = trimmed.match(/[?&#]build=([^&#\s]+)/);
    if (!match) return trimmed;
    try {
        return decodeURIComponent(match[1]);
    } catch {
        return match[1];
    }
}

// Decode a build code → { v, g, p } or null on error
function decodeBuildCode(code) {
    try {
        const trimmed = code.trim();
        let payload;
        if (trimmed.startsWith("3.")) payload = _decodeDictionaryBuildCode(trimmed);
        else if (trimmed.startsWith("2.")) payload = _decodeCompactBuildCode(trimmed);
        else payload = JSON.parse(LZString.decompressFromEncodedURIComponent(trimmed));
        if (payload.v !== 1) throw new Error("Unknown version");
        if (typeof payload.g !== "string") throw new Error("Missing gun ID");
        if (!Array.isArray(payload.p)) throw new Error("Missing slot pairs");
        return payload;
    } catch {
        return null;
    }
}
