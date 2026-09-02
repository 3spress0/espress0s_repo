import { describe, it } from 'node:test';
import assert from 'node:assert';
import { deflateRawSync } from 'node:zlib';
import { zip, unzip, crc32, unsafeEntryName, ZipError } from '../src/lib/zip.js';

/**
 * lib/zip.js is the only thing between an uploaded archive and the filesystem,
 * so these tests aim at the ways an archive can be hostile rather than at
 * round-tripping alone.
 */

const S_IFLNK = 0o120000;
const S_IFREG = 0o100000;

/** Offset of the central directory, read from the EOCD at the end of a buffer. */
function centralDirOffset(buf) {
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return buf.readUInt32LE(i + 16);
  }
  throw new Error('no EOCD found');
}

describe('zip: round trip', () => {
  it('reads back what it wrote, including binary payloads', () => {
    const binary = Buffer.from([0, 1, 2, 253, 254, 255]);
    const archive = zip([
      { name: 'catalog.json', data: '{"a":1}' },
      { name: 'nested/deep/notes.md', data: '# heading\n'.repeat(400) },
      { name: 'raw.bin', data: binary },
    ]);

    const { entries } = unzip(archive);
    assert.deepEqual(entries.map((e) => e.name), ['catalog.json', 'nested/deep/notes.md', 'raw.bin']);
    assert.equal(entries[0].data.toString(), '{"a":1}');
    assert.equal(entries[1].data.toString().length, 4000);
    assert.equal(Buffer.compare(entries[2].data, binary), 0);
  });

  it('implements the canonical CRC-32 test vector', () => {
    assert.equal(crc32(Buffer.from('123456789')).toString(16), 'cbf43926');
  });

  it('stores incompressible data uncompressed and still reads it', () => {
    const noise = Buffer.from(Array.from({ length: 5000 }, (_, i) => (i * 7919) % 256));
    const { entries } = unzip(zip([{ name: 'noise.bin', data: noise }]));
    assert.equal(Buffer.compare(entries[0].data, noise), 0);
  });
});

describe('zip: path traversal', () => {
  const bad = [
    ['../escape.json', '.. segment'],
    ['a/../../escape.json', 'nested .. segment'],
    ['/etc/passwd', 'absolute path'],
    ['C:\\Windows\\system.ini', 'drive letter'],
    ['back\\slash.json', 'backslash'],
    ['a//b.json', 'empty segment'],
    ['./a.json', 'dot segment'],
    ['', 'empty name'],
  ];

  for (const [name, label] of bad) {
    it(`rejects "${name}" (${label})`, () => {
      assert.ok(unsafeEntryName(name), `unsafeEntryName accepted "${name}"`);
      assert.throws(() => zip([{ name, data: 'x' }]), ZipError, `writer accepted "${name}"`);
    });
  }

  it('rejects a traversal entry encountered while reading, even if written by another tool', () => {
    // Build a valid archive, then rewrite one entry name to escape the root.
    const archive = zip([{ name: 'safe.json', data: '{}' }]);
    const cd = centralDirOffset(archive);
    const nameLen = archive.readUInt16LE(cd + 28);
    // Must be exactly nameLen bytes: writing past the field would clobber the
    // EOCD signature and the test would pass for the wrong reason.
    const evil = '../evil'.padEnd(nameLen, 'x');
    assert.equal(Buffer.byteLength(evil), nameLen);
    const evilBuf = Buffer.from(evil, 'utf8');
    evilBuf.copy(archive, cd + 46);      // central directory
    evilBuf.copy(archive, 30);           // local header, so both agree

    assert.throws(() => unzip(archive), (e) => e.code === 'ZIP_UNSAFE_NAME', 'reader accepted a traversal name');
  });

  it('accepts an ordinary nested name', () => {
    assert.equal(unsafeEntryName('catalog/deep/file.json'), null);
  });
});

