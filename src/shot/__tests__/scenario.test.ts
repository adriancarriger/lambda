import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  SCENARIO_ID,
  type ScenarioEntry,
  checkScenarioFile,
  searchScenarios,
} from '..';

const tmp = (): string =>
  fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-scenario-')));

const DESCRIPTION =
  'Ann Perkins is signed in as a park ranger on a Tuesday at 4pm. The Ramsett Park loop trail was just closed for flooding, and she is on the Trail map screen.';

const fields = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: 'Trail map, trail closed',
  description: DESCRIPTION,
  tags: ['trail', 'map'],
  ...extra,
});

const write = (dir: string, name: string, text: string): string => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, text);

  return file;
};

describe('the scenario format', () => {
  it('exports the id pattern', () => {
    expect(SCENARIO_ID.test('trail-map-closed')).toBe(true);
    expect(SCENARIO_ID.test('Trail_map')).toBe(false);
  });

  it('accepts a .scenario.json with every field, viewport defaulting to desktop', () => {
    const dir = tmp();
    const file = write(
      dir,
      'trail-map-closed.scenario.json',
      JSON.stringify(fields('trail-map-closed', { seed: { trails: 1 } }))
    );

    const checked = checkScenarioFile(file);

    expect(checked.problems).toEqual([]);
    expect(checked.scenario).toMatchObject({
      id: 'trail-map-closed',
      title: 'Trail map, trail closed',
      tags: ['trail', 'map'],
      viewport: 'desktop',
    });
  });

  it('reads a lambda-scenario line from a .scenario.ts on line 3', () => {
    const dir = tmp();
    const file = write(
      dir,
      'festival-day.scenario.ts',
      [
        "import { seed } from './seed';",
        '',
        `// lambda-scenario: ${JSON.stringify(
          fields('festival-day', { viewport: 'phone' })
        )}`,
        'export default seed();',
      ].join('\n')
    );

    const checked = checkScenarioFile(file);

    expect(checked.problems).toEqual([]);
    expect(checked.scenario?.viewport).toBe('phone');
  });

  it('refuses the line when it is past the first 20 lines', () => {
    const dir = tmp();
    const file = write(
      dir,
      'festival-day.scenario.ts',
      [
        ...Array.from({ length: 24 }, () => '// filler'),
        `// lambda-scenario: ${JSON.stringify(fields('festival-day'))}`,
      ].join('\n')
    );

    expect(checkScenarioFile(file).problems.join('\n')).toMatch(
      /no line containing lambda-scenario: in its first 20 lines/
    );
  });

  it('refuses a description of 119 characters', () => {
    const dir = tmp();
    const file = write(
      dir,
      'trail-map-closed.scenario.json',
      JSON.stringify(
        fields('trail-map-closed', { description: 'x'.repeat(119) })
      )
    );

    expect(checkScenarioFile(file).problems).toEqual([
      expect.stringMatching(/description is 119 characters/),
    ]);
  });

  it('refuses an id that differs from the file name', () => {
    const dir = tmp();
    const file = write(
      dir,
      'trail-map-closed.scenario.json',
      JSON.stringify(fields('trail-map-open'))
    );

    expect(checkScenarioFile(file).problems).toEqual([
      expect.stringMatching(/id "trail-map-open" isn't the file name's/),
    ]);
  });

  it('names every problem at once', () => {
    const dir = tmp();
    const file = write(
      dir,
      'trail-map-closed.scenario.json',
      JSON.stringify({ id: 'trail-map-closed', tags: [1], viewport: 'tv' })
    );

    const { problems } = checkScenarioFile(file);

    expect(problems).toEqual([
      expect.stringMatching(/title/),
      expect.stringMatching(/description/),
      expect.stringMatching(/tags/),
      expect.stringMatching(/viewport/),
    ]);
  });

  it('refuses a file not named <id>.scenario.<ext>', () => {
    const dir = tmp();
    const file = write(dir, 'trail.json', JSON.stringify(fields('trail')));

    expect(checkScenarioFile(file).problems[0]).toMatch(
      /isn't named <id>\.scenario\.<ext>/
    );
  });
});

describe('searchScenarios', () => {
  const entry = (
    id: string,
    extra: Partial<ScenarioEntry> = {}
  ): ScenarioEntry => ({
    id,
    title: 'A screen',
    description: DESCRIPTION,
    tags: [],
    viewport: 'desktop',
    source: 'tracked',
    file: `/x/${id}.scenario.json`,
    ...extra,
  });

  it('needs every word, ranks title hits first, keeps the label', () => {
    const entries = [
      entry('described', {
        description: `${DESCRIPTION} Festival day, on a phone.`,
      }),
      entry('festival-day', {
        title: 'Home on a festival day',
        tags: ['phone'],
        source: 'pending',
      }),
      entry('only-festival', { title: 'Festival' }),
    ];

    const found = searchScenarios(entries, ['festival', 'PHONE']);

    expect(found.map((one) => [one.id, one.source])).toEqual([
      ['festival-day', 'pending'],
      ['described', 'tracked'],
    ]);
  });
});
