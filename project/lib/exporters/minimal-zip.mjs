// minimal-zip.mjs [INLINE]
// STORE（无压缩）zip 写入器：正确的 local file header / central directory / EOCD，
// 文件名一律 UTF-8（general purpose flag bit 11）。零依赖，浏览器 / Node 通用。

const ZIP_CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c;
  }
  return table;
})();

// 固定 DOS 时间戳（2026-01-01 00:00:00），保证产物字节级可复现。
const ZIP_DOS_TIME = 0;
const ZIP_DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

const zipEncoder = new TextEncoder();

const zipU16 = (value) => new Uint8Array([value & 0xff, (value >>> 8) & 0xff]);

const zipU32 = (value) => new Uint8Array([
  value & 0xff,
  (value >>> 8) & 0xff,
  (value >>> 16) & 0xff,
  (value >>> 24) & 0xff,
]);

const zipConcat = (chunks) => {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const chunk of chunks) {
    out.set(chunk, cursor);
    cursor += chunk.length;
  }
  return out;
};

export function crc32(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes ?? []);
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    c = ZIP_CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

export function buildStoreZip(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('buildStoreZip: entries 必须是非空数组');
  }
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;
  for (const entry of entries) {
    const name = String(entry?.name ?? '');
    if (!name) throw new Error('buildStoreZip: entry.name 不能为空');
    const data = entry?.data instanceof Uint8Array ? entry.data : Uint8Array.from(entry?.data ?? []);
    const nameBytes = zipEncoder.encode(name);
    const checksum = crc32(data);
    const localHeader = zipConcat([
      zipU32(0x04034b50),      // local file header signature
      zipU16(20),              // version needed to extract (2.0)
      zipU16(0x0800),          // general purpose flags: bit 11 = UTF-8 文件名
      zipU16(0),               // compression method: 0 = STORE
      zipU16(ZIP_DOS_TIME),
      zipU16(ZIP_DOS_DATE),
      zipU32(checksum),
      zipU32(data.length),     // compressed size（STORE 与原始一致）
      zipU32(data.length),     // uncompressed size
      zipU16(nameBytes.length),
      zipU16(0),               // extra field length
      nameBytes,
    ]);
    localChunks.push(localHeader, data);
    centralChunks.push(zipConcat([
      zipU32(0x02014b50),      // central directory header signature
      zipU16(20),              // version made by
      zipU16(20),              // version needed to extract
      zipU16(0x0800),
      zipU16(0),
      zipU16(ZIP_DOS_TIME),
      zipU16(ZIP_DOS_DATE),
      zipU32(checksum),
      zipU32(data.length),
      zipU32(data.length),
      zipU16(nameBytes.length),
      zipU16(0),               // extra field length
      zipU16(0),               // comment length
      zipU16(0),               // disk number start
      zipU16(0),               // internal attributes
      zipU32(0),               // external attributes
      zipU32(offset),          // local header 相对偏移
      nameBytes,
    ]));
    offset += localHeader.length + data.length;
  }
  const centralBytes = zipConcat(centralChunks);
  const eocd = zipConcat([
    zipU32(0x06054b50),        // end of central directory signature
    zipU16(0),                 // disk number
    zipU16(0),                 // central directory start disk
    zipU16(entries.length),    // entries on this disk
    zipU16(entries.length),    // total entries
    zipU32(centralBytes.length),
    zipU32(offset),            // central directory 起始偏移
    zipU16(0),                 // comment length
  ]);
  return zipConcat([...localChunks, centralBytes, eocd]);
}
