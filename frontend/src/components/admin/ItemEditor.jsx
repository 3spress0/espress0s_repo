import { useEffect, useMemo, useState } from 'react';
import { X, Save, Loader2, AlertCircle, Eye } from 'lucide-react';
import { itemsApi, categoriesApi } from '../../lib/api';
import ImagePicker from './ImagePicker';
import DownloadLinksEditor from './DownloadLinksEditor';

const LICENSE_STATUSES = [
  { value: 'public-domain', label: 'Public domain' },
  { value: 'redistributable', label: 'Redistributable' },
  { value: 'proprietary', label: 'Proprietary' },
  { value: 'check-license', label: 'Check license' },
  { value: 'internal-only', label: 'Internal only' },
  { value: 'abandonware', label: 'Abandonware' },
];

const SECTIONS = [
  { id: 'basics', label: 'Basics' },
  { id: 'media', label: 'Images' },
  { id: 'downloads', label: 'Downloads' },
  { id: 'details', label: 'File details' },
  { id: 'publishing', label: 'Publishing' },
];

function emptyForm() {
  return {
    name: '', description: '', long_description: '', category_id: '', version: '',
    release_date: '', file_name: '', file_size: '', file_type: '', platform: '',
    architecture: '', sha256: '', md5: '', storage_provider: 'external', storage_path: '',
    download_url: '', external_url: '', featured: false, published: true,
    license_status: 'check-license', license_notes: '', tags: '', icon_url: '',
    image_url: '', screenshots: '', documentation_url: '', changelog: '',
  };
}

function itemToForm(item) {
  const tags = Array.isArray(item.tags)
    ? item.tags
    : (() => { try { return JSON.parse(item.tags || '[]'); } catch { return []; } })();
  const shots = Array.isArray(item.screenshots)
    ? item.screenshots
    : (() => { try { return JSON.parse(item.screenshots || '[]'); } catch { return []; } })();

  return {
    name: item.name || '',
    description: item.description || '',
    long_description: item.long_description || '',
    category_id: item.category_id ?? '',
    version: item.version || '',
    release_date: item.release_date ? String(item.release_date).slice(0, 10) : '',
    file_name: item.file_name || '',
    file_size: item.file_size ?? '',
    file_type: item.file_type || '',
    platform: item.platform || '',
    architecture: item.architecture || '',
    sha256: item.sha256 || '',
    md5: item.md5 || '',
    storage_provider: item.storage_provider || 'external',
    storage_path: item.storage_path || '',
    download_url: item.download_url || '',
    external_url: item.external_url || '',
    featured: !!item.featured,
    published: item.published === undefined ? true : !!item.published,
    license_status: item.license_status || 'check-license',
    license_notes: item.license_notes || '',
    tags: tags.join(', '),
    icon_url: item.icon_url || '',
    image_url: item.image_url || '',
    screenshots: shots.join('\n'),
    documentation_url: item.documentation_url || '',
    changelog: item.changelog || '',
  };
}

/**
 * The single item editor. Used by the admin items list AND inline on the item
 * detail page, so there is exactly one implementation of "edit this item".
 *
 * @param {object|null} item   Item to edit (null = create new)
 * @param {function}    onSaved  Called with the saved item
 * @param {function}    onClose
 */
