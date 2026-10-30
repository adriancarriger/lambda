import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { ProjectConfigSchema } from '../../config/projectConfig';
import { shootScenario } from '../../shot';
import {
  type BeforeSituation,
  beforeFile,
  takeBeforeShots,
} from '../beforeShot';

const tmp = (): string =>
  fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-before-')));

const DESCRIPTION =
  'Ann Perkins is signed in as a park ranger on a Tuesday at 4pm. The Oct 3 storm just closed the Ramsett Park loop trail, and she is on the Trail map screen.';

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([0, 0, 0, 13]),
  Buffer.from('IHDR', 'ascii'),
  Buffer.from([0, 0, 0, 2, 0, 0, 0, 2, 8, 6, 0, 0, 0]),
]);

/** Every temp folder a test made, removed after it. */
const made: string[] = [];
const podsRootBefore = process.env.LAMBDA_PODS_ROOT;

const setup = (shot: string | undefined) => {
  const root = tmp();
  const tracked = path.join(root, '.lambda', 'scenarios');
  fs.mkdirSync(tracked, { recursive: true });
  ['trail-map-closed', 'trail-map-open'].forEach((id) =>
    fs.writeFileSync(
      path.join(tracked, `${id}.scenario.json`),
      JSON.stringify({ id, title: id, description: DESCRIPTION, tags: [] })
    )
  );
  fs.writeFileSync(path.join(root, 'fixture.png'), PNG);
  const screenDir = path.join(root, 'pods', 'pod-1', 'designs', 'trail-map');
  fs.mkdirSync(screenDir, { recursive: true });
  process.env.LAMBDA_PODS_ROOT = path.join(root, 'pods');
  made.splice(made.length, 0, root);
  const project = {
    root,
    file: path.join(root, 'lambda.json'),
    config: ProjectConfigSchema.parse({
      commands: shot === undefined ? {} : { shot },
    }),
  };
  const shoot = (scenarioId: string, out: string) =>
    shootScenario(scenarioId, out, {
      project,
      checkout: root,
      env: { LAMBDA_PODS_ROOT: path.join(root, 'pods') },
      showOutput: () => undefined,
    });

  return { root, screenDir, shoot };
};

afterEach(() => {
  made
    .splice(0)
    .forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));

  if (podsRootBefore === undefined) {
    delete process.env.LAMBDA_PODS_ROOT;
  } else {
    process.env.LAMBDA_PODS_ROOT = podsRootBefore;
  }
});

const SITUATIONS: BeforeSituation[] = [
  { situation: 'trail-closed', scenarioId: 'trail-map-closed' },
  { situation: 'trail-open', scenarioId: 'trail-map-open' },
];

describe("a screen's before shots", () => {
  it('photographs each situation to <situation>.before.png', async () => {
    const { screenDir, shoot } = setup('cp fixture.png {out}');

    const result = await takeBeforeShots({
      slug: 'trail-map',
      screenDir,
      situations: SITUATIONS,
      shoot,
    });

    expect(result).toEqual({
      kind: 'taken',
      befores: SITUATIONS.map((one) => ({
        ...one,
        file: beforeFile(screenDir, one.situation),
      })),
    });
    expect(fs.existsSync(path.join(screenDir, 'trail-open.before.png'))).toBe(
      true
    );
  });

  it('ends the screen on a failed hook', async () => {
    const { screenDir, shoot } = setup(
      'echo "starting the app"; echo "the app did not answer on its port"; exit 1'
    );

    const result = await takeBeforeShots({
      slug: 'trail-map',
      screenDir,
      situations: SITUATIONS,
      shoot,
    });

    expect(result).toEqual({
      kind: 'failed',
      line: 'DESIGN FAILED trail-map: before shot — trail-map-closed: the app did not answer on its port',
    });
  });

  it("names the hook's last line that says something, past trailing blank lines", async () => {
    const { screenDir, shoot } = setup(
      "printf 'starting the app\\nthe app did not answer on its port\\n\\n\\n'; exit 1"
    );

    const result = await takeBeforeShots({
      slug: 'trail-map',
      screenDir,
      situations: SITUATIONS,
      shoot,
    });

    expect(result).toEqual({
      kind: 'failed',
      line: 'DESIGN FAILED trail-map: before shot — trail-map-closed: the app did not answer on its port',
    });
  });

  it('ends the screen when the hook writes no PNG', async () => {
    const { screenDir, shoot } = setup('true');

    const result = await takeBeforeShots({
      slug: 'trail-map',
      screenDir,
      situations: SITUATIONS,
      shoot,
    });

    expect(result.kind).toBe('failed');
    expect(result.kind === 'failed' ? result.line : '').toMatch(
      /^DESIGN FAILED trail-map: before shot — trail-map-closed: The photo hook exited 0 but didn't write a PNG/
    );
  });

  it('takes no befores and says noPhotoHook without commands.shot', async () => {
    const { screenDir, shoot } = setup(undefined);

    const result = await takeBeforeShots({
      slug: 'trail-map',
      screenDir,
      situations: SITUATIONS,
      shoot,
    });

    expect(result).toEqual({ kind: 'no-hook', noPhotoHook: true });
    expect(
      fs.readdirSync(screenDir).filter((name) => name.endsWith('.before.png'))
    ).toEqual([]);
  });

  // Nothing to photograph would read as "taken", hiding a missing hook.
  it('refuses an empty situation list', async () => {
    const { screenDir, shoot } = setup(undefined);

    await expect(
      takeBeforeShots({ slug: 'trail-map', screenDir, situations: [], shoot })
    ).rejects.toThrow('--situation');
  });

  it('refuses a situation name that is not a slug', async () => {
    const { screenDir, shoot } = setup('cp fixture.png {out}');

    await expect(
      takeBeforeShots({
        slug: 'trail-map',
        screenDir,
        situations: [{ situation: '../escape', scenarioId: 'trail-map-open' }],
        shoot,
      })
    ).rejects.toThrow(/isn't a situation name/);
  });

  // The same slug rule as canvas, brief and round: a slug they accept must
  // reach the DESIGN FAILED line, never an unexpected throw.
  it('accepts every slug DESIGN_SLUG accepts', async () => {
    const { screenDir, shoot } = setup('exit 1');

    const result = await takeBeforeShots({
      slug: 'trail-',
      screenDir,
      situations: SITUATIONS,
      shoot,
    });

    expect(result.kind).toBe('failed');
    expect(result.kind === 'failed' ? result.line : '').toMatch(
      /^DESIGN FAILED trail-: before shot — trail-map-closed: /
    );
  });

  it('refuses a screen dir outside the pods root, writing nothing', async () => {
    const { root, shoot } = setup('cp fixture.png {out}');
    const stray = path.join(root, 'elsewhere', 'trail-map');
    fs.mkdirSync(stray, { recursive: true });

    await expect(
      takeBeforeShots({
        slug: 'trail-map',
        screenDir: stray,
        situations: SITUATIONS,
        shoot,
      })
    ).rejects.toThrow(/Refusing screen dir/);
    expect(fs.readdirSync(stray)).toEqual([]);
  });
});
