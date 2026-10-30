import * as fs from 'fs';
import * as path from 'path';

import {
  type Project,
  ProjectConfigSchema,
} from '../../../config/projectConfig';
import { manifestText } from '../manifest';
import { outsideMessage, writeSetupManifest } from '../manifestWrite';
import { commitAll, initRepo, put, run, tmpDir } from './gitFixture';

const DIR = '.lambda/design-system';
const MANIFEST = `${DIR}/design-system.json`;

const projectAt = (root: string): Project => ({
  root,
  file: path.join(root, 'lambda.json'),
  config: ProjectConfigSchema.parse({}),
});

/** The app as it is on main before the setup ticket. */
const appAtBase = (
  extra: Record<string, string> = {}
): { root: string; base: string } => {
  const root = initRepo();
  put(root, '.gitignore', 'node_modules/\n');
  put(root, 'package.json', '{ "name": "pawnee-parks-map" }\n');
  put(
    root,
    'src/components/ParkCard.tsx',
    'export const ParkCard = () => null;\n'
  );
  put(
    root,
    'src/features/map/MapView.tsx',
    'export const MapView = () => null;\n'
  );
  Object.entries(extra).forEach(([rel, body]) => put(root, rel, body));
  const base = commitAll(root, 'Pawnee parks map');
  // The setup ticket's own branch, so main stays its base.
  run(root, ['checkout', '-q', '-b', 'pawnee-12']);

  return { root, base };
};

/** What the setup writes: only files inside the design system. */
const writeDesignSystem = (root: string): void => {
  put(
    root,
    `${DIR}/index.tsx`,
    "export { ParkCard } from '../../src/components/ParkCard';\nexport { MapView } from './patterns/MapView';\n"
  );
  put(root, `${DIR}/catalog.ts`, 'export const catalog = {};\n');
  put(
    root,
    `${DIR}/sampleData.ts`,
    "export const sampleData = { parks: [{ name: 'Ramsett Park' }] };\n"
  );
  put(
    root,
    `${DIR}/patterns/MapView.tsx`,
    '// Copies src/features/map/MapView.tsx\nexport const MapView = () => null;\n'
  );
  put(
    root,
    `${DIR}/sources.json`,
    JSON.stringify({
      system: [`${DIR}/`],
      tokens: [],
      components: { ParkCard: 'src/components/ParkCard.tsx' },
      patterns: { 'MapView.tsx': ['src/features/map/MapView.tsx'] },
    })
  );
  put(
    root,
    `${DIR}/screens/index.ts`,
    [
      'export const SCREENS = [',
      "  { file: 'ParksList.dc.html', title: 'Parks list', route: '/parks' },",
      "  { file: 'ParkPage.dc.html', title: 'Park page', route: '/parks/1' },",
      '];',
      '',
    ].join('\n')
  );
  put(root, `${DIR}/screens/ParksList.dc.html`, '<div data-screen></div>\n');
  put(root, `${DIR}/screens/ParkPage.dc.html`, '<div data-screen></div>\n');
};

const picture = (scenarioId: string, severities: string[]) => ({
  scenarioId,
  photo: `/pods/pawnee-setup/design-system/photos/${scenarioId}.png`,
  drawn: `/pods/pawnee-setup/design-system/round-4/${scenarioId}.png`,
  issues: severities.map((severity) => ({
    severity,
    where: 'Buttons',
    what: `corners differ (${severity})`,
  })),
});

/** The last round's pictures for each result, as the stop rule decides it. */
const LAST_PICTURES = {
  MATCH: [picture('parks-list', ['low']), picture('park-page', ['low'])],
  CLOSE: [
    picture('parks-list', ['low']),
    picture('park-page', ['low', 'medium-low']),
  ],
  BLOCKED: [picture('parks-list', ['high']), picture('park-page', ['low'])],
};

/**
 * A rounds.json as round record writes it, ending in `last` (round 4, or
 * round 7 for BLOCKED). `pictures` overrides the last round's pictures, to
 * forge a result its issues don't give.
 */
const roundsFile = (
  last: 'CLOSE' | 'MATCH' | 'BLOCKED',
  pictures = LAST_PICTURES[last]
): string => {
  const file = path.join(tmpDir('lambda-ds-rounds-'), 'rounds.json');
  const rounds = last === 'BLOCKED' ? 7 : 4;
  const continuing = Array.from({ length: rounds - 1 }, (_, index) => ({
    round: index + 1,
    pictures: [picture('parks-list', ['high'])],
    result: 'CONTINUE',
  }));
  fs.writeFileSync(
    file,
    JSON.stringify([...continuing, { round: rounds, pictures, result: last }])
  );

  return file;
};

const write = (
  root: string,
  overrides: { roundsFile?: string; notChecked?: string } = {}
) =>
  writeSetupManifest({
    project: projectAt(root),
    projectName: 'Pawnee parks map',
    checkout: root,
    base: 'main',
    ticketId: 'PAWNEE-12',
    ...overrides,
  });

