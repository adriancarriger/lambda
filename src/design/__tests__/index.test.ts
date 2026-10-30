import { Command } from 'commander';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { registerDesignCommand } from '../../commands/design';
import { runDesign } from './runDesign';

/** The full `--help` output of `lambda design <path…>`, after-text included. */
const helpFor = (...names: string[]): string => {
  const program = new Command('lambda');
  registerDesignCommand(program);

  const command = names.reduce((parent: Command, name) => {
    const child = parent.commands.find((c) => c.name() === name);

    if (!child) {
      throw new Error(`No subcommand ${name}`);
    }

    return child;
  }, program);

  const writeOut = jest.fn<void, [string]>();

  command.configureOutput({ writeOut });
  command.outputHelp();

  return writeOut.mock.calls.map(([text]) => text).join('');
};

describe('lambda design help', () => {
  it.each([[['design']], [['design', 'render']]])(
    '%j --help says rendering is asked for',
    (names) => {
      const help = helpFor(...names);

      expect(help).toContain('Rendering is asked for:');
      expect(help).toContain('The owner asked');
    }
  );

  it('has every command of the design loop', () => {
    const program = new Command('lambda');
    registerDesignCommand(program);
    const design = program.commands.find((c) => c.name() === 'design');

    expect(design?.commands.map((c) => c.name()).sort()).toEqual([
      'brief',
      'canvas',
      'capability',
      'redesign',
      'render',
      'round',
      'runtime',
      'snapshot',
      'system',
      'walk',
    ]);
  });
});

describe('lambda design brief', () => {
  const brief = (body: unknown): string => {
    const file = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-design-brief-')),
      'brief.json'
    );
    fs.writeFileSync(file, JSON.stringify(body));

    return file;
  };

  it('prints the situations and steps of a good brief', async () => {
    const result = await runDesign([
      'brief',
      brief({
        situations: [
          { slug: 'empty', title: 'No parks yet' },
          { slug: 'busy', title: 'Every park' },
        ],
        path: [{ step: 'Open Lot 48', action: 'click lot-48' }],
      }),
    ]);

    expect(result.code).toBe(0);
    expect(result.out).toContain('Situations: empty, busy');
    expect(result.out).toContain('Step 1 (Open Lot 48): click lot-48');
  });

  it('exits 1 naming the problem', async () => {
    const result = await runDesign(['brief', brief({ situations: [] })]);

    expect(result.code).toBe(1);
    expect(result.err).toContain('situations');
  });
});

describe('lambda design canvas', () => {
  it("makes the screen's canvas folder, gitignored, and prints it", async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-design-work-'));
    const result = await runDesign(['canvas', 'park-map', '--dir', work]);
    const dir = path.join(work, '.lambda', 'design', 'park-map', 'canvas');

    expect(result).toMatchObject({ code: 0, out: dir });
    expect(fs.statSync(dir).isDirectory()).toBe(true);
    expect(
      fs.readFileSync(
        path.join(work, '.lambda', 'design', '.gitignore'),
        'utf8'
      )
    ).toBe('*\n');
  });

  it('refuses a slug that is not one', async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-design-work-'));
    const result = await runDesign(['canvas', '../escape', '--dir', work]);

    expect(result.code).toBe(1);
    expect(fs.readdirSync(work)).toEqual([]);
  });
});
