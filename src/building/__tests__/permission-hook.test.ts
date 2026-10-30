import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import {
  FORK_DENY,
  PRODUCT_MANAGER_DENY,
  writePodSettings,
} from '../../pod/launch';
import { buildingPodStore } from './fakes';

/**
 * The Engineering manager's permission hook: it answers each permission
 * request with allow or deny, so nobody has to watch its pane.
 */

const HOOK_NAME = 'permission-hook.cjs';
const HOOK = path.join(__dirname, '..', HOOK_NAME);

/** As a PreToolUse hook: its decision, or '' when it leaves the call alone. */
const decideBefore = (tool: string, command?: string): string => {
  const out = execFileSync('node', [HOOK], {
    input: JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: tool,
      tool_input: command === undefined ? {} : { command },
    }),
    encoding: 'utf8',
  });

  if (out.trim() === '') {
    return '';
  }

  const { hookSpecificOutput } = JSON.parse(out);
  expect(hookSpecificOutput.hookEventName).toBe('PreToolUse');

  return hookSpecificOutput.permissionDecision;
};

const decide = (tool: string, command?: string): string => {
  const out = execFileSync('node', [HOOK], {
    input: JSON.stringify({
      tool_name: tool,
      tool_input: command === undefined ? {} : { command },
    }),
    encoding: 'utf8',
  });

  return JSON.parse(out).hookSpecificOutput.decision.behavior;
};

