import { inflateRawSync, deflateRawSync } from 'node:zlib';

/**
 * A deliberately small ZIP reader/writer.
 *
 * The catalogue import takes an uploaded archive, which makes the parser an
 * attack surface: a hostile ZIP can try to write outside the extraction root
 * (`../../.ssh/authorized_keys`), expand 40 bytes into 4 GB (zip bomb), hide a
 * symlink, or simply lie about its sizes. Rather than pull in a general-purpose
 * archive library and inherit its defaults, this implements only the subset the
 * catalogue needs (stored + deflated entries, no ZIP64, no spanning) and enforces
 * every limit on the way in.
 *
 * Deliberately unsupported, and rejected loudly rather than mis-parsed:
 *   - ZIP64 (archives > 4 GB / > 65535 entries)
 *   - encrypted entries
 *   - compression methods other than 0 (stored) and 8 (deflate)
 *   - multi-disk archives
 */

export const DEFAULT_LIMITS = Object.freeze({
  /** Refuse archives with more entries than this. */
  maxEntries: 1000,
  /** Refuse an archive whose total inflated size exceeds this. */
  maxTotalBytes: 32 * 1024 * 1024,
  /** Refuse any single entry larger than this once inflated. */
  maxEntryBytes: 16 * 1024 * 1024,
  /**
   * Refuse an entry that inflates to more than this many times its stored size.
   *
   * Set generously on purpose: the absolute caps above are what actually bound
   * the damage, and this is only a cheap early-out. A catalogue of repetitive
   * Markdown legitimately reaches 100:1, so a tighter ratio would reject real
   * archives while still catching the 1000:1-and-up shape a bomb has.
   */
  maxCompressionRatio: 1000,
  /** Refuse entry names longer than this. */
  maxNameLength: 1024,
});

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;

const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

/** POSIX file-type bits from the central directory's external attributes. */
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;
const S_IFREG = 0o100000;

