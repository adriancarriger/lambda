import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { SetupState } from '../../setup/routes';
import { HOUR_MS, RenewalBanner, everyHour } from '../client/RenewalBanner';
import { SignedIn } from '../client/Root';

/** The sign-in made 2026-10-19 runs out on Tue, Oct 19 2027. */
const EXPIRES = '2027-10-19T12:00:00.000Z';
// Read on a pinned clock, so the suite passes in any zone.
const PAWNEE = 'America/Indiana/Indianapolis';

const state = (done: boolean): SetupState => ({
  steps: {
    claude: { done: true, run: { phase: 'idle' } },
    project: { done },
    tickets: { done },
    browser: { phase: 'not-app' },
  },
  claudeExpiresOn: EXPIRES,
  ticketSource: 'markdown',
});

const text = (html: string): string => html.replace(/<[^>]+>/g, ' ');

describe('the Claude renewal banner', () => {
  it('shows above setup too, not only above the app', () => {
    const onSetup = renderToStaticMarkup(
      createElement(SignedIn, {
        state: state(false),
        setupPage: true,
        day: '2027-10-09',
        zone: PAWNEE,
      })
    );

    expect(text(onSetup)).toContain(
      'Your Claude sign-in runs out on Tue, Oct 19. Agents stop working after that.'
    );
  });

  it('reads only that it ran out, once it has', () => {
    const html = renderToStaticMarkup(
      createElement(RenewalBanner, {
        expiresOn: EXPIRES,
        day: '2027-10-21',
        zone: PAWNEE,
      })
    );

    expect(text(html)).toContain('Your Claude sign-in ran out on Tue, Oct 19.');
    expect(html).not.toContain('Agents stop working after that.');
  });

  it("names the day on the reader's clock, far east of UTC too", () => {
    const html = renderToStaticMarkup(
      createElement(RenewalBanner, {
        expiresOn: EXPIRES,
        day: '2027-10-09',
        zone: 'Pacific/Auckland',
      })
    );

    // Noon UTC on Oct 19 is 1 am on Wed Oct 20 in Auckland.
    expect(text(html)).toContain(
      'Your Claude sign-in runs out on Wed, Oct 20.'
    );
  });

  it('is not there outside the 21 days', () => {
    expect(
      renderToStaticMarkup(
        createElement(RenewalBanner, {
          expiresOn: EXPIRES,
          day: '2027-09-27',
          zone: PAWNEE,
        })
      )
    ).toBe('');
  });
});

describe("the banner's clock", () => {
  afterEach(() => jest.useRealTimers());

  it('reads the time again every hour, so a window left open crosses the 21 days', () => {
    jest.useFakeTimers({ now: Date.parse('2027-09-27T23:30:00.000Z') });
    const read: number[] = [];
    const stop = everyHour((now) => read.splice(read.length, 0, now));

    jest.advanceTimersByTime(HOUR_MS);
    expect(read).toEqual([Date.parse('2027-09-28T00:30:00.000Z')]);

    stop();
    jest.advanceTimersByTime(HOUR_MS);
    expect(read).toHaveLength(1);
  });
});
