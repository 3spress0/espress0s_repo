import { useEffect, useRef, useState } from 'react';
import { Upload, Link2, Image as ImageIcon, X, Check } from 'lucide-react';
import { uploadsApi } from '../../lib/api';
import { LoadingDots } from '../Loading';

/**
 * Image field for the item editor.
 *
 * Supports three ways to set an image, because admins shouldn't have to host
 * their own assets first:
 *   1. upload a file (stored by the backend, returns /api/uploads/...)
 *   2. paste an external URL
 *   3. pick from previously uploaded media
 *
 * `value` is always a URL string, so it drops straight into image_url/icon_url.
 */
export default function ImagePicker({ label, value, onChange, hint }) {
  const [tab, setTab] = useState('upload');
  const [urlDraft, setUrlDraft] = useState(value || '');
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [library, setLibrary] = useState([]);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => { setUrlDraft(value || ''); }, [value]);

  const loadLibrary = async () => {
    setLibraryLoading(true);
    try {
      const data = await uploadsApi.list('image');
      setLibrary(data.uploads || []);
    } catch (e) {
      setError(e.response?.data?.error || 'Could not load media library');
    } finally {
      setLibraryLoading(false);
    }
  };

  useEffect(() => {
    if (tab === 'library') loadLibrary();
  }, [tab]);

  const doUpload = async (file) => {
    if (!file) return;
    setError('');
    setUploading(true);
    try {
      const data = await uploadsApi.upload(file);
      onChange(data.upload.url);
      setTab('upload');
    } catch (e) {
      setError(e.response?.data?.error || 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  const onDrop = (e) => {
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0];
    if (file) doUpload(file);
  };

  const applyUrl = () => {
    const v = urlDraft.trim();
    if (v && !/^(https?:\/\/|\/api\/uploads\/|data:image\/)/i.test(v)) {
      setError('Enter a full URL (https://...) or upload a file');
      return;
    }
    setError('');
    onChange(v);
  };

  return (
    <div>
      <label className="text-xs font-medium text-textMuted uppercase tracking-widest mb-2 block">{label}</label>

      {/* Current value preview */}
      <div className="flex items-start gap-3 mb-3">
        <div className="w-20 h-20 rounded-xl bg-surface border border-border flex items-center justify-center overflow-hidden flex-shrink-0">
          {value ? (
            <img src={value} alt="" loading="lazy" decoding="async" className="w-full h-full object-cover" onError={(e) => { e.target.style.display = 'none'; }} />
          ) : (
            <ImageIcon className="w-6 h-6 text-textMuted" />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-xs text-textSecondary truncate font-mono">{value || 'No image set'}</div>
          {value && (
            <button
              type="button"
              onClick={() => { onChange(''); setUrlDraft(''); }}
              className="mt-1 text-xs text-red-400 hover:text-red-300 flex items-center gap-1"
            >
              <X className="w-3 h-3" /> Remove image
            </button>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-3 p-1 bg-surface rounded-lg border border-border w-fit">
        {[
          { id: 'upload', label: 'Upload', icon: Upload },
          { id: 'url', label: 'From URL', icon: Link2 },
          { id: 'library', label: 'Library', icon: ImageIcon },
        ].map(t => (
          <button
            key={t.id}
            type="button"
            onClick={() => { setTab(t.id); setError(''); }}
            className={`px-3 py-1.5 rounded-md text-xs font-medium flex items-center gap-1.5 transition-colors ${
              tab === t.id ? 'bg-gradient-primary text-white' : 'text-textSecondary hover:text-textPrimary'
            }`}
          >
            <t.icon className="w-3 h-3" /> {t.label}
          </button>
        ))}
      </div>

      {tab === 'upload' && (
        <div
          onDragOver={(e) => e.preventDefault()}
          onDrop={onDrop}
          onClick={() => inputRef.current?.click()}
          className="border-2 border-dashed border-border rounded-xl p-5 text-center cursor-pointer hover:border-primary/40 transition-colors"
        >
          <input
            ref={inputRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
            className="hidden"
            onChange={(e) => doUpload(e.target.files?.[0])}
          />
          {uploading ? (
            <div className="flex items-center justify-center gap-2 text-sm text-textSecondary">
              <LoadingDots size={16} /> Uploading...
            </div>
          ) : (
            <>
              <Upload className="w-5 h-5 mx-auto mb-2 text-textMuted" />
              <p className="text-sm text-textSecondary">Click to choose, or drop an image here</p>
              <p className="text-xs text-textMuted mt-1">PNG, JPEG, GIF, WebP or SVG (max 5 MB)</p>
            </>
          )}
        </div>
      )}

      {tab === 'url' && (
        <div className="flex gap-2">
          <input
            type="url"
            value={urlDraft}
            onChange={(e) => setUrlDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); applyUrl(); } }}
            placeholder="https://example.com/cover.png"
            className="flex-1 px-3 py-2 bg-surface border border-border rounded-xl focus:outline-none focus:border-primary/50 text-sm"
          />
          <button
            type="button"
            onClick={applyUrl}
            className="px-4 py-2 bg-gradient-primary text-white rounded-xl text-xs font-medium flex items-center gap-1.5"
          >
            <Check className="w-3.5 h-3.5" /> Use
          </button>
        </div>
      )}

      {tab === 'library' && (
        <div>
          {libraryLoading ? (
            <div className="text-sm text-textMuted flex items-center gap-2"><LoadingDots size={16} /> Loading library...</div>
          ) : library.length === 0 ? (
            <p className="text-sm text-textMuted">Nothing uploaded yet. Use the Upload tab to add images.</p>
          ) : (
            <div className="grid grid-cols-4 sm:grid-cols-6 gap-2 max-h-40 overflow-y-auto">
              {library.map(u => (
                <button
                  key={u.id}
                  type="button"
                  onClick={() => { onChange(u.url); setError(''); }}
                  title={u.original_name}
                  className={`aspect-square rounded-lg overflow-hidden border transition-colors ${
                    value === u.url ? 'border-primary ring-2 ring-primary/30' : 'border-border hover:border-primary/40'
                  }`}
                >
                  <img src={u.url} alt={u.original_name} loading="lazy" decoding="async" className="w-full h-full object-cover" />
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
      {hint && !error && <p className="mt-2 text-xs text-textMuted">{hint}</p>}
    </div>
  );
}
