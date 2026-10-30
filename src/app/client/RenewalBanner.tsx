import { useEffect, useState } from 'react';

import { bannerLine, renewalState } from '../../setup/tokenExpiry';

export const HOUR_MS = 60 * 60 * 1000;

/** Calls `onTick` with the time every hour; returns what stops it. */
export const everyHour = (onTick: (now: number) => void): (() => void) => {
  const timer = setInterval(() => onTick(Date.now()), HOUR_MS);

  return () => clearInterval(timer);
};

/**
 * From 21 days before the Claude sign-in runs out, every Lambda page says so
 * (in a plain browser too, not only the Mac app), with a way to reconnect.
 */
export const RenewalBanner = ({
  expiresOn,
  day,
  zone,
}: {
  expiresOn: string | null;
  /** Now, as an ISO time (tests pin it). */
  day?: string;
  /** The reader's time zone (tests pin it); default: the browser's. */
  zone?: string;
}) => {
  // A window left open for days (the Mac app's) still crosses the 21 days.
  const [clock, setClock] = useState(Date.now);
  useEffect(() => everyHour(setClock), []);
  const now = day === undefined ? clock : Date.parse(day);
  const line = expiresOn === null ? null : bannerLine(expiresOn, now, zone);
  // Once it has run out, agents already have stopped: the date says it all.
  const expired =
    expiresOn !== null && renewalState(expiresOn, now) === 'expired';

  if (line === null) {
    return null;
  }

  return (
    <div className="renewal-banner" role="status">
      <span aria-hidden="true">⚠</span>
      <span>{expired ? line : `${line} Agents stop working after that.`}</span>
      <button
        type="button"
        onClick={() => window.location.assign('/setup?step=claude')}
      >
        Reconnect Claude
      </button>
    </div>
  );
};
