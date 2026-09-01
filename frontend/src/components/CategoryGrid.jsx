import { Link } from 'react-router-dom';
import { Monitor, Disc, Package, Wrench, Code2, Gamepad2, BookOpen, Folder, HardDrive } from 'lucide-react';

const categoryIcons = {
  'operating-systems': Monitor,
  'isos': Disc,
  'applications': Package,
  'utilities': Wrench,
  'development': Code2,
  'games': Gamepad2,
  'documentation': BookOpen,
  'other': Folder,
};

export default function CategoryGrid({ categories }) {
  if (!categories?.length) {
    return (
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[...Array(8)].map((_, i) => (
          <div key={i} className="h-32 rounded-2xl bg-surface border border-border animate-pulse" />
        ))}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
      {categories.map((cat) => {
        const Icon = categoryIcons[cat.slug] || Folder;
        return (
          <Link
            key={cat.id}
            to={`/browse?category=${cat.slug}`}
            className="group relative overflow-hidden rounded-2xl bg-surface border border-border hover:border-primary/30 p-5 transition-all hover:shadow-xl hover:shadow-purple-500/5 hover:-translate-y-1"
          >
            <div className="absolute inset-0 bg-gradient-subtle opacity-0 group-hover:opacity-100 transition-opacity" />
            <div className="absolute top-0 right-0 w-20 h-20 bg-gradient-to-br from-purple-500/10 to-blue-500/10 rounded-full blur-xl group-hover:from-purple-500/20 group-hover:to-blue-500/20 transition-all" />
            
            <div className="relative">
              <div className="w-10 h-10 rounded-xl flex items-center justify-center mb-3"
                   style={{ backgroundColor: cat.color ? `${cat.color}15` : 'rgb(var(--c-primary) / 0.08)', border: cat.color ? `1px solid ${cat.color}30` : '1px solid rgb(var(--c-primary) / 0.2)' }}>
                <Icon className="w-5 h-5" style={{ color: cat.color || 'rgb(var(--c-primary))' }} />
              </div>
              
              <h3 className="font-semibold text-textPrimary group-hover:text-white transition-colors mb-1">
                {cat.name}
              </h3>
              <p className="text-xs text-textMuted line-clamp-2 mb-3">
                {cat.description}
              </p>
              
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium px-2.5 py-1 rounded-full bg-surfaceHover border border-border text-textSecondary group-hover:border-primary/20 group-hover:text-primary transition-all">
                  {cat.count || 0} files
                </span>
                <span className="text-xs text-textMuted group-hover:text-primary group-hover:translate-x-1 transition-all">
                  →
                </span>
              </div>
            </div>
          </Link>
        );
      })}
    </div>
  );
}
