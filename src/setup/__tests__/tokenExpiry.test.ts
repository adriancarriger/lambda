import {
  bannerLine,
  expiresOn,
  expiryDay,
  renewalState,
  renewsLine,
  today,
  weekdayOf,
} from '../tokenExpiry';

/**
 * Every day here is read on a pinned clock, so the suite passes in any zone:
 * Pawnee's (US Eastern, Indiana) and one far east of UTC.
 */
const PAWNEE = 'America/Indiana/Indianapolis';
const FAR_EAST = 'Pacific/Auckland';

const at = (iso: string): number => Date.parse(iso);

describe('the Claude sign-in expiry', () => {
  it('runs out a year after it was made, to the moment', () => {
    const expires = expiresOn('2026-10-19T15:30:00.000Z');

    expect(expires).toBe('2027-10-19T15:30:00.000Z');
    expect(renewsLine(expires, PAWNEE)).toBe('renews Oct 2027');
    expect(expiryDay(expires, PAWNEE)).toBe('2027-10-19');
  });

  it('warns from 21 days before, and has run out from that moment on', () => {
    const expires = expiresOn('2026-10-19T15:30:00.000Z');

    expect(renewalState(expires, at('2027-09-28T15:29:59.999Z'))).toBe('fine');
    expect(renewalState(expires, at('2027-09-28T15:30:00.000Z'))).toBe('soon');
    expect(renewalState(expires, at('2027-10-19T15:29:59.999Z'))).toBe('soon');
    expect(renewalState(expires, at('2027-10-19T15:30:00.000Z'))).toBe(
      'expired'
    );
  });

  it('says the day in local time, not in UTC', () => {
    // 11 pm on Tue Oct 19 in Pawnee is already Oct 20 in UTC.
    const expires = expiresOn('2026-10-20T03:00:00.000Z');
    const evening = at('2027-10-20T03:30:00.000Z');

    expect(weekdayOf(expires, PAWNEE)).toBe('Tue, Oct 19');
    expect(expiryDay(expires, PAWNEE)).toBe('2027-10-19');
    expect(today(evening, PAWNEE)).toBe('2027-10-19');
    // Half an hour after it ran out, the same evening.
    expect(renewalState(expires, evening)).toBe('expired');
    expect(bannerLine(expires, evening, PAWNEE)).toBe(
      'Your Claude sign-in ran out on Tue, Oct 19.'
    );
  });

  it('says the next day far east of UTC, for the same moment', () => {
    // 3:30 pm UTC on Oct 19 is 4:30 am on Wed Oct 20 in Auckland.
    const expires = expiresOn('2026-10-19T15:30:00.000Z');

    expect(weekdayOf(expires, FAR_EAST)).toBe('Wed, Oct 20');
    expect(expiryDay(expires, FAR_EAST)).toBe('2027-10-20');
    expect(today(at('2027-10-19T12:00:00.000Z'), FAR_EAST)).toBe('2027-10-20');
    expect(renewsLine(expires, FAR_EAST)).toBe('renews Oct 2027');
    expect(bannerLine(expires, at('2027-10-01T12:00:00.000Z'), FAR_EAST)).toBe(
      'Your Claude sign-in runs out on Wed, Oct 20.'
    );
  });

  it('says when, in the banner', () => {
    const expires = expiresOn('2026-10-19T15:30:00.000Z');

    expect(weekdayOf(expires, PAWNEE)).toBe('Tue, Oct 19');
    expect(
      bannerLine(expires, at('2027-09-27T12:00:00.000Z'), PAWNEE)
    ).toBeNull();
    expect(bannerLine(expires, at('2027-10-01T12:00:00.000Z'), PAWNEE)).toBe(
      'Your Claude sign-in runs out on Tue, Oct 19.'
    );
    expect(bannerLine(expires, at('2027-10-21T12:00:00.000Z'), PAWNEE)).toBe(
      'Your Claude sign-in ran out on Tue, Oct 19.'
    );
  });
});
