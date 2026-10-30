import * as fs from 'fs';

import { buildingPodStore } from '../../building/__tests__/fakes';
import { NEVER_IN_A_POD, writePodSettings } from '../launch';
import './podProject';

/**
 * An ask fork's read-only floor is its settings' deny list, not only its
 * PreToolUse guard: a hook that fails (or an older `lambda` that doesn't know
 * `ask-guard`) lets the tool through, but a deny never does.
 */

const denyOf = (file: string) => {
  const { store, podId } = buildingPodStore();
  writePodSettings(store, podId, { projectRoot: '/tmp', cli: undefined });

  const settings: { permissions: { deny: string[] } } = JSON.parse(
    fs.readFileSync(store.file(podId, file), 'utf8')
  );

  return settings.permissions.deny;
};

describe('ask fork denies', () => {
  it('denies the pod-wide rules, tmux, shipping, messaging and ticket writes outright', () => {
    expect(denyOf('ask-settings.json')).toEqual(
      expect.arrayContaining([
        ...NEVER_IN_A_POD,
        'Edit',
        'Write',
        'NotebookEdit',
        'Artifact',
        'Bash(tmux:*)',
        'Bash(lambda ship:*)',
        'Bash(lambda tmux:*)',
        'Bash(lambda pod send:*)',
        'Bash(lambda pod deliver:*)',
        'Bash(lambda pod relay:*)',
        'Bash(lambda tickets create:*)',
        'Bash(lambda tickets update:*)',
        'Bash(lambda tickets comment:*)',
        'Bash(lambda tickets push:*)',
        'Bash(lambda tickets delete:*)',
        'Bash(lambda tickets reorder:*)',
      ])
    );
  });

  it('denies the Product manager raw tmux: it reads panes through lambda pod peek', () => {
    expect(denyOf('pm-settings.json')).toContain('Bash(tmux:*)');
  });
});
