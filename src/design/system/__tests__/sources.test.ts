import { Command } from 'commander';
import * as path from 'path';

import { registerSystemCommands } from '../../../commands/design/system';
import {
  NO_DESIGN_CHANGES,
  type SourceMap,
  checkSourceMap,
  designChanges,
  formatDesignChanges,
  parseSourceMap,
  shapeMessage,
  ticketChanges,
} from '../sources';
import { HAND_MADE_SOURCES } from './fixtures/handMade';
import { commitAll, initRepo, put, run, tmpDir } from './gitFixture';

const DIR = '.lambda/design-system';

describe('parseSourceMap', () => {
  it("parses a hand-made design system's map: Lambda's map has its shape", () => {
    const map = parseSourceMap(HAND_MADE_SOURCES, 'apps/festival/kit');

    expect(map.system).toContain('apps/festival/kit/');
    expect(map.patterns['TrailMap.tsx']).toHaveLength(4);
    expect(Object.keys(map.components)).toEqual([
      'StallTag',
      'MapLegend',
      'VolunteerChip',
    ]);
  });

  it.each([
    ['missing patterns', { system: [], tokens: [], components: {} }],
    [
      'a pattern mapped to a string',
      {
        system: [],
        tokens: [],
        components: {},
        patterns: { 'MapView.tsx': 'src/x.tsx' },
      },
    ],
    [
      'a components list',
      { system: [], tokens: [], components: ['ParkCard'], patterns: {} },
    ],
    [
      'tokens of numbers',
      { system: [], tokens: [1], components: {}, patterns: {} },
    ],
    ['not an object', null],
  ])('refuses %s with the exact shape message', (_, raw) => {
    expect(() => parseSourceMap(raw, DIR)).toThrow(shapeMessage(DIR));
    expect(shapeMessage(DIR)).toBe(
      '.lambda/design-system/sources.json must hold system and tokens (path lists), components ({name: path}) and patterns ({file: path list}).'
    );
  });

  // git names changed files plainly, so these would never match one.
  it.each([
    ['../app/theme.ts'],
    ['/etc/theme.ts'],
    ['./src/theme.ts'],
    ['src//theme.ts'],
    ['src/./theme.ts'],
  ])('refuses a path outside the project: %s', (outside) => {
    expect(() =>
      parseSourceMap(
        { system: [], tokens: [outside], components: {}, patterns: {} },
        DIR
      )
    ).toThrow(
      `${DIR}/sources.json: ${outside} must be a path inside the project.`
    );
  });
});

const MAP: SourceMap = {
  system: [`${DIR}/`],
  tokens: ['src/theme.ts'],
  components: { ParkCard: 'src/components/ParkCard.tsx' },
  patterns: {
    'MapView.tsx': ['src/features/map/MapView.tsx', 'src/features/map/pins/'],
  },
};

describe('designChanges and formatDesignChanges', () => {
  it('names each kind of hit, and nothing for tests or files the map does not name', () => {
    const lines = formatDesignChanges(
      designChanges(MAP, [
        'src/theme.ts',
        'src/components/ParkCard.tsx',
        'src/features/map/MapView.tsx',
        `${DIR}/catalog.ts`,
        'src/components/ParkCard.test.tsx',
        `${DIR}/__tests__/catalog.spec.ts`,
        'README.md',
      ])
    );

    expect(lines).toEqual([
      'rebuild only     theme   src/theme.ts',
      'rebuild only     component ParkCard  ← src/components/ParkCard.tsx',
      `rebuild only     system  ${DIR}/catalog.ts`,
      'update the copy  pattern MapView.tsx  ← src/features/map/MapView.tsx',
    ]);
  });

  it("matches a pattern's folder entry, listing every changed file it copies", () => {
    expect(
      formatDesignChanges(
        designChanges(MAP, [
          'src/features/map/pins/Pin.tsx',
          'src/features/map/MapView.tsx',
          'src/features/map/pins/Pin.tsx',
        ])
      )
    ).toEqual([
      'update the copy  pattern MapView.tsx  ← src/features/map/MapView.tsx, src/features/map/pins/Pin.tsx',
    ]);
  });

  it('a folder entry never matches a sibling that only shares its prefix', () => {
    expect(
      formatDesignChanges(
        designChanges(MAP, ['src/features/map/pinsOld.tsx', `${DIR}-old/x.ts`])
      )
    ).toEqual([NO_DESIGN_CHANGES]);
  });

  it("matches a component's folder entry on a changed file inside it", () => {
    expect(
      formatDesignChanges(
        designChanges(
          { ...MAP, components: { Avatar: 'src/components/Avatar/' } },
          ['src/components/Avatar/Avatar.tsx', 'src/components/AvatarOld.tsx']
        )
      )
    ).toEqual([
      'rebuild only     component Avatar  ← src/components/Avatar/Avatar.tsx',
    ]);
  });

  it('an empty diff is NO DESIGN CHANGES', () => {
    expect(formatDesignChanges(designChanges(MAP, []))).toEqual([
      'NO DESIGN CHANGES',
    ]);
  });
});

