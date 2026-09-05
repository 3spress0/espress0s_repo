import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Sparkles, Layers } from 'lucide-react';
import { itemsApi } from '../lib/api';
import { ItemPlaceholder } from './Logo';

/**
 * "Similar software" under an entry. The server scores the catalogue
 * deterministically (tags, category, curator links, description text) and,
 * when an AI provider is configured, lets it reorder that pool. The badge
 * says which path produced the list, so a plain ranking never masquerades as
 * an AI one.
 */
export default function SimilarSoftware({ slug }) {
  const [data, setData] = useState(null);

  useEffect(() => {
    let alive = true;
    setData(null);
    itemsApi.similar(slug).then((d) => { if (alive) setData(d); }).catch(() => { if (alive) setData({ items: [] }); });
    return () => { alive = false; };
  }, [slug]);

  if (!data || !data.items?.length) return null;

  return (
    <section className="mt-10" aria-labelledby="similar-heading">
      <div className="flex items-center justify-between mb-4">
        <h2 id="similar-heading" className="text-lg font-semibold text-textPrimary flex items-center gap-2">
          <Layers className="w-5 h-5 text-primary" /> Similar software
        </h2>
        <span className="text-[11px] text-textMuted inline-flex items-center gap-1" title={data.usedAI ? `Ranked by ${data.provider}` : 'Ranked by tags, category and description'}>
          {data.usedAI ? <><Sparkles className="w-3 h-3" /> AI-ranked</> : 'catalogue match'}
        </span>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        {data.items.map((it) => (
          <Link key={it.id} to={`/file/${it.slug}`} className="glass rounded-xl border border-white/5 p-3 hover:border-primary/40 transition-colors flex gap-3 min-w-0">
            {it.icon_url || it.image_url
              ? <img src={it.icon_url || it.image_url} alt="" className="w-10 h-10 rounded-lg object-cover flex-shrink-0" loading="lazy" />
              : <ItemPlaceholder fileType={it.file_type} size="small" className="flex-shrink-0" />}
            <div className="min-w-0">
              <div className="text-sm font-medium text-textPrimary truncate">{it.name}{it.version ? <span className="text-textSecondary font-normal"> {it.version}</span> : null}</div>
              <div className="text-xs text-textSecondary line-clamp-2">{it.description}</div>
              {it.why && <div className="text-[10px] text-textMuted mt-1 truncate">{it.why}</div>}
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}
