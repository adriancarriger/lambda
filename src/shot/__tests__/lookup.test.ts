import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { type ScenarioRoots, findScenario, listScenarioEntries } from '..';

const tmp = (): string =>
  fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-lookup-')));

const DESCRIPTION =
  'Leslie Knope is signed in as the parks director on a Monday at 9am, with three trail inspections due today for Ann, Ron and April, looking at the home screen.';

const put = (dir: string, id: string, title = id): string => {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.scenario.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({ id, title, description: DESCRIPTION, tags: ['home'] })
  );

  return file;
};

const setup = () => {
  const root = tmp();
  const roots: ScenarioRoots = {
    tracked: path.join(root, '.lambda', 'scenarios'),
    pendingRoot: path.join(root, '.lambda', 'scenarios-pending'),
    podsStore: path.join(root, 'pods', '_scenarios'),
    ext: 'json',
  };
  const a = put(path.join(roots.pendingRoot, 'PAWNEE-9'), 'home-a');
  const b = put(path.join(roots.pendingRoot, 'PAWNEE-9'), 'home-b');
  put(roots.podsStore, 'home-b');
  const c = put(roots.tracked, 'festival-day');
  put(roots.podsStore, 'festival-day');

  return { roots, a, b, c };
};

describe('finding a scenario', () => {
  it('looks in the tracked folder, then pending, then the pods store', () => {
    const { roots, a, b, c } = setup();

    expect(findScenario('home-a', roots)).toMatchObject({
      file: a,
      source: 'pending',
    });
    expect(findScenario('home-b', roots)).toMatchObject({
      file: b,
      source: 'pending',
    });
    expect(findScenario('festival-day', roots)).toMatchObject({
      file: c,
      source: 'tracked',
    });
  });

  it('finds one only the pods store has', () => {
    const { roots } = setup();
    const file = put(roots.podsStore, 'home-plan-only');

    expect(findScenario('home-plan-only', roots)).toMatchObject({
      file,
      source: 'pending',
    });
  });

  it.each(['../x', 'A_B'])('refuses %s before any path is built', (bad) => {
    // Any look at a folder would read these roots first.
    const looked = (): string => {
      throw new Error('a folder was looked at');
    };
    const untouchable: ScenarioRoots = {
      get tracked() {
        return looked();
      },
      get pendingRoot() {
        return looked();
      },
      get podsStore() {
        return looked();
      },
      get ext() {
        return looked();
      },
    };

    expect(() => findScenario(bad, untouchable)).toThrow(/isn't a scenario id/);
  });

  it('suggests the closest known ids for an unknown one', () => {
    const { roots } = setup();

    expect(() => findScenario('sheltr-day', roots)).toThrow(
      /Closest: festival-day/
    );
  });

  it('lists every scenario once, labelled', () => {
    const { roots } = setup();

    expect(
      listScenarioEntries(roots).entries.map((one) => [one.id, one.source])
    ).toEqual([
      ['festival-day', 'tracked'],
      ['home-a', 'pending'],
      ['home-b', 'pending'],
    ]);
  });

  it('lists a broken tracked scenario as broken, not its pending copy', () => {
    const { roots } = setup();
    const broken = path.join(roots.tracked, 'home-a.scenario.json');
    fs.writeFileSync(broken, '{ not json');

    const { entries, broken: found } = listScenarioEntries(roots);

    // `lambda shot home-a` takes the tracked file, so search mustn't offer it.
    expect(entries.map((one) => one.id)).not.toContain('home-a');
    expect(found.map((one) => one.file)).toEqual([broken]);
  });
});
