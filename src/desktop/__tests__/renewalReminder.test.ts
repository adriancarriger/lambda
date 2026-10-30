import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { REMINDER_TITLE, maybeRemind, remindSafely } from '../renewalReminder';

const CREATED = '2026-10-19T12:00:00.000Z';
// Days are read on a pinned clock, so the suite passes in any zone.
const PAWNEE = 'America/Indiana/Indianapolis';
// The sign-in runs out on 2027-10-19.
const at = (day: string, hour = 9) =>
  Date.parse(`${day}T${String(hour).padStart(2, '0')}:00:00.000Z`);

describe('the renewal reminder', () => {
  it('posts once a day in the last 21 days, and a restart the same day posts nothing', () => {
    const stateFile = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-app-')),
      'state.json'
    );
    const posted: string[] = [];
    const notify = (title: string, body: string) =>
      posted.splice(posted.length, 0, `${title}: ${body}`);
    const remind = (now: number) =>
      maybeRemind({ now, createdAt: CREATED, stateFile, notify, zone: PAWNEE });

    expect(remind(at('2027-10-09'))).toBe(true);
    expect(posted).toEqual([
      `${REMINDER_TITLE}: Your Claude sign-in runs out on Tue, Oct 19. Agents stop working after that.`,
    ]);

    expect(remind(at('2027-10-09', 15))).toBe(false);
    // A restart reads state.json again, from the file.
    expect(JSON.parse(fs.readFileSync(stateFile, 'utf8'))).toEqual({
      lastRenewalReminder: '2027-10-09',
    });
    expect(remind(at('2027-10-09', 20))).toBe(false);

    expect(remind(at('2027-10-10'))).toBe(true);
    expect(posted).toHaveLength(2);
  });

  it('counts days on the clock far east of UTC: a new day there posts again', () => {
    const stateFile = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-app-')),
      'state.json'
    );
    const posted: string[] = [];
    const remind = (now: number) =>
      maybeRemind({
        now,
        createdAt: CREATED,
        stateFile,
        zone: 'Pacific/Auckland',
        notify: (title, body) =>
          posted.splice(posted.length, 0, `${title}: ${body}`),
      });

    // 9 am UTC on Oct 9 is 10 pm Oct 9 in Auckland; 3 pm UTC is 4 am Oct 10.
    expect(remind(at('2027-10-09'))).toBe(true);
    expect(remind(at('2027-10-09', 10))).toBe(false);
    expect(remind(at('2027-10-09', 15))).toBe(true);
    expect(JSON.parse(fs.readFileSync(stateFile, 'utf8'))).toEqual({
      lastRenewalReminder: '2027-10-10',
    });
    // Noon UTC on Oct 19 is already Oct 20 there.
    expect(posted[0]).toBe(
      `${REMINDER_TITLE}: Your Claude sign-in runs out on Wed, Oct 20. Agents stop working after that.`
    );
  });

  it('says only that it ran out, once it has', () => {
    const stateFile = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-app-')),
      'state.json'
    );
    const posted: string[] = [];

    expect(
      maybeRemind({
        now: at('2027-10-21'),
        createdAt: CREATED,
        stateFile,
        zone: PAWNEE,
        notify: (title, body) =>
          posted.splice(posted.length, 0, `${title}: ${body}`),
      })
    ).toBe(true);
    expect(posted).toEqual([
      `${REMINDER_TITLE}: Your Claude sign-in ran out on Tue, Oct 19.`,
    ]);
  });

  it('posts nothing before the window, or with no sign-in', () => {
    const stateFile = path.join(os.tmpdir(), `lambda-none-${Date.now()}.json`);
    const notify = jest.fn();

    expect(
      maybeRemind({
        now: at('2027-09-27'),
        createdAt: CREATED,
        stateFile,
        notify,
        zone: PAWNEE,
      })
    ).toBe(false);
    expect(
      maybeRemind({
        now: at('2027-10-09'),
        createdAt: undefined,
        stateFile,
        notify,
        zone: PAWNEE,
      })
    ).toBe(false);
    expect(notify).not.toHaveBeenCalled();
  });

  it('logs a config it cannot read (half-written, say) instead of crashing the app', () => {
    const logged: string[] = [];
    const notify = jest.fn();

    expect(() =>
      remindSafely({
        now: at('2027-10-09'),
        readCreatedAt: () => {
          throw new Error('Invalid JSON in config.json');
        },
        stateFile: path.join(os.tmpdir(), `lambda-bad-${Date.now()}.json`),
        notify,
        log: (line) => logged.splice(logged.length, 0, line),
      })
    ).not.toThrow();
    expect(logged).toEqual([
      'Renewal reminder skipped: Invalid JSON in config.json',
    ]);
    expect(notify).not.toHaveBeenCalled();
  });
});
