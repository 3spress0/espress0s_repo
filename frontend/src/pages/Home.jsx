import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Sparkles, Clock, Layers } from 'lucide-react';
import Hero from '../components/Hero';
import ItemCard from '../components/ItemCard';
import RecentlyViewed from '../components/RecentlyViewed';
import { statsApi, itemsApi, categoriesApi } from '../lib/api';

export default function Home() {
  const [stats, setStats] = useState(null);
  const [featured, setFeatured] = useState([]);
  const [newest, setNewest] = useState([]);
  const [categories, setCategories] = useState([]);

  useEffect(() => {
    statsApi.get().then(setStats).catch(() => {});
    itemsApi.list({ featured: 1, sort: 'date', order: 'desc', limit: 6 })
      .then(d => setFeatured(d.items || [])).catch(() => {});
    itemsApi.list({ sort: 'date', order: 'desc', limit: 6 })
      .then(d => setNewest(d.items || [])).catch(() => {});
    categoriesApi.list().then(d => setCategories(d.categories || [])).catch(() => {});
  }, []);

  return (
    <div className="min-h-screen">
      <Hero stats={stats} />

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pb-16 -mt-2 space-y-12">
        {/* Quick category shortcuts */}
        <section>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-textPrimary flex items-center gap-2">
              <Layers className="w-4 h-4 text-primary" /> Categories
            </h2>
            <Link to="/browse" className="text-sm text-textMuted hover:text-primary flex items-center gap-1">
              Browse all <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          </div>
          <div className="flex flex-wrap gap-2">
            {categories.map(cat => (
              <Link
                key={cat.id}
                to={`/browse?category=${cat.slug}`}
                className="px-4 py-2 rounded-xl bg-surface border border-border text-sm text-textSecondary hover:text-textPrimary hover:border-primary/40 transition-colors"
              >
                {cat.name} <span className="text-textMuted">({cat.count?.toLocaleString?.() ?? cat.count})</span>
              </Link>
            ))}
          </div>
        </section>

        {/* Featured */}
        {featured.length > 0 && (
          <section>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-textPrimary flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-purple-400" /> Featured downloads
              </h2>
              <Link to="/browse?featured=1" className="text-sm text-textMuted hover:text-primary flex items-center gap-1">
                All featured <ArrowRight className="w-3.5 h-3.5" />
              </Link>
            </div>
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {featured.map(item => <ItemCard key={item.id} item={item} featured />)}
            </div>
          </section>
        )}

        <RecentlyViewed />

        {/* Newest */}
        {newest.length > 0 && (
          <section>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-textPrimary flex items-center gap-2">
                <Clock className="w-4 h-4 text-cyan-400" /> Recently added
              </h2>
              <Link to="/browse?sort=date" className="text-sm text-textMuted hover:text-primary flex items-center gap-1">
                See all <ArrowRight className="w-3.5 h-3.5" />
              </Link>
            </div>
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {newest.map(item => <ItemCard key={item.id} item={item} />)}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