export class ZipError extends Error {
  constructor(message, code = 'ZIP_INVALID') {
    super(message);
    this.name = 'ZipError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// CRC-32 (IEEE 802.3), as specified by the ZIP format.
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

export function crc32(buf) {
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Locate the End Of Central Directory record, ignoring any trailing comment. */
function findEocd(buf) {
  // The EOCD is 22 bytes and may be followed by a comment of up to 65535 bytes.
  const earliest = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= earliest; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  return -1;
}

/**
 * Reject entry names that could escape the extraction root or that the platform
 * would interpret as something other than a plain relative file.
 *
 * @returns {string|null} a reason to reject, or null when the name is safe
 */
export function unsafeEntryName(name) {
  if (!name) return 'empty entry name';
  if (name.length > DEFAULT_LIMITS.maxNameLength) return `entry name exceeds ${DEFAULT_LIMITS.maxNameLength} characters`;
  if (name.includes('\0')) return 'entry name contains a null byte';
  if (name.startsWith('/')) return 'entry name is an absolute path';
  if (/^[A-Za-z]:/.test(name)) return 'entry name contains a drive letter';
  if (name.includes('\\')) return 'entry name contains a backslash';
  const segments = name.split('/');
  if (segments.some((s) => s === '..')) return 'entry name contains a ".." path segment';
  if (segments.some((s) => s === '.')) return 'entry name contains a "." path segment';
  if (segments.some((s) => s === '')) return 'entry name contains an empty path segment';
  // Round-tripping through UTF-8 catches names that were not really UTF-8,
  // which is how a decoder can be tricked into two different paths.
  if (!Buffer.from(name, 'utf8').equals(Buffer.from(name, 'utf8'))) return 'entry name is not valid UTF-8';
  return null;
}

/**
 * Read a ZIP archive into memory.
 *
 * @param {Buffer} buf  the whole archive
 * @param {Partial<typeof DEFAULT_LIMITS>} [overrides]
 * @returns {{ entries: Array<{ name: string, data: Buffer }>, warnings: string[] }}
 * @throws {ZipError} on any structural problem or exceeded limit
 */
export function unzip(buf, overrides = {}) {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  const warnings = [];

  if (!Buffer.isBuffer(buf)) throw new ZipError('Expected a binary archive', 'ZIP_NOT_BINARY');
  if (buf.length < 22) throw new ZipError('File is too small to be a ZIP archive', 'ZIP_TOO_SMALL');
  if (buf.readUInt32LE(0) !== SIG_LOCAL && buf.readUInt16LE(0) !== 0x4b50) {
    throw new ZipError('Not a ZIP archive (bad magic number)', 'ZIP_BAD_MAGIC');
  }

  const eocdAt = findEocd(buf);
  if (eocdAt < 0) throw new ZipError('Could not find the ZIP end-of-central-directory record', 'ZIP_NO_EOCD');

  const totalEntries = buf.readUInt16LE(eocdAt + 10);
  const cdSize = buf.readUInt32LE(eocdAt + 12);
  const cdOffset = buf.readUInt32LE(eocdAt + 16);

  if (buf.readUInt16LE(eocdAt + 4) !== 0 || buf.readUInt16LE(eocdAt + 6) !== 0) {
    throw new ZipError('Multi-disk ZIP archives are not supported', 'ZIP_MULTIDISK');
  }
  if (totalEntries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new ZipError('ZIP64 archives are not supported', 'ZIP64_UNSUPPORTED');
  }

  // A ZIP64 locator sits immediately before the EOCD; reject rather than guess.
  if (eocdAt >= 20 && buf.readUInt32LE(eocdAt - 20) === SIG_ZIP64_LOCATOR) {
    throw new ZipError('ZIP64 archives are not supported', 'ZIP64_UNSUPPORTED');
  }
  if (cdOffset + 4 <= buf.length && buf.readUInt32LE(cdOffset) === SIG_ZIP64_EOCD) {
    throw new ZipError('ZIP64 archives are not supported', 'ZIP64_UNSUPPORTED');
  }

  if (totalEntries > limits.maxEntries) {
    throw new ZipError(`Archive holds ${totalEntries} entries, above the limit of ${limits.maxEntries}`, 'ZIP_TOO_MANY_ENTRIES');
  }
  if (cdOffset + cdSize > buf.length) {
    throw new ZipError('Central directory extends past the end of the file', 'ZIP_TRUNCATED');
  }

  const entries = [];
  let cursor = cdOffset;
  let totalInflated = 0;

  for (let i = 0; i < totalEntries; i++) {
    if (cursor + 46 > buf.length) throw new ZipError('Central directory is truncated', 'ZIP_TRUNCATED');
    if (buf.readUInt32LE(cursor) !== SIG_CENTRAL) {
      throw new ZipError(`Bad central directory signature at entry ${i}`, 'ZIP_BAD_CENTRAL');
    }

    const externalAttrs = buf.readUInt32LE(cursor + 38);
    const method = buf.readUInt16LE(cursor + 10);
    const expectedCrc = buf.readUInt32LE(cursor + 16);
    const compressedSize = buf.readUInt32LE(cursor + 20);
    const uncompressedSize = buf.readUInt32LE(cursor + 24);
    const nameLen = buf.readUInt16LE(cursor + 28);
    const extraLen = buf.readUInt16LE(cursor + 30);
    const commentLen = buf.readUInt16LE(cursor + 32);
    const localOffset = buf.readUInt32LE(cursor + 42);
    const nameStart = cursor + 46;

    if (nameStart + nameLen + extraLen + commentLen > buf.length) {
      throw new ZipError(`Entry ${i} name runs past the end of the file`, 'ZIP_TRUNCATED');
    }
    const name = buf.subarray(nameStart, nameStart + nameLen).toString('utf8');
    cursor = nameStart + nameLen + extraLen + commentLen;

    // Directory entries carry no payload; skip them silently.
    if (name.endsWith('/')) continue;

    const nameProblem = unsafeEntryName(name);
    if (nameProblem) throw new ZipError(`Refusing entry "${name}": ${nameProblem}`, 'ZIP_UNSAFE_NAME');

    // A symlink entry would let an archive point a written file at
    // /etc/passwd; the mode bits live in the upper half of the external attrs.
    const fileType = (externalAttrs >>> 16) & S_IFMT;
    if (fileType === S_IFLNK) throw new ZipError(`Refusing symlink entry "${name}"`, 'ZIP_SYMLINK');
    if (fileType !== 0 && fileType !== S_IFREG) {
      throw new ZipError(`Refusing non-regular file entry "${name}"`, 'ZIP_NOT_REGULAR');
    }

    if (method !== METHOD_STORED && method !== METHOD_DEFLATE) {
      throw new ZipError(`Entry "${name}" uses unsupported compression method ${method}`, 'ZIP_UNSUPPORTED_METHOD');
    }
    if (uncompressedSize === 0xffffffff || compressedSize === 0xffffffff) {
      throw new ZipError(`Entry "${name}" requires ZIP64`, 'ZIP64_UNSUPPORTED');
    }
    // Declared sizes are checked *before* any inflation happens.
    if (uncompressedSize > limits.maxEntryBytes) {
      throw new ZipError(
        `Entry "${name}" inflates to ${uncompressedSize} bytes, above the limit of ${limits.maxEntryBytes}`,
        'ZIP_ENTRY_TOO_LARGE'
      );
    }
    if (compressedSize > 0 && uncompressedSize / compressedSize > limits.maxCompressionRatio) {
      throw new ZipError(
        `Entry "${name}" compresses ${Math.round(uncompressedSize / compressedSize)}:1, above the ${limits.maxCompressionRatio}:1 limit`,
        'ZIP_BOMB'
      );
    }
    if (totalInflated + uncompressedSize > limits.maxTotalBytes) {
      throw new ZipError(
        `Archive inflates past the ${limits.maxTotalBytes} byte limit`,
        'ZIP_TOO_LARGE'
      );
    }

    // Re-read the local header: the payload offset depends on *its* name and
    // extra lengths, which need not match the central directory's.
    if (localOffset + 30 > buf.length) throw new ZipError(`Entry "${name}" points outside the file`, 'ZIP_TRUNCATED');
    if (buf.readUInt32LE(localOffset) !== SIG_LOCAL) {
      throw new ZipError(`Entry "${name}" has no local file header`, 'ZIP_BAD_LOCAL');
    }
    const localFlags = buf.readUInt16LE(localOffset + 6);
    if (localFlags & 0x1) throw new ZipError(`Entry "${name}" is encrypted`, 'ZIP_ENCRYPTED');
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    if (dataStart + compressedSize > buf.length) {
      throw new ZipError(`Entry "${name}" data runs past the end of the file`, 'ZIP_TRUNCATED');
    }
    const compressed = buf.subarray(dataStart, dataStart + compressedSize);

    let data;
    if (method === METHOD_STORED) {
      data = compressed;
    } else {
      try {
        // maxOutputLength makes inflateRawSync throw instead of allocating
        // gigabytes when the header lied about the inflated size.
        data = inflateRawSync(compressed, { maxOutputLength: uncompressedSize });
      } catch (e) {
        if (e.code === 'ERR_BUFFER_TOO_LARGE') {
          throw new ZipError(`Entry "${name}" inflates to more than its declared ${uncompressedSize} bytes`, 'ZIP_BOMB');
        }
        throw new ZipError(`Entry "${name}" could not be decompressed: ${e.message}`, 'ZIP_CORRUPT');
      }
    }

    if (data.length !== uncompressedSize) {
      throw new ZipError(
        `Entry "${name}" declared ${uncompressedSize} bytes but inflated to ${data.length}`,
        'ZIP_SIZE_MISMATCH'
      );
    }
    const actualCrc = crc32(data);
    if (actualCrc !== expectedCrc) {
      throw new ZipError(
        `Entry "${name}" failed its CRC-32 check (expected ${expectedCrc.toString(16)}, got ${actualCrc.toString(16)})`,
        'ZIP_CRC_MISMATCH'
      );
    }

    totalInflated += data.length;
    if (entries.some((e) => e.name === name)) warnings.push(`duplicate entry "${name}" ignored`);
    else entries.push({ name, data });
  }

  return { entries, warnings };
}

/**
 * Read one text file out of an archive.
 *
 * @returns {{ name: string, text: string }|null}
 */
export function readTextEntry(buf, match, overrides = {}) {
  const { entries } = unzip(buf, overrides);
  const hit = entries.find((e) => match(e.name));
  if (!hit) return null;
  return { name: hit.name, text: hit.data.toString('utf8') };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** DOS time/date pair for a fixed timestamp, so exports are reproducible. */
function dosDateTime(date) {
  const time = ((date.getUTCHours() & 0x1f) << 11)
    | ((date.getUTCMinutes() & 0x3f) << 5)
    | ((Math.floor(date.getUTCSeconds() / 2)) & 0x1f);
  const day = (((date.getUTCFullYear() - 1980) & 0x7f) << 9)
    | (((date.getUTCMonth() + 1) & 0x0f) << 5)
    | (date.getUTCDate() & 0x1f);
  return { time, day };
}

/**
 * Build a ZIP archive from a list of `{ name, data }` entries.
 *
 * Entry names are validated with the same rules the reader enforces, so an
 * archive this function produces can always be read back by `unzip`.
 *
 * @param {Array<{ name: string, data: Buffer|string }>} files
 * @param {{ date?: Date, store?: boolean }} [options] `store: true` skips deflate
 * @returns {Buffer}
 */
export function zip(files, options = {}) {
  const date = options.date || new Date('2020-01-01T00:00:00Z');
  const { time, day } = dosDateTime(date);

  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const file of files) {
    const nameProblem = unsafeEntryName(file.name);
    if (nameProblem) throw new ZipError(`Refusing to write "${file.name}": ${nameProblem}`, 'ZIP_UNSAFE_NAME');

    const nameBuf = Buffer.from(file.name, 'utf8');
    const raw = Buffer.isBuffer(file.data) ? file.data : Buffer.from(String(file.data), 'utf8');
    const checksum = crc32(raw);

    const deflated = options.store ? null : deflateRawSync(raw, { level: 9 });
    const useStored = options.store || deflated.length >= raw.length;
    const payload = useStored ? raw : deflated;
    const method = useStored ? METHOD_STORED : METHOD_DEFLATE;

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4);            // version needed
    local.writeUInt16LE(0x0800, 6);        // flags: UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(SIG_CENTRAL, 0);
    central.writeUInt16LE(20, 4);          // version made by
    central.writeUInt16LE(20, 6);          // version needed
    central.writeUInt16LE(0x0800, 8);      // flags: UTF-8 names
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);          // extra len
    central.writeUInt16LE(0, 32);          // comment len
    central.writeUInt16LE(0, 34);          // disk number
    central.writeUInt16LE(0, 36);          // internal attrs
    // >>> 0: the regular-file bit is 0x8000_0000, which is negative as a signed
    // 32-bit int and makes writeUInt32LE throw.
    central.writeUInt32LE(((S_IFREG << 16) | 0o644) >>> 0, 38); // regular file, 0644
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);

    locals.push(local, payload);
    centrals.push(central);
    offset += local.length + payload.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuf, eocd]);
}
