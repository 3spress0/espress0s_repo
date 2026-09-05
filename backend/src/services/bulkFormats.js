/**
 * Bulk import formats (#14).
 *
 * The catalogue pipeline understands one thing: a catalog.zip holding a
 * catalog.json. Rather than teach it CSV, this module turns the other shapes
 * an admin is likely to drop on the page into exactly that archive, so
 * validation, modes, duplicate detection, snapshots and history are shared:
 *
 *   .zip   passed through untouched
 *   .json  either a full catalogue object, or a bare array of entries
 *   .csv   one entry per row; header names are catalogue field names
 *
 * CSV conventions: `tags` and `related` are split on "|" (or ","); `links`
 * come from `link_url` / `link_label` / `link_provider` columns (one link per
 * row, more via link_url_2...); `requirements` may be JSON or "type:name
 * version | ..."; booleans accept true/false/yes/no/1/0.
 */
import { zip } from '../lib/zip.js';
import { CATALOG_FORMAT, CATALOG_VERSION, CATALOG_FILENAME, CatalogError } from './catalogService.js';

export const BULK_EXTENSIONS = ['zip', 'json', 'csv'];

const LIST_FIELDS = new Set(['tags']);
const BOOL_FIELDS = new Set(['featured', 'published']);
const NUM_FIELDS = new Set(['file_size']);

/** Minimal RFC 4180 parser: quotes, doubled quotes, CR/LF, BOM. */
export function parseCsv(text) {
  const src = String(text).replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}

const toBool = (v) => /^(true|yes|y|1)$/i.test(String(v).trim());
const splitList = (v) => String(v).split(/[|,]/).map((s) => s.trim()).filter(Boolean);

function parseRequirementsCell(v) {
  const s = String(v).trim();
  if (!s) return undefined;
  if (s.startsWith('[')) { try { return JSON.parse(s); } catch { /* fall through */ } }
  // "runtime:.NET Framework 4.8 | hardware:RAM 4 GB"
  return s.split('|').map((part) => {
    const m = part.trim().match(/^(?:(os|runtime|hardware|dependency|other)\s*:\s*)?(.+?)(?:\s+(v?\d[^\s]*|>=?\s*\S+|<=?\s*\S+))?$/i);
    if (!m) return null;
    return { type: (m[1] || 'other').toLowerCase(), name: m[2].trim(), version: m[3] ? m[3].trim() : null };
  }).filter(Boolean);
}

function parseRelatedCell(v) {
  return splitList(v).map((s) => {
    const [slug, relation] = s.split(':').map((x) => x.trim());
    return { slug, relation: relation || 'related' };
  });
}

/** CSV rows -> catalogue entries. Empty cells are omitted (not nulled). */
export function csvToEntries(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new CatalogError('CSV needs a header row and at least one entry', 'CATALOG_CSV_EMPTY');
  const header = rows[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  if (!header.includes('name')) throw new CatalogError('CSV header must include a "name" column', 'CATALOG_CSV_HEADER');
  const entries = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    const entry = {};
    const links = {};
    header.forEach((key, i) => {
      const raw = cells[i] === undefined ? '' : String(cells[i]);
      if (raw.trim() === '') return;
      const link = key.match(/^link_(url|label|provider|path|primary)(?:_(\d+))?$/);
      if (link) {
        const n = link[2] || '1';
        links[n] = links[n] || {};
        links[n][link[1]] = raw.trim();
        return;
      }
      if (LIST_FIELDS.has(key)) entry[key] = splitList(raw);
      else if (BOOL_FIELDS.has(key)) entry[key] = toBool(raw);
      else if (NUM_FIELDS.has(key)) entry[key] = Number(raw) || undefined;
      else if (key === 'requirements') entry.requirements = parseRequirementsCell(raw);
      else if (key === 'related') entry.related = parseRelatedCell(raw);
      else entry[key] = raw.trim();
    });
    const linkList = Object.keys(links).sort((a, b) => Number(a) - Number(b)).map((n, i) => {
      const l = links[n];
      const out = { label: l.label || `Download${i ? ` ${i + 1}` : ''}`, storage_provider: l.provider || (/^magnet:/i.test(l.url || '') ? 'torrent' : 'external'), is_primary: l.primary ? toBool(l.primary) : i === 0, sort_order: i };
      if (l.url) out.download_url = l.url;
      if (l.path) out.storage_path = l.path;
      return out;
    }).filter((l) => l.download_url || l.storage_path);
    if (linkList.length) entry.links = linkList;
    entries.push(entry);
  }
  return entries;
}

