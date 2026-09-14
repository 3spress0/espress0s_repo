import { describe, it } from 'node:test';
import assert from 'node:assert';
import Fastify from 'fastify';

import {
  REBOOT_NOTICE_MINUTES,
  REBOOT_WORK_GUARD_MINUTES,
  activeMaintenanceActivities,
  beginMaintenanceActivity,
  maintenanceDeferral,
  nextScheduledRebootAt,
  publicMaintenanceNotice,
  scheduledRebootWindow,
} from '../src/services/maintenanceService.js';
import { maintenanceRoutes } from '../src/routes/maintenance.js';

const enabled = { enabled: true };
const disabled = { enabled: false };

function localAt(hour, minute = 0) {
  // The reboot schedule is deliberately local server time, so this test avoids
  // a UTC string whose date can shift in a non-UTC CI environment.
  return new Date(2030, 5, 10, hour, minute, 0, 0);
}

describe('scheduled reboot maintenance window', () => {
  it('finds the next local 00:30 or 12:30 trigger', () => {
    const morning = nextScheduledRebootAt(localAt(0, 29));
    assert.equal(morning.getHours(), 0);
    assert.equal(morning.getMinutes(), 30);

    const afternoon = nextScheduledRebootAt(localAt(0, 30));
    assert.equal(afternoon.getHours(), 12);
    assert.equal(afternoon.getMinutes(), 30);

    const nextDay = nextScheduledRebootAt(localAt(23, 59));
    assert.equal(nextDay.getHours(), 0);
    assert.equal(nextDay.getMinutes(), 30);
    assert.equal(nextDay.getDate(), 11);
  });

  it('defers costly work during the final guard hour, but not beforehand', () => {
    const inside = scheduledRebootWindow(localAt(11, 30), enabled);
    assert.equal(inside.workDeferred, true);
    assert.equal(inside.guardMinutes, REBOOT_WORK_GUARD_MINUTES);

    const outside = scheduledRebootWindow(localAt(11, 29), enabled);
    assert.equal(outside.workDeferred, false);

    const deferral = maintenanceDeferral('a catalogue import', localAt(11, 45), enabled);
    assert.equal(deferral.code, 'SCHEDULED_REBOOT_IMMINENT');
    assert.match(deferral.error, /catalogue import/);
  });

  it('does not create a warning or deferral window when reboots are disabled', () => {
    const window = scheduledRebootWindow(localAt(12, 10), disabled);
    assert.equal(window.nextAt, null);
    assert.equal(window.workDeferred, false);
    assert.equal(window.noticeActive, false);
  });

  it('shows visitors a warning only in the final notice window', () => {
    const active = scheduledRebootWindow(localAt(12, 0), enabled);
    assert.equal(active.noticeActive, true);
    assert.equal(active.noticeMinutes, REBOOT_NOTICE_MINUTES);
    const inactive = scheduledRebootWindow(localAt(11, 59), enabled);
    assert.equal(inactive.noticeActive, false);
    const notice = publicMaintenanceNotice(localAt(12, 0), enabled);
    assert.equal(notice.active, true);
    assert.match(notice.message, /restart this site in about 30 minutes/i);
  });

  it('tracks in-process long-running activity until its completion callback', () => {
    const before = activeMaintenanceActivities().length;
    const finish = beginMaintenanceActivity('catalogue-import', 'Applying a test catalogue import');
    assert.equal(activeMaintenanceActivities().length, before + 1);
    finish();
    finish(); // completion is idempotent
    assert.equal(activeMaintenanceActivities().length, before);
  });
});

describe('public maintenance notice endpoint', () => {
  it('is intentionally public and never fails on a non-systemd development host', async () => {
    const app = Fastify({ logger: false });
    await app.register(maintenanceRoutes, { prefix: '/api' });
    await app.ready();
    try {
      const response = await app.inject({ method: 'GET', url: '/api/maintenance/notice' });
      assert.equal(response.statusCode, 200);
      assert.equal(typeof response.json().active, 'boolean');
      assert.match(response.headers['cache-control'], /no-store/);
    } finally {
      await app.close();
    }
  });
});
