import { StorageProvider } from './StorageProvider.js';

export class GoogleDriveProvider extends StorageProvider {
  constructor(config) {
    super(config);
    this.name = 'gdrive';
  }

  /**
   * Google Drive file ID handling
   * storagePath can be:
   * - File ID: "1a2b3c..."
   * - Full path not supported directly, we use ID
   */
  async getDownloadUrl(storagePath, item) {
    if (!storagePath) {
      throw new Error('Missing storage path for Google Drive');
    }

    // If item already has a direct download_url, prefer it (admin may have set it)
    if (item && item.download_url && item.download_url.startsWith('http')) {
      return item.download_url;
    }

    // Extract file ID if storagePath looks like URL
    let fileId = storagePath;
    
    // Handle URLs like https://drive.google.com/file/d/FILEID/view
    const driveMatch = storagePath.match(/\/d\/([a-zA-Z0-9_-]+)/);
    if (driveMatch) {
      fileId = driveMatch[1];
    }
    
    // Handle id= parameter
    const idParam = storagePath.match(/[?&]id=([a-zA-Z0-9_-]+)/);
    if (idParam) {
      fileId = idParam[1];
    }

    // If API key configured and direct download preferred
    // Note: For large files, Drive shows warning page. We redirect to uc endpoint which handles that.
    // For production, consider using Drive API with auth.
    if (this.config.apiKey) {
      return `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&key=${this.config.apiKey}`;
    }

    // Standard direct download link (works for files <100MB without virus scan warning)
    // For larger files, this will redirect to a confirmation page - frontend should handle
    // Alternative that often works better: https://drive.google.com/uc?export=download&id=FILEID
    return `https://drive.google.com/uc?export=download&id=${fileId}`;
  }

  async validatePath(storagePath) {
    if (!storagePath) return false;
    // Basic validation: ID should be alphanumeric with - _
    const id = storagePath.match(/\/d\/([a-zA-Z0-9_-]+)/)?.[1] || storagePath.split('?')[0];
    if (/^[a-zA-Z0-9_-]{10,}$/.test(id)) return true;
    // A full URL counts only when its *host* is Drive. Testing whether the
    // string contains "drive.google.com" anywhere would accept
    // https://attacker.example/?x=drive.google.com and
    // https://drive.google.com.attacker.example/file alike.
    try {
      return new URL(storagePath).host === 'drive.google.com';
    } catch {
      return false;
    }
  }

  async getMetadata(storagePath) {
    // In real implementation, call Drive API
    // For now return null - metadata is stored in our DB
    return {
      provider: 'gdrive',
      path: storagePath,
      // Would fetch: name, size, mimeType, etc via API
    };
  }

  shouldRedirect() {
    return true; // Always redirect, don't proxy large files
  }

  // Helper to convert file ID to view link (for admin)
  static toViewLink(fileId) {
    return `https://drive.google.com/file/d/${fileId}/view`;
  }
}
