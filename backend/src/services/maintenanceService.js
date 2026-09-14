import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { fileURLToPath } from 'url';
import { STARTED_AT } from '../lib/buildInfo.js';

/**
 * Host-maintenance facts shared by the public pre-reboot notice, the admin
 * Operations page, and work that should not begin just before the host goes
 * down.  This module never grants the web process power to reboot, enable, or
 * disable anything: it reads deployment-written state and makes fixed,
 * read-only systemctl queries where systemd is available.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const REBOOT_STATUS_FILE = process.env.ESPRESS0_REBOOT_STATUS_FILE
  || path.join(repoRoot, 'data', '.scheduled-reboot-status.json');
export const OPERATIONS_EVENTS_FILE = process.env.ESPRESS0_OPERATIONS_EVENTS_FILE
  || path.join(repoRoot, 'data', '.operations-events.jsonl');
export const AUTO_UPDATE_STATE_FILE = path.join(repoRoot, 'data', '.auto-update-status');

export const SCHEDULED_REBOOT_HOURS = [0, 12];
export const SCHEDULED_REBOOT_MINUTE = 30;
// A release build, bulk import or all-link scan can take several minutes. Do
// not start new nonessential work in its final hour; the systemd reboot still
// has priority, but "deferred" is much safer than interrupting that work.
export const REBOOT_WORK_GUARD_MINUTES = 60;
// Visitors only need a short actionable warning, not the host's whole cadence.
export const REBOOT_NOTICE_MINUTES = 30;

const MAX_STATUS_BYTES = 64 * 1024;
const MAX_EVENT_BYTES = 256 * 1024;
const MAX_EVENTS = 30;
const activeActivities = new Map();
let nextActivityId = 1;

function readJsonFile(file, fallback = null, maxBytes = MAX_STATUS_BYTES) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > maxBytes) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function isoOrNull(value) {
  const at = Date.parse(value || '');
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

function nonEmptyString(value, max = 500) {
  return typeof value === 'string' && value.trim()
    ? value.trim().slice(0, max)
    : null;
}

/** Deployment writes this once it has successfully enabled/disabled the timer. */
export function readScheduledRebootConfiguration() {
  const raw = readJsonFile(REBOOT_STATUS_FILE, {});
  return {
    enabled: raw?.enabled === true,
    updatedAt: isoOrNull(raw?.updatedAt),
    timer: nonEmptyString(raw?.timer, 100) || 'espress0-repo-reboot.timer',
    service: nonEmptyString(raw?.service, 100) || 'espress0-repo-reboot.service',
    schedule: '00:30 and 12:30 local time',
    guardMinutes: REBOOT_WORK_GUARD_MINUTES,
  };
}

/** The next fixed local 00:30 / 12:30 trigger strictly after `now`. */
export function nextScheduledRebootAt(now = new Date()) {
  const current = new Date(now);
  if (Number.isNaN(current.getTime())) return null;

  for (let day = 0; day <= 1; day++) {
    for (const hour of SCHEDULED_REBOOT_HOURS) {
      const candidate = new Date(
        current.getFullYear(), current.getMonth(), current.getDate() + day,
        hour, SCHEDULED_REBOOT_MINUTE, 0, 0,
      );
      if (candidate.getTime() > current.getTime()) return candidate;
    }
  }
  return null;
}

/**
 * Reports the deployment's fixed maintenance window. The status file is the
 * authority for work deferral: `systemctl` is intentionally not invoked on a
 * request that is about to start a costly job.
 */
export function scheduledRebootWindow(now = new Date(), configuration = readScheduledRebootConfiguration()) {
  const next = configuration.enabled ? nextScheduledRebootAt(now) : null;
  const secondsUntil = next ? Math.max(0, Math.ceil((next.getTime() - now.getTime()) / 1000)) : null;
  const guardSeconds = REBOOT_WORK_GUARD_MINUTES * 60;
  const noticeSeconds = REBOOT_NOTICE_MINUTES * 60;
  return {
    enabled: configuration.enabled,
    nextAt: next?.toISOString() || null,
    secondsUntil,
    guardMinutes: REBOOT_WORK_GUARD_MINUTES,
    noticeMinutes: REBOOT_NOTICE_MINUTES,
    workDeferred: secondsUntil !== null && secondsUntil <= guardSeconds,
    noticeActive: secondsUntil !== null && secondsUntil <= noticeSeconds,
  };
}

