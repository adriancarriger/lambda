import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { run } from '../../../cli';
import { claudeLine, runDoctor } from '../index';

const tmp = (prefix: string): string =>
  fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

const write = (file: string, text: string): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

const pawneeProject = (): { root: string; home: string } => {
  const root = tmp('lambda-doctor-');
  const home = tmp('lambda-home-');
  write(
    path.join(root, 'lambda.json'),
    JSON.stringify({ cli: 'parks', commands: { e2e: 'pnpm test:e2e {spec}' } })
  );
  write(
    path.join(root, '.lambda', 'commands', 'trace.ts'),
    'export const register = () => undefined;\n'
  );
  write(
    path.join(root, '.lambda', 'commands', 'pod.ts'),
    "throw new Error('pod drop-in loaded');\n"
  );
  write(
    path.join(root, '.lambda', 'commands', 'agent.ts'),
    'export const agent = 1;\n'
  );
  write(
    path.join(home, 'config.json'),
    JSON.stringify({
      owner: { name: 'Leslie Knope' },
      tokens: { claude: { value: 'claude-pawnee-secret' } },
    })
  );

  return { root, home };
};

describe('lambda doctor', () => {
  it('shows where each command comes from, and no token', async () => {
    const { root, home } = pawneeProject();

    const output = (
      await runDoctor({ cwd: root, env: { ...process.env, LAMBDA_HOME: home } })
    ).join('\n');

    expect(output).toContain('  trace    drop-in: .lambda/commands/trace.ts');
    expect(output).toContain(
      '  pod      refused drop-in: .lambda/commands/pod.ts'
    );
    expect(output).toContain(
      '  agent    broken drop-in: .lambda/commands/agent.ts (no register export)'
    );
    expect(output).toContain('  e2e      lambda.json: commands.e2e');
    expect(output).toContain('  *        codebase CLI: parks');
    ['init', 'doctor', 'tmux', 'await'].forEach((name) =>
      expect(output).toContain(`  ${name.padEnd(8)} built in`)
    );
    expect(output).toContain('Leslie Knope');
    expect(output).not.toContain('claude-pawnee-secret');
  });

  it('checks the tools on PATH', async () => {
    const { root, home } = pawneeProject();
    const bin = tmp('lambda-bin-');
    write(path.join(bin, 'git'), '#!/bin/sh\n');
    fs.chmodSync(path.join(bin, 'git'), 0o755);

    const tools = (
      await runDoctor({ cwd: root, env: { PATH: bin, LAMBDA_HOME: home } })
    ).at(-1);

    expect(tools).toContain('✓ git');
    expect(tools).toContain('✗ tmux');
  });

  it('shows an invalid lambda.json on the Project line and carries on', async () => {
    const root = tmp('lambda-doctor-');
    write(
      path.join(root, 'lambda.json'),
      '{ "tickets": { "source": "trello" } }'
    );

    const output = await runDoctor({
      cwd: root,
      env: { ...process.env, LAMBDA_HOME: tmp('lambda-home-') },
    });

    expect(output[0]).toMatch(
      /^Codebase .*lambda\.json: tickets\.source "trello" isn.t one of/
    );
    expect(output).toContain('Commands');
    expect(output).toContain('  init     built in');
  });

  it('never quotes a token from a machine file that is not JSON', async () => {
    const { root, home } = pawneeProject();
    write(
      path.join(home, 'config.json'),
      '{"tokens":{"claude":{"value": claude-pawnee-secret}}}'
    );

    const output = await runDoctor({
      cwd: root,
      env: { ...process.env, LAMBDA_HOME: home },
    });

    expect(output[1]).toMatch(/^You {6}Invalid JSON in .*config\.json: /);
    expect(output.join('\n')).not.toMatch(/sk-ant|pawnee-secret/);
  });

  it('shows an unreadable .lambda/commands instead of failing', async () => {
    const root = tmp('lambda-doctor-');
    write(path.join(root, 'lambda.json'), '{}');
    write(path.join(root, '.lambda', 'commands'), 'not a folder\n');

    const output = await runDoctor({
      cwd: root,
      env: { ...process.env, LAMBDA_HOME: tmp('lambda-home-') },
    });

    expect(output).toContain("  Can't read .lambda/commands: ENOTDIR");
    expect(output).toContain('  init     built in');
  });

  it('lists only files a drop-in name can come from', async () => {
    const { root, home } = pawneeProject();
    write(path.join(root, '.lambda', 'commands', 'parks.d.ts'), '');
    write(path.join(root, '.lambda', 'commands', 'budget.mts'), '');
    write(
      path.join(root, '.lambda', 'commands', 'harvest.js'),
      'exports.register = () => undefined;\n'
    );

    const output = await runDoctor({
      cwd: root,
      env: { ...process.env, LAMBDA_HOME: home },
    });
    const names = output.map((line) => line.trim().split(/\s+/)[0]);

    expect(names).toContain('harvest');
    expect(names).not.toContain('parks.d');
    expect(names).not.toContain('parks');
    expect(names).not.toContain('budget');
  });

  describe('the Claude line', () => {
    const CREATED = '2026-10-19T12:00:00.000Z';
    const homeWith = (claude: unknown): string => {
      const home = tmp('lambda-home-');
      write(
        path.join(home, 'config.json'),
        JSON.stringify({ tokens: claude === undefined ? {} : { claude } })
      );

      return home;
    };
    const lineAt = (claude: unknown, day: string): string =>
      claudeLine(
        { LAMBDA_HOME: homeWith(claude) },
        Date.parse(`${day}T09:00:00.000Z`),
        // A pinned clock, so the days read the same in any zone.
        'America/Indiana/Indianapolis'
      );
    const token = { value: 'claude-pawnee-secret', createdAt: CREATED };

    it.each([
      [
        'not connected',
        undefined,
        '2027-01-01',
        'not connected (run lambda connect claude)',
      ],
      [
        'connected with no date',
        { value: 'claude-pawnee-secret' },
        '2027-01-01',
        'connected (no date: run lambda connect claude to see when it runs out)',
      ],
      ['fine', token, '2027-09-27', 'connected · runs out on 2027-10-19'],
      [
        'within 21 days',
        token,
        '2027-09-29',
        'connected · runs out on 2027-10-19: run lambda connect claude soon',
      ],
      [
        'run out',
        token,
        '2027-10-20',
        'ran out on 2027-10-19: run lambda connect claude',
      ],
    ])('%s', (_what, claude, day, line) => {
      const shown = lineAt(claude, day);

      expect(shown).toBe(line);
      expect(shown).not.toContain('pawnee-secret');
    });
  });

  it.each([
    ['✗', false],
    ['✓', true],
  ])("shows %s for Playwright's browser", async (mark, complete) => {
    const { root, home } = pawneeProject();
    const browsers = tmp('lambda-browsers-');
    const build = path.join(browsers, 'chromium-1187');
    fs.mkdirSync(build);

    if (complete) {
      write(path.join(build, 'INSTALLATION_COMPLETE'), '');
    }

    const tools = (
      await runDoctor({
        cwd: root,
        env: {
          PATH: '',
          LAMBDA_HOME: home,
          PLAYWRIGHT_BROWSERS_PATH: browsers,
        },
      })
    ).at(-1);

    expect(tools).toContain(`${mark} Playwright's browser`);
  });

  it("shows the codebase's process changes and where each instruction comes from, by the codebase's name", async () => {
    const root = tmp('lambda-doctor-');
    write(
      path.join(root, 'lambda.json'),
      JSON.stringify({ name: 'Pawnee', cli: 'parks' })
    );
    write(
      path.join(root, '.lambda', 'building', 'workflow.json'),
      JSON.stringify({
        extends: 'standard',
        add: [
          {
            id: 'trail-check',
            label: 'Trail check',
            run: '/trail-check',
            after: 'self-review',
          },
        ],
      })
    );
    write(
      path.join(root, '.lambda', 'building', 'trail-check.md'),
      'Check.\n'
    );
    write(
      path.join(root, '.lambda', 'building', 'manager.add.md'),
      'Lot 48.\n'
    );
    write(path.join(root, '.claude', 'commands', 'qa.md'), 'Our QA.\n');

    const output = await runDoctor({
      cwd: root,
      env: { LAMBDA_HOME: tmp('lambda-home-') },
    });
    const lineFor = (label: string): string =>
      output.find((line) => line.trim().startsWith(label)) ?? '';

    expect(lineFor('planning steps')).toContain("Lambda's standard");
    expect(lineFor('building steps')).toContain(
      "Lambda's standard · 1 added by Pawnee"
    );
    expect(lineFor('building/qa ')).toContain(
      'Pawnee override (.claude/commands/qa.md)'
    );
    expect(lineFor('building/trail-check ')).toContain(
      'Pawnee override (.lambda/building/trail-check.md)'
    );
    expect(lineFor('building/manager ')).toContain(
      'Lambda default + Pawnee addendum (.lambda/building/manager.add.md)'
    );
    expect(lineFor('building/check-ticket ')).toContain('Lambda default');
    expect(output).toContain('✓ No errors');
  });

  it("lists a process that won't load as an error, and still exits 0", async () => {
    const root = tmp('lambda-doctor-');
    write(path.join(root, 'lambda.json'), JSON.stringify({}));
    write(path.join(root, '.lambda', 'building', 'manager.md'), 'Ours.\n');

    const output = await runDoctor({
      cwd: root,
      env: { LAMBDA_HOME: tmp('lambda-home-') },
    });

    expect(
      output.some((line) =>
        line.startsWith('✗ .lambda/building/manager.md replaces')
      )
    ).toBe(true);
    expect(output).not.toContain('✓ No errors');
  });

  it('says there is no project', async () => {
    const output = await runDoctor({
      cwd: tmp('lambda-doctor-'),
      env: { ...process.env, LAMBDA_HOME: tmp('lambda-home-') },
    });

    expect(output[0]).toBe('Codebase none (run lambda init)');
  });

  describe('lambda doctor through the CLI', () => {
    const savedCwd = process.cwd();
    const savedHome = process.env.LAMBDA_HOME;
    const logged: string[] = [];

    beforeEach(() => {
      logged.length = 0;
      jest.spyOn(console, 'log').mockImplementation((line: string) => {
        logged.splice(logged.length, 0, line);
      });
    });

    afterEach(() => {
      process.chdir(savedCwd);

      if (savedHome === undefined) {
        delete process.env.LAMBDA_HOME;
      } else {
        process.env.LAMBDA_HOME = savedHome;
      }
      process.exitCode = undefined;
      jest.restoreAllMocks();
    });

    it('exits 0 with an invalid lambda.json, still printing the commands', async () => {
      const root = tmp('lambda-doctor-');
      write(
        path.join(root, 'lambda.json'),
        '{ "tickets": { "source": "trello" } }'
      );
      process.env.LAMBDA_HOME = tmp('lambda-home-');
      process.chdir(root);

      expect(await run(['node', 'lambda', 'doctor'])).toBe(0);
      expect(logged[0]).toMatch(
        /^Codebase .*lambda\.json: tickets\.source "trello" isn.t one of/
      );
      expect(logged).toContain('Commands');
      expect(logged).toContain('  init     built in');
    });

    it('exits 0 with an invalid machine file, showing it on the You line', async () => {
      const { root, home } = pawneeProject();
      write(
        path.join(home, 'config.json'),
        JSON.stringify({ owner: { name: 7 } })
      );
      process.env.LAMBDA_HOME = home;
      process.chdir(root);

      expect(await run(['node', 'lambda', 'doctor'])).toBe(0);
      expect(logged[1]).toMatch(
        /^You {6}.*config\.json: owner\.name expected string/
      );
      expect(logged).toContain('  *        codebase CLI: parks');
    });
  });
});
