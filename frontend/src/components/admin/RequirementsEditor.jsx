import { Plus, Trash2 } from 'lucide-react';

export const REQUIREMENT_TYPES = [
  { id: 'os', label: 'Operating system' },
  { id: 'runtime', label: 'Runtime / framework' },
  { id: 'hardware', label: 'Hardware' },
  { id: 'dependency', label: 'Dependency' },
  { id: 'other', label: 'Other' },
];

const EMPTY_ROW = { type: 'dependency', name: '', version: '', optional: false, note: '' };

/**
 * Structured "requires" rows for an entry: OS, runtimes, hardware, other
 * packages. Stored as JSON on the item so the public page and the API can
 * render them consistently instead of parsing free text.
 */
export default function RequirementsEditor({ value = [], onChange }) {
  const rows = Array.isArray(value) ? value : [];
  const set = (i, patch) => onChange(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const input = 'px-3 py-2 bg-surface border border-border rounded-lg text-sm focus:outline-none focus:border-primary/50 w-full';
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="text-sm font-medium text-textSecondary">Requirements &amp; dependencies</label>
        <button type="button" onClick={() => onChange([...rows, { ...EMPTY_ROW }])} className="text-xs text-primary hover:underline flex items-center gap-1"><Plus className="w-3.5 h-3.5" /> Add row</button>
      </div>
      {rows.length === 0 && <p className="text-xs text-textMuted">None listed. Add what this software needs to run: OS version, runtimes such as .NET or Java, RAM, other packages.</p>}
      {rows.map((r, i) => (
        <div key={i} className="grid grid-cols-12 gap-2 items-center">
          <select value={r.type || 'other'} onChange={e => set(i, { type: e.target.value })} className={`${input} col-span-12 sm:col-span-3`}>
            {REQUIREMENT_TYPES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
          <input value={r.name || ''} onChange={e => set(i, { name: e.target.value })} placeholder="Name (e.g. .NET Framework)" className={`${input} col-span-7 sm:col-span-3`} />
          <input value={r.version || ''} onChange={e => set(i, { version: e.target.value })} placeholder="Version (>= 4.8)" className={`${input} col-span-5 sm:col-span-2 font-mono`} />
          <input value={r.note || ''} onChange={e => set(i, { note: e.target.value })} placeholder="Note (optional)" className={`${input} col-span-9 sm:col-span-3`} />
          <div className="col-span-3 sm:col-span-1 flex items-center justify-end gap-2">
            <label className="text-[11px] text-textMuted flex items-center gap-1" title="Optional requirement"><input type="checkbox" checked={!!r.optional} onChange={e => set(i, { optional: e.target.checked })} className="accent-purple-500" />opt</label>
            <button type="button" onClick={() => onChange(rows.filter((_, idx) => idx !== i))} className="p-1.5 rounded-lg text-textMuted hover:text-red-400" title="Remove"><Trash2 className="w-4 h-4" /></button>
          </div>
        </div>
      ))}
    </div>
  );
}
