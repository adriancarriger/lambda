import type { SetupState } from '../../setup/routes';
import { stepAfter } from '../client/setupSteps';

const withDone = (done: {
  claude: boolean;
  project: boolean;
  tickets: boolean;
}): SetupState => ({
  steps: {
    claude: { done: done.claude, run: { phase: 'idle' } },
    project: { done: done.project },
    tickets: { done: done.tickets },
    browser: { phase: 'not-app' },
  },
  claudeExpiresOn: '2027-10-19',
  ticketSource: 'markdown',
});

describe('where a finished setup step leads', () => {
  it('finishes after Reconnect Claude when the other steps are done', () => {
    expect(
      stepAfter(
        'claude',
        withDone({ claude: true, project: true, tickets: true })
      )
    ).toBeNull();
  });

  it('skips a done step for the next one still to do', () => {
    expect(
      stepAfter(
        'claude',
        withDone({ claude: true, project: true, tickets: false })
      )
    ).toBe('tickets');
  });

  it('goes back to an earlier step still to do', () => {
    expect(
      stepAfter(
        'tickets',
        withDone({ claude: false, project: true, tickets: true })
      )
    ).toBe('claude');
  });

  it('walks a first run in order', () => {
    expect(
      stepAfter(
        'claude',
        withDone({ claude: true, project: false, tickets: false })
      )
    ).toBe('project');
  });
});