/**
 * main with the app and a design system, a ticket branch with one committed
 * change, and main moved on after the branch (not the ticket's).
 */
const ticketRepo = (options: { manifest?: boolean } = {}): string => {
  const root = initRepo();
  put(root, 'lambda.json', JSON.stringify({ name: 'Pawnee parks map' }));
  put(root, 'src/theme.ts', 'export const theme = {};\n');
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
  put(
    root,
    'src/features/benches/BenchRow.tsx',
    'export const BenchRow = () => null;\n'
  );
  put(root, 'README.md', '# Pawnee parks map\n');
  put(root, `${DIR}/sources.json`, JSON.stringify(MAP));
  put(
    root,
    `${DIR}/index.tsx`,
    "export { ParkCard } from '../../src/components/ParkCard';\n"
  );

  if (options.manifest !== false) {
    put(
      root,
      `${DIR}/design-system.json`,
      JSON.stringify({ namespace: 'PawneeParksMap', version: 1 })
    );
  }

  commitAll(root, 'Pawnee parks map');
  run(root, ['checkout', '-q', '-b', 'pawnee-31']);
  put(root, 'src/theme.ts', "export const theme = { green: '#2e7d32' };\n");
  commitAll(root, 'PAWNEE-31: greener parks');
  run(root, ['checkout', '-q', 'main']);
  put(
    root,
    'src/features/benches/BenchRow.tsx',
    'export const BenchRow = () => 1;\n'
  );
  commitAll(root, 'PAWNEE-30: on main after the branch');
  run(root, ['checkout', '-q', 'pawnee-31']);
  // Staged, unstaged and untracked.
  put(
    root,
    'src/components/ParkCard.tsx',
    'export const ParkCard = () => 1;\n'
  );
  run(root, ['add', 'src/components/ParkCard.tsx']);
  put(
    root,
    'src/features/map/MapView.tsx',
    'export const MapView = () => 1;\n'
  );
  put(
    root,
    'src/features/map/pins/Pin.tsx',
    'export const Pin = () => null;\n'
  );

  return root;
};

describe('ticketChanges', () => {
  it('counts committed changes since the merge base, plus staged, unstaged and untracked files', () => {
    const root = ticketRepo();

    expect(ticketChanges(root, 'main')).toEqual([
      'src/components/ParkCard.tsx',
      'src/features/map/MapView.tsx',
      'src/features/map/pins/Pin.tsx',
      'src/theme.ts',
    ]);
  });

  it('counts both paths of a renamed file', () => {
    const root = ticketRepo();
    run(root, [
      'mv',
      'src/features/benches/BenchRow.tsx',
      'src/features/benches/Bench.tsx',
    ]);

    expect(ticketChanges(root, 'main')).toEqual(
      expect.arrayContaining([
        'src/features/benches/Bench.tsx',
        'src/features/benches/BenchRow.tsx',
      ])
    );
  });
});

describe('lambda design system changed', () => {
  const runCli = async (cwd: string, args: string[]): Promise<string[]> => {
    const printed: string[] = [];
    const log = jest
      .spyOn(console, 'log')
      .mockImplementation((line: unknown) => {
        printed.splice(printed.length, 0, String(line));
      });
    const error = jest
      .spyOn(console, 'error')
      .mockImplementation((line: unknown) => {
        printed.splice(printed.length, 0, `error: ${String(line)}`);
      });
    const savedCwd = process.cwd();
    const savedExit = process.exitCode;

    try {
      process.chdir(cwd);
      const program = new Command('lambda').exitOverride();
      registerSystemCommands(program.command('design'));
      await program.parseAsync(['design', 'system', 'changed', ...args], {
        from: 'user',
      });

      return [...printed, `exit ${process.exitCode ?? 0}`];
    } finally {
      process.chdir(savedCwd);
      log.mockRestore();
      error.mockRestore();
      process.exitCode = savedExit;
    }
  };

  it("prints one line per hit over the ticket's changes", async () => {
    const root = ticketRepo();

    expect(await runCli(root, ['--base', 'main'])).toEqual([
      'rebuild only     theme   src/theme.ts',
      'rebuild only     component ParkCard  ← src/components/ParkCard.tsx',
      'update the copy  pattern MapView.tsx  ← src/features/map/MapView.tsx, src/features/map/pins/Pin.tsx',
      'exit 0',
    ]);
  });

  it('exits 1 naming a base that is not a commit here', async () => {
    const root = ticketRepo();

    expect(await runCli(root, ['--base', 'nope/main'])).toEqual([
      expect.stringContaining('nope/main'),
      'exit 1',
    ]);
  });

  it('reads a project in a subfolder of its repo', async () => {
    const top = initRepo();
    const root = path.join(top, 'apps', 'parks');
    put(root, 'lambda.json', JSON.stringify({ name: 'Pawnee parks map' }));
    put(root, 'src/theme.ts', 'export const theme = {};\n');
    put(root, `${DIR}/sources.json`, JSON.stringify(MAP));
    put(
      root,
      `${DIR}/design-system.json`,
      JSON.stringify({ namespace: 'PawneeParksMap', version: 1 })
    );
    commitAll(top, 'Pawnee parks map');
    run(top, ['checkout', '-q', '-b', 'pawnee-31']);
    put(root, 'src/theme.ts', "export const theme = { green: '#2e7d32' };\n");
    commitAll(top, 'PAWNEE-31: greener parks');

    expect(await runCli(root, ['--base', 'main'])).toEqual([
      'rebuild only     theme   src/theme.ts',
      'exit 0',
    ]);
  });

  it('prints only the no-design-system line, exit 0, with no manifest on the base', async () => {
    const root = ticketRepo({ manifest: false });

    expect(await runCli(root, ['--base', 'main'])).toEqual([
      'This project has no design system yet (.lambda/design-system/design-system.json).',
      'exit 0',
    ]);
  });
});

