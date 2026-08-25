import { useEffect, useState } from 'react';
import Hero from '../components/Hero';
import Stats from '../components/Stats';
import { statsApi } from '../lib/api';

export default function Home() {
  const [stats, setStats] = useState(null);

  useEffect(() => {
    async function load() {
      try {
        const statsData = await statsApi.get().catch(() => null);
        if (statsData) setStats(statsData);
      } catch (e) {
        console.error('Failed to load home data', e);
      }
    }
    load();
  }, []);

  return (
    <div className="min-h-screen">
      <Hero stats={stats} />

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 space-y-16 pb-16">
        {stats && (
          <section>
            <Stats stats={stats} />
          </section>
        )}
      </div>
    </div>
  );
}
