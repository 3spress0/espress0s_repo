/**
 * Abstract Storage Provider
 * All providers must implement these methods
 */
export class StorageProvider {
  constructor(config = {}) {
    this.config = config;
    this.name = 'abstract';
  }

  /**
   * Get a direct download URL for a file
   * @param {string} storagePath - path or ID in external storage
   * @param {object} item - full item metadata
   * @returns {Promise<string>} download URL
   */
  async getDownloadUrl(storagePath, item) {
    throw new Error('getDownloadUrl not implemented');
  }

  /**
   * Validate that a storage path exists / is accessible
   * @param {string} storagePath
   * @returns {Promise<boolean>}
   */
  async validatePath(storagePath) {
    return true; // default allow
  }

  /**
   * Get file metadata from storage
   * @param {string} storagePath
   * @returns {Promise<object|null>}
   */
  async getMetadata(storagePath) {
    return null;
  }

  /**
   * List files (optional, for admin browsing)
   * @param {string} prefix
   * @returns {Promise<Array>}
   */
  async listFiles(prefix = '') {
    return [];
  }

  /**
   * Whether this provider should be proxied through backend or redirected
   * @returns {boolean} true if redirect preferred
   */
  shouldRedirect() {
    return true;
  }
}