/** An API-safe reason for deferring a costly job, or null when it may start. */
export function maintenanceDeferral(operation, now = new Date(), configuration = readScheduledRebootConfiguration()) {
  const window = scheduledRebootWindow(now, configuration);
  if (!window.workDeferred) return null;
  const minutes = Math.max(1, Math.ceil(window.secondsUntil / 60));
  return {
    code: 'SCHEDULED_REBOOT_IMMINENT',
    error: `Scheduled host reboot is in about ${minutes} minute${minutes === 1 ? '' : 's'}; ${operation} was not started. Try again after ${window.nextAt}.`,
    retryAt: window.nextAt,
    window,
  };
}

/** Public response: only disclose a short warning while it is relevant. */
export function publicMaintenanceNotice(now = new Date(), configuration = readScheduledRebootConfiguration()) {
  const window = scheduledRebootWindow(now, configuration);
  if (!window.noticeActive) return { active: false };
  const minutes = Math.max(1, Math.ceil(window.secondsUntil / 60));
  return {
    active: true,
    type: 'scheduled-reboot',
    rebootAt: window.nextAt,
    message: `Scheduled maintenance will restart this site in about ${minutes} minute${minutes === 1 ? '' : 's'}. Please finish uploads and changes now.`,
  };
}

/**
 * In-process activity ledger for slow HTTP/background work. It is deliberately
 * ephemeral: after a reboot the work is gone too, while the JSONL event record
 * remains the durable audit trail.
 */
export function beginMaintenanceActivity(type, label) {
  const id = `${process.pid}-${nextActivityId++}`;
  activeActivities.set(id, {
    id,
    type: nonEmptyString(type, 80) || 'maintenance',
    label: nonEmptyString(label, 160) || 'Maintenance work',
    startedAt: new Date().toISOString(),
  });
  let done = false;
  return () => {
    if (done) return;
    done = true;
    activeActivities.delete(id);
  };
}

/** Keep a request visible until Fastify has actually sent its response. */
export function trackMaintenanceRequest(reply, type, label) {
  const finish = beginMaintenanceActivity(type, label);
  if (!reply?.raw?.once) return finish;
  reply.raw.once('finish', finish);
  reply.raw.once('close', finish);
  return finish;
}

