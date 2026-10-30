/**
 * The Claude sign-in's lifetime. `claude setup-token` makes a token that
 * lasts a year; Lambda keeps when it was made (`tokens.claude.createdAt`) and
 * works out the rest. Pure, so the setup page, the renewal banner (in the
 * browser) and `lambda doctor` all read the same dates.
 *
 * It runs out at a moment (`createdAt` plus a year); the day shown is that
 * moment's day on the clock of whoever reads it.
 */

export const TOKEN_LIFETIME_DAYS = 365;

/** The banner (and the Mac app's notification) start this many days before. */
export const WARNING_DAYS = 21;

const DAY_MS = 24 * 60 * 60 * 1000;

const instantOf = (time: string): Date => {
  const date = new Date(time);

  if (Number.isNaN(date.getTime())) {
    throw new Error(`Not a date: ${time}`);
  }

  return date;
};

/**
 * A moment's calendar parts on the clock in `zone` (an IANA name, for
 * tests); with no zone, this computer's own.
 */
const partsOf = (
  date: Date,
  zone?: string
): {
  year: string;
  month: string;
  day: string;
  monthName: string;
  weekday: string;
} => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes): string => {
    const found = parts.find((one) => one.type === type)?.value;

    if (found === undefined) {
      throw new Error(`No ${type} in ${date.toISOString()}`);
    }

    return found;
  };
  const monthName = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    month: 'short',
  }).format(date);

  return {
    year: part('year'),
    month: part('month'),
    day: part('day'),
    monthName,
    weekday: part('weekday'),
  };
};

/** A calendar day, `YYYY-MM-DD`, on the clock in `zone` (default: here). */
const localDay = (date: Date, zone?: string): string => {
  const { year, month, day } = partsOf(date, zone);

  return `${year}-${month}-${day}`;
};

/** Today, as a calendar day here. */
export const today = (now: number = Date.now(), zone?: string): string =>
  localDay(new Date(now), zone);

/** The moment (an ISO time) a token made at `createdAt` runs out. */
export const expiresOn = (createdAt: string): string =>
  new Date(
    instantOf(createdAt).getTime() + TOKEN_LIFETIME_DAYS * DAY_MS
  ).toISOString();

/** The calendar day here it runs out on. */
export const expiryDay = (expires: string, zone?: string): string =>
  localDay(instantOf(expires), zone);

export type RenewalState = 'fine' | 'soon' | 'expired';

/** `soon` from 21 days before the moment it runs out; `expired` from then on. */
export const renewalState = (expires: string, now: number): RenewalState => {
  const end = instantOf(expires).getTime();

  if (now >= end) {
    return 'expired';
  }

  return now >= end - WARNING_DAYS * DAY_MS ? 'soon' : 'fine';
};

/** "Oct 2027". */
export const monthOf = (expires: string, zone?: string): string => {
  const { monthName, year } = partsOf(instantOf(expires), zone);

  return `${monthName} ${year}`;
};

/** "Tue, Oct 19". */
export const weekdayOf = (expires: string, zone?: string): string => {
  const { weekday, monthName, day } = partsOf(instantOf(expires), zone);

  return `${weekday}, ${monthName} ${Number(day)}`;
};

/** "Claude connected · renews Oct 2027", as the setup step shows it. */
export const renewsLine = (expires: string, zone?: string): string =>
  `renews ${monthOf(expires, zone)}`;

/** The banner's first line, or null outside the warning window. */
export const bannerLine = (
  expires: string,
  now: number,
  zone?: string
): string | null => {
  switch (renewalState(expires, now)) {
    case 'fine':
      return null;
    case 'soon':
      return `Your Claude sign-in runs out on ${weekdayOf(expires, zone)}.`;
    case 'expired':
      return `Your Claude sign-in ran out on ${weekdayOf(expires, zone)}.`;
  }
};
