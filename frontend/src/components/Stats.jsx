import { Database, HardDrive, Download, Layers } from 'lucide-react';

export default function Stats({ stats }) {
  if (!stats) return null;

  const items = [
    { label: 'Total Files', value: stats.totals.items, icon: Database, color: 'from-purple-500 to-violet-500' },
    { label: 'Categories', value: stats.totals.categories, icon: Layers, color: 'from-blue-500 to-cyan-500' },
    { label: 'Total Size', value: stats.totals.totalSizeFormatted, icon: HardDrive, color: 'from-emerald-500 to-teal-500' },
    { label: 'Downloads', value: stats.totals.totalDownloads?.toLocaleString() || '0', icon: Download, color: 'from-orange-500 to-pink-500' },
  ];

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      {items.map((stat, i) => (
        <div key={i} className="glass rounded-2xl p-5 border border-white/5 hover:border-white/10 transition-colors group">
          <div className="flex items-center justify-between mb-3">
            <div className={`w-10 h-10 rounded-xl bg-gradient-to-br ${stat.color} flex items-center justify-center shadow-lg group-hover:scale-110 transition-transform`}>
              <stat.icon className="w-5 h-5 text-white" />
            </div>
            <div className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
          </div>
          <div className="text-2xl font-bold text-textPrimary mb-1">{stat.value}</div>
          <div className="text-xs text-textMuted font-medium tracking-wide uppercase">{stat.label}</div>
        </div>
      ))}
    </div>
  );
}
