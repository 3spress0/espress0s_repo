import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  X, Save, Loader2, AlertCircle, Eye, Check, Link as LinkIcon,
  RotateCcw, Sparkles, CheckCircle2, Circle, ArrowLeft, ArrowRight,
} from 'lucide-react';
import { itemsApi, categoriesApi, adminApi } from '../../lib/api';
import ImagePicker from './ImagePicker';
import DownloadLinksEditor from './DownloadLinksEditor';
import MarkdownField from './MarkdownField';
import TemplatePicker from './TemplatePicker';
import { applyTemplate } from './pageTemplates';

const LICENSE_STATUSES = [
  { value: 'public-domain', label: 'Public domain' },
  { value: 'redistributable', label: 'Redistributable' },
  { value: 'proprietary', label: 'Proprietary' },
  { value: 'check-license', label: 'Check license' },
  { value: 'internal-only', label: 'Internal only' },
  { value: 'abandonware', label: 'Abandonware' },
];

const BASE_SECTIONS = [
  { id: 'basics', label: 'Basics' },
  { id: 'description', label: 'Description' },
  { id: 'media', label: 'Images' },
  { id: 'downloads', label: 'Downloads' },
  { id: 'details', label: 'File details' },
  { id: 'publishing', label: 'Publishing' },
];

/** Mirrors the backend's slugify closely enough for a live URL preview. */
function slugify(text) {
  return String(text || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 200);
}

