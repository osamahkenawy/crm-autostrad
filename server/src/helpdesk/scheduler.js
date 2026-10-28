// Background work for the helpdesk, driven by one timer that wakes every minute:
//  - mailbox sync every `sync_minutes`
//  - cases opened while a customer system was down are looked up again (spaced retries)
//  - follow-up reminders, automatic closure and escalation every 15 minutes
//  - the daily summary at `report_hour_gulf` (Gulf time) and the weekly summary on Mondays
// Each job records when it last ran in hd_state, so a restart catches up instead of repeating or skipping.
import { getSettings, getState, setState } from './settings.js';
import { runFollowups } from './followups.js';
import { syncMailbox } from './mail/index.js';
import { gulfToday } from './metrics.js';
import { generateReport } from './reports.js';
import { retryPendingAccounts } from './systems/actions.js';

const MINUTE = 60_000;
let timer = null;
let busy = false;

const ageMinutes = (iso) => (iso ? (Date.now() - new Date(iso).getTime()) / MINUTE : Infinity);

/** One pass over the jobs that are due. Safe to call directly (tests, "Run now" buttons). */
export async function tick({ force = false } = {}) {
  if (busy) return { skipped: true };
  busy = true;
  const done = {};
  try {
    const settings = getSettings();
    if (force || ageMinutes(getState('last_sync_at')) >= Math.max(1, settings.sync_minutes)) {
      done.sync = await syncMailbox();
    }
    const accounts = await retryPendingAccounts(); // cases opened while a customer system was down
    if (accounts.tried) done.accounts = accounts;
    if (force || ageMinutes(getState('last_followup_at')) >= 15) {
      done.followups = await runFollowups();
      setState('last_followup_at', new Date().toISOString());
    }
    const gulf = new Date(Date.now() + 4 * 3600000);
    const today = gulfToday();
    if (gulf.getUTCHours() >= settings.report_hour_gulf && getState('last_daily_report') !== today) {
      generateReport('daily');
      setState('last_daily_report', today);
      done.daily_report = true;
      if (gulf.getUTCDay() === 1 && getState('last_weekly_report') !== today) {
        generateReport('weekly');
        setState('last_weekly_report', today);
        done.weekly_report = true;
      }
    }
  } catch (e) {
    console.error('[helpdesk] scheduled job failed:', e);
    done.error = e.message;
  } finally {
    busy = false;
  }
  return done;
}

export function startScheduler() {
  if (timer || process.env.HELPDESK_SCHEDULER === 'off') return;
  timer = setInterval(() => { tick(); }, MINUTE);
  timer.unref();
  setTimeout(() => { tick(); }, 4000).unref(); // catch up shortly after a start
  console.log('  Helpdesk scheduler on (mailbox sync, follow-ups, daily and weekly reports)');
}

export function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}