describe('zip: bombs and lying headers', () => {
  it('rejects an entry that inflates far beyond its stored size', () => {
    const payload = Buffer.alloc(4 * 1024 * 1024, 0x41); // compresses to almost nothing
    const archive = zip([{ name: 'bomb.json', data: payload }]);
    assert.throws(
      () => unzip(archive, { maxCompressionRatio: 100 }),
      (e) => e.code === 'ZIP_BOMB',
      'a 4 MB run of one byte slipped through the ratio limit'
    );
  });

  it('rejects an entry whose declared inflated size exceeds the cap', () => {
    const payload = Buffer.alloc(2 * 1024 * 1024, 0x42);
    const archive = zip([{ name: 'big.json', data: payload }]);
    assert.throws(
      () => unzip(archive, { maxEntryBytes: 1024, maxCompressionRatio: 100000 }),
      (e) => e.code === 'ZIP_ENTRY_TOO_LARGE'
    );
  });

  it('rejects an archive whose total inflated size exceeds the cap', () => {
    const payload = Buffer.alloc(1000, 0x43);
    const archive = zip([
      { name: 'a.json', data: payload },
      { name: 'b.json', data: payload },
      { name: 'c.json', data: payload },
    ]);
    assert.throws(
      () => unzip(archive, { maxTotalBytes: 2500 }),
      (e) => e.code === 'ZIP_TOO_LARGE'
    );
  });

  it('rejects an entry whose declared size does not match what it inflates to', () => {
    const raw = Buffer.from('the truth is ten bytes');
    const archive = zip([{ name: 'liar.json', data: raw }]);
    // Inflate to the same size but claim a different one: the CRC would still
    // match, so this specifically exercises the size check.
    const cd = centralDirOffset(archive);
    archive.writeUInt32LE(raw.length + 5, cd + 24);
    assert.throws(() => unzip(archive), (e) => e.code === 'ZIP_SIZE_MISMATCH' || e.code === 'ZIP_BOMB');
  });

  it('rejects a corrupted payload via the CRC-32 check', () => {
    // Incompressible, so the ratio check passes and the CRC is what catches it.
    const noise = Buffer.from(Array.from({ length: 5000 }, (_, i) => (i * 7919 + 13) % 256));
    const archive = zip([{ name: 'data.json', data: noise }]);
    const dataStart = 30 + 'data.json'.length;
    archive[dataStart] ^= 0xff;
    assert.throws(() => unzip(archive), (e) => ['ZIP_CRC_MISMATCH', 'ZIP_CORRUPT'].includes(e.code));
  });

  it('refuses to inflate a hand-built entry that lies about being tiny', () => {
    const raw = Buffer.alloc(200000, 0x44);
    const deflated = deflateRawSync(raw, { level: 9 });
    const name = Buffer.from('lie.json');

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);          // deflate
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(16, 22);        // claim 16 bytes, really 200 000
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc32(raw), 16);
    central.writeUInt32LE(deflated.length, 20);
    central.writeUInt32LE(16, 24);      // the same lie
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((S_IFREG << 16) | 0o644) >>> 0, 38);
    central.writeUInt32LE(0, 42);
    name.copy(central, 46);

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(1, 8);
    eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(central.length, 12);
    eocd.writeUInt32LE(local.length + deflated.length, 16);

    const forged = Buffer.concat([local, deflated, central, eocd]);
    assert.throws(() => unzip(forged), (e) => ['ZIP_BOMB', 'ZIP_SIZE_MISMATCH'].includes(e.code),
      'a forged size field was trusted');
  });
});

describe('zip: entry types and structure', () => {
  it('rejects a symlink entry', () => {
    const archive = zip([{ name: 'link.json', data: '/etc/passwd' }]);
    const cd = centralDirOffset(archive);
    archive.writeUInt32LE(((S_IFLNK << 16) | 0o777) >>> 0, cd + 38);
    assert.throws(() => unzip(archive), (e) => e.code === 'ZIP_SYMLINK');
  });

  it('rejects an encrypted entry', () => {
    const archive = zip([{ name: 'secret.json', data: 'x' }]);
    archive.writeUInt16LE(0x1, 6); // local header general purpose bit 0
    assert.throws(() => unzip(archive), (e) => e.code === 'ZIP_ENCRYPTED');
  });

  it('rejects an unsupported compression method', () => {
    const archive = zip([{ name: 'odd.json', data: 'x' }]);
    const cd = centralDirOffset(archive);
    archive.writeUInt16LE(14, cd + 10); // LZMA
    assert.throws(() => unzip(archive), (e) => e.code === 'ZIP_UNSUPPORTED_METHOD');
  });

  it('rejects an archive with too many entries', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ name: `f${i}.json`, data: '{}' }));
    assert.throws(() => unzip(zip(many), { maxEntries: 10 }), (e) => e.code === 'ZIP_TOO_MANY_ENTRIES');
  });

  it('rejects something that is not a ZIP at all', () => {
    assert.throws(() => unzip(Buffer.from('this is not a zip file, not even close')), (e) => e.code === 'ZIP_BAD_MAGIC');
    assert.throws(() => unzip(Buffer.alloc(4)), (e) => e.code === 'ZIP_TOO_SMALL');
  });

  it('skips directory entries instead of treating them as files', () => {
    // A directory entry is a name ending in "/" with no payload.
    const archive = zip([{ name: 'dir/inner.json', data: '{}' }]);
    const { entries } = unzip(archive);
    assert.deepEqual(entries.map((e) => e.name), ['dir/inner.json']);
  });
});