describe('checkSourceMap: the map test', () => {
  const mapRepo = (map: object, index: string): string => {
    const root = tmpDir('lambda-ds-map-');
    put(root, 'src/theme.ts', 'export const theme = {};\n');
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
    put(
      root,
      `${DIR}/patterns/MapView.tsx`,
      'export const MapView = () => null;\n'
    );
    put(root, `${DIR}/index.tsx`, index);
    put(root, `${DIR}/sources.json`, JSON.stringify(map));

    return root;
  };
  const GOOD = {
    system: [`${DIR}/`],
    tokens: ['src/theme.ts'],
    components: { ParkCard: 'src/components/ParkCard.tsx' },
    patterns: { 'MapView.tsx': ['src/features/map/MapView.tsx'] },
  };
  const INDEX = [
    "export { ParkCard } from '../../src/components/ParkCard';",
    "export { MapView as Map, type MapProps } from './patterns/MapView';",
    'export const Root = () => null;',
    '',
  ].join('\n');

  it('passes a map that holds', () => {
    expect(checkSourceMap(mapRepo(GOOD, INDEX), DIR)).toEqual([]);
  });

  it('names a pattern file with no entry', () => {
    const root = mapRepo(GOOD, INDEX);
    put(
      root,
      `${DIR}/patterns/BenchRow.tsx`,
      'export const BenchRow = () => null;\n'
    );

    expect(checkSourceMap(root, DIR)).toEqual([
      'patterns/BenchRow.tsx has no entry in sources.json patterns.',
    ]);
  });

  it('names an entry that copies no file', () => {
    expect(
      checkSourceMap(
        mapRepo({ ...GOOD, patterns: { 'MapView.tsx': [] } }, INDEX),
        DIR
      )
    ).toEqual(['patterns.MapView.tsx copies no file.']);
  });

  it('names an entry naming a missing file', () => {
    expect(
      checkSourceMap(
        mapRepo(
          {
            ...GOOD,
            patterns: { 'MapView.tsx': ['src/features/map/Gone.tsx'] },
          },
          INDEX
        ),
        DIR
      )
    ).toEqual([
      'patterns.MapView.tsx: src/features/map/Gone.tsx is not a file.',
    ]);
  });

  it('names a / entry that is a file, and a file entry that is a folder', () => {
    expect(
      checkSourceMap(
        mapRepo(
          {
            ...GOOD,
            system: [`${DIR}/`, 'src/theme.ts/'],
            tokens: ['src/features/map'],
          },
          INDEX
        ),
        DIR
      )
    ).toEqual([
      'system: src/theme.ts/ is not a folder.',
      'tokens: src/features/map is not a file.',
    ]);
  });

  it('sees names re-exported with export * from a relative module, one level', () => {
    const root = mapRepo(
      {
        ...GOOD,
        components: {
          ...GOOD.components,
          MapView: 'src/features/map/MapView.tsx',
        },
      },
      [
        "export * from '../../src/components/ParkCard';",
        "export * from './patterns/MapView';",
        "export * from 'some-package';",
        '',
      ].join('\n')
    );

    expect(checkSourceMap(root, DIR)).toEqual([]);
  });

  it('never counts export { type Foo as Bar } as a value export', () => {
    const root = mapRepo(
      GOOD,
      "export { type ParkCardProps as ParkCard } from '../../src/components/ParkCard';\n"
    );

    expect(checkSourceMap(root, DIR)).toEqual([
      'components.ParkCard is not exported from index.tsx.',
    ]);
  });

  it('names a components name not exported from index.tsx', () => {
    const root = mapRepo(
      {
        ...GOOD,
        components: {
          ...GOOD.components,
          MapView: 'src/features/map/MapView.tsx',
        },
      },
      INDEX
    );

    expect(checkSourceMap(root, DIR)).toEqual([
      'components.MapView is not exported from index.tsx.',
    ]);
  });
});
