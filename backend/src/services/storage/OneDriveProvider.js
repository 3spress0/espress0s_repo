import { StorageProvider } from './StorageProvider.js';

export class OneDriveProvider extends StorageProvider {
  constructor(config) {
    super(config);
    this.name = 'onedrive';
  }

  async getDownloadUrl(storagePath, item) {
    if (!storagePath && (!item || !item.download_url)) {
      throw new Error('Missing storage path for OneDrive');
    }

    // If item has explicit download_url, use it
    if (item && item.download_url && item.download_url.startsWith('http')) {
      // If it's a share link, convert to direct download if possible
      return this.convertShareLink(item.download_url);
    }

    // storagePath could be:
    // - /path/to/file.iso
    // - share link https://1drv.ms/...
    // - direct graph URL

    if (storagePath.startsWith('http')) {
      return this.convertShareLink(storagePath);
    }

    // If we have Drive ID and path, we could construct Graph API URL
    // For now, return a placeholder that would be resolved via Microsoft Graph
    // In production, you'd call Graph API: /drives/{drive-id}/root:/{path}:/content
    if (this.config.driveId) {
      // This URL requires auth token in production - for redirect we use share link approach
      // We'll return storagePath as-is and let admin provide shareable link via download_url
      // Fallback: if storagePath is a path, we can't direct download without auth, so require download_url
      throw new Error('OneDrive direct path download requires shareable link in download_url field. Please set download_url to a OneDrive share link.');
    }

    // If storagePath is already a share link, convert
    return storagePath;
  }

  convertShareLink(shareUrl) {
    // OneDrive share links: https://1drv.ms/u/s!... or https://onedrive.live.com/...
    // To get direct download, replace ? with ?download=1 or use format
    if (!shareUrl) return shareUrl;

    // If already has download param, return as is
    if (shareUrl.includes('download=1')) return shareUrl;

    // For 1drv.ms links, adding &download=1 or ?download=1 triggers download
    try {
      const url = new URL(shareUrl);
      url.searchParams.set('download', '1');
      return url.toString();
    } catch {
      // If not valid URL, return as is
      return shareUrl;
    }
  }

  async validatePath(storagePath) {
    if (!storagePath) return false;
    // Accept share links or paths
    return storagePath.length > 5;
  }

  async getMetadata(storagePath) {
    return {
      provider: 'onedrive',
      path: storagePath,
    };
  }

  shouldRedirect() {
    return true;
  }
}
