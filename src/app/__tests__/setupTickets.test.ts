import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { SetupState } from '../../setup/routes';
import { TicketsStep, WhoAreYou, afterTicketsSaved } from '../client/Setup';

const state: SetupState = {
  steps: {
    claude: { done: true, run: { phase: 'idle' } },
    project: { done: true },
    tickets: { done: false },
    browser: { phase: 'not-app' },
  },
  claudeExpiresOn: '2027-10-19',
  ticketSource: 'linear',
};

describe("the Tickets step's Connected as line", () => {
  it('stays on the step after a checked key, and carries on after markdown', () => {
    expect(afterTicketsSaved('Leslie Knope')).toBe('stay');
    expect(afterTicketsSaved(null)).toBe('continue');
  });

  it('shows who it connected as, with Continue to move on', () => {
    const html = renderToStaticMarkup(
      createElement(TicketsStep, {
        state,
        onDone: () => undefined,
        connected: 'Leslie Knope',
      })
    );

    expect(html).toContain('✓ Connected as Leslie Knope');
    expect(html).toMatch(
      /<button type="button" class="primary">Continue<\/button>/
    );
  });
});

describe('who you are, asked under Connected as', () => {
  it('asks whether a login that isn’t yours yet is you, with both answers', () => {
    const html = renderToStaticMarkup(
      createElement(WhoAreYou, {
        ask: {
          login: { name: 'Pawnee build bot', email: 'bot@pawnee.gov' },
          yourEmail: 'leslie@pawnee.gov',
        },
        tracker: 'Linear',
      })
    );

    expect(html).toContain(
      'Lambda builds only the tickets you report. Is Pawnee build bot (bot@pawnee.gov) you?'
    );
    expect(html).toContain('Yes, that&#x27;s me');
    expect(html).toContain('No, it&#x27;s this computer&#x27;s own login');
  });

  it('names the login alone when the tracker hides its email', () => {
    const html = renderToStaticMarkup(
      createElement(WhoAreYou, {
        ask: { login: { name: 'Ann Perkins', email: null }, yourEmail: null },
        tracker: 'Jira',
      })
    );

    expect(html).toContain('Is Ann Perkins you?');
  });
});
