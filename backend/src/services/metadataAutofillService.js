import { safeFetchBuffer } from '../lib/safeFetch.js';
import { makeSlug } from '../utils/slug.js';

/**
 * Optional metadata autofill for manual item creation.
 *
 * Point it at a public software page and it pulls back a *suggestion*: the
 * admin reviews every field before saving, and nothing is written by this
 * service. Fetching goes through `safeFetchBuffer`, so the URL cannot be used
 * to reach the loopback interface, the LAN or a cloud metadata endpoint, and
 * the response is byte-capped.
 *
 * Deliberately conservative: it only reports what it actually found, and every
 * field is optional. A page it cannot parse yields an empty suggestion rather
 * than plausible-looking guesses.
 */

const MAX_HTML_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15000;

/** File extensions that indicate a downloadable artefact. */
const DOWNLOAD_PATTERN = /https?:\/\/[^\s"'<>)]+\.(?:iso|img|exe|msi|dmg|pkg|zip|tar\.gz|tgz|deb|rpm|apk|appimage|ova|vmdk|jar|whl)(?:[?#][^\s"'<>)]*)?/gi;

const PLATFORM_HINTS = [
  { platform: 'windows', patterns: [/windows/i, /\.exe\b/i, /\.msi\b/i, /win64|win32|x86_64-windows/i] },
  { platform: 'macos', patterns: [/macos|mac os x|\bosx\b/i, /\.dmg\b/i, /\.pkg\b/i, /darwin/i] },
  { platform: 'linux', patterns: [/linux/i, /\.deb\b/i, /\.rpm\b/i, /\.appimage\b/i, /ubuntu|debian|fedora|arch linux/i] },
  { platform: 'android', patterns: [/android/i, /\.apk\b/i] },
];

const ARCH_HINTS = [
  { architecture: 'arm64', patterns: [/arm64|aarch64|apple silicon/i] },
  { architecture: 'x64', patterns: [/x86_64|amd64|x64\b/i] },
  { architecture: 'x86', patterns: [/\bi386\b|\bi686\b|x86\b(?!_64)/i] },
  { architecture: 'universal', patterns: [/universal binary/i] },
];

const FILE_TYPE_HINTS = [
  { file_type: 'iso', pattern: /\.iso\b/i },
  { file_type: 'exe', pattern: /\.exe\b/i },
  { file_type: 'msi', pattern: /\.msi\b/i },
  { file_type: 'dmg', pattern: /\.dmg\b/i },
  { file_type: 'deb', pattern: /\.deb\b/i },
  { file_type: 'rpm', pattern: /\.rpm\b/i },
  { file_type: 'apk', pattern: /\.apk\b/i },
  { file_type: 'appimage', pattern: /\.appimage\b/i },
  { file_type: 'zip', pattern: /\.zip\b/i },
  { file_type: 'pdf', pattern: /\.pdf\b/i },
];

function decodeEntities(text) {
  return String(text)
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, ent) => {
      if (ent[0] === '#') {
        const code = ent[1] === 'x' || ent[1] === 'X'
          ? parseInt(ent.slice(2), 16)
          : parseInt(ent.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
      const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…' };
      return named[ent.toLowerCase()] ?? m;
    });
}

function stripTags(html) {
  return decodeEntities(
    String(html)
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  ).replace(/\s+/g, ' ').trim();
}

/** First matching <meta> content, by property or name. */
function metaContent(html, keys) {
  for (const key of keys) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(
      `<meta[^>]+(?:property|name)=["']${escaped}["'][^>]*content=["']([^"']*)["']` +
      `|<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${escaped}["']`,
      'i'
    );
    const m = html.match(re);
    const value = (m?.[1] || m?.[2] || '').trim();
    if (value) return decodeEntities(value);
  }
  return null;
}

function firstPattern(haystack, patterns) {
  for (const p of patterns) if (p.test(haystack)) return true;
  return false;
}

/** Version-looking substrings, best candidate first. */
function findVersion(text) {
  const candidates = [
    ...text.matchAll(/\b(?:version|release|v)\s*:?\s*(\d+(?:\.\d+){1,3}[a-z0-9.\-]*)/gi),
    ...text.matchAll(/\b(\d+\.\d+(?:\.\d+){0,2})\b/g),
  ].map((m) => m[1]);
  return candidates.find((c) => c && c.length <= 30) || null;
}

