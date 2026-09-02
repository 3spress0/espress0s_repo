import { useRef, useState } from 'react';
import {
  Bold, Italic, Heading2, List, ListOrdered, Link2, Code, Quote,
  Eye, Pencil, Sparkles, Loader2, AlertCircle,
} from 'lucide-react';
import Markdown from '../../lib/markdown.jsx';

/**
 * Markdown body editor for a file page.
 *
 * Three things make writing a page bearable:
 *  - a toolbar that wraps the selection, so nobody has to remember syntax
 *  - a preview tab that renders exactly what the public page will render
 *  - "Draft with AI", which turns the metadata already in the form into a
 *    starting body (falls back to a filled-in skeleton when tgpt is absent)
 */

const TOOLBAR = [
  { id: 'bold', icon: Bold, title: 'Bold', wrap: ['**', '**'], placeholder: 'bold text' },
  { id: 'italic', icon: Italic, title: 'Italic', wrap: ['*', '*'], placeholder: 'italic text' },
  { id: 'heading', icon: Heading2, title: 'Heading', line: '## ', placeholder: 'Section title' },
  { id: 'ul', icon: List, title: 'Bullet list', line: '- ', placeholder: 'List item' },
  { id: 'ol', icon: ListOrdered, title: 'Numbered list', line: '1. ', placeholder: 'First step' },
  { id: 'link', icon: Link2, title: 'Link', wrap: ['[', '](https://)'], placeholder: 'link text' },
  { id: 'code', icon: Code, title: 'Code', wrap: ['`', '`'], placeholder: 'code' },
  { id: 'quote', icon: Quote, title: 'Quote', line: '> ', placeholder: 'Quoted note' },
];

export default function MarkdownField({
  label,
  value,
  onChange,
  rows = 14,
  hint,
  onGenerate,          // optional async () => string  (AI draft)
  generateLabel = 'Draft with AI',
  maxLength = 5000,
}) {
  const [tab, setTab] = useState('write');
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState('');
  const ref = useRef(null);

  const text = value || '';

  const applyFormat = (button) => {
    const el = ref.current;
    if (!el) return;

    const start = el.selectionStart ?? text.length;
    const end = el.selectionEnd ?? text.length;
    const selected = text.slice(start, end);

    let next;
    let caretStart;
    let caretEnd;

    if (button.wrap) {
      const [open, close] = button.wrap;
      const body = selected || button.placeholder;
      next = text.slice(0, start) + open + body + close + text.slice(end);
      caretStart = start + open.length;
      caretEnd = caretStart + body.length;
    } else {
      // Line prefix: apply to every selected line, or the current line.
      const body = selected || button.placeholder;
      const prefixed = body.split('\n').map(l => button.line + l).join('\n');
      next = text.slice(0, start) + prefixed + text.slice(end);
      caretStart = start + button.line.length;
      caretEnd = caretStart + body.length;
    }

    onChange(next.slice(0, maxLength));
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(caretStart, caretEnd);
    });
  };

  const runGenerate = async () => {
    if (!onGenerate) return;
    setError('');
    setGenerating(true);
    try {
      await onGenerate();
      setTab('write');
    } catch (e) {
      setError(e?.message || 'Could not generate a draft');
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
        <span className="text-[11px] text-textMuted">{label}</span>
        <div className="flex items-center gap-2">
          {onGenerate && (
            <button
              type="button"
              onClick={runGenerate}
              disabled={generating}
              className="px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 bg-primary/10 border border-primary/30 text-primary hover:bg-primary/20 disabled:opacity-50"
            >
              {generating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
              {generating ? 'Writing...' : generateLabel}
            </button>
          )}
          <div className="flex items-center gap-1 p-1 bg-background rounded-lg border border-border">
            {[
              { id: 'write', icon: Pencil, label: 'Write' },
              { id: 'preview', icon: Eye, label: 'Preview' },
            ].map(t => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                className={`px-2.5 py-1 rounded-md text-xs font-medium flex items-center gap-1.5 transition-colors ${
                  tab === t.id ? 'bg-gradient-primary text-white' : 'text-textSecondary hover:text-textPrimary'
                }`}
              >
                <t.icon className="w-3 h-3" /> {t.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {tab === 'write' ? (
        <>
          <div className="flex flex-wrap items-center gap-1 p-1.5 bg-background border border-border border-b-0 rounded-t-lg">
            {TOOLBAR.map(b => (
              <button
                key={b.id}
                type="button"
                title={b.title}
                onClick={() => applyFormat(b)}
                className="p-1.5 rounded-md text-textMuted hover:text-textPrimary hover:bg-surfaceHover transition-colors"
              >
                <b.icon className="w-3.5 h-3.5" />
              </button>
            ))}
            <span className="ml-auto text-[10px] text-textMuted pr-1 font-mono">
              {text.length}/{maxLength}
            </span>
          </div>
          <textarea
            ref={ref}
            value={text}
            rows={rows}
            maxLength={maxLength}
            onChange={(e) => onChange(e.target.value)}
            placeholder={'## Overview\n\nWhat this file is, who it is for...\n\n- bullet point\n- another point'}
            className="w-full px-3 py-2 bg-background border border-border rounded-b-lg text-sm font-mono leading-relaxed focus:outline-none focus:border-primary/50 resize-y"
          />
        </>
      ) : (
        <div className="min-h-[200px] px-4 py-3 bg-background border border-border rounded-lg">
          {text.trim()
            ? <Markdown>{text}</Markdown>
            : <p className="text-sm text-textMuted italic">Nothing to preview yet.</p>}
        </div>
      )}

      {error && (
        <div className="mt-2 text-xs text-red-400 flex items-center gap-1.5">
          <AlertCircle className="w-3.5 h-3.5" /> {error}
        </div>
      )}
      {hint && <p className="text-[11px] text-textMuted mt-1.5">{hint}</p>}
    </div>
  );
}
