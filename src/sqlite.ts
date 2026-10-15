import * as fs from "fs";

const MAX_PAYLOAD = 1_000_000;
const WAL_MAGIC_BE = 0x377f0682;
const WAL_MAGIC_LE = 0x377f0683;

/** Read selected ItemTable values without sqlite3, Python, or native bindings. Includes WAL pages. */
export function readItemValues(dbPath: string, keys: readonly string[]): Record<string, string> {
  const wanted = new Set(keys);
  const found: Record<string, string> = {};
  const fd = fs.openSync(dbPath, "r");
  let wal: WalIndex | null = null;
  try {
    const header = Buffer.alloc(100);
    if (fs.readSync(fd, header, 0, header.length, 0) < 100 || header.toString("utf8", 0, 16) !== "SQLite format 3\0") {
      throw new Error("Invalid SQLite database header");
    }
    const pageSize = header.readUInt16BE(16) === 1 ? 65536 : header.readUInt16BE(16);
    const reserved = header[20] ?? 0;
    wal = openWal(dbPath, pageSize);
    const readPage = (page: number) => readDbPage(fd, wal, page, pageSize);
    const root = findItemTableRoot(readPage, pageSize, reserved);
    if (root === null) throw new Error("Could not find ItemTable");
    walkTable(readPage, root, pageSize, reserved, (row) => {
      const key = row[0];
      const value = row[1];
      if (typeof key === "string" && typeof value === "string" && wanted.has(key)) {
        found[key] = value;
        wanted.delete(key);
      }
      return wanted.size > 0;
    });
    return found;
  } finally {
    if (wal) fs.closeSync(wal.fd);
    fs.closeSync(fd);
  }
}

interface WalIndex {
  fd: number;
  pages: Map<number, number>;
}

function openWal(dbPath: string, pageSize: number): WalIndex | null {
  const walPath = `${dbPath}-wal`;
  if (!fs.existsSync(walPath)) return null;
  const fd = fs.openSync(walPath, "r");
  try {
    const size = fs.fstatSync(fd).size;
    if (size < 32) return { fd, pages: new Map() };
    const header = Buffer.alloc(32);
    fs.readSync(fd, header, 0, 32, 0);
    const magic = header.readUInt32BE(0);
    if (magic !== WAL_MAGIC_BE && magic !== WAL_MAGIC_LE) {
      fs.closeSync(fd);
      return null;
    }
    const salt = header.subarray(16, 24);
    const frame = 24 + pageSize;
    const pages = new Map<number, number>();
    for (let offset = 32; offset + frame <= size; offset += frame) {
      const frameHeader = Buffer.alloc(24);
      fs.readSync(fd, frameHeader, 0, 24, offset);
      if (!frameHeader.subarray(8, 16).equals(salt)) break;
      const page = frameHeader.readUInt32BE(0);
      if (page > 0) pages.set(page, offset + 24);
    }
    return { fd, pages };
  } catch (err) {
    fs.closeSync(fd);
    throw err;
  }
}

function readDbPage(fd: number, wal: WalIndex | null, page: number, pageSize: number): Buffer | null {
  if (page < 1) return null;
  const buf = Buffer.alloc(pageSize);
  const walOffset = wal?.pages.get(page);
  const read = walOffset === undefined
    ? fs.readSync(fd, buf, 0, pageSize, (page - 1) * pageSize)
    : fs.readSync(wal!.fd, buf, 0, pageSize, walOffset);
  if (read <= 0) return null;
  return read === pageSize ? buf : buf.subarray(0, read);
}

function findItemTableRoot(readPage: (page: number) => Buffer | null, pageSize: number, reserved: number): number | null {
  let root: number | null = null;
  walkTable(readPage, 1, pageSize, reserved, (row) => {
    const [type, name, , page] = row;
    if (type === "table" && name === "ItemTable" && typeof page === "number" && page > 0) {
      root = page;
      return false;
    }
    return true;
  });
  return root;
}

function walkTable(
  readPage: (page: number) => Buffer | null,
  page: number,
  pageSize: number,
  reserved: number,
  onRow: (row: unknown[]) => boolean,
  seen = new Set<number>(),
): void {
  if (seen.has(page)) return;
  seen.add(page);
  const buf = readPage(page);
  if (!buf) return;
  const header = page === 1 ? 100 : 0;
  const kind = buf[header];
  if (kind !== 5 && kind !== 13) return;
  const cells = buf.readUInt16BE(header + 3);
  const pointers = header + (kind === 5 ? 12 : 8);
  if (kind === 5) {
    for (let i = 0; i < cells; i++) {
      const at = pointers + i * 2;
      if (at + 2 > buf.length) break;
      const cell = buf.readUInt16BE(at);
      if (cell + 4 <= buf.length) walkTable(readPage, buf.readUInt32BE(cell), pageSize, reserved, onRow, seen);
    }
    if (header + 12 <= buf.length) walkTable(readPage, buf.readUInt32BE(header + 8), pageSize, reserved, onRow, seen);
    return;
  }
  const usable = pageSize > 0 ? pageSize - reserved : buf.length;
  for (let i = 0; i < cells; i++) {
    const at = pointers + i * 2;
    if (at + 2 > buf.length) break;
    const row = readLeafRow(buf, buf.readUInt16BE(at), usable, readPage);
    if (row && !onRow(row)) return;
  }
}