function findReleaseDate(html) {
  const iso = html.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const named = html.match(/\b(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(20\d{2})\b/i);
  if (named) {
    const months = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
    const month = String(months.indexOf(named[2].toLowerCase()) + 1).padStart(2, '0');
    const day = named[1].padStart(2, '0');
    return `${named[3]}-${month}-${day}`;
  }
  return null;
}

function findChecksum(text) {
  const sha256 = text.match(/\b[a-f0-9]{64}\b/i);
  if (sha256) return { sha256: sha256[0].toLowerCase() };
  const md5 = text.match(/\b[a-f0-9]{32}\b/i);
  if (md5) return { md5: md5[0].toLowerCase() };
  return {};
}

/** Resolve a possibly-relative URL against the page URL. */
function absolutise(baseUrl, value) {
  if (!value) return null;
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return null;
  }
}

/**
 * @param {string} url  a public software page
 * @returns {Promise<{ url: string, fields: object, found: string[], downloads: string[], notes: string[] }>}
 */
export async function autofillFromUrl(url) {
  const fetched = await safeFetchBuffer(url, {
    maxBytes: MAX_HTML_BYTES,
    timeoutMs: FETCH_TIMEOUT_MS,
    headers: { Accept: 'text/html,application/xhtml+xml' },
  });
  const { buffer } = fetched;
  // safeFetchBuffer resolves redirects itself and reports where it landed.
  const finalUrl = fetched.url;
  const contentType = fetched.response?.headers?.get?.('content-type') || null;

  const notes = [];
  const isHtml = !contentType || /html/i.test(contentType);
  const html = buffer.toString('utf8');

  if (!isHtml) {
    notes.push(`The URL returned ${contentType || 'an unknown content type'}, not a web page. Only the URL and file type were inferred.`);
  }

  const title = isHtml
    ? (metaContent(html, ['og:title', 'twitter:title'])
      || (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').trim()
      || null)
    : null;
  const cleanTitle = title ? stripTags(title).slice(0, 200) : null;

  const description = isHtml
    ? (metaContent(html, ['og:description', 'description', 'twitter:description']) || null)
    : null;
  const cleanDescription = description ? stripTags(description).slice(0, 500) : null;

  const bodyText = isHtml ? stripTags(html).slice(0, 20000) : '';
  const haystack = `${cleanTitle || ''} ${cleanDescription || ''} ${bodyText}`;

  const fields = {};
  const found = [];
  const add = (key, value) => {
    if (value === null || value === undefined || value === '') return;
    fields[key] = value;
    found.push(key);
  };

  if (cleanTitle) add('name', cleanTitle);
  if (cleanDescription) add('description', cleanDescription);
  if (cleanTitle) add('slug', makeSlug(cleanTitle.replace(/\s*[|\-–—]\s*[^|\-–—]*$/, '')).slice(0, 200) || makeSlug(cleanTitle));
  add('version', findVersion(haystack));
  add('release_date', findReleaseDate(html));

  const platform = PLATFORM_HINTS.find((p) => firstPattern(haystack, p.patterns));
  add('platform', platform?.platform);
  const arch = ARCH_HINTS.find((a) => firstPattern(haystack, a.patterns));
  add('architecture', arch?.architecture);
  const fileType = FILE_TYPE_HINTS.find((f) => f.pattern.test(haystack));
  add('file_type', fileType?.file_type);

  const icon = isHtml
    ? absolutise(finalUrl, metaContent(html, ['og:image', 'twitter:image']))
      || absolutise(finalUrl, html.match(/<link[^>]+rel=["'](?:apple-touch-)?icon["'][^>]*href=["']([^"']+)["']/i)?.[1])
    : null;
  add('icon_url', icon);
  add('external_url', finalUrl);
  add('documentation_url', isHtml ? absolutise(finalUrl, html.match(/<link[^>]+rel=["'](?:help|documentation)["'][^>]*href=["']([^"']+)["']/i)?.[1]) : null);

  // Checksums: only report a hex run that is labelled, so a random 32-char id is
  // not mistaken for an MD5.
  const labelled = bodyText.match(/\b(?:sha-?256|md5)\b[^\w]{0,8}([a-f0-9]{32,64})/i);
  if (labelled) {
    const hex = labelled[1].toLowerCase();
    if (hex.length === 64) add('sha256', hex);
    else if (hex.length === 32) add('md5', hex);
  } else {
    const checksums = findChecksum(bodyText);
    if (checksums.sha256 || checksums.md5) notes.push('A checksum-like string appears on the page but is not clearly labelled, so it was not filled in.');
  }

  const downloads = [...new Set((html.match(DOWNLOAD_PATTERN) || []).slice(0, 10))];

  if (!found.length) {
    notes.push('Nothing on that page could be recognised. Fill the fields in manually.');
  }

  return { url, finalUrl, fields, found, downloads, notes };
}
