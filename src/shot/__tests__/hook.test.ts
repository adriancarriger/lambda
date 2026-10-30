import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { NO_PHOTO_HOOK, isPng, lastLineOf, runPhotoHook, runShot } from '..';
import { ProjectConfigSchema } from '../../config/projectConfig';

const tmp = (name = 'lambda-hook-'): string =>
  fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), name)));

/** A 2×2 PNG's signature and IHDR (all the check reads). */
const png = (width = 2, height = 2): Buffer => {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'ascii');
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr.writeUInt8(8, 16);
  ihdr.writeUInt8(6, 17);

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    ihdr,
  ]);
};

const DESCRIPTION =
  'Ann Perkins is signed in as a park ranger on a Tuesday at 4pm. The Ramsett Park loop trail was just closed for flooding, and she is on the Trail map screen.';

const project = (root: string, shot: string | undefined) => {
  const tracked = path.join(root, '.lambda', 'scenarios');
  fs.mkdirSync(tracked, { recursive: true });
  fs.writeFileSync(
    path.join(tracked, 'trail-map-closed.scenario.json'),
    JSON.stringify({
      id: 'trail-map-closed',
      title: 'Trail map, trail closed',
      description: DESCRIPTION,
      tags: ['trail'],
      viewport: 'phone',
    })
  );
  fs.writeFileSync(path.join(root, 'fixture.png'), png());

  return {
    root,
    file: path.join(root, 'lambda.json'),
    config: ProjectConfigSchema.parse({
      commands: shot === undefined ? {} : { shot },
    }),
  };
};

const shoot = async (
  shot: string | undefined,
  options: { root?: string; timeoutMs?: number } = {}
) => {
  const root = options.root ?? tmp();
  const out = path.join(root, 'out', 'trail.png');
  const printed: string[] = [];
  const errors: string[] = [];
  const code = await runShot(
    'trail-map-closed',
    { out },
    {
      project: project(root, shot),
      checkout: root,
      env: { LAMBDA_PODS_ROOT: path.join(root, 'pods') },
      print: (line) => printed.splice(printed.length, 0, line),
      printError: (line) => errors.splice(errors.length, 0, line),
      showOutput: () => undefined,
      timeoutMs: options.timeoutMs,
    }
  );

  return { code, out, root, printed, errors };
};

describe('isPng', () => {
  it('needs the signature and a width and height above 0', () => {
    const dir = tmp();
    const good = path.join(dir, 'good.png');
    const flat = path.join(dir, 'flat.png');
    const text = path.join(dir, 'text.png');
    fs.writeFileSync(good, png());
    fs.writeFileSync(flat, png(2, 0));
    fs.writeFileSync(text, 'not a picture');

    expect(isPng(good)).toBe(true);
    expect(isPng(flat)).toBe(false);
    expect(isPng(text)).toBe(false);
    expect(isPng(path.join(dir, 'missing.png'))).toBe(false);
  });
});