const manifestOf = (root: string): string | null => {
  const file = path.join(root, MANIFEST);

  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
};

const refusal = async (promise: Promise<unknown>): Promise<string> => {
  const outcome = await promise.then(
    () => undefined,
    (error: unknown) => error
  );

  if (!(outcome instanceof Error)) {
    throw new Error('Expected manifest write to refuse.');
  }

  return outcome.message;
};

describe('manifest write: one direction', () => {
  it('writes the manifest when the setup changed only the design system', async () => {
    const { root, base } = appAtBase();
    writeDesignSystem(root);

    const { file, manifest } = await write(root, {
      roundsFile: roundsFile('CLOSE'),
    });

    expect(file).toBe(path.join(root, MANIFEST));
    expect(JSON.parse(manifestOf(root) ?? 'null')).toEqual(manifest);
    expect(manifest).toEqual({
      namespace: 'PawneeParksMap',
      version: 1,
      builtFrom: base,
      syncedBy: 'PAWNEE-12',
      source: 'code+photos',
      check: {
        result: 'close',
        rounds: 4,
        photos: 2,
        issues: [
          {
            severity: 'medium-low',
            where: 'Buttons',
            what: 'corners differ (medium-low)',
          },
          { severity: 'low', where: 'Buttons', what: 'corners differ (low)' },
          { severity: 'low', where: 'Buttons', what: 'corners differ (low)' },
        ],
      },
      components: ['ParkCard'],
      patterns: ['MapView'],
      screens: ['Parks list', 'Park page'],
      leftOut: [],
    });
    expect(manifest).not.toHaveProperty('fingerprint');
  });

  it('records MATCH, and a design system staged but not committed still counts as inside', async () => {
    const { root } = appAtBase();
    writeDesignSystem(root);
    run(root, ['add', DIR]);

    const { manifest } = await write(root, { roundsFile: roundsFile('MATCH') });

    expect(manifest.check).toMatchObject({ result: 'match', rounds: 4 });
  });

  it('records not-checked with its reason when there were no rounds', async () => {
    const { root } = appAtBase();
    writeDesignSystem(root);
    const reason = 'there are no screenshot scenarios to photograph yet';

    const { manifest } = await write(root, { notChecked: reason });

    expect(manifest.check).toEqual({
      result: 'not-checked',
      rounds: 0,
      photos: 0,
      issues: [],
      reason,
    });
    expect(manifest.source).toBe('code');
  });

  it('records source photos for a design system made from photos only', async () => {
    const { root } = appAtBase();
    put(root, `${DIR}/tokens.photos.json`, '{}\n');

    const { manifest } = await write(root, { roundsFile: roundsFile('CLOSE') });

    expect(manifest).toMatchObject({
      source: 'photos',
      components: [],
      patterns: [],
      screens: [],
    });
  });

  it('bumps the version and keeps the namespace of a manifest already there', async () => {
    const { root } = appAtBase({
      [MANIFEST]: manifestText({
        namespace: 'Pawnee',
        version: 1,
        leftOut: [{ name: 'MapView', why: 'loads mapbox-gl' }],
      }),
    });
    writeDesignSystem(root);

    const { manifest } = await write(root, { roundsFile: roundsFile('CLOSE') });

    expect(manifest).toMatchObject({
      namespace: 'Pawnee',
      version: 2,
      leftOut: [{ name: 'MapView', why: 'loads mapbox-gl' }],
    });
    expect(Object.keys(manifest).slice(0, 3)).toEqual([
      'namespace',
      'version',
      'leftOut',
    ]);
  });

  it("keeps the working tree's namespace when the base has no manifest yet", async () => {
    const { root } = appAtBase();
    writeDesignSystem(root);
    put(root, MANIFEST, manifestText({ namespace: 'Parks' }));

    const { manifest } = await write(root, { roundsFile: roundsFile('CLOSE') });

    expect(manifest).toMatchObject({ namespace: 'Parks', version: 1 });
  });

  it.each([
    [
      'an edit to an app file',
      (root: string) =>
        put(
          root,
          'src/components/ParkCard.tsx',
          'export const ParkCard = () => 1;\n'
        ),
      'src/components/ParkCard.tsx',
    ],
    [
      'a new untracked app file',
      (root: string) => put(root, 'src/x.ts', 'export {};\n'),
      'src/x.ts',
    ],
    [
      'a committed app change',
      (root: string) => {
        put(
          root,
          'src/features/map/MapView.tsx',
          'export const MapView = () => 1;\n'
        );
        commitAll(root, 'PAWNEE-12: tweak the map');
      },
      'src/features/map/MapView.tsx',
    ],
  ])(
    'refuses %s, naming the path, with the manifest unchanged',
    async (_, change, changed) => {
      const { root } = appAtBase();
      writeDesignSystem(root);
      change(root);

      expect(
        await refusal(write(root, { roundsFile: roundsFile('CLOSE') }))
      ).toBe(outsideMessage([changed]));
      expect(outsideMessage([changed])).toBe(
        `This ticket changed files outside the design system: ${changed}. Making the design system only pulls from the app into the design system.`
      );
      expect(manifestOf(root)).toBeNull();
    }
  );

  it('refuses a rounds file that ends in BLOCKED', async () => {
    const { root } = appAtBase();
    writeDesignSystem(root);

    expect(
      await refusal(write(root, { roundsFile: roundsFile('BLOCKED') }))
    ).toContain("doesn't end in MATCH or CLOSE (its last round is BLOCKED)");
    expect(manifestOf(root)).toBeNull();
  });

  it("refuses a last round whose written result its issues don't give", async () => {
    const { root } = appAtBase();
    writeDesignSystem(root);

    expect(
      await refusal(
        write(root, {
          roundsFile: roundsFile('MATCH', [picture('parks-list', ['high'])]),
        })
      )
    ).toContain("doesn't end in MATCH or CLOSE (its last round is CONTINUE)");
    expect(manifestOf(root)).toBeNull();
  });

  it('refuses a rounds file that is not JSON, naming it', async () => {
    const { root } = appAtBase();
    writeDesignSystem(root);
    const file = roundsFile('MATCH');
    fs.writeFileSync(file, '[{ "pictures": ');

    expect(await refusal(write(root, { roundsFile: file }))).toMatch(
      new RegExp(
        `^${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} is not valid JSON: `
      )
    );
    expect(manifestOf(root)).toBeNull();
  });

  it('refuses with neither rounds nor a not-checked reason', async () => {
    const { root } = appAtBase();
    writeDesignSystem(root);

    expect(await refusal(write(root))).toContain(
      'manifest write needs --rounds'
    );
    expect(manifestOf(root)).toBeNull();
  });
});

