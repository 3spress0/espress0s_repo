import { StorageProvider } from './StorageProvider.js';
import path from 'path';
import fs from 'fs';

export class LocalProvider extends StorageProvider {
  constructor(config) {
    super(config);
    this.name = 'local';
    this.basePath = config.basePath || './uploads';
  }

  async getDownloadUrl(storagePath, item) {
    // For local provider in dev, if download_url is external, use it
    if (item && item.download_url && item.download_url.startsWith('http')) {
      return item.download_url;
    }

    // For local files, we would serve via /api/files/:path
    // But per requirements, we should not store large files on VM
    // So this is mainly for small files or external redirects
    if (storagePath && storagePath.startsWith('http')) {
      return storagePath;
    }

    // Return API endpoint that would serve file (if file exists locally)
    // In production, this provider should be avoided for large files
    return `/api/files/${encodeURIComponent(storagePath)}`;
  }

  async validatePath(storagePath) {
    if (!storagePath) return false;
    if (storagePath.startsWith('http')) return true;
    
    try {
      const fullPath = path.resolve(this.basePath, storagePath);
      // Prevent path traversal
      if (!fullPath.startsWith(path.resolve(this.basePath))) return false;
      return fs.existsSync(fullPath);
    } catch {
      return false;
    }
  }

  shouldRedirect() {
    return false; // For local, we can serve directly (small files)
  }
}

export class ExternalProvider extends StorageProvider {
  constructor(config) {
    super(config);
    this.name = 'external';
  }

  async getDownloadUrl(storagePath, item) {
    // External provider: download_url must be set
    if (item && item.download_url) {
      return item.download_url;
    }
    if (storagePath && storagePath.startsWith('http')) {
      return storagePath;
    }
    throw new Error('External provider requires download_url to be set');
  }

  async validatePath(storagePath) {
    return true; // External URLs are validated elsewhere
  }

  shouldRedirect() {
    return true;
  }
}

export class GitHubProvider extends StorageProvider {
  constructor(config) {
    super(config);
    this.name = 'github';
  }

  async getDownloadUrl(storagePath, item) {
    if (item && item.download_url) return item.download_url;
    if (storagePath && storagePath.startsWith('http')) return storagePath;
    throw new Error('GitHub provider requires download_url (release asset URL)');
  }

  shouldRedirect() {
    return true;
  }
}