describe('the photo hook', () => {
  it('succeeds when the hook writes a PNG', async () => {
    const { code, out, printed } = await shoot('cp fixture.png {out}');

    expect(code).toBe(0);
    expect(isPng(out)).toBe(true);
    expect(printed).toEqual([out]);
  });

  it.each([
    ['writes a text file', 'echo hi > {out}'],
    ['writes nothing', 'true'],
  ])('fails when it exits 0 but %s', async (_label, shot) => {
    const { code, errors } = await shoot(shot);

    expect(code).toBe(1);
    expect(errors.join('\n')).toMatch(/didn't write a PNG/);
  });

  it('fails with exactly the last 20 lines when it exits 1', async () => {
    const { code, errors } = await shoot(
      'for i in $(seq 1 30); do echo "line $i"; done; exit 1'
    );

    expect(code).toBe(1);
    const shown = errors.filter((line) => /^ {2}line \d+$/.test(line));
    expect(shown).toEqual(
      Array.from({ length: 20 }, (_, index) => `  line ${index + 11}`)
    );
  });

  it('keeps blank lines in the last 20, counting them as lines', async () => {
    const root = tmp();
    // 25 lines: "line 1" … "line 25", with every fifth one blank.
    const result = await runPhotoHook(
      'for i in $(seq 1 25); do if [ $((i % 5)) -eq 0 ]; then echo; else echo "line $i"; fi; done; exit 1',
      {
        scenario: path.join(root, 'trail-map-closed.scenario.json'),
        id: 'trail-map-closed',
        viewport: 'desktop',
        out: path.join(root, 'trail.png'),
      },
      { cwd: root }
    );

    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.tail).toEqual(
      Array.from({ length: 20 }, (_, index) =>
        (index + 6) % 5 === 0 ? '' : `line ${index + 6}`
      )
    );
  });

  it('prints the blank lines too, and reports the last line that says something', async () => {
    const { code, errors } = await shoot(
      "printf 'Starting the Pawnee app\\n\\nCould not reach the app\\n\\n'; exit 1"
    );

    expect(code).toBe(1);
    expect(errors.slice(-4)).toEqual([
      '  Starting the Pawnee app',
      '',
      '  Could not reach the app',
      '',
    ]);
    expect(
      lastLineOf({
        ok: false,
        reason: 'The photo hook failed (exit 1).',
        tail: ['Could not reach the app', '', ''],
      })
    ).toBe('Could not reach the app');
  });

  it('keeps output that arrives just after the hook exits', async () => {
    const root = tmp();
    // The shell exits at once; what it started writes its last words 100 ms on.
    const result = await runPhotoHook(
      '(sleep 0.1; echo "Could not reach the app") & exit 1',
      {
        scenario: path.join(root, 'trail-map-closed.scenario.json'),
        id: 'trail-map-closed',
        viewport: 'desktop',
        out: path.join(root, 'trail.png'),
      },
      { cwd: root }
    );

    expect(lastLineOf(result)).toBe('Could not reach the app');
  });

  it('listens for Ctrl-C only while a hook runs, to end its group', async () => {
    const root = tmp();
    const before = ['SIGINT', 'SIGTERM', 'exit'].map((event) =>
      process.listenerCount(event)
    );
    const running = runPhotoHook(
      'exit 0',
      {
        scenario: path.join(root, 'trail-map-closed.scenario.json'),
        id: 'trail-map-closed',
        viewport: 'desktop',
        out: path.join(root, 'trail.png'),
      },
      { cwd: root }
    );

    expect(
      ['SIGINT', 'SIGTERM', 'exit'].map((event) => process.listenerCount(event))
    ).toEqual(before.map((count) => count + 1));
    await running;
    expect(
      ['SIGINT', 'SIGTERM', 'exit'].map((event) => process.listenerCount(event))
    ).toEqual(before);
  });

  it('kills a hook that runs past the timeout', async () => {
    const started = Date.now();
    const { code, errors } = await shoot('sleep 5; cp fixture.png {out}', {
      timeoutMs: 500,
    });

    expect(code).toBe(1);
    expect(Date.now() - started).toBeLessThan(4000);
    expect(errors.join('\n')).toMatch(/timed out/);
  });

  it('hands the placeholders over literally, quoted', async () => {
    const root = tmp("lambda-it's-");
    const { code, out } = await shoot(
      "printf '%s\\n' {scenario} {id} {viewport} {out} > args.txt; cp fixture.png {out}",
      { root }
    );

    expect(code).toBe(0);
    expect(fs.readFileSync(path.join(root, 'args.txt'), 'utf8')).toBe(
      [
        path.join(
          root,
          '.lambda',
          'scenarios',
          'trail-map-closed.scenario.json'
        ),
        'trail-map-closed',
        'phone',
        out,
        '',
      ].join('\n')
    );
  });

  it('exits 2 with no commands.shot', async () => {
    const { code, errors } = await shoot(undefined);

    expect(code).toBe(2);
    expect(errors).toEqual([NO_PHOTO_HOOK]);
    expect(NO_PHOTO_HOOK).toBe(
      "This project has no photo hook (commands.shot in lambda.json), so Lambda can't photograph the app."
    );
  });

  it('exits 1 naming the closest ids for an unknown one', async () => {
    const root = tmp();
    const errors: string[] = [];
    const code = await runShot(
      'trail-map-close',
      { out: path.join(root, 'x.png') },
      {
        project: project(root, 'true'),
        checkout: root,
        env: { LAMBDA_PODS_ROOT: path.join(root, 'pods') },
        print: () => undefined,
        printError: (line) => errors.splice(errors.length, 0, line),
        showOutput: () => undefined,
      }
    );

    expect(code).toBe(1);
    expect(errors.join('\n')).toMatch(/Closest: trail-map-closed/);
  });
});