export default function ItemEditor({ item, onSaved, onClose, compact = false }) {
  const [form, setForm] = useState(emptyForm);
  const [links, setLinks] = useState([]);
  const [categories, setCategories] = useState([]);
  const [section, setSection] = useState('basics');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const isEdit = !!item?.id;

  useEffect(() => {
    categoriesApi.list().then(d => setCategories(d.categories || [])).catch(() => {});
  }, []);

  useEffect(() => {
    if (!item) { setForm(emptyForm()); setLinks([]); return; }
    setForm(itemToForm(item));
    // Copy so mutations in the editor never touch the caller's object.
    setLinks((item.download_links || []).map(l => ({ ...l })));
  }, [item]);

  const set = (field) => (e) => {
    const value = e?.target?.type === 'checkbox' ? e.target.checked : e.target.value;
    setForm(f => ({ ...f, [field]: value }));
  };

  const splitList = (raw) => String(raw || '')
    .split(/[,\n]/).map(s => s.trim()).filter(Boolean);

  const payload = useMemo(() => ({
    ...form,
    category_id: form.category_id === '' || form.category_id === null ? null : parseInt(form.category_id, 10),
    file_size: form.file_size === '' || form.file_size === null ? null : parseInt(form.file_size, 10),
    featured: form.featured ? 1 : 0,
    published: form.published ? 1 : 0,
    tags: splitList(form.tags),
    screenshots: splitList(form.screenshots),
    // Strip empty-string URL fields: the API expects a valid URL or nothing.
    download_url: form.download_url || null,
    external_url: form.external_url || null,
    documentation_url: form.documentation_url || null,
    icon_url: form.icon_url || null,
    image_url: form.image_url || null,
    download_links: links
      .filter(l => (l.label || '').trim().length >= 2)
      .map((l, idx) => ({
        ...l,
        file_size: l.file_size === '' || l.file_size === null ? null : parseInt(l.file_size, 10),
        is_primary: !!l.is_primary,
        is_down: !!l.is_down,
        sort_order: idx,
      })),
  }), [form, links]);

  const submit = async (e) => {
    e?.preventDefault();
    setError('');
    setSaving(true);
    try {
      const saved = isEdit ? await itemsApi.update(item.id, payload) : await itemsApi.create(payload);
      onSaved?.(saved);
    } catch (err) {
      const details = err.response?.data?.details;
      setError(details
        ? 'Validation failed: ' + details.map(d => `${d.path?.join('.') || 'field'}: ${d.message}`).join('; ')
        : (err.response?.data?.error || `Save failed: ${err.message}`));
    } finally {
      setSaving(false);
    }
  };

  const field = (label, key, opts = {}) => (
    <div className={opts.wide ? 'sm:col-span-2' : ''}>
      <span className="text-[11px] text-textMuted block mb-1">{label}</span>
      {opts.type === 'textarea' ? (
        <textarea
          value={form[key] ?? ''}
          onChange={set(key)}
          rows={opts.rows || 4}
          placeholder={opts.placeholder}
          className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm focus:outline-none focus:border-primary/50"
        />
      ) : opts.type === 'select' ? (
        <select
          value={form[key] ?? ''}
          onChange={set(key)}
          className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm focus:outline-none focus:border-primary/50"
        >
          {opts.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      ) : (
        <input
          type={opts.type || 'text'}
          value={form[key] ?? ''}
          onChange={set(key)}
          placeholder={opts.placeholder}
          className={`w-full px-3 py-2 bg-background border border-border rounded-lg text-sm focus:outline-none focus:border-primary/50 ${opts.mono ? 'font-mono' : ''}`}
        />
      )}
    </div>
  );

  return (
    <form onSubmit={submit} className={compact ? '' : 'bg-surface border border-border rounded-2xl p-5'}>
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-bold text-textPrimary">
          {isEdit ? `Edit: ${item.name}` : 'Add new item'}
        </h3>
        <div className="flex items-center gap-2">
          {isEdit && item.slug && (
            <a
              href={`/file/${item.slug}`}
              target="_blank"
              rel="noreferrer"
              className="px-3 py-2 bg-surface border border-border rounded-xl text-xs text-textSecondary hover:border-primary/30 flex items-center gap-1.5"
            >
              <Eye className="w-3.5 h-3.5" /> View page
            </a>
          )}
          {onClose && (
            <button type="button" onClick={onClose} className="p-2 hover:bg-surfaceHover rounded-xl">
              <X className="w-5 h-5" />
            </button>
          )}
        </div>
      </div>

      {/* Section tabs */}
      <div className="flex flex-wrap gap-1 mb-5 p-1 bg-background rounded-lg border border-border w-fit">
        {SECTIONS.map(s => (
          <button
            key={s.id}
            type="button"
            onClick={() => setSection(s.id)}
            className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
              section === s.id ? 'bg-gradient-primary text-white' : 'text-textSecondary hover:text-textPrimary'
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>

      {section === 'basics' && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {field('Name *', 'name', { wide: true })}
          {field('Short description *', 'description', { wide: true, placeholder: 'One line shown on cards (5-500 chars)' })}
          {field('Long description', 'long_description', { wide: true, type: 'textarea', rows: 7 })}
          {field('Category', 'category_id', {
            type: 'select',
            options: [{ value: '', label: '— None —' }, ...categories.map(c => ({ value: String(c.id), label: c.name }))],
          })}
          {field('Version', 'version')}
          {field('Release date', 'release_date', { type: 'date' })}
          {field('Tags (comma separated)', 'tags', { wide: true, placeholder: 'ubuntu, linux, lts' })}
        </div>
      )}

      {section === 'media' && (
        <div className="space-y-6">
          <ImagePicker
            label="Cover image"
            value={form.image_url}
            onChange={(v) => setForm(f => ({ ...f, image_url: v }))}
            hint="Shown at the top of the item page and on cards."
          />
          <ImagePicker
            label="Icon / logo"
            value={form.icon_url}
            onChange={(v) => setForm(f => ({ ...f, icon_url: v }))}
            hint="Used as a fallback when no cover image is set."
          />
          <div>
            <span className="text-[11px] text-textMuted block mb-1">Screenshots (one URL per line)</span>
            <textarea
              value={form.screenshots}
              onChange={set('screenshots')}
              rows={3}
              placeholder={'https://example.com/shot-1.png\nhttps://example.com/shot-2.png'}
              className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm font-mono focus:outline-none focus:border-primary/50"
            />
          </div>
          {field('Documentation URL', 'documentation_url', { wide: true, placeholder: 'https://...' })}
        </div>
      )}

      {section === 'downloads' && (
        <div className="space-y-5">
          <DownloadLinksEditor links={links} onChange={setLinks} />
          <div className="rounded-xl border border-border bg-background p-3">
            <p className="text-xs text-textMuted mb-3">
              Legacy single-source fields. New mirrors above take precedence; keep these in sync if you use them.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {field('Storage provider', 'storage_provider', {
                type: 'select',
                options: [
                  { value: 'external', label: 'External URL' },
                  { value: 'gdrive', label: 'Google Drive' },
                  { value: 'onedrive', label: 'OneDrive' },
                  { value: 'github', label: 'GitHub Releases' },
                  { value: 'local', label: 'Local file' },
                ],
              })}
              {field('Storage path / file ID', 'storage_path', { mono: true })}
              {field('Download URL', 'download_url', { mono: true, placeholder: 'https://...' })}
              {field('Source / project page', 'external_url', { mono: true, placeholder: 'https://...' })}
            </div>
          </div>
        </div>
      )}

      {section === 'details' && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {field('File name', 'file_name')}
          {field('File size (bytes)', 'file_size', { type: 'number' })}
          {field('File type', 'file_type', { placeholder: 'iso, exe, zip, pdf' })}
          {field('Platform', 'platform', { placeholder: 'linux, windows, macos' })}
          {field('Architecture', 'architecture', { placeholder: 'x64, arm64, universal' })}
          {field('SHA-256', 'sha256', { mono: true })}
          {field('MD5', 'md5', { mono: true })}
          {field('Changelog', 'changelog', { wide: true, type: 'textarea', rows: 5 })}
        </div>
      )}

      {section === 'publishing' && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {field('License status', 'license_status', { type: 'select', options: LICENSE_STATUSES })}
            {field('License notes', 'license_notes')}
          </div>
          <label className="flex items-center gap-2 text-sm text-textSecondary cursor-pointer">
            <input type="checkbox" checked={!!form.published} onChange={set('published')} className="accent-purple-500" />
            Published (visible to everyone)
          </label>
          <label className="flex items-center gap-2 text-sm text-textSecondary cursor-pointer">
            <input type="checkbox" checked={!!form.featured} onChange={set('featured')} className="accent-purple-500" />
            Featured (shown on the homepage)
          </label>
        </div>
      )}

      {error && (
        <div className="mt-4 p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-sm text-red-400 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="flex items-center justify-end gap-3 mt-6 pt-4 border-t border-border">
        {onClose && (
          <button type="button" onClick={onClose} className="px-5 py-2.5 bg-surface border border-border rounded-xl text-sm">
            Cancel
          </button>
        )}
        <button
          type="submit"
          disabled={saving}
          className="px-6 py-2.5 bg-gradient-primary text-white rounded-xl text-sm font-medium flex items-center gap-2 disabled:opacity-50"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          {saving ? 'Saving...' : (isEdit ? 'Save changes' : 'Create item')}
        </button>
      </div>
    </form>
  );
}
