import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from project root and backend
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config();

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3000', 10),
  host: process.env.HOST || '0.0.0.0',
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5173',
  corsOrigin: (process.env.CORS_ORIGIN || 'http://localhost:5173').split(',').map(s => s.trim()),

  db: {
    path: (() => {
      const p = process.env.DATABASE_PATH || path.resolve(__dirname, '../../data/repo.db');
      // If relative, resolve from project root (two levels up from this file's dir)
      if (!path.isAbsolute(p)) {
        return path.resolve(__dirname, '../../', p);
      }
      return p;
    })(),
    url: process.env.DATABASE_URL || null,
  },

  security: {
    jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-in-production-min-32-chars-long!',
    jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
    adminUsername: process.env.ADMIN_USERNAME || 'admin',
    adminEmail: process.env.ADMIN_EMAIL || 'admin@espress0.local',
    adminPassword: process.env.ADMIN_PASSWORD || 'ChangeMe123!',
    encryptionKey: process.env.ENCRYPTION_KEY || '',
    passwordPepper: process.env.PASSWORD_PEPPER || '',
    allowRegistration: process.env.ALLOW_REGISTRATION !== 'false',
  },

  storage: {
    defaultProvider: process.env.DEFAULT_STORAGE_PROVIDER || 'local',
    googleDrive: {
      enabled: process.env.GOOGLE_DRIVE_ENABLED === 'true',
      clientId: process.env.GOOGLE_DRIVE_CLIENT_ID || '',
      clientSecret: process.env.GOOGLE_DRIVE_CLIENT_SECRET || '',
      redirectUri: process.env.GOOGLE_DRIVE_REDIRECT_URI || '',
      folderId: process.env.GOOGLE_DRIVE_FOLDER_ID || '',
      apiKey: process.env.GOOGLE_DRIVE_API_KEY || '',
    },
    onedrive: {
      enabled: process.env.ONEDRIVE_ENABLED === 'true',
      clientId: process.env.ONEDRIVE_CLIENT_ID || '',
      clientSecret: process.env.ONEDRIVE_CLIENT_SECRET || '',
      tenantId: process.env.ONEDRIVE_TENANT_ID || 'common',
      redirectUri: process.env.ONEDRIVE_REDIRECT_URI || '',
      driveId: process.env.ONEDRIVE_DRIVE_ID || '',
      folderId: process.env.ONEDRIVE_FOLDER_ID || '',
    }
  },

  ai: {
    enabled: process.env.TGPT_ENABLED !== 'false',
    binaryPath: process.env.TGPT_BINARY_PATH || '/usr/local/bin/tgpt',
    provider: process.env.TGPT_PROVIDER || 'openai',
    model: process.env.TGPT_MODEL || 'gpt-3.5-turbo',
  },

  rateLimit: {
    max: parseInt(process.env.RATE_LIMIT_MAX || '100', 10),
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000', 10),
  },

  logLevel: process.env.LOG_LEVEL || 'info',
  isDev: (process.env.NODE_ENV || 'development') !== 'production',
};
