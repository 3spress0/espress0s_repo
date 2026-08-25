import crypto from 'crypto';
import { config } from '../config.js';

/**
 * Encryption Service - AES-256-GCM at-rest encryption
 * 
 * Security design:
 * - Passwords: pepper (HMAC-SHA256) + bcrypt cost 12
 * - Sensitive fields: AES-256-GCM with random IV per encryption
 * - Searchable encrypted fields: deterministic HMAC for lookup + encrypted value
 * - Keys from env, never logged
 */

class EncryptionService {
  constructor() {
    this.algorithm = 'aes-256-gcm';
    this.keyLength = 32; // 256 bits
    this.ivLength = 12; // 96 bits for GCM
    this.authTagLength = 16;
    this.saltLength = 16;
    
    // Get or generate encryption key
    this.encryptionKey = this.getEncryptionKey();
    this.pepper = this.getPepper();
  }

  getEncryptionKey() {
    const keyEnv = process.env.ENCRYPTION_KEY;
    if (!keyEnv) {
      // In dev, derive from JWT secret (not ideal for prod, but works for demo)
      // In prod, MUST set ENCRYPTION_KEY
      const fallback = config.security.jwtSecret;
      // Derive 32-byte key via SHA-256
      return crypto.createHash('sha256').update(fallback + '_encryption').digest();
    }

    // Support base64, hex, or raw string
    try {
      if (keyEnv.length === 64 && /^[a-f0-9]+$/i.test(keyEnv)) {
        // hex 32 bytes = 64 hex chars
        return Buffer.from(keyEnv, 'hex');
      }
      if (keyEnv.length >= 44) {
        // try base64
        const buf = Buffer.from(keyEnv, 'base64');
        if (buf.length === 32) return buf;
        // If not 32, hash it
        return crypto.createHash('sha256').update(buf).digest();
      }
      // raw string - hash to 32 bytes
      return crypto.createHash('sha256').update(keyEnv).digest();
    } catch {
      return crypto.createHash('sha256').update(keyEnv).digest();
    }
  }

  getPepper() {
    const pepperEnv = process.env.PASSWORD_PEPPER;
    if (!pepperEnv) {
      // Derive pepper from JWT secret + fixed string
      return crypto.createHash('sha256').update(config.security.jwtSecret + '_pepper_v1').digest('hex');
    }
    return pepperEnv;
  }

  /**
   * Encrypt text with AES-256-GCM
   * Returns: base64(iv):base64(authTag):base64(ciphertext)
   */
  encrypt(plaintext) {
    if (!plaintext) return null;
    if (typeof plaintext !== 'string') plaintext = String(plaintext);

    // Check if already encrypted (avoid double encryption)
    if (this.isEncrypted(plaintext)) {
      return plaintext;
    }

    try {
      const iv = crypto.randomBytes(this.ivLength);
      const cipher = crypto.createCipheriv(this.algorithm, this.encryptionKey, iv);
      
      let encrypted = cipher.update(plaintext, 'utf8', 'base64');
      encrypted += cipher.final('base64');
      const authTag = cipher.getAuthTag();

      // Format: iv:authTag:ciphertext (all base64)
      const result = `${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted}`;
      
      // Prefix to identify encrypted values
      return `enc_v1:${result}`;
    } catch (e) {
      console.error('Encryption failed:', e.message);
      throw new Error('Encryption failed');
    }
  }

  /**
   * Decrypt text
   */
  decrypt(encryptedText) {
    if (!encryptedText) return null;
    if (typeof encryptedText !== 'string') return encryptedText;

    // If not encrypted, return as-is (for backward compatibility)
    if (!this.isEncrypted(encryptedText)) {
      return encryptedText;
    }

    try {
      // Remove prefix
      const withoutPrefix = encryptedText.replace(/^enc_v1:/, '');
      const parts = withoutPrefix.split(':');
      if (parts.length !== 3) throw new Error('Invalid encrypted format');

      const iv = Buffer.from(parts[0], 'base64');
      const authTag = Buffer.from(parts[1], 'base64');
      const ciphertext = parts[2];

      const decipher = crypto.createDecipheriv(this.algorithm, this.encryptionKey, iv);
      decipher.setAuthTag(authTag);

      let decrypted = decipher.update(ciphertext, 'base64', 'utf8');
      decrypted += decipher.final('utf8');

      return decrypted;
    } catch (e) {
      console.error('Decryption failed:', e.message);
      // For security, don't reveal if decryption failed vs wrong key
      throw new Error('Decryption failed - invalid key or corrupted data');
    }
  }

  isEncrypted(text) {
    return typeof text === 'string' && text.startsWith('enc_v1:');
  }

