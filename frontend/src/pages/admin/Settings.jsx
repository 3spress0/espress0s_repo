import { useEffect, useMemo, useState } from 'react';
import { Save, RotateCcw, Loader2, Check, AlertCircle, RefreshCw, Sparkles } from 'lucide-react';
import { adminApi, autoUpdateApi } from '../../lib/api';
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
  linkcheck: 'Link health checker',
  theme: 'Theme & effects',
};

// The AI backend is chosen from what the server understands rather than typed:
// a typo in a provider name resolves to "no model answering", which is a quiet
// failure an admin notices only when visitors get metadata answers.
const AI_SELECTS = {
  ai_provider: [
    { value: '', label: 'Keep the .env value' },
    { value: 'auto', label: 'auto — Gemini if a key is set, else tgpt' },
    { value: 'gemini', label: 'gemini — Google Gemini API' },
    { value: 'openai', label: 'openai — any /chat/completions endpoint' },
    { value: 'tgpt', label: 'tgpt — free CLI, no key' },
    { value: 'none', label: 'none — catalogue answers only' },
  ],
  ai_format: [
    { value: '', label: 'Derive from the provider' },
    { value: 'gemini', label: 'gemini — :generateContent' },
    { value: 'openai', label: 'openai — /chat/completions' },
  ],
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

    if (AI_SELECTS[m.key]) {
      const options = [...AI_SELECTS[m.key]];
      const current = value ?? '';
      // A value saved by an older release (or typed into .env) still has to be
      // visible, or editing another field would silently rewrite it.
      if (current && !options.some(o => o.value === current)) {
        options.splice(1, 0, { value: current, label: `${current} (from .env)` });
      }
      return (
        <select
          value={current}
          onChange={(e) => set(m.key, e.target.value)}
          className={common}
        >
          {options.map(o => <option key={o.value || 'keep'} value={o.value}>{o.label}</option>)}
        </select>
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

      <AiCard />
      <AutoUpdateCard />
    </div>
  );
}

/**
 * What the server actually resolved for the AI backend, plus a live test.
 *
 * The generated form above edits individual keys; this shows the merged result
 * (.env + these settings) and can fire one real request at it, because "saved"
 * and "working" are different claims - a wrong model name or a revoked key
 * otherwise surfaces as visitors quietly getting catalogue-only answers.
 * The API key itself is intentionally absent: it lives in .env and never in
 * the settings table, so there is nothing here to leak.
 */
function AiCard() {
  const [info, setInfo] = useState(null);
  const [result, setResult] = useState(null);
  const [testing, setTesting] = useState(false);

  const load = () => adminApi.aiStatus().then(setInfo).catch(() => setInfo(null));
  useEffect(() => { load(); }, []);

  const test = async () => {
    setTesting(true);
    setResult(null);
    try {
      setResult(await adminApi.aiTest());
    } catch (e) {
      setResult({ ok: false, error: e.response?.data?.error || e.message || 'Test request failed' });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="glass rounded-2xl border border-white/5 p-6">
      <div className="flex items-center gap-2 mb-3">
        <Sparkles className="w-4 h-4 text-primary" />
        <h3 className="font-semibold text-textPrimary">AI backend</h3>
        {info?.provider && (
          <span className="ml-auto text-xs text-textMuted font-mono">
            {info.provider}{info.model ? ` · ${info.model}` : ''}
          </span>
        )}
      </div>

      {info ? (
        <div className={`p-3 rounded-xl border text-sm ${info.ready ? 'bg-green-500/10 border-green-500/20 text-green-400' : 'bg-amber-500/10 border-amber-500/20 text-amber-400'}`}>
          <div className="font-medium">{info.ready ? `Answering via ${info.format}` : 'Catalogue answers only'}</div>
          <div className="mt-0.5 opacity-90 font-mono text-xs">{info.baseUrl || '—'}</div>
          <div className="mt-1 text-xs opacity-90">API key: {info.keyHint}</div>
          {info.tgptAvailable && <div className="mt-1 text-xs opacity-70">tgpt CLI: {info.tgptBinary}</div>}
          {info.notes?.length > 0 && (
            <ul className="mt-2 space-y-1 text-xs opacity-90 list-disc pl-4">
              {info.notes.map(n => <li key={n}>{n}</li>)}
            </ul>
          )}
          {info.error && <div className="mt-2 text-xs text-red-400">last failure: {info.error}</div>}
        </div>
      ) : (
        <div className="p-3 rounded-xl border border-border bg-surfaceHover text-sm text-textSecondary">
          Could not read the AI status from the server.
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={test}
          disabled={testing}
          className="px-4 py-2 bg-surface border border-border rounded-xl text-sm font-medium flex items-center gap-2 hover:border-primary/40 disabled:opacity-50"
        >
          {testing ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
          {testing ? 'Testing…' : 'Send a test prompt'}
        </button>
        <button
          type="button"
          onClick={load}
          className="text-xs text-textMuted hover:text-primary flex items-center gap-1"
        >
          <RotateCcw className="w-3 h-3" /> Reload status
        </button>
        {result && (
          <span className={`text-sm ${result.ok ? 'text-green-400' : 'text-red-400'}`}>
            {result.ok
              ? `OK in ${result.ms} ms — “${result.sample}”`
              : `Failed: ${result.error}`}
          </span>
        )}
      </div>
    </div>
  );
}

const STATE_STYLES = {
  updated: 'bg-green-500/10 border-green-500/20 text-green-400',
  idle:    'bg-blue-500/10 border-blue-500/20 text-blue-400',
  paused:  'bg-amber-500/10 border-amber-500/20 text-amber-400',
  skipped: 'bg-amber-500/10 border-amber-500/20 text-amber-400',
  error:   'bg-red-500/10 border-red-500/20 text-red-400',
};

/**
 * Read-only view of the host-side auto-updater (scripts/auto-update.sh).
 * The updater always runs on the machine, never from the browser - this card
 * just shows the state file the updater writes after every check.
 */
function AutoUpdateCard() {
  const [info, setInfo] = useState(null);
  useEffect(() => {
    let alive = true;
    const load = () => autoUpdateApi.status().then(d => { if (alive) setInfo(d); }).catch(() => { if (alive) setInfo({ state: null }); });
    load();
    const t = setInterval(load, 30000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const s = info?.state;
  return (
    <div className="glass rounded-2xl border border-white/5 p-6">
      <div className="flex items-center gap-2 mb-3">
        <RefreshCw className={`w-4 h-4 text-primary ${s ? '' : 'opacity-40'}`} />
        <h3 className="font-semibold text-textPrimary">Auto-update</h3>
        {info?.commit && (
          <span className="ml-auto text-xs text-textMuted font-mono">
            {info.branch}@{info.commit}
          </span>
        )}
      </div>
      {s ? (
        <div className={`p-3 rounded-xl border text-sm ${STATE_STYLES[s.state] || 'bg-surfaceHover border-border text-textSecondary'}`}>
          <div className="font-medium capitalize">{s.state}</div>
          <div className="mt-0.5 opacity-90">{s.message}</div>
          {s.at && <div className="mt-1 text-xs opacity-70">Last check: {new Date(s.at).toLocaleString()}</div>}
        </div>
      ) : (
        <div className="p-3 rounded-xl border border-border bg-surfaceHover text-sm text-textSecondary">
          Not running on this host. Keep the site current from the shell:
          <pre className="mt-2 p-2 rounded-lg bg-background border border-border text-xs font-mono overflow-x-auto">./scripts/start-tmux.sh          # app + updater in tmux
./scripts/auto-update.sh         # or standalone (adds --once, --service)</pre>
          <span className="text-xs text-textMuted">Pause anytime with <code className="font-mono">touch data/.auto-update-disabled</code>.</span>
        </div>
      )}
    </div>
  );
}
