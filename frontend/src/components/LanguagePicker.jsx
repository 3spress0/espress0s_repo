import { Languages } from 'lucide-react';
import { useI18n } from '../i18n/index.jsx';

/** Interface-language selector. `compact` renders an icon + select for the navbar. */
export default function LanguagePicker({ compact = false }) {
  const { locale, choice, setLocale, locales, t } = useI18n();
  const detected = locales.find((l) => l.code === locale);
  const select = (
    <select
      aria-label={t('common.language')}
      value={choice || 'auto'}
      onChange={(e) => setLocale(e.target.value === 'auto' ? null : e.target.value)}
      className={compact
        ? 'bg-transparent text-sm text-textSecondary hover:text-textPrimary focus:outline-none cursor-pointer'
        : 'px-3 py-2.5 bg-surface border border-border rounded-xl text-sm focus:outline-none focus:border-primary/50'}
    >
      <option value="auto">{t('common.auto', { name: detected?.name || locale })}</option>
      {locales.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
    </select>
  );
  if (compact) {
    return (
      <div className="hidden sm:flex items-center gap-1.5 px-2 py-2 rounded-full text-textSecondary" title={t('common.language')}>
        <Languages className="w-4 h-4" />
        {select}
      </div>
    );
  }
  return (
    <div className="space-y-1.5">
      <label className="text-sm font-medium text-textSecondary flex items-center gap-2"><Languages className="w-4 h-4" /> {t('common.language')}</label>
      {select}
      <p className="text-xs text-textMuted">{t('common.languageHint')}</p>
    </div>
  );
}
