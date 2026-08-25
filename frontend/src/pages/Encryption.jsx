import { useState, useEffect } from 'react';
import { Shield, Lock, Key, Database, Eye, EyeOff, Check, AlertTriangle, FileKey, Hash } from 'lucide-react';
import { authApi } from '../lib/api';

export default function Encryption() {
  const [securityInfo, setSecurityInfo] = useState(null);
  const [encryptionStatus, setEncryptionStatus] = useState(null);
  const [showKeys, setShowKeys] = useState(false);
  const [testData, setTestData] = useState({ plaintext: 'my secret file path', encrypted: '', decrypted: '' });

  useEffect(() => {
    authApi.securityInfo().then(setSecurityInfo).catch(() => {});
    // Try to get encryption status (requires auth)
    fetch('/api/auth/encryption-status', {
      headers: { 'Authorization': `Bearer ${localStorage.getItem('espress0_token')}` }
    })
      .then(r => r.json())
      .then(setEncryptionStatus)
      .catch(() => {});
  }, []);

  const testEncryption = async () => {
    // Simulate encryption via backend? For demo, show what encrypted looks like
    const fakeEncrypted = `enc_v1:${btoa('random_iv_12b')}:${btoa('auth_tag_16b')}:${btoa(testData.plaintext)}`;
    setTestData(prev => ({ ...prev, encrypted: fakeEncrypted, decrypted: prev.plaintext }));
  };

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="text-center mb-8">
        <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-green-500/10 border border-green-500/20 text-sm mb-4">
          <Lock className="w-4 h-4 text-green-400" />
          <span className="text-green-300 font-medium">Encryption at Rest • AES-256-GCM</span>
        </div>
        <h1 className="text-4xl font-bold tracking-tight mb-3">
          Encrypted <span className="gradient-text">Storage</span>
        </h1>
        <p className="text-textSecondary max-w-2xl mx-auto">
          Passwords and sensitive data are encrypted at rest. Even if database file leaks, data remains protected without keys.
        </p>
      </div>

      <div className="grid lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          {/* How it works */}
          <div className="glass rounded-2xl border border-white/5 p-6">
            <h2 className="font-semibold text-textPrimary flex items-center gap-2 mb-6">
              <FileKey className="w-5 h-5 text-primary" />
              How Encryption Works
            </h2>
            
            <div className="space-y-6">
              <div className="flex gap-4">
                <div className="w-12 h-12 rounded-xl bg-purple-500/10 border border-purple-500/20 flex items-center justify-center flex-shrink-0">
                  <Lock className="w-6 h-6 text-purple-400" />
                </div>
                <div className="flex-1">
                  <h3 className="font-semibold text-textPrimary">Passwords: Pepper + bcrypt</h3>
                  <p className="text-sm text-textSecondary mt-1 leading-relaxed">
                    Passwords are not just bcrypt. We first HMAC-SHA256 with a secret pepper (from env <code className="px-1.5 py-0.5 bg-surface rounded text-xs">PASSWORD_PEPPER</code>), then bcrypt cost 12.
                    Even if DB leaks, attacker needs pepper + bcrypt crack. Stored as <code className="text-xs font-mono bg-surface px-1.5 py-0.5 rounded">pepper_v1:$2b$12$...</code>
                  </p>
                  <div className="mt-3 p-3 rounded-xl bg-surface border border-border font-mono text-xs">
                    <div className="text-textMuted">Plain: MyPassword123!</div>
                    <div className="text-textMuted">Peppered: HMAC-SHA256(pepper, password) → 64 hex chars</div>
                    <div className="text-green-400">Stored: pepper_v1:$2b$12$...bcrypt...</div>
                  </div>
                </div>
              </div>

              <div className="flex gap-4">
                <div className="w-12 h-12 rounded-xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center flex-shrink-0">
                  <Database className="w-6 h-6 text-blue-400" />
                </div>
                <div className="flex-1">
                  <h3 className="font-semibold text-textPrimary">Sensitive Fields: AES-256-GCM</h3>
                  <p className="text-sm text-textSecondary mt-1 leading-relaxed">
                    Fields like <code className="text-xs bg-surface px-1 py-0.5 rounded">email, storage_path, download_url, external_url, license_notes</code> are encrypted with AES-256-GCM.
                    Random 12-byte IV per encryption, 16-byte auth tag for integrity. Format: <code className="text-xs font-mono">enc_v1:iv:authTag:ciphertext</code> (base64)
                  </p>
                  <div className="mt-3 grid sm:grid-cols-2 gap-2 text-xs">
                    <div className="p-2.5 rounded-xl bg-surface border border-border">
                      <div className="font-medium text-textPrimary">Encrypted Fields</div>
                      <div className="text-textMuted mt-1">• users.email<br/>• items.storage_path<br/>• items.download_url<br/>• items.external_url<br/>• items.license_notes</div>
                    </div>
                    <div className="p-2.5 rounded-xl bg-surface border border-border">
                      <div className="font-medium text-textPrimary">Not Encrypted (searchable)</div>
                      <div className="text-textMuted mt-1">• name, slug<br/>• description<br/>• file_name, file_type<br/>• platform, arch<br/>• tags (for FTS5 search)</div>
                    </div>
                  </div>
                </div>
              </div>

              <div className="flex gap-4">
                <div className="w-12 h-12 rounded-xl bg-green-500/10 border border-green-500/20 flex items-center justify-center flex-shrink-0">
                  <Hash className="w-6 h-6 text-green-400" />
                </div>
                <div className="flex-1">
                  <h3 className="font-semibold text-textPrimary">Searchable Encryption: HMAC for Email Lookup</h3>
                  <p className="text-sm text-textSecondary mt-1 leading-relaxed">
                    Email needs to be searchable for login, but we can't use random IV (would break lookup). Solution: store <strong>deterministic HMAC-SHA256 hash</strong> as <code className="text-xs bg-surface px-1 py-0.5 rounded">email_hash</code> for lookup, plus encrypted email for display.
                    Login flow: hash input email with same key → lookup via <code className="text-xs">email_hash</code> → decrypt email → verify.
                  </p>
                  <div className="mt-3 p-3 rounded-xl bg-surface border border-border font-mono text-xs space-y-1">
                    <div><span className="text-textMuted">Input:</span> <span className="text-textPrimary">user@example.com</span></div>
                    <div><span className="text-textMuted">email_hash:</span> <span className="text-blue-400">HMAC-SHA256(key, lower(email)) → 64 hex (deterministic)</span></div>
                    <div><span className="text-textMuted">email:</span> <span className="text-green-400">enc_v1:iv:tag:AES-GCM(email) (random IV)</span></div>
                  </div>
                </div>
              </div>

              <div className="flex gap-4">
                <div className="w-12 h-12 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center flex-shrink-0">
                  <Key className="w-6 h-6 text-amber-400" />
                </div>
                <div className="flex-1">
                  <h3 className="font-semibold text-textPrimary">Key Management</h3>
                  <p className="text-sm text-textSecondary mt-1">Keys from env, never in code or logs. Rotate via re-encryption.</p>
                  <div className="mt-3 p-3 rounded-xl bg-background border border-border font-mono text-xs">
                    <div className="text-textMuted"># Generate keys:</div>
                    <div className="text-green-400">openssl rand -base64 32  # ENCRYPTION_KEY</div>
                    <div className="text-green-400">openssl rand -hex 32     # PASSWORD_PEPPER</div>
                    <div className="text-green-400">openssl rand -base64 32  # JWT_SECRET</div>
                    <div className="text-textMuted mt-2"># .env perms:</div>
                    <div className="text-blue-400">chmod 600 .env</div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Live status */}
          <div className="glass rounded-2xl border border-white/5 p-6">
            <h3 className="font-semibold text-textPrimary flex items-center gap-2 mb-4">
              <Shield className="w-4 h-4 text-green-400" />
              Live Encryption Status
            </h3>
            
            {encryptionStatus ? (
              <div className="grid sm:grid-cols-2 gap-4">
                <div className="p-4 rounded-xl bg-surface border border-border">
                  <div className="text-xs text-textMuted uppercase tracking-widest mb-2">Users</div>
                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between"><span>Total</span><span className="font-bold">{encryptionStatus.users.totalUsers}</span></div>
                    <div className="flex justify-between"><span>Encrypted emails</span><span className="text-green-400 font-bold">{encryptionStatus.users.encryptedEmails}</span></div>
                    <div className="flex justify-between"><span>Legacy emails</span><span className={encryptionStatus.users.legacyEmails > 0 ? 'text-amber-400' : 'text-textMuted'}>{encryptionStatus.users.legacyEmails}</span></div>
                    <div className="flex justify-between"><span>Peppered pwd</span><span className="text-green-400 font-bold">{encryptionStatus.users.pepperedPasswords}</span></div>
                    <div className="flex justify-between"><span>With email_hash</span><span>{encryptionStatus.users.withEmailHash}</span></div>
                  </div>
                </div>
                <div className="p-4 rounded-xl bg-surface border border-border">
                  <div className="text-xs text-textMuted uppercase tracking-widest mb-2">Items</div>
                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between"><span>Total</span><span className="font-bold">{encryptionStatus.items.total}</span></div>
                    <div className="flex justify-between"><span>Enc storage_path</span><span className="text-green-400">{encryptionStatus.items.encryptedStoragePath}</span></div>
                    <div className="flex justify-between"><span>Enc download_url</span><span className="text-green-400">{encryptionStatus.items.encryptedDownloadUrl}</span></div>
                  </div>
                  <div className="mt-4 pt-4 border-t border-white/5">
                    <div className="text-xs text-textMuted uppercase tracking-widest mb-2">Keys Configured</div>
                    <div className="space-y-1 text-xs">
                      <div className="flex items-center gap-2"><Check className={`w-3 h-3 ${encryptionStatus.config.encryptionKeySet ? 'text-green-400' : 'text-amber-400'}`} /> ENCRYPTION_KEY: {encryptionStatus.config.encryptionKeySet ? 'Set' : 'Derived (set in prod!)'}</div>
                      <div className="flex items-center gap-2"><Check className={`w-3 h-3 ${encryptionStatus.config.pepperSet ? 'text-green-400' : 'text-amber-400'}`} /> PASSWORD_PEPPER: {encryptionStatus.config.pepperSet ? 'Set' : 'Derived'}</div>
                      <div className="flex items-center gap-2"><Check className={`w-3 h-3 ${encryptionStatus.config.jwtSet ? 'text-green-400' : 'text-red-400'}`} /> JWT_SECRET: {encryptionStatus.config.jwtSet ? 'Set' : 'Default!'}</div>
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="text-center py-8">
                <Lock className="w-8 h-8 mx-auto mb-2 text-textMuted" />
                <p className="text-sm text-textMuted">Login as admin to see live encryption status</p>
                <p className="text-xs text-textMuted mt-1">GET /api/auth/encryption-status requires Bearer token</p>
              </div>
            )}
          </div>

          {/* Test encryption */}
          <div className="glass rounded-2xl border border-white/5 p-6">
            <h3 className="font-semibold text-textPrimary mb-4">Test Encryption (Demo)</h3>
            <div className="space-y-3">
              <input
                type="text"
                value={testData.plaintext}
                onChange={(e) => setTestData(prev => ({ ...prev, plaintext: e.target.value }))}
                placeholder="Enter text to encrypt"
                className="w-full px-4 py-3 bg-surface border border-border rounded-xl text-sm"
              />
              <button onClick={testEncryption} className="px-4 py-2 bg-gradient-primary text-white rounded-xl text-sm">
                Simulate Encrypt
              </button>
              {testData.encrypted && (
                <div className="space-y-2">
                  <div className="p-3 rounded-xl bg-surface border border-border">
                    <div className="text-xs text-textMuted uppercase tracking-widest">Encrypted (AES-256-GCM)</div>
                    <div className="font-mono text-xs break-all mt-1 text-green-400">{testData.encrypted}</div>
                  </div>
                  <div className="p-3 rounded-xl bg-surface border border-border">
                    <div className="text-xs text-textMuted uppercase tracking-widest">Decrypted</div>
                    <div className="font-mono text-xs mt-1 text-textPrimary">{testData.decrypted}</div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Sidebar */}
        <div className="space-y-6">
          <div className="glass rounded-2xl border border-white/5 p-6">
            <h3 className="font-semibold text-textPrimary mb-4">Security Layers</h3>
            <div className="space-y-3 text-sm">
              <div className="flex gap-3">
                <div className="w-8 h-8 rounded-lg bg-green-500/10 flex items-center justify-center flex-shrink-0"><Check className="w-4 h-4 text-green-400" /></div>
                <div><div className="font-medium">At Rest</div><div className="text-xs text-textMuted">AES-256-GCM for sensitive fields, bcrypt+pepper for passwords</div></div>
              </div>
              <div className="flex gap-3">
                <div className="w-8 h-8 rounded-lg bg-blue-500/10 flex items-center justify-center flex-shrink-0"><Check className="w-4 h-4 text-blue-400" /></div>
                <div><div className="font-medium">In Transit</div><div className="text-xs text-textMuted">HTTPS via Caddy/Nginx, Helmet HSTS</div></div>
              </div>
              <div className="flex gap-3">
                <div className="w-8 h-8 rounded-lg bg-purple-500/10 flex items-center justify-center flex-shrink-0"><Check className="w-4 h-4 text-purple-400" /></div>
                <div><div className="font-medium">In Use</div><div className="text-xs text-textMuted">Decrypted only in memory, never logged, JWT Bearer auth</div></div>
              </div>
              <div className="flex gap-3">
                <div className="w-8 h-8 rounded-lg bg-amber-500/10 flex items-center justify-center flex-shrink-0"><Check className="w-4 h-4 text-amber-400" /></div>
                <div><div className="font-medium">Backups</div><div className="text-xs text-textMuted">Encrypted with same AES key, gzip, off-site via rclone</div></div>
              </div>
            </div>
          </div>

          {securityInfo && (
            <div className="glass rounded-2xl border border-white/5 p-6">
              <h3 className="font-semibold text-textPrimary mb-3">Protections Detail</h3>
              <div className="space-y-2 text-xs">
                {Object.entries(securityInfo.protections).slice(0, 8).map(([k, v]) => (
                  <div key={k} className="p-2.5 rounded-xl bg-surface border border-border">
                    <div className="font-medium text-textPrimary capitalize">{k}</div>
                    <div className="text-textMuted mt-1 leading-relaxed">{v}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="glass rounded-2xl border border-amber-500/20 bg-amber-500/5 p-6">
            <h3 className="font-semibold text-amber-300 flex items-center gap-2 mb-3">
              <AlertTriangle className="w-4 h-4" />
              Important
            </h3>
            <ul className="text-xs text-amber-200/70 space-y-2 list-disc list-inside">
              <li>Set <code>ENCRYPTION_KEY</code>, <code>PASSWORD_PEPPER</code>, <code>JWT_SECRET</code> in production — never use defaults</li>
              <li>Keys in <code>.env</code> with <code>chmod 600</code>, not committed</li>
              <li>Backups encrypted — need same key to restore</li>
              <li>If key lost, encrypted data unrecoverable — backup keys securely</li>
              <li>Rotation: decrypt with old key, encrypt with new, update version</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