export function activeMaintenanceActivities() {
  return [...activeActivities.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

/** Append a compact local audit event. It is best effort and never blocks boot. */
export function recordMaintenanceEvent(type, message, { source = 'application' } = {}) {
  const cleanType = nonEmptyString(type, 80);
  const cleanMessage = nonEmptyString(message, 500);
  if (!cleanType || !/^[a-z0-9-]+$/i.test(cleanType) || !cleanMessage) return false;
  const event = {
    at: new Date().toISOString(),
    type: cleanType,
    message: cleanMessage,
    source: nonEmptyString(source, 80) || 'application',
  };
  try {
    fs.mkdirSync(path.dirname(OPERATIONS_EVENTS_FILE), { recursive: true });
    fs.appendFileSync(OPERATIONS_EVENTS_FILE, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o640 });
    return true;
  } catch {
    return false;
  }
}

export function recentMaintenanceEvents(limit = MAX_EVENTS) {
  try {
    const stat = fs.statSync(OPERATIONS_EVENTS_FILE);
    if (!stat.isFile() || stat.size > MAX_EVENT_BYTES) return [];
    const rows = fs.readFileSync(OPERATIONS_EVENTS_FILE, 'utf8').trim().split('\n');
    return rows
      .slice(-Math.min(Math.max(Number(limit) || MAX_EVENTS, 1), MAX_EVENTS))
      .map(line => { try { return JSON.parse(line); } catch { return null; } })
      .filter(event => event && isoOrNull(event.at) && nonEmptyString(event.type, 80) && nonEmptyString(event.message, 500))
      .map(event => ({
        at: isoOrNull(event.at),
        type: nonEmptyString(event.type, 80),
        message: nonEmptyString(event.message, 500),
        source: nonEmptyString(event.source, 80) || 'unknown',
      }))
      .reverse();
  } catch {
    return [];
  }
}

export function hostBootedAt() {
  try {
    const value = fs.readFileSync('/proc/stat', 'utf8').match(/^btime\s+(\d+)$/m)?.[1];
    if (!value) return null;
    return new Date(Number(value) * 1000).toISOString();
  } catch {
    return null;
  }
}

/**
 * Write the post-start half of a scheduled-reboot audit trail. A pre-reboot
 * event is written by the root unit; this process sees the new kernel boot time
 * and records it once, then records that the health endpoint is serving.
 */
export function recordApplicationHealthyEvent() {
  const bootAt = hostBootedAt();
  const events = recentMaintenanceEvents();
  const hadApplicationBeforeBoot = bootAt && events.some(event => event.type === 'application-healthy' && Date.parse(event.at) < Date.parse(bootAt));
  const recordedThisBoot = bootAt && events.some(event => event.type === 'host-rebooted' && event.message.includes(bootAt));
  if (bootAt && hadApplicationBeforeBoot && !recordedThisBoot) {
    recordMaintenanceEvent('host-rebooted', `Host boot detected at ${bootAt}; application recovery is starting.`);
  }
  recordMaintenanceEvent('application-healthy', 'Application started and its health endpoint is accepting requests.');
}

function execSystemctlShow(timer) {
  // Fixed executable and arguments, no shell, no request-derived input. A
  // non-root process may read unit metadata but cannot change the timer.
  return new Promise(resolve => {
    execFile('systemctl', ['show', '--no-pager', timer, '-p', 'LoadState', '-p', 'UnitFileState', '-p', 'ActiveState', '-p', 'LastTriggerUSec'], {
      timeout: 2000,
      maxBuffer: 16 * 1024,
      windowsHide: true,
    }, (error, stdout) => {
      if (error?.code === 'ENOENT' || error?.killed) return resolve(null);
      const props = Object.fromEntries(String(stdout || '').split('\n')
        .filter(Boolean)
        .map(line => {
          const index = line.indexOf('=');
          return index > 0 ? [line.slice(0, index), line.slice(index + 1)] : null;
        })
        .filter(Boolean));
      if (!props.LoadState) return resolve(null);
      resolve({
        available: true,
        loaded: props.LoadState === 'loaded',
        unitFileState: props.UnitFileState || 'unknown',
        active: props.ActiveState === 'active',
        lastTriggeredAt: isoOrNull(props.LastTriggerUSec),
      });
    });
  });
}

function timeZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'local'; }
  catch { return 'local'; }
}

/** Full read-only payload for Admin -> Operations. */
export async function operationsStatus() {
  const configuration = readScheduledRebootConfiguration();
  const [runtime, autoUpdate] = await Promise.all([
    execSystemctlShow(configuration.timer),
    Promise.resolve(readJsonFile(AUTO_UPDATE_STATE_FILE, null)),
  ]);
  const timerRuntime = runtime || { available: false };
  const window = scheduledRebootWindow(new Date(), configuration);
  const events = recentMaintenanceEvents();
  const lastScheduledReboot = events.find(event => event.type === 'scheduled-reboot-starting') || null;
  const appStartedAt = isoOrNull(STARTED_AT);
  const bootAt = hostBootedAt();
  const appStartedMs = Date.parse(STARTED_AT);

  return {
    generatedAt: new Date().toISOString(),
    timeZone: timeZone(),
    reboot: {
      ...configuration,
      // A live systemd read wins over the deploy record. On Docker, macOS or a
      // dev checkout it is explicitly unavailable rather than guessed.
      enabled: timerRuntime.available
        ? timerRuntime.loaded && timerRuntime.active && timerRuntime.unitFileState.startsWith('enabled')
        : configuration.enabled,
      runtime: timerRuntime,
      window,
      lastScheduledReboot,
    },
    health: {
      status: 'ok', // this authenticated endpoint itself proves the app is serving
      appStartedAt,
      appUptimeSeconds: Number.isFinite(appStartedMs) ? Math.max(0, Math.floor((Date.now() - appStartedMs) / 1000)) : null,
      hostBootedAt: bootAt,
      hostUptimeSeconds: Math.max(0, Math.floor(os.uptime())),
      restartedAfterHostBoot: !!(appStartedAt && bootAt && Date.parse(appStartedAt) >= Date.parse(bootAt)),
    },
    autoUpdate: autoUpdate,
    activities: activeMaintenanceActivities(),
    events,
  };
}
