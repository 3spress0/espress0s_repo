import { Link } from 'react-router-dom';
import { Database, Shield } from 'lucide-react';
import { useSettings } from '../context/SettingsContext';
import { safeHref } from '../lib/utils';
import { LOGO_SRC } from '../lib/brand.js';

/**
 * Footer. Branding, intro copy and every link come from site settings, so an
 * admin can restructure the footer from /admin/settings without a deploy.
 * `footer_links` is a JSON array of { label, href, group, external }.
 */
export default function Footer() {
  const { get } = useSettings();

  const siteName = get('site_name', '');
  const tagline = get('site_tagline', '');
  const note = get('footer_note', '');
  const intro = get('footer_intro', '');
  const copyright = get('footer_copyright', '');

  const links = Array.isArray(get('footer_links', [])) ? get('footer_links', []) : [];

  // Preserve the order groups first appear in the data.
  const groups = [];
  for (const l of links) {
    const g = l.group || 'Links';
    if (!groups.includes(g)) groups.push(g);
  }

  const isExternal = (l) => !!l.external || /^https?:\/\//i.test(l.href || '');

  return (
    <footer className="border-t border-white/5 mt-20 bg-surface/50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <div className="grid md:grid-cols-4 gap-8">
          <div className="md:col-span-2">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-9 h-9 rounded-xl overflow-hidden">
                <img src={LOGO_SRC} alt="" className="w-full h-full object-contain" />
              </div>
              <div>
                <h3 className="font-bold text-textPrimary">{siteName}</h3>
                {tagline && <p className="text-xs text-textMuted">{tagline}</p>}
              </div>
            </div>
            {intro && (
              <p className="text-sm text-textSecondary max-w-md leading-relaxed whitespace-pre-line">{intro}</p>
            )}
          </div>

          {groups.map(group => (
            <div key={group}>
              <h4 className="font-semibold text-textPrimary mb-4 text-sm uppercase tracking-widest">{group}</h4>
              <ul className="space-y-2 text-sm">
                {links.filter(l => (l.group || 'Links') === group).map((l, i) => (
                  <li key={`${l.href}-${i}`}>
                    {isExternal(l) ? (
                      <a href={safeHref(l.href) || '#'} target="_blank" rel="noopener noreferrer" className="text-textSecondary hover:text-primary transition-colors">
                        {l.label}
                      </a>
                    ) : (
                      <Link to={l.href} className="text-textSecondary hover:text-primary transition-colors">
                        {l.label}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-12 pt-8 border-t border-white/5 flex flex-col md:flex-row items-center justify-between gap-4">
          <p className="text-xs text-textMuted">
            {copyright || `© ${new Date().getFullYear()} ${siteName}`}
          </p>
          <div className="flex items-center gap-4 text-xs text-textMuted">
            {note && <span>{note}</span>}
            <span className="flex items-center gap-1.5"><Database className="w-3.5 h-3.5" /> SQLite • FTS5</span>
            <span className="flex items-center gap-1.5"><Shield className="w-3.5 h-3.5" /> Encrypted metadata</span>
          </div>
        </div>
      </div>
    </footer>
  );
}
