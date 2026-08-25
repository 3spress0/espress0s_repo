import { config } from '../../config.js';
import { GoogleDriveProvider } from './GoogleDriveProvider.js';
import { OneDriveProvider } from './OneDriveProvider.js';
import { LocalProvider, ExternalProvider, GitHubProvider } from './LocalProvider.js';

class StorageManager {
  constructor() {
    this.providers = new Map();
    this.initProviders();
  }

  initProviders() {
    this.providers.set('local', new LocalProvider({ basePath: './uploads' }));
    this.providers.set('gdrive', new GoogleDriveProvider(config.storage.googleDrive));
    this.providers.set('onedrive', new OneDriveProvider(config.storage.onedrive));
    this.providers.set('external', new ExternalProvider({}));
    this.providers.set('github', new GitHubProvider({}));
  }

  getProvider(name) {
    const provider = this.providers.get(name);
    if (!provider) {
      throw new Error(`Unknown storage provider: ${name}`);
    }
    return provider;
  }

  async getDownloadUrl(providerName, storagePath, item) {
    const provider = this.getProvider(providerName);
    return await provider.getDownloadUrl(storagePath, item);
  }

  shouldRedirect(providerName) {
    try {
      const provider = this.getProvider(providerName);
      return provider.shouldRedirect();
    } catch {
      return true;
    }
  }

  listProviders() {
    return Array.from(this.providers.keys()).map(name => ({
      id: name,
      name: this.getProviderDisplayName(name),
      enabled: this.isEnabled(name),
    }));
  }

  getProviderDisplayName(name) {
    const names = {
      'local': 'Local Storage (Dev Only)',
      'gdrive': 'Google Drive',
      'onedrive': 'Microsoft OneDrive',
      'external': 'External URL',
      'github': 'GitHub Releases',
    };
    return names[name] || name;
  }

  isEnabled(name) {
    if (name === 'local') return true;
    if (name === 'external') return true;
    if (name === 'github') return true;
    if (name === 'gdrive') return config.storage.googleDrive.enabled || true; // Allow even if not fully configured, admin sets link
    if (name === 'onedrive') return config.storage.onedrive.enabled || true;
    return true;
  }
}

export const storageManager = new StorageManager();
