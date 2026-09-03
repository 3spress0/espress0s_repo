import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from project root and backend
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config();

// Placeholder values that are fine for `npm run dev` and must never reach a
// production box. `assertProductionSecrets()` below turns them into a boot
// failure instead of a silent, permanently-forgeable JWT.
export const DEV_JWT_SECRET = 'dev-secret-change-in-production-min-32-chars-long!';
export const DEV_ADMIN_PASSWORD = 'ChangeMe123!';

/**
 * Parses a positive integer from the environment, falling back when the value
 * is missing, malformed or outside a sane range (an empty `TGPT_TIMEOUT_MS=`
 * in .env would otherwise become NaN and disable the subprocess timeout).
 */
function intFromEnv(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = parseInt(raw, 10);
  if (!Number.isFinite(value) || value < min || value > max) {
    console.warn(`[config] Ignoring ${name}=${raw} (expected ${min}-${max} ms); using ${fallback} ms.`);
    return fallback;
  }
  return value;
}

/**
 * How long a single tgpt run may take before it is killed.
 *
 * Both budgets must stay *below* the browser's request budget (AI_TIMEOUT in
 * frontend/src/lib/api.js). They used to both be 30000 ms - exactly the axios
 * default - so a slow provider killed tgpt at the same instant the browser
 * gave up: the rule-based fallback answer was computed for nobody and the
 * visitor saw a bare "timeout of 30000ms exceeded". backend/tests/ai.test.js
 * asserts the ordering so the two cannot drift back into a tie.
 */
export const TGPT_ASK_TIMEOUT_MS = intFromEnv('TGPT_TIMEOUT_MS', 20000, 2000, 60000);
export const TGPT_DRAFT_TIMEOUT_MS = intFromEnv('TGPT_DRAFT_TIMEOUT_MS', 30000, 2000, 120000);

const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PROD = NODE_ENV === 'production';

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

  // Where pre-import database snapshots go. Catalogue imports write one before
  // applying so a bad archive can be rolled back without restoring from cron.
  // Resolved relative to the project root, exactly like db.path.
  backupDir: (() => {
    const p = process.env.BACKUP_DIR || './backups';
    if (!path.isAbsolute(p)) {
      return path.resolve(__dirname, '../../', p);
    }
    return p;
  })(),

  security: {
    jwtSecret: process.env.JWT_SECRET || DEV_JWT_SECRET,
    jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
    adminUsername: process.env.ADMIN_USERNAME || 'admin',
    adminEmail: process.env.ADMIN_EMAIL || 'admin@espress0.local',
    adminPassword: process.env.ADMIN_PASSWORD || DEV_ADMIN_PASSWORD,
    encryptionKey: process.env.ENCRYPTION_KEY || '',
    passwordPepper: process.env.PASSWORD_PEPPER || '',
    allowRegistration: process.env.ALLOW_REGISTRATION !== 'false',
    // Session cookies get the Secure flag automatically in production; set
    // COOKIE_SECURE explicitly when terminating TLS somewhere unusual.
    cookieSecure: process.env.COOKIE_SECURE
      ? process.env.COOKIE_SECURE === 'true'
      : IS_PROD,
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
    // Empty = let tgpt use its own default provider (phind at the time of
    // writing), which is free and needs no key. 'openai' etc. need TGPT_API_KEY.
    provider: process.env.TGPT_PROVIDER || '',
    apiKey: process.env.TGPT_API_KEY || process.env.AI_API_KEY || '',
    model: process.env.TGPT_MODEL || '',
    // Per-run subprocess budgets; see TGPT_ASK_TIMEOUT_MS above for why they
    // must be smaller than the client's AI_TIMEOUT.
    timeoutMs: TGPT_ASK_TIMEOUT_MS,
    draftTimeoutMs: TGPT_DRAFT_TIMEOUT_MS,
  },

  rateLimit: {
    max: parseInt(process.env.RATE_LIMIT_MAX || '100', 10),
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000', 10),
  },

  logLevel: process.env.LOG_LEVEL || 'info',
  isDev: !IS_PROD,
  isProd: IS_PROD,
};

/**
 * Fail fast when a production deployment is still running on development
 * defaults. A shipped default JWT secret means anyone who has read the source
 * can mint an admin token, so this refuses to boot rather than warn.
 *
 * @returns {string[]} problems found (empty in development, where it only warns)
 */
export function assertProductionSecrets({ throwOnError = true } = {}) {
  const problems = [];

  if (!process.env.JWT_SECRET || process.env.JWT_SECRET === DEV_JWT_SECRET) {
    problems.push('JWT_SECRET is unset or still the built-in development value');
  } else if (process.env.JWT_SECRET.length < 32) {
    problems.push('JWT_SECRET is shorter than 32 characters');
  }
  if (!process.env.ENCRYPTION_KEY) {
    problems.push('ENCRYPTION_KEY is unset (field encryption key would be derived from JWT_SECRET)');
  }
  if (!process.env.PASSWORD_PEPPER) {
    problems.push('PASSWORD_PEPPER is unset (password pepper would be derived from JWT_SECRET)');
  }
  if (!process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD === DEV_ADMIN_PASSWORD) {
    problems.push('ADMIN_PASSWORD is unset or still the built-in development value');
  }
  if (config.corsOrigin.includes('*')) {
    problems.push('CORS_ORIGIN is "*" while credentialed requests are enabled');
  }

  if (problems.length && IS_PROD && throwOnError) {
    const err = new Error(
      'Refusing to start in production with insecure configuration:\n  - ' +
      problems.join('\n  - ') +
      '\n\nGenerate secrets with: openssl rand -hex 32'
    );
    err.name = 'InsecureConfigurationError';
    throw err;
  }
  return problems;
}
