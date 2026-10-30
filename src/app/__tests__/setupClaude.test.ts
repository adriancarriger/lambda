import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { SAVE_FAILED } from '../../setup/connectClaude';
import type { SetupState } from '../../setup/routes';
import { ClaudeStep } from '../client/Setup';

const state: SetupState = {
  steps: {
    claude: {
      done: true,
      run: {
        phase: 'failed',
        step: 'sign-in',
        message: SAVE_FAILED,
        lines: [],
      },
    },
    project: { done: true },
    tickets: { done: true },
    browser: { phase: 'not-app' },
  },
  claudeExpiresOn: '2027-10-19',
  ticketSource: 'markdown',
};

describe('the Connect Claude step', () => {
  it('says why a Reconnect failed, still showing the sign-in it kept', () => {
    const html = renderToStaticMarkup(
      createElement(ClaudeStep, {
        state,
        onContinue: () => undefined,
        refresh: () => undefined,
      })
    );

    expect(html).toContain('✓ Claude connected');
    expect(html).toContain(SAVE_FAILED.replace("'", '&#x27;'));
  });
});
