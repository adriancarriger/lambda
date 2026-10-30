import * as fs from 'fs';
import * as path from 'path';

import { assertPlainData, buildSystem } from '../build';
import {
  DIR,
  NAMESPACE,
  PROJECT_NAME,
  type Repo,
  SAMPLE_DATA,
  type ScreenFixture,
  makeRepo,
  parksApp,
  quiet,
  read,
  rejection,
  screenFiles,
  tmp,
  useReactRuntime,
} from './buildFixture';

// Real Chromium, one launch per screen.
jest.setTimeout(120_000);

const PARK_MAP: ScreenFixture = {
  file: 'ParkMap.dc.html',
  title: 'Park map',
  clicks: ['open-park'],
};
const BENCHES: ScreenFixture = {
  file: 'BenchList.dc.html',
  title: 'Bench list',
  situations: ['list'],
};

describe('the reference screens', () => {
  const runtime = { restore: () => {} };
  const fixture: { repo?: Repo } = {};

  beforeAll(() => {
    runtime.restore = useReactRuntime().restore;
    const repo = makeRepo({
      ...parksApp(),
      ...screenFiles([PARK_MAP, BENCHES]),
    });
    repo.commit('Pawnee parks map design system');
    fixture.repo = repo;
  });

  afterAll(() => {
    runtime.restore();
  });

  const repoOf = (): Repo => {
    if (fixture.repo === undefined) {
      throw new Error('The fixture repo was not made.');
    }

    return fixture.repo;
  };

  /** Build the working tree with its screens rewritten (put back after); the build's error. */
  const failingBuild = async (screens: ScreenFixture[]): Promise<Error> => {
    const repo = repoOf();
    const out = path.join(tmp('lambda-ds-out-'), 'system');
    repo.write(screenFiles(screens));

    try {
      const error = await rejection(
        buildSystem({
          project: repo.project(),
          projectName: PROJECT_NAME,
          checkout: repo.root,
          out,
          workingTree: true,
          log: quiet,
        })
      );
      expect(fs.existsSync(out)).toBe(false);

      return error;
    } finally {
      repo.git(['checkout', '--', DIR]);
      repo.git(['clean', '-fdq', '--', DIR]);
    }
  };

  it('copies both screens as written, sets the sample data and writes the Screens page', async () => {
    const repo = repoOf();
    const out = path.join(tmp('lambda-ds-out-'), 'system');
    await buildSystem({
      project: repo.project(),
      projectName: PROJECT_NAME,
      checkout: repo.root,
      out,
      log: quiet,
    });

    [PARK_MAP, BENCHES].forEach(({ file }) =>
      expect(read(out, `project/screens/${file}`)).toBe(
        read(repo.root, `${DIR}/screens/${file}`)
      )
    );

    const sample = read(out, 'project/sample-data.js');
    expect(sample).toContain(
      `window.${NAMESPACE}Sample = ${JSON.stringify(SAMPLE_DATA)};`
    );

    const page = read(out, 'project/Screens.md');
    expect(page).toContain('## Park map');
    expect(page).toContain('## Bench list');
    expect(page.match(/!\[[^\]]+\]\(data:image\/jpeg;base64,/g)).toHaveLength(
      2
    );
    expect(Buffer.byteLength(page)).toBeLessThanOrEqual(200 * 1024);
    expect(read(out, 'project/README.md')).toContain(
      '`screens/ParkMap.dc.html` — Park map (`/parkmap`)'
    );
  });

  it.each<[string, ScreenFixture, string]>([
    [
      'a screen that throws',
      {
        ...PARK_MAP,
        script: "throw new Error('Jerry spilled coffee on the map');",
      },
      'ParkMap.dc.html, situation list: The artboard threw: Jerry spilled coffee on the map',
    ],
    [
      'a screen with no [data-screen]',
      { ...PARK_MAP, noScreen: true },
      'ParkMap.dc.html, situation list: it needs exactly one [data-screen], not 0',
    ],
    [
      'a situation with no [data-state]',
      { ...PARK_MAP, situations: ['list', 'closed'], drawnStates: ['list'] },
      'ParkMap.dc.html, situation closed: it has no [data-state="closed"]',
    ],
    [
      'a path click whose [data-target] is missing',
      { ...PARK_MAP, clicks: ['open-bench'], drawnTargets: [] },
      'ParkMap.dc.html, step "Open open-bench": it has no [data-target="open-bench"]',
    ],
    [
      'a 1440×900 screen whose bench situation is 960 high',
      { ...PARK_MAP, benchHeight: 960 },
      "ParkMap.dc.html, situation bench: the window scrolls (0px across, 60px down): the page must scroll inside the app's frame, never the window",
    ],
    [
      'a screen sized 1280×800',
      { ...PARK_MAP, width: 1280, height: 800 },
      'ParkMap.dc.html, situation list: its [data-screen] is 1280px wide, not one window of 1440×900',
    ],
    [
      'a full-width screen only 800 high',
      { ...PARK_MAP, height: 800 },
      'ParkMap.dc.html, situation list: its [data-screen] ends 800px down, not at the bottom of one window of 1440×900',
    ],
  ])(
    'fails the build on %s, naming the screen and the rule',
    async (_label, screen, message) => {
      const error = await failingBuild([screen, BENCHES]);

      expect(error.message).toBe(message);
    }
  );

  it.each([
    [
      'a function',
      'export const sample = { director: "Leslie Knope", greet: () => "hi" };\n',
      'greet is a function',
    ],
    [
      'a Date',
      'export const sample = { opens: new Date(0) };\n',
      'opens is a Date',
    ],
  ])(
    'refuses sampleData.ts exporting %s with the exact message',
    async (_label, body, what) => {
      const repo = repoOf();
      const out = path.join(tmp('lambda-ds-out-'), 'system');
      repo.write({ [`${DIR}/sampleData.ts`]: body });

      try {
        const error = await rejection(
          buildSystem({
            project: repo.project(),
            projectName: PROJECT_NAME,
            checkout: repo.root,
            out,
            workingTree: true,
            log: quiet,
          })
        );

        expect(error.message).toBe(
          `sampleData.ts must export one plain data object: ${what}.`
        );
        expect(fs.existsSync(out)).toBe(false);
      } finally {
        repo.git(['checkout', '--', DIR]);
      }
    }
  );
});

describe('assertPlainData', () => {
  it('passes plain JSON and names the first non-plain key', () => {
    expect(() => assertPlainData(SAMPLE_DATA)).not.toThrow();
    expect(() =>
      assertPlainData({ parks: [{ name: 'Ramsett Park', at: new Date(0) }] })
    ).toThrow(
      'sampleData.ts must export one plain data object: parks[0].at is a Date.'
    );
    expect(() => assertPlainData({ benches: new Map() })).toThrow(
      'sampleData.ts must export one plain data object: benches is a Map.'
    );
  });
});