  /**
   * Deterministic encryption for searchable fields (e.g., email lookup)
   * Uses HMAC-SHA256 - same input always produces same output
   * For email, we store HMAC for lookup + encrypted email for display
   */
  deterministicEncrypt(plaintext) {
    if (!plaintext) return null;
    return crypto.createHmac('sha256', this.encryptionKey).update(String(plaintext).toLowerCase()).digest('hex');
  }

  /**
   * Hash email for lookup (deterministic)
   */
  hashEmail(email) {
    if (!email) return null;
    return this.deterministicEncrypt(email);
  }

  /**
   * Password hashing with pepper + bcrypt
   * Pepper is secret key added before bcrypt to protect against DB leak + brute force
   */
  async hashPasswordWithPepper(password) {
    if (!password) throw new Error('Password required');
    
    // Step 1: HMAC with pepper (adds secret key, protects if bcrypt hashes leaked)
    const peppered = crypto.createHmac('sha256', this.pepper).update(password).digest('hex');
    
    // Step 2: bcrypt with cost 12 - use bcryptjs (pure JS, no native tar dep vuln)
    // Supports both bcrypt and bcryptjs
    try {
      const bcryptjs = await import('bcryptjs');
      const hash = await bcryptjs.default.hash(peppered, 12);
      return `pepper_v1:${hash}`;
    } catch {
      const bcrypt = await import('bcrypt');
      const hash = await bcrypt.default.hash(peppered, 12);
      return `pepper_v1:${hash}`;
    }
  }

  async verifyPasswordWithPepper(password, storedHash) {
    if (!password || !storedHash) return false;

    try {
      let hashToCompare = storedHash;
      let pepper = this.pepper;

      // Check version prefix
      if (storedHash.startsWith('pepper_v1:')) {
        hashToCompare = storedHash.replace('pepper_v1:', '');
      } else if (storedHash.startsWith('$2')) {
        // Legacy bcrypt without pepper
        try {
          const bcryptjs = await import('bcryptjs');
          const ok = await bcryptjs.default.compare(password, hashToCompare);
          if (ok) return true;
        } catch {}
        try {
          const bcrypt = await import('bcrypt');
          return await bcrypt.default.compare(password, hashToCompare);
        } catch {
          return false;
        }
      }

      // HMAC with pepper
      const peppered = crypto.createHmac('sha256', pepper).update(password).digest('hex');
      
      try {
        const bcryptjs = await import('bcryptjs');
        return await bcryptjs.default.compare(peppered, hashToCompare);
      } catch {
        const bcrypt = await import('bcrypt');
        return await bcrypt.default.compare(peppered, hashToCompare);
      }
    } catch (e) {
      console.error('Password verification failed:', e.message);
      return false;
    }
  }

  /**
   * Encrypt object fields
   */
  encryptFields(obj, fields) {
    if (!obj) return obj;
    const result = { ...obj };
    for (const field of fields) {
      if (result[field]) {
        result[field] = this.encrypt(result[field]);
      }
    }
    return result;
  }

  decryptFields(obj, fields) {
    if (!obj) return obj;
    const result = { ...obj };
    for (const field of fields) {
      if (result[field]) {
        try {
          result[field] = this.decrypt(result[field]);
        } catch {
          // Keep original if decryption fails (backward compat)
        }
      }
    }
    return result;
  }

  /**
   * Generate secure random key (for setup)
   */
  static generateKey() {
    return crypto.randomBytes(32).toString('base64');
  }

  static generatePepper() {
    return crypto.randomBytes(32).toString('hex');
  }

  /**
   * Encrypt database file at rest (for backups)
   */
  encryptFile(buffer) {
    const iv = crypto.randomBytes(this.ivLength);
    const cipher = crypto.createCipheriv(this.algorithm, this.encryptionKey, iv);
    const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);
    const authTag = cipher.getAuthTag();
    // Return iv + authTag + encrypted
    return Buffer.concat([iv, authTag, encrypted]);
  }

  decryptFile(encryptedBuffer) {
    const iv = encryptedBuffer.subarray(0, this.ivLength);
    const authTag = encryptedBuffer.subarray(this.ivLength, this.ivLength + this.authTagLength);
    const encrypted = encryptedBuffer.subarray(this.ivLength + this.authTagLength);
    
    const decipher = crypto.createDecipheriv(this.algorithm, this.encryptionKey, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
  }
}

export const encryptionService = new EncryptionService();

// Sensitive fields that should be encrypted at rest
export const ENCRYPTED_USER_FIELDS = ['email'];
export const ENCRYPTED_ITEM_FIELDS = ['storage_path', 'download_url', 'external_url', 'license_notes'];
export const SEARCHABLE_ENCRYPTED_FIELDS = ['email']; // fields that need deterministic hash for lookup
