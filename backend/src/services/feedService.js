/**
 * RSS 2.0 and Atom 1.0 feeds (#15).
 *
 * Two feeds, both public and published-only:
 *   entries  - newest catalogue entries (by created_at), optionally filtered
 *              by category, folder or tag
 *   changes  - the public change log (created / updated / published / link
 *              status), one item per event
 *
 * Pure string building; the routes pass the rows in. Everything user-authored
 * is XML-escaped and long descriptions are rendered as plain text.
 */
import { listEvents } from './eventBus.js';
import { getDb } from '../db/index.js';
import { getSetting } from './settingsService.js';

export const FEED_TYPES = ['entries', 'changes'];

export function xmlEscape(s) {
  return String(s ?? '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
}

const rfc822 = (d) => new Date(d || Date.now()).toUTCString();
const iso = (d) => new Date(d || Date.now()).toISOString();

/** Origin for absolute links: PUBLIC_URL env, else the request's own host. */
export function siteOrigin(request) {
  const env = (process.env.PUBLIC_URL || process.env.SITE_URL || '').replace(/\/+$/, '');
  if (env) return env;
  const proto = String(request.headers['x-forwarded-proto'] || request.protocol || 'https').split(',')[0].trim();
  const host = String(request.headers['x-forwarded-host'] || request.headers.host || 'localhost').split(',')[0].trim();
  return `${proto}://${host}`;
}

function siteMeta() {
  return {
    title: getSetting('site_name', "espress0's repo"),
    description: getSetting('site_tagline', 'Personal software archive'),
  };
}

/** Newest published entries with the category/folder names joined in. */
export function loadEntries({ category = null, folder = null, tag = null, limit = 50 } = {}) {
  const db = getDb();
  const where = ['i.published = 1'];
  const params = {};
  if (category) { where.push('c.slug = @category'); params.category = category; }
  if (folder) { where.push('f.slug = @folder'); params.folder = folder; }
  if (tag) {
    // tags are a JSON array column; match the quoted value.
    where.push("i.tags LIKE @tag");
    params.tag = `%"${String(tag).replace(/[%_]/g, '')}"%`;
  }
  params.limit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  return db.prepare(`
    SELECT i.id, i.slug, i.name, i.description, i.version, i.platform, i.file_type, i.file_size, i.tags,
           i.created_at, i.updated_at, c.name AS category_name, c.slug AS category_slug, f.name AS folder_name
    FROM items i
    LEFT JOIN categories c ON c.id = i.category_id
    LEFT JOIN folders f ON f.id = i.folder_id
    WHERE ${where.join(' AND ')}
    ORDER BY i.created_at DESC, i.id DESC
    LIMIT @limit
  `).all(params);
}

export function loadChanges({ limit = 50 } = {}) {
  return listEvents({
    types: ['item.created', 'item.updated', 'item.published', 'item.unpublished', 'item.deleted', 'link.down', 'link.recovered'],
    limit: Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200),
  }).filter((e) => e.payload?.item?.published !== false || e.type === 'item.unpublished' || e.type === 'item.deleted');
}

const CHANGE_TITLES = {
  'item.created': 'New: ', 'item.updated': 'Updated: ', 'item.published': 'Published: ', 'item.unpublished': 'Unpublished: ',
  'item.deleted': 'Removed: ', 'link.down': 'Link down: ', 'link.recovered': 'Link back up: ',
};

/** Normalise both sources into one item shape for the serialisers. */
export function toFeedItems(type, rows, origin) {
  if (type === 'changes') {
    return rows.map((e) => {
      const item = e.payload?.item || {};
      const parts = [];
      if (e.payload?.changes?.length) parts.push(`Changed: ${e.payload.changes.join(', ')}.`);
      if (e.payload?.link) parts.push(`Mirror "${e.payload.link.label}" is ${e.payload.link.status}${e.payload.link.http_status ? ` (HTTP ${e.payload.link.http_status})` : ''}.`);
      if (item.version) parts.push(`Version ${item.version}.`);
      return {
        id: `${origin}/api/v1/changes#${e.id}`,
        title: `${CHANGE_TITLES[e.type] || ''}${item.name || 'entry'}`,
        link: item.slug && e.type !== 'item.deleted' ? `${origin}/file/${item.slug}` : `${origin}/browse`,
        summary: parts.join(' ') || e.type,
        date: e.created_at,
        categories: [e.type],
      };
    });
  }
  return rows.map((r) => {
    let tags = [];
    try { tags = JSON.parse(r.tags || '[]'); } catch { tags = []; }
    const meta = [r.version ? `v${r.version}` : null, r.platform, r.file_type ? r.file_type.toUpperCase() : null].filter(Boolean).join(' · ');
    return {
      id: `${origin}/file/${r.slug}`,
      title: r.name + (r.version ? ` ${r.version}` : ''),
      link: `${origin}/file/${r.slug}`,
      summary: [r.description, meta].filter(Boolean).join(' — '),
      date: r.created_at,
      updated: r.updated_at,
      categories: [r.category_name, r.folder_name, ...(Array.isArray(tags) ? tags : [])].filter(Boolean),
    };
  });
}

export function renderRss({ type, items, origin, selfUrl }) {
  const site = siteMeta();
  const title = type === 'changes' ? `${site.title} — changes` : `${site.title} — new entries`;
  const body = items.map((it) => `
    <item>
      <title>${xmlEscape(it.title)}</title>
      <link>${xmlEscape(it.link)}</link>
      <guid isPermaLink="false">${xmlEscape(it.id)}</guid>
      <pubDate>${rfc822(it.date)}</pubDate>
      <description>${xmlEscape(it.summary)}</description>${it.categories.map((c) => `
      <category>${xmlEscape(c)}</category>`).join('')}
    </item>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${xmlEscape(title)}</title>
    <link>${xmlEscape(origin)}/</link>
    <description>${xmlEscape(site.description)}</description>
    <language>en</language>
    <lastBuildDate>${rfc822(items[0]?.date)}</lastBuildDate>
    <atom:link href="${xmlEscape(selfUrl)}" rel="self" type="application/rss+xml" />
    <generator>espress0 repo</generator>${body}
  </channel>
</rss>
`;
}

export function renderAtom({ type, items, origin, selfUrl }) {
  const site = siteMeta();
  const title = type === 'changes' ? `${site.title} — changes` : `${site.title} — new entries`;
  const body = items.map((it) => `
  <entry>
    <title>${xmlEscape(it.title)}</title>
    <link href="${xmlEscape(it.link)}" />
    <id>${xmlEscape(it.id)}</id>
    <published>${iso(it.date)}</published>
    <updated>${iso(it.updated || it.date)}</updated>
    <summary>${xmlEscape(it.summary)}</summary>${it.categories.map((c) => `
    <category term="${xmlEscape(c)}" />`).join('')}
  </entry>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>${xmlEscape(title)}</title>
  <subtitle>${xmlEscape(site.description)}</subtitle>
  <link href="${xmlEscape(origin)}/" />
  <link href="${xmlEscape(selfUrl)}" rel="self" type="application/atom+xml" />
  <id>${xmlEscape(origin)}/api/v1/feed/${type}</id>
  <updated>${iso(items[0]?.updated || items[0]?.date)}</updated>
  <generator>espress0 repo</generator>${body}
</feed>
`;
}