/** Wrap a list of entries (or a full catalogue object) as catalog.json. */
export function toCatalogObject(input) {
  if (Array.isArray(input)) return { format: CATALOG_FORMAT, version: CATALOG_VERSION, items: input };
  if (input && typeof input === 'object') {
    if (Array.isArray(input.items)) return { format: CATALOG_FORMAT, version: CATALOG_VERSION, ...input };
    throw new CatalogError('JSON must be a catalogue object with "items" or a bare array of entries', 'CATALOG_BAD_JSON');
  }
  throw new CatalogError('JSON must be an object or an array', 'CATALOG_BAD_JSON');
}

export function extensionOf(filename) {
  const m = String(filename || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
}

/**
 * Normalise an upload into { buffer, filename } for importCatalogArchive.
 * Zips pass straight through. Returns `converted` so the UI can say so.
 */
export function toCatalogArchive(buffer, filename) {
  const ext = extensionOf(filename);
  // Sniff: a zip starts with PK, JSON with { or [ (after whitespace/BOM).
  const head = buffer.subarray(0, 4).toString('latin1');
  if (head.startsWith('PK')) return { buffer, filename, converted: null };
  const text = buffer.toString('utf8').replace(/^\uFEFF/, '');
  const first = text.trimStart()[0];
  if (ext === 'json' || first === '{' || first === '[') {
    let raw;
    try { raw = JSON.parse(text); } catch (e) { throw new CatalogError(`Not valid JSON: ${e.message}`, 'CATALOG_BAD_JSON'); }
    const catalog = toCatalogObject(raw);
    return { buffer: zip([{ name: CATALOG_FILENAME, data: JSON.stringify(catalog) }]), filename: filename.replace(/\.json$/i, '') + '.zip', converted: 'json' };
  }
  if (ext === 'csv' || ext === 'txt' || ext === '') {
    const entries = csvToEntries(text);
    const catalog = { format: CATALOG_FORMAT, version: CATALOG_VERSION, items: entries };
    return { buffer: zip([{ name: CATALOG_FILENAME, data: JSON.stringify(catalog) }]), filename: filename.replace(/\.(csv|txt)$/i, '') + '.zip', converted: 'csv' };
  }
  throw new CatalogError(`Unsupported file type ".${ext}" - upload a catalog.zip, .json or .csv`, 'CATALOG_BAD_TYPE');
}

/** A starter CSV with the common columns and one example row. */
export function csvTemplate() {
  const header = ['slug', 'name', 'description', 'category', 'folder', 'version', 'platform', 'architecture', 'file_type', 'file_size', 'license_status', 'status', 'tags', 'external_url', 'documentation_url', 'link_label', 'link_url', 'link_label_2', 'link_url_2', 'requirements', 'related', 'published', 'featured'];
  const row = ['ubuntu-24-04-desktop', 'Ubuntu 24.04 LTS Desktop', 'Long-term support desktop release of Ubuntu.', 'operating-systems', '', '24.04.1', 'linux', 'x64', 'iso', '6114656256', 'redistributable', 'current', 'linux|ubuntu|lts', 'https://releases.ubuntu.com/24.04/', 'https://ubuntu.com/tutorials', 'Ubuntu mirror', 'https://releases.ubuntu.com/24.04/ubuntu-24.04.1-desktop-amd64.iso', '', '', 'hardware:RAM 4 GB | hardware:Disk 25 GB', 'ubuntu-22-04-desktop:supersedes', 'true', 'false'];
  const esc = (v) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return header.join(',') + '\r\n' + row.map(esc).join(',') + '\r\n';
}
