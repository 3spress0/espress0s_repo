import { PAGE_TEMPLATES } from './pageTemplates';

/**
 * Shown as the first step when creating a file page. Picking a template fills
 * in the mechanical fields and drops a markdown outline into the body, so a new
 * page starts at "fill in the blanks" instead of "stare at 25 empty fields".
 */
export default function TemplatePicker({ selected, onSelect }) {
  return (
    <div>
      <p className="text-sm text-textSecondary mb-1">Start from a template</p>
      <p className="text-xs text-textMuted mb-4">
        Pre-fills type, platform, tags and a description outline. Nothing you have already
        typed is overwritten, and every field stays editable.
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {PAGE_TEMPLATES.map(t => {
          const active = selected === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => onSelect(t)}
              className={`text-left p-4 rounded-xl border transition-all ${
                active
                  ? 'border-primary/60 bg-primary/10 shadow-lg shadow-purple-500/10'
                  : 'border-border bg-background hover:border-primary/30'
              }`}
            >
              <div className="flex items-center gap-2 mb-1.5">
                <span className="text-lg">{t.icon}</span>
                <span className="text-sm font-medium text-textPrimary">{t.label}</span>
              </div>
              <p className="text-xs text-textMuted leading-relaxed">{t.summary}</p>
            </button>
          );
        })}
      </div>
    </div>
  );
}
