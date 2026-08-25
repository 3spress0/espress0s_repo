import { useEffect, useState } from 'react';
import { adminApi } from '../../lib/api';

const PROVIDERS = [
  {
    id: 'gdrive',
    title: 'Google Drive Provider',
    body: 'Set storage_path to the File ID (e.g. 1a2b3c...). Encrypted at rest. The download URL is constructed as https://drive.google.com/uc?export=download&id=FILEID',
  },
  {
    id: 'onedrive',
    title: 'OneDrive Provider',
    body: 'Set download_url to a shareable link. Encrypted at rest. ?download=1 is appended for a direct download.',
  },
  {
    id: 'external',
    title: 'External URL',
    body: 'Set download_url to a direct external URL. Encrypted at rest. No storage_path needed.',
  },
  {
    id: 'github',
    title: 'GitHub Releases',
    body: 'For open-source tools. Set download_url to the release asset URL. Encrypted at rest.',
  },
];

export default function AdminStorage() {
  const [providers, setProviders] = useState(null);

  useEffect(() => {
    adminApi.storage().then(d => setProviders(d.providers || d)).catch(() => setProviders([]));
  }, []);

  return (
    <div className="space-y-6">
      <div className="glass rounded-2xl border border-white/5 p-6">
        <h3 className="font-semibold text-textPrimary mb-3">Storage Abstraction</h3>
        <p className="text-sm text-textSecondary leading-relaxed">
          Large files are not stored on the VM. The database keeps only metadata - encrypted with AES-256-GCM -
          and downloads redirect straight to the configured provider.
        </p>
      </div>

      {Array.isArray(providers) && providers.length > 0 && (
        <div className="glass rounded-2xl border border-white/5 p-6">
          <h3 className="font-semibold text-textPrimary mb-4">Configured Providers</h3>
          <div className="grid md:grid-cols-3 gap-3">
            {providers.map(p => (
              <div key={p.id} className="p-4 rounded-xl bg-surface border border-border">
                <div className="font-medium text-textPrimary text-sm">{p.name}</div>
                <div className="text-xs text-textMuted mt-1">ID: {p.id} • {p.enabled ? 'Enabled' : 'Disabled'}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="glass rounded-2xl border border-white/5 p-6">
        <h3 className="font-semibold text-textPrimary mb-4">How each provider works</h3>
        <div className="grid md:grid-cols-2 gap-4">
          {PROVIDERS.map(p => (
            <div key={p.id} className="p-4 rounded-xl bg-surface border border-border">
              <h4 className="font-medium text-textPrimary text-sm mb-2">{p.title}</h4>
              <p className="text-xs text-textMuted mb-3">{p.body}</p>
              <code className="text-xs bg-background p-2 rounded block font-mono">storage_provider: {p.id}</code>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
