import { buildingPodStore } from '../../building/__tests__/fakes';
import { agentCommandLine } from '../launch';
import './podProject';

/**
 * Every fork in a building pod is read-only, whatever its window is called:
 * the ask fork's settings and no auto mode. The read-only roles also take no
 * optional git locks, so their `git status` in the shared checkout never
 * holds `.git/index.lock` while the dev commits.
 */

const fork = { kind: 'fork' as const, fromSessionId: 'dev-session' };

const commandFor = (
  agent: string,
  mode: Parameters<typeof agentCommandLine>[3]
) => {
  const { store } = buildingPodStore();

  return agentCommandLine(store.requirePod('build-a1b2'), store, agent, mode);
};

describe('a building pod fork', () => {
  it.each(['ask-a1b2c3', 'fork-q7'])(
    '%s starts on the ask settings, without auto mode or the person’s settings',
    (agent) => {
      const command = commandFor(agent, fork);

      expect(command).toContain('ask-settings.json');
      expect(command).toContain('--permission-mode default');
      expect(command).toContain('--setting-sources project ');
      expect(command).not.toContain('--permission-mode auto');
    }
  );
});

describe('GIT_OPTIONAL_LOCKS', () => {
  it('is off for ask forks and the Product manager', () => {
    expect(commandFor('ask-a1b2c3', fork)).toContain('GIT_OPTIONAL_LOCKS=0');
    expect(commandFor('fork-q7', fork)).toContain('GIT_OPTIONAL_LOCKS=0');
    expect(
      commandFor('product-manager', { kind: 'fresh', sessionId: 'pm-session' })
    ).toContain('GIT_OPTIONAL_LOCKS=0');
  });

  it('is left alone for the agents that commit', () => {
    ['dev', 'qa', 'engineering-manager'].forEach((agent) =>
      expect(
        commandFor(agent, { kind: 'fresh', sessionId: `${agent}-session` })
      ).not.toContain('GIT_OPTIONAL_LOCKS')
    );
  });
});