function readLeafRow(
  page: Buffer,
  offset: number,
  usable: number,
  readPage: (page: number) => Buffer | null,
): unknown[] | null {
  if (offset >= page.length) return null;
  const payloadSize = readVarint(page, offset);
  if (!payloadSize) return null;
  const rowid = readVarint(page, payloadSize.next);
  if (!rowid || payloadSize.value > MAX_PAYLOAD) return null;
  const local = localPayloadBytes(usable, payloadSize.value);
  const start = rowid.next;
  if (local > payloadSize.value || start + local > page.length) return null;
  let payload: Buffer = page.subarray(start, start + local);
  if (local < payloadSize.value) {
    if (start + local + 4 > page.length) return null;
    const rest = readOverflow(readPage, page.readUInt32BE(start + local), payloadSize.value - local, usable);
    if (!rest) return null;
    payload = Buffer.concat([payload, rest]);
  }
  return parseRecord(payload);
}

function localPayloadBytes(usable: number, payload: number): number {
  if (usable < 40) return payload;
  const maxLocal = usable - 35;
  const minLocal = Math.floor(((usable - 12) * 32) / 255) - 23;
  if (payload <= maxLocal) return payload;
  const surplus = minLocal + ((payload - minLocal) % (usable - 4));
  return surplus <= maxLocal ? surplus : minLocal;
}

function readOverflow(
  readPage: (page: number) => Buffer | null,
  pageNo: number,
  remaining: number,
  usable: number,
): Buffer | null {
  const chunks: Buffer[] = [];
  const seen = new Set<number>();
  let left = remaining;
  while (left > 0) {
    if (pageNo < 1 || seen.has(pageNo)) return null;
    seen.add(pageNo);
    const page = readPage(pageNo);
    if (!page || page.length < 4) return null;
    const take = Math.min(left, Math.max(0, usable - 4), page.length - 4);
    chunks.push(page.subarray(4, 4 + take));
    left -= take;
    pageNo = page.readUInt32BE(0);
    if (left > 0 && pageNo === 0) return null;
  }
  return Buffer.concat(chunks);
}

function parseRecord(payload: Buffer): unknown[] | null {
  const header = readVarint(payload, 0, payload.length);
  if (!header || header.value > payload.length) return null;
  const types: number[] = [];
  let cursor = header.next;
  while (cursor < header.value) {
    const serial = readVarint(payload, cursor, header.value);
    if (!serial) return null;
    types.push(serial.value);
    cursor = serial.next;
  }
  const values: unknown[] = [];
  let at = header.value;
  for (const serial of types) {
    const value = readSerial(payload, at, serial);
    if (!value) return null;
    values.push(value.value);
    at += value.bytes;
  }
  return values;
}

function readSerial(buf: Buffer, offset: number, serial: number): { value: unknown; bytes: number } | null {
  const bytes = serialSize(serial);
  if (bytes === null || offset + bytes > buf.length) return null;
  if (serial === 0) return { value: null, bytes };
  if (serial === 8) return { value: 0, bytes };
  if (serial === 9) return { value: 1, bytes };
  if (serial >= 1 && serial <= 6) {
    const value = readSigned(buf, offset, bytes);
    return value === null ? null : { value, bytes };
  }
  if (serial === 7 || serial % 2 === 0) {
    return { value: buf.toString("utf8", offset, offset + bytes), bytes };
  }
  return { value: buf.toString("utf8", offset, offset + bytes), bytes };
}

function serialSize(serial: number): number | null {
  if (serial === 0 || serial === 8 || serial === 9) return 0;
  if (serial >= 1 && serial <= 4) return serial;
  if (serial === 5) return 6;
  if (serial === 6 || serial === 7) return 8;
  if (serial >= 12) return Math.floor((serial - 12) / 2);
  return null;
}

function readSigned(buf: Buffer, offset: number, bytes: number): number | null {
  if (bytes === 0) return 0;
  if (offset + bytes > buf.length) return null;
  let value = 0;
  for (let i = 0; i < bytes; i++) value = value * 256 + (buf[offset + i] ?? 0);
  const sign = 2 ** (bytes * 8 - 1);
  return value >= sign ? value - 2 ** (bytes * 8) : value;
}

function readVarint(buf: Buffer, offset: number, end = buf.length): { value: number; next: number } | null {
  let value = 0;
  for (let i = 0; i < 8 && offset + i < end; i++) {
    const byte = buf[offset + i];
    if (byte === undefined) return null;
    value = value * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) return { value, next: offset + i + 1 };
  }
  if (offset + 8 < end) {
    const last = buf[offset + 8];
    if (last === undefined) return null;
    return { value: value * 256 + last, next: offset + 9 };
  }
  return null;
}