describe("the Engineering manager's permission hook", () => {
  it.each([
    'lambda tmux dev "/start 3"',
    'lambda tmux qa "/check-ticket 3"',
    'lambda tickets get 3',
    'lambda pod blocked 3 --what x --problem y --options z --recommendation w',
    'lambda pod skip-ticket build-a1b2 4',
    'lambda pod step test start',
    'lambda pod step visual-check skip --reason "no design"',
    'lambda pod blocked 3 --visual',
    "lambda tmux qa '/visual-check 3'",
    'lambda pod reply --fyi "picked up 3 Trail markers"',
    'lambda event stage.start --name security-review',
    'lambda ship 3',
  ])('allows %s', (command) => {
    expect(decide('Bash', command)).toBe('allow');
  });

  it.each(['git commit -m "3: Trail markers"', 'git push', 'sleep 60'])(
    'denies %s',
    (command) => {
      expect(decide('Bash', command)).toBe('deny');
    }
  );

  it.each([
    'lambda event x && git push',
    'lambda tickets get 3; git commit -am x',
    'lambda ship 3 || git push',
    'lambda tickets get 3 | sh',
    'lambda tickets get 3 > notes.txt',
    'lambda event x\ngit push',
    'lambda tmux dev "$(git push)"',
    'lambda tmux dev `git push`',
    'lambda tmux dev "unterminated',
    '  git push',
    'lambda tmux dev =(touch /tmp/p)',
    "lambda tmux dev *(e:'touch /tmp/p':)",
  ])('denies a chained or hidden command: %s', (command) => {
    expect(decide('Bash', command)).toBe('deny');
  });

  it.each([
    "lambda tmux dev '!git push'",
    'lambda tmux qa "!git push"',
    "lambda tmux dev ' !git push'",
    'lambda tmux dev --raw "!git push"',
    'lambda tmux dev \\!git push',
    'lambda tmux dev ""\'!git push\'',
    "lambda tmux dev -S 5 '!git push'",
  ])(
    'denies a message that Claude Code would run as a shell command: %s',
    (command) => {
      expect(decide('Bash', command)).toBe('deny');
    }
  );

  it.each([
    'lambda tmux dev "fix the pin; then rerun the map spec"',
    "lambda pod reply --fyi 'Test passed | shipping next'",
  ])('still allows shell characters inside a quoted message: %s', (command) => {
    expect(decide('Bash', command)).toBe('allow');
  });

  it('allows skip-ticket exactly as manager.md tells the Engineering manager to run it', () => {
    const manager = fs.readFileSync(
      path.join(
        __dirname,
        '..',
        '..',
        '..',
        'instructions',
        'building',
        'manager.md'
      ),
      'utf8'
    );
    const worded = /`(lambda pod skip-ticket[^`]*)`/.exec(manager);

    if (worded === null) {
      throw new Error('manager.md no longer words a skip-ticket command.');
    }
    expect(
      decide(
        'Bash',
        worded[1].replace('<pod-id>', 'build-a1b2').replace('<id>', '4')
      )
    ).toBe('allow');
  });

  it.each([
    'lambda tickets update 3 --status done',
    'lambda event ship.end --ticket 3 --result pass',
    'lambda event group.shipped --group g1',
  ])('denies marking a ticket done around lambda ship: %s', (command) => {
    expect(decide('Bash', command)).toBe('deny');
  });

  it('denies Edit, and allows reads', () => {
    expect(decide('Edit')).toBe('deny');
    expect(decide('Read')).toBe('allow');
  });
});

describe("the Engineering manager's hook before a tool runs", () => {
  it.each([
    'git -C . commit -am x',
    'lambda tickets update 3 --status done',
    'lambda event ship.end --ticket 3 --result pass',
    'lambda pod send build-a1b2 dev "ship it"',
  ])('denies %s, whatever already allowed it', (command) => {
    expect(decideBefore('Bash', command)).toBe('deny');
  });

  it('allows the loop’s own commands', () => {
    expect(decideBefore('Bash', 'lambda ship 3')).toBe('allow');
  });

  it('leaves tools other than Bash to the settings and the permission request', () => {
    expect(decideBefore('ToolSearch')).toBe('');
  });
});

describe("the visual check's permissions", () => {
  const settingsOf = (file: string) => {
    const made = buildingPodStore();
    writePodSettings(made.store, made.podId, {
      projectRoot: made.root,
      cli: undefined,
    });

    return JSON.parse(
      fs.readFileSync(made.store.file(made.podId, file), 'utf8')
    ).permissions;
  };

  it('let QA photograph the app and record each round', () => {
    const permissions = settingsOf('qa-settings.json');

    expect(permissions.allow).toEqual(
      expect.arrayContaining([
        'Bash(lambda shot:*)',
        'Bash(lambda verdict visual record:*)',
      ])
    );
    expect(permissions.deny).not.toContain(
      'Bash(lambda verdict visual record:*)'
    );
  });

  it.each(['pm-settings.json', 'settings.json', 'em-settings.json'])(
    'deny recording a round in %s (the Product manager, the dev, the Engineering manager)',
    (file) => {
      expect(settingsOf(file).deny).toContain(
        'Bash(lambda verdict visual record:*)'
      );
    }
  );

  it('deny it to every fork', () => {
    expect(FORK_DENY).toContain('Bash(lambda verdict visual record:*)');
    expect(PRODUCT_MANAGER_DENY).toContain(
      'Bash(lambda verdict visual record:*)'
    );
  });
});

describe("the Engineering manager's own settings", () => {
  it('refuse an Edit before any allow can grant it: denied, never pre-allowed', () => {
    const made = buildingPodStore();
    writePodSettings(made.store, made.podId, {
      projectRoot: made.root,
      cli: undefined,
    });
    const { permissions } = JSON.parse(
      fs.readFileSync(made.store.file(made.podId, 'em-settings.json'), 'utf8')
    );

    ['Edit', 'Write', 'NotebookEdit'].forEach((tool) => {
      expect(permissions.deny).toContain(tool);
      expect(permissions.allow).not.toContain(tool);
    });
    expect(decide('Edit')).toBe('deny');
  });

  it('deny recording a verdict or starting a pod, which `Bash(lambda:*)` would pre-allow past the hook', () => {
    const made = buildingPodStore();
    writePodSettings(made.store, made.podId, {
      projectRoot: made.root,
      cli: undefined,
    });
    const { permissions } = JSON.parse(
      fs.readFileSync(made.store.file(made.podId, 'em-settings.json'), 'utf8')
    );

    expect(permissions.deny).toEqual(
      expect.arrayContaining([
        'Bash(lambda verdict record:*)',
        'Bash(lambda pod build:*)',
      ])
    );
  });

  it('runs the hook before every Bash call, not only when a prompt would show', () => {
    const made = buildingPodStore();
    writePodSettings(made.store, made.podId, {
      projectRoot: made.root,
      cli: undefined,
    });
    const { hooks, permissions } = JSON.parse(
      fs.readFileSync(made.store.file(made.podId, 'em-settings.json'), 'utf8')
    );

    expect(hooks.PreToolUse).toEqual([
      {
        matcher: 'Bash',
        hooks: [
          { type: 'command', command: expect.stringContaining(HOOK_NAME) },
        ],
      },
    ]);
    expect(permissions.deny).toEqual(
      expect.arrayContaining([
        'Bash(lambda tickets update:*)',
        'Bash(lambda event ship.:*)',
        'Bash(lambda event group.:*)',
        'Bash(lambda pod send:*)',
      ])
    );
  });

  it('pre-allow no Bash command, so every one reaches the hook', () => {
    const made = buildingPodStore();
    writePodSettings(made.store, made.podId, {
      projectRoot: made.root,
      cli: undefined,
    });
    const { permissions } = JSON.parse(
      fs.readFileSync(made.store.file(made.podId, 'em-settings.json'), 'utf8')
    );

    expect(
      permissions.allow.filter((rule: string) => rule.startsWith('Bash('))
    ).toEqual([]);
  });
});

describe("the design system's permissions", () => {
  const settingsOf = (file: string) => {
    const made = buildingPodStore();
    writePodSettings(made.store, made.podId, {
      projectRoot: made.root,
      cli: undefined,
    });

    return JSON.parse(
      fs.readFileSync(made.store.file(made.podId, file), 'utf8')
    ).permissions;
  };

  /** A rule `Bash(<prefix>:*)` covers every command that starts with it. */
  const covers = (rules: string[], command: string): boolean =>
    rules.some((rule) => {
      const prefix = /^Bash\((.+):\*\)$/.exec(rule)?.[1];

      return (
        prefix !== undefined &&
        (command === prefix || command.startsWith(`${prefix} `))
      );
    });

  const SETUP_COMMANDS = [
    'lambda design system build --check',
    'lambda design system changed',
    'lambda design system round record --round r.json',
    'lambda design system manifest write --rounds rounds.json',
    'lambda design render canvas screens/ParksList.dc.html --out a.png',
    'lambda shot parks-list --out a.png',
  ];

  it.each(SETUP_COMMANDS)(
    "let the building dev run %s (the setup ticket's and the design check's)",
    (command) => {
      const permissions = settingsOf('settings.json');

      expect(covers(permissions.allow, command)).toBe(true);
      expect(covers(permissions.deny, command)).toBe(false);
    }
  );

  it('name the three rules in the dev window', () => {
    expect(settingsOf('settings.json').allow).toEqual(
      expect.arrayContaining([
        'Bash(lambda design system:*)',
        'Bash(lambda design render:*)',
        'Bash(lambda shot:*)',
      ])
    );
  });

  it.each([
    'lambda design system build --check',
    'lambda design system manifest write',
  ])('deny %s to every building fork', (command) => {
    const ask = settingsOf('ask-settings.json');

    expect(FORK_DENY).toContain('Bash(lambda design system:*)');
    expect(covers(ask.deny, command)).toBe(true);
    expect(covers(ask.allow, command)).toBe(false);
    expect(covers(settingsOf('pm-settings.json').deny, command)).toBe(true);
  });

  it('let the Engineering manager read whether the base has a design system, and nothing else of it', () => {
    expect(decide('Bash', 'lambda design system changed')).toBe('allow');
    expect(decide('Bash', 'lambda tmux dev "/design-check PAWNEE-12"')).toBe(
      'allow'
    );
    expect(
      decide(
        'Bash',
        'lambda pod step design-check skip --reason "no design system"'
      )
    ).toBe('allow');
    [
      'lambda design system build --check',
      'lambda design system manifest write',
      'lambda design system changedx',
    ].forEach((command) => expect(decide('Bash', command)).toBe('deny'));
  });
});