function emptyForm() {
  return {
    name: '', slug: '', description: '', long_description: '', category_id: '', version: '',
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
    slug: item.slug || '',
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
 * Authoring aids layered on top of the plain form:
 *  - templates pre-fill a new page (create mode only)
 *  - the page URL (slug) is editable, with live availability checking
 *  - the body is markdown, with a toolbar, a preview and an AI draft button
 *  - a readiness checklist replaces "save and find out what was missing"
 *  - Ctrl/Cmd+S saves; "Save as draft" and "Save & publish" are separate
 *
 * @param {object|null} item   Item to edit (null = create new)
 * @param {function}    onSaved  Called with the saved item
 * @param {function}    onClose
 */
export default function ItemEditor({ item, onSaved, onClose, compact = false }) {
  const [form, setForm] = useState(emptyForm);
  const [links, setLinks] = useState([]);
  const [categories, setCategories] = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [templateId, setTemplateId] = useState(null);
  const [slugTouched, setSlugTouched] = useState(false);
  const [slugState, setSlugState] = useState(null); // { checking, available, takenBy }
  const [aiNotice, setAiNotice] = useState('');

  const isEdit = !!item?.id;
  const sections = useMemo(
    () => (isEdit ? BASE_SECTIONS : [{ id: 'start', label: 'Template' }, ...BASE_SECTIONS]),
    [isEdit]
  );
  const [section, setSection] = useState(isEdit ? 'basics' : 'start');

  useEffect(() => {
    categoriesApi.list().then(d => setCategories(d.categories || [])).catch(() => {});
  }, []);

  useEffect(() => {
    if (!item) {
      setForm(emptyForm());
      setLinks([]);
      setSlugTouched(false);
      setSection('start');
      setTemplateId(null);
      return;
    }
    setForm(itemToForm(item));
    setSlugTouched(true); // an existing page already has a URL people may share
    setSection('basics');
    // Copy so mutations in the editor never touch the caller's object.
    setLinks((item.download_links || []).map(l => ({ ...l })));
  }, [item]);

  const set = (field) => (e) => {
    const value = e?.target?.type === 'checkbox' ? e.target.checked : e.target.value;
    setForm(f => ({ ...f, [field]: value }));
  };

  // Slug follows the name until the admin edits it by hand.
  const onNameChange = (e) => {
    const name = e.target.value;
    setForm(f => ({ ...f, name, slug: slugTouched ? f.slug : slugify(name) }));
  };

  const effectiveSlug = slugify(form.slug || form.name);

  // Debounced availability check so the admin sees a clash before saving.
  useEffect(() => {
    if (!effectiveSlug || effectiveSlug.length < 2) { setSlugState(null); return; }
    let cancelled = false;
    setSlugState(s => ({ ...(s || {}), checking: true }));
    const t = setTimeout(() => {
      adminApi.checkSlug(effectiveSlug, item?.id)
        .then(res => { if (!cancelled) setSlugState({ checking: false, ...res }); })
        .catch(() => { if (!cancelled) setSlugState(null); });
    }, 400);
    return () => { cancelled = true; clearTimeout(t); };
  }, [effectiveSlug, item?.id]);

  const chooseTemplate = (template) => {
    setTemplateId(template.id);
    const { form: nextForm, links: presetLinks } = applyTemplate(form, template, categories);
    setForm(nextForm);
    if (presetLinks.length && links.length === 0) setLinks(presetLinks);
    setSection('basics');
  };

  const splitList = (raw) => String(raw || '')
    .split(/[,\n]/).map(s => s.trim()).filter(Boolean);

  const payload = useMemo(() => ({
    ...form,
    slug: effectiveSlug || undefined,
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
  }), [form, links, effectiveSlug]);

  /** What still needs doing before this page is worth publishing. */
  const checklist = useMemo(() => {
    const usableLinks = links.filter(l => (l.label || '').trim().length >= 2 && (l.download_url || l.storage_path));
    return [
      { id: 'name', label: 'Name', done: form.name.trim().length >= 2, section: 'basics', required: true },
      { id: 'description', label: 'Short description', done: form.description.trim().length >= 5, section: 'basics', required: true },
      { id: 'slug', label: 'Page URL is free', done: !!slugState?.available, section: 'basics', required: true },
      { id: 'category', label: 'Category', done: form.category_id !== '' && form.category_id !== null, section: 'basics', required: false },
      { id: 'body', label: 'Description body', done: form.long_description.trim().length > 30, section: 'description', required: false },
      { id: 'image', label: 'Cover image', done: !!(form.image_url || form.icon_url), section: 'media', required: false },
      { id: 'links', label: 'At least one download link', done: usableLinks.length > 0, section: 'downloads', required: false },
    ];
  }, [form, links, slugState]);

  const blockers = checklist.filter(c => c.required && !c.done);
  const optionalMissing = checklist.filter(c => !c.required && !c.done);

  const save = useCallback(async (opts = {}) => {
    setError('');
    setAiNotice('');

    const body = opts.publish === undefined
      ? payload
      : { ...payload, published: opts.publish ? 1 : 0 };

    if (body.name.trim().length < 2 || body.description.trim().length < 5) {
      setSection('basics');
      setError('A name and a short description (at least 5 characters) are required.');
      return;
    }
    if (slugState && slugState.available === false) {
      setSection('basics');
      setError(`The URL /file/${effectiveSlug} is already used by "${slugState.takenBy?.name || 'another page'}". Pick a different one.`);
      return;
    }

    setSaving(true);
    try {
      const saved = isEdit ? await itemsApi.update(item.id, body) : await itemsApi.create(body);
      if (opts.publish !== undefined) setForm(f => ({ ...f, published: !!opts.publish }));
      onSaved?.(saved);
    } catch (err) {
      const details = err.response?.data?.details;
      setError(details
        ? 'Validation failed: ' + details.map(d => `${d.path?.join('.') || 'field'}: ${d.message}`).join('; ')
        : (err.response?.data?.error || `Save failed: ${err.message}`));
    } finally {
      setSaving(false);
    }
  }, [payload, isEdit, item, onSaved, slugState, effectiveSlug]);

  const submit = (e) => { e?.preventDefault(); save(); };

  // Ctrl/Cmd+S saves without hunting for the button.
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        saveRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /** Ask the backend to draft the page copy from the metadata typed so far. */
  const generateDescription = async () => {
    setAiNotice('');
    const category = categories.find(c => String(c.id) === String(form.category_id));
    const draft = await adminApi.describeItem({
      name: form.name,
      version: form.version,
      category: category?.name || '',
      platform: form.platform,
      architecture: form.architecture,
      file_type: form.file_type,
      file_size: form.file_size ? parseInt(form.file_size, 10) : null,
      tags: splitList(form.tags),
      links: links.map(l => l.label).filter(Boolean),
      notes: form.description,
    }).catch(err => {
      throw new Error(err.response?.data?.error || 'AI draft failed');
    });

    setForm(f => ({
      ...f,
      long_description: draft.long_description || f.long_description,
      description: f.description.trim() ? f.description : (draft.description || ''),
    }));
    setAiNotice(draft.usedTgpt
      ? 'Drafted with tgpt — review it, the AI does not know your files.'
      : 'tgpt is unavailable, so this is a filled-in outline. Replace the [bracketed] parts.');
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
          onChange={opts.onChange || set(key)}
          placeholder={opts.placeholder}
          className={`w-full px-3 py-2 bg-background border border-border rounded-lg text-sm focus:outline-none focus:border-primary/50 ${opts.mono ? 'font-mono' : ''}`}
        />
      )}
      {opts.hint && <p className="text-[11px] text-textMuted mt-1">{opts.hint}</p>}
    </div>
  );

  const sectionIndex = sections.findIndex(s => s.id === section);
  const goto = (dir) => {
    const next = sections[sectionIndex + dir];
    if (next) setSection(next.id);
  };

  return (
    <form onSubmit={submit} className={compact ? '' : 'bg-surface border border-border rounded-2xl p-5'}>
      <div className="flex items-start justify-between gap-3 mb-4">
        <div className="min-w-0">
          <h3 className="text-lg font-bold text-textPrimary truncate">
            {isEdit ? `Edit page: ${item.name}` : 'New file page'}
          </h3>
          <p className="text-xs text-textMuted mt-0.5">
            {effectiveSlug
              ? <>Will live at <span className="font-mono text-textSecondary">/file/{effectiveSlug}</span></>
              : 'Give it a name and it gets its own page.'}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
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
        {sections.map(s => (
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

      {section === 'start' && (
        <TemplatePicker selected={templateId} onSelect={chooseTemplate} />
      )}

      {section === 'basics' && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {field('Name *', 'name', { wide: true, onChange: onNameChange, placeholder: 'Ubuntu Desktop 24.04 LTS' })}

          {/* Page URL */}
          <div className="sm:col-span-2">
            <span className="text-[11px] text-textMuted block mb-1">Page URL</span>
            <div className="flex items-stretch gap-2">
              <div className="flex-1 flex items-center bg-background border border-border rounded-lg overflow-hidden focus-within:border-primary/50">
                <span className="pl-3 pr-1 text-xs text-textMuted font-mono select-none">/file/</span>
                <input
                  type="text"
                  value={form.slug}
                  onChange={(e) => { setSlugTouched(true); setForm(f => ({ ...f, slug: e.target.value })); }}
                  onBlur={() => setForm(f => ({ ...f, slug: slugify(f.slug) }))}
                  placeholder={slugify(form.name) || 'page-url'}
                  className="flex-1 px-1 py-2 bg-transparent text-sm font-mono focus:outline-none"
                />
              </div>
              {slugTouched && (
                <button
                  type="button"
                  title="Reset the URL to match the name"
                  onClick={() => { setSlugTouched(false); setForm(f => ({ ...f, slug: slugify(f.name) })); }}
                  className="px-3 rounded-lg bg-surface border border-border text-textMuted hover:text-textPrimary"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
            <div className="text-[11px] mt-1 h-4">
              {slugState?.checking && <span className="text-textMuted">Checking availability...</span>}
              {!slugState?.checking && slugState?.available === true && (
                <span className="text-green-400 flex items-center gap-1"><Check className="w-3 h-3" /> /file/{slugState.slug} is free</span>
              )}
              {!slugState?.checking && slugState?.available === false && (
                <span className="text-red-400 flex items-center gap-1">
                  <AlertCircle className="w-3 h-3" /> Already used by “{slugState.takenBy?.name || 'another page'}”
                </span>
              )}
            </div>
          </div>

          {field('Short description *', 'description', {
            wide: true,
            placeholder: 'One line shown on cards and in search (5-500 chars)',
            hint: `${form.description.length}/500`,
          })}
          {field('Category', 'category_id', {
            type: 'select',
            options: [{ value: '', label: '— None —' }, ...categories.map(c => ({ value: String(c.id), label: c.name }))],
          })}
          {field('Version', 'version', { placeholder: '24.04.1' })}
          {field('Release date', 'release_date', { type: 'date' })}
          {field('Tags (comma separated)', 'tags', { placeholder: 'ubuntu, linux, lts' })}
        </div>
      )}

      {section === 'description' && (
        <div className="space-y-4">
          <MarkdownField
            label="Page body (markdown)"
            value={form.long_description}
            onChange={(v) => setForm(f => ({ ...f, long_description: v }))}
            onGenerate={generateDescription}
            hint="Headings, lists, links and code blocks are supported and render on the public page."
          />
          {aiNotice && (
            <div className="p-3 rounded-xl bg-primary/10 border border-primary/20 text-xs text-primary flex items-start gap-2">
              <Sparkles className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" /> <span>{aiNotice}</span>
            </div>
          )}
          <MarkdownField
            label="Changelog (markdown, optional)"
            value={form.changelog}
            onChange={(v) => setForm(f => ({ ...f, changelog: v }))}
            rows={8}
            hint="What changed in this version. Shown under the description."
          />
        </div>
      )}

      {section === 'media' && (
        <div className="space-y-6">
          <ImagePicker
            label="Cover image"
            value={form.image_url}
            onChange={(v) => setForm(f => ({ ...f, image_url: v }))}
            hint="Shown at the top of the item page and on cards. Upload a file or paste a URL."
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
          <details className="rounded-xl border border-border bg-background p-3">
            <summary className="text-xs text-textMuted cursor-pointer select-none">
              Legacy single-source fields (rarely needed)
            </summary>
            <p className="text-xs text-textMuted my-3">
              The mirrors above take precedence; these older fields are kept for pages that still use them.
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
          </details>
        </div>
      )}

      {section === 'details' && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {field('File name', 'file_name', { placeholder: 'ubuntu-24.04.1-desktop-amd64.iso' })}
          {field('File size (bytes)', 'file_size', { type: 'number' })}
          {field('File type', 'file_type', { placeholder: 'iso, exe, zip, pdf' })}
          {field('Platform', 'platform', { placeholder: 'linux, windows, macos' })}
          {field('Architecture', 'architecture', { placeholder: 'x64, arm64, universal' })}
          {field('SHA-256', 'sha256', { mono: true })}
          {field('MD5', 'md5', { mono: true })}
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

      {/* Readiness checklist — so nothing is discovered only after saving. */}
      {section !== 'start' && (
        <div className="mt-6 rounded-xl border border-border bg-background p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[11px] uppercase tracking-widest text-textMuted">Page checklist</span>
            <span className={`text-[11px] ${blockers.length ? 'text-amber-400' : 'text-green-400'}`}>
              {blockers.length
                ? `${blockers.length} required item${blockers.length === 1 ? '' : 's'} left`
                : optionalMissing.length ? 'Ready to publish — some optional fields empty' : 'Complete'}
            </span>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1.5">
            {checklist.map(c => (
              <button
                key={c.id}
                type="button"
                onClick={() => setSection(c.section)}
                className={`text-xs flex items-center gap-1.5 hover:underline ${
                  c.done ? 'text-green-400' : c.required ? 'text-amber-400' : 'text-textMuted'
                }`}
              >
                {c.done ? <CheckCircle2 className="w-3.5 h-3.5" /> : <Circle className="w-3.5 h-3.5" />}
                {c.label}{c.required && !c.done ? ' *' : ''}
              </button>
            ))}
          </div>
        </div>
      )}

      {error && (
        <div className="mt-4 p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-sm text-red-400 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3 mt-6 pt-4 border-t border-border">
        <button
          type="button"
          onClick={() => goto(-1)}
          disabled={sectionIndex <= 0}
          className="px-3 py-2.5 bg-surface border border-border rounded-xl text-sm text-textSecondary disabled:opacity-30 flex items-center gap-1.5"
        >
          <ArrowLeft className="w-4 h-4" /> Back
        </button>
        <button
          type="button"
          onClick={() => goto(1)}
          disabled={sectionIndex >= sections.length - 1}
          className="px-3 py-2.5 bg-surface border border-border rounded-xl text-sm text-textSecondary disabled:opacity-30 flex items-center gap-1.5"
        >
          Next <ArrowRight className="w-4 h-4" />
        </button>

        <span className="hidden sm:block text-[11px] text-textMuted ml-1">⌘/Ctrl + S to save</span>

        <div className="flex items-center gap-2 ml-auto">
          {onClose && (
            <button type="button" onClick={onClose} className="px-4 py-2.5 bg-surface border border-border rounded-xl text-sm">
              Cancel
            </button>
          )}
          <button
            type="button"
            onClick={() => save({ publish: false })}
            disabled={saving}
            className="px-4 py-2.5 bg-surface border border-border rounded-xl text-sm text-textSecondary hover:border-primary/30 disabled:opacity-50"
          >
            Save as draft
          </button>
          <button
            type="submit"
            disabled={saving}
            className="px-6 py-2.5 bg-gradient-primary text-white rounded-xl text-sm font-medium flex items-center gap-2 disabled:opacity-50"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            {saving ? 'Saving...' : (isEdit ? 'Save changes' : 'Create page')}
          </button>
          {!form.published && (
            <button
              type="button"
              onClick={() => save({ publish: true })}
              disabled={saving}
              className="px-4 py-2.5 bg-green-500/10 border border-green-500/30 text-green-400 rounded-xl text-sm font-medium flex items-center gap-2 disabled:opacity-50"
            >
              <LinkIcon className="w-4 h-4" /> Save &amp; publish
            </button>
          )}
        </div>
      </div>
    </form>
  );
}
