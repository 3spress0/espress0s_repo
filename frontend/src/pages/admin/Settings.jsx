import { useEffect, useMemo, useState } from 'react';
import { Save, RotateCcw, Loader2, Check, AlertCircle } from 'lucide-react';
import { adminApi } from '../../lib/api';
import { useSettings } from '../../context/SettingsContext';
import { DARK_THEMES, LIGHT_THEMES, getTheme } from '../../themes';
import { ThemeSwatch } from '../../components/ThemePicker';

const GROUP_LABELS = {
  general: 'General',
  homepage: 'Homepage',
  footer: 'Footer',
  auth: 'Authentication',
  ai: 'AI',
  uploads: 'Uploads',
  theme: 'Theme & effects',
};

// Scheme ids are picked from the registry rather than typed, so a typo can't
// silently fall back to the default palette.
const THEME_SELECTS = {
  theme_default: DARK_THEMES,
  theme_light_default: LIGHT_THEMES,
};

/**
 * Site settings editor. The form is generated from the `meta` the API returns,
 * so adding a new setting on the backend makes it editable here automatically -
 * no component changes needed.
 */
export default function AdminSettings() {
  const { refresh } = useSettings();
  const [settings, setSettings] = useState({});
  const [meta, setMeta] = useState([]);
  const [originals, setOriginals] = useState({});
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState(null);

  useEffect(() => {
    adminApi.settings()
      .then(d => {
        setSettings(d.settings || {});
        setOriginals(d.settings || {});
        setMeta(d.meta || []);
      })
      .catch(e => setStatus({ type: 'error', text: e.response?.data?.error || 'Failed to load settings' }));
  }, []);

  const groups = useMemo(() => {
    const out = {};
    for (const m of meta) (out[m.group] ||= []).push(m);
    return Object.entries(out).sort(([a], [b]) => a.localeCompare(b));
  }, [meta]);

  const dirtyKeys = Object.keys(settings).filter(k => settings[k] !== originals[k]);

  const set = (key, value) => setSettings(s => ({ ...s, [key]: value }));

  const save = async () => {
    if (!dirtyKeys.length) return;
    setSaving(true);
    setStatus(null);
    try {
      const patch = Object.fromEntries(dirtyKeys.map(k => [k, settings[k]]));
      await adminApi.updateSettings(patch);
      setOriginals(settings);
      setStatus({ type: 'ok', text: `Saved ${dirtyKeys.length} setting(s).` });
      await refresh(); // live-update the running site
    } catch (e) {
      setStatus({ type: 'error', text: e.response?.data?.error || 'Failed to save' });
    } finally {
      setSaving(false);
    }
  };

  const resetOne = async (key) => {
    try {
      const d = await adminApi.resetSetting(key);
      setSettings(s => ({ ...s, ...d.updated }));
      setStatus({ type: 'ok', text: `Reset ${key} to its default.` });
    } catch (e) {
      setStatus({ type: 'error', text: e.response?.data?.error || 'Reset failed' });
    }
  };

  const renderControl = (m) => {
    const value = settings[m.key];
    const common = 'w-full px-3 py-2 bg-background border border-border rounded-lg text-sm focus:outline-none focus:border-primary/50';

    // Theme defaults get a visual picker instead of a free-text scheme id.
    if (THEME_SELECTS[m.key]) {
      const options = THEME_SELECTS[m.key];
      const selected = getTheme(value);
      return (
        <div className="flex items-center gap-3">
          <ThemeSwatch theme={selected} size={36} />
          <select
            value={value ?? ''}
            onChange={(e) => set(m.key, e.target.value)}
            className={common}
          >
            {options.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
        </div>
      );
    }

    if (m.type === 'boolean') {
      return (
        <label className="flex items-center gap-2 text-sm text-textSecondary cursor-pointer">
          <input type="checkbox" checked={!!value} onChange={(e) => set(m.key, e.target.checked)} className="accent-purple-500" />
          {value ? 'On' : 'Off'}
        </label>
      );
    }
    if (m.type === 'textarea' || m.type === 'json') {
      return (
        <textarea
          value={typeof value === 'string' ? value : JSON.stringify(value ?? '', null, 2)}
          onChange={(e) => set(m.key, m.type === 'json' ? e.target.value : e.target.value)}
          rows={m.type === 'json' ? 8 : 3}
          className={`${common} ${m.type === 'json' ? 'font-mono text-xs' : ''}`}
        />
      );
    }
    return (
      <input
        type={m.type === 'number' ? 'number' : m.type === 'color' ? 'color' : 'text'}
        value={value ?? ''}
        onChange={(e) => set(m.key, m.type === 'number' ? Number(e.target.value) : e.target.value)}
        className={common}
      />
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-sm text-textMuted flex-1 min-w-[200px]">
          Site copy, branding and behaviour. Changes apply immediately - no rebuild needed.
        </p>
        <button
          onClick={save}
          disabled={!dirtyKeys.length || saving}
          className="px-5 py-2.5 bg-gradient-primary text-white rounded-xl text-sm font-medium flex items-center gap-2 disabled:opacity-40"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          {dirtyKeys.length ? `Save ${dirtyKeys.length} change${dirtyKeys.length > 1 ? 's' : ''}` : 'No changes'}
        </button>
      </div>

      {status && (
        <div className={`p-3 rounded-xl border text-sm flex items-start gap-2 ${
          status.type === 'ok' ? 'bg-green-500/10 border-green-500/20 text-green-400' : 'bg-red-500/10 border-red-500/20 text-red-400'
        }`}>
          {status.type === 'ok' ? <Check className="w-4 h-4 mt-0.5" /> : <AlertCircle className="w-4 h-4 mt-0.5" />}
          <span>{status.text}</span>
        </div>
      )}

      {groups.map(([group, fields]) => (
        <div key={group} className="glass rounded-2xl border border-white/5 p-6">
          <h3 className="font-semibold text-textPrimary mb-4">{GROUP_LABELS[group] || group}</h3>
          <div className="space-y-5">
            {fields.map(m => (
              <div key={m.key} className={m.type === 'json' || m.type === 'textarea' ? '' : 'grid sm:grid-cols-2 gap-3 items-start'}>
                <div>
                  <div className="text-sm text-textPrimary font-medium">{m.label}</div>
                  {m.description && <div className="text-xs text-textMuted mt-0.5">{m.description}</div>}
                  <div className="text-[11px] text-textMuted mt-1 font-mono">{m.key}{!m.public && ' • admin-only'}</div>
                </div>
                <div>
                  {renderControl(m)}
                  {settings[m.key] !== originals[m.key] && (
                    <button
                      type="button"
                      onClick={() => set(m.key, originals[m.key])}
                      className="mt-1.5 text-xs text-textMuted hover:text-primary flex items-center gap-1"
                    >
                      <RotateCcw className="w-3 h-3" /> Undo
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
