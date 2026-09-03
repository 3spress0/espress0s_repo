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

/** First non-empty value among `names`, so AI_TIMEOUT_MS can supersede the
 * older TGPT_TIMEOUT_MS without an .env that still has the old key losing it. */
function envFirst(names) {
  for (const name of names) {
    const raw = process.env[name];
    if (raw !== undefined && raw.trim() !== '') return { name, value: raw.trim() };
  }
  return null;
}

/**
 * Parses a positive integer from the environment, falling back when the value
 * is missing, malformed or outside a sane range (an empty `TGPT_TIMEOUT_MS=`
 * in .env would otherwise become NaN and disable the subprocess timeout).
 */
function intFromEnv(names, fallback, min, max, unit = 'ms') {
  const found = envFirst(Array.isArray(names) ? names : [names]);
  if (!found) return fallback;
  const value = parseInt(found.value, 10);
  if (!Number.isFinite(value) || value < min || value > max) {
    console.warn(`[config] Ignoring ${found.name}=${found.value} (expected ${min}-${max} ${unit}); using ${fallback} ${unit}.`);
    return fallback;
  }
  return value;
}

function floatFromEnv(name, fallback, min, max) {
  const found = envFirst([name]);
  if (!found) return fallback;
  const value = Number(found.value);
  if (!Number.isFinite(value) || value < min || value > max) {
    console.warn(`[config] Ignoring ${found.name}=${found.value} (expected ${min}-${max}); using ${fallback}.`);
    return fallback;
  }
  return value;
}

/**
 * How long a single AI call may take before it is killed - a tgpt subprocess or
 * an HTTP round-trip alike.
 *
 * Both budgets must stay *below* the browser's request budget (AI_TIMEOUT in
 * frontend/src/lib/api.js). They used to both be 30000 ms - exactly the axios
 * default - so a slow provider killed the call at the same instant the browser
 * gave up: the rule-based fallback answer was computed for nobody and the
 * visitor saw a bare "timeout of 30000ms exceeded". backend/tests/ai.test.js
 * asserts the ordering so the two cannot drift back into a tie.
 */
export const AI_ASK_TIMEOUT_MS = intFromEnv(['AI_TIMEOUT_MS', 'TGPT_TIMEOUT_MS'], 20000, 2000, 60000);
export const AI_DRAFT_TIMEOUT_MS = intFromEnv(['AI_DRAFT_TIMEOUT_MS', 'TGPT_DRAFT_TIMEOUT_MS'], 30000, 2000, 120000);
// Names the config block shipped under before the Gemini provider existed.
export const TGPT_ASK_TIMEOUT_MS = AI_ASK_TIMEOUT_MS;
export const TGPT_DRAFT_TIMEOUT_MS = AI_DRAFT_TIMEOUT_MS;

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

  /**
   * Environment half of the AI configuration. Everything here can be overridden
   * per-key by an admin in Settings (site_settings) except `apiKey`, which is
   * env-only on purpose - see services/aiConfig.js for the merge rules and
   * services/aiProviders.js for the transports.
   */
  ai: {
    enabled: (envFirst(['AI_ENABLED', 'TGPT_ENABLED'])?.value ?? 'true') !== 'false',
    // auto = Gemini when a key exists, the tgpt CLI when it does not.
    // gemini | openai | tgpt | none force one.
    provider: envFirst(['AI_PROVIDER'])?.value || (process.env.TGPT_PROVIDER ? 'tgpt' : 'auto'),
    // Wire format, derived from the provider unless you point at something that
    // speaks the other one (a proxy that serves Gemini-style JSON, say).
    format: envFirst(['AI_FORMAT'])?.value || '',
    model: envFirst(['AI_MODEL'])?.value || '',
    // Any endpoint: https://openrouter.ai/api/v1, http://127.0.0.1:11434/v1,
    // an Azure-style gateway. Validated at request time by safeFetch.js.
    baseUrl: envFirst(['AI_BASE_URL'])?.value || '',
    // Google's SDKs read these two names, so a box that already exports one
    // needs no .env edit. TGPT_API_KEY stays as the historical spelling.
    apiKey: envFirst(['AI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'TGPT_API_KEY'])?.value || '',
    // Which name supplied it, because the name carries meaning: a key found in
    // TGPT_API_KEY belongs to whatever TGPT_PROVIDER points at (OpenAI, say),
    // and must not talk `auto` into sending it to Google.
    apiKeySource: envFirst(['AI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'TGPT_API_KEY'])?.name || '',
    temperature: floatFromEnv('AI_TEMPERATURE', 0.2, 0, 2),
    maxTokens: intFromEnv(['AI_MAX_TOKENS'], 1024, 64, 32768, 'tokens'),
    // Per-run budgets; see AI_ASK_TIMEOUT_MS above for why they must be
    // smaller than the client's AI_TIMEOUT.
    timeoutMs: AI_ASK_TIMEOUT_MS,
    draftTimeoutMs: AI_DRAFT_TIMEOUT_MS,
    // Off by default: a base URL is admin-set but the request leaves the box,
    // so link-local/metadata addresses are refused whatever this is set to.
    allowPrivateBaseUrl: process.env.AI_ALLOW_PRIVATE_BASE_URL === 'true',
    tgpt: {
      binaryPath: envFirst(['AI_TGPT_BINARY_PATH', 'TGPT_BINARY_PATH'])?.value || '/usr/local/bin/tgpt',
      // tgpt's own sub-provider (phind by default: free, no key) and model.
      provider: envFirst(['AI_TGPT_PROVIDER', 'TGPT_PROVIDER'])?.value || '',
      model: envFirst(['AI_TGPT_MODEL', 'TGPT_MODEL'])?.value || '',
    },
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