describe('manifest write: what git reports', () => {
  it('refuses an app file moved into the design system, naming the app path', async () => {
    const { root } = appAtBase();
    writeDesignSystem(root);
    run(root, ['mv', 'src/components/ParkCard.tsx', `${DIR}/ParkCard.tsx`]);

    expect(
      await refusal(write(root, { roundsFile: roundsFile('CLOSE') }))
    ).toBe(outsideMessage(['src/components/ParkCard.tsx']));
    expect(manifestOf(root)).toBeNull();
  });

  it('counts a design system file with a non-ASCII name as inside', async () => {
    const { root } = appAtBase();
    writeDesignSystem(root);
    put(root, `${DIR}/patterns/Café.tsx`, 'export const Cafe = () => null;\n');

    const { manifest } = await write(root, { roundsFile: roundsFile('CLOSE') });

    expect(manifest.version).toBe(1);
  });

  it('takes the version from the base, so writing twice in one setup is still version 1', async () => {
    const { root } = appAtBase();
    writeDesignSystem(root);

    await write(root, { roundsFile: roundsFile('CLOSE') });
    const { manifest } = await write(root, { roundsFile: roundsFile('CLOSE') });

    expect(manifest.version).toBe(1);
  });
});

describe('manifest write: a project in a subfolder of its repo', () => {
  const PARKS = 'apps/parks';

  /** The repo on main: the parks app under apps/parks, a library beside it. */
  const subfolderAtBase = (): { root: string; project: string } => {
    const root = initRepo();
    put(root, 'libs/ui/Button.tsx', 'export const Button = () => null;\n');
    put(
      root,
      `${PARKS}/src/components/ParkCard.tsx`,
      'export const ParkCard = () => null;\n'
    );
    commitAll(root, 'Pawnee parks map');
    run(root, ['checkout', '-q', '-b', 'pawnee-12']);
    const project = path.join(root, PARKS);
    put(project, `${DIR}/index.tsx`, 'export {};\n');
    commitAll(root, 'PAWNEE-12: the design system');

    return { root, project };
  };

  it('writes the manifest when the setup changed only the design system', async () => {
    const { project } = subfolderAtBase();

    const { manifest } = await write(project, { notChecked: 'no photos' });

    expect(manifest.version).toBe(1);
  });

  it.each([
    [
      'an app file inside the subfolder',
      (root: string) => put(root, `${PARKS}/src/x.ts`, 'export {};\n'),
      `${PARKS}/src/x.ts`,
    ],
    [
      'a file outside the subfolder',
      (root: string) =>
        put(root, 'libs/ui/Button.tsx', 'export const Button = () => 1;\n'),
      'libs/ui/Button.tsx',
    ],
    [
      'an untracked file outside the subfolder',
      (root: string) => put(root, 'libs/ui/Link.tsx', 'export {};\n'),
      'libs/ui/Link.tsx',
    ],
  ])('refuses %s, naming it', async (_, change, changed) => {
    const { root, project } = subfolderAtBase();
    change(root);

    expect(await refusal(write(project, { notChecked: 'no photos' }))).toBe(
      outsideMessage([changed])
    );
  });
});
