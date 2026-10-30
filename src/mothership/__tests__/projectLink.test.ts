import * as fs from 'fs';
import * as path from 'path';

import { type Db, openDb } from '../db';
import { addRunner, folderOf, linkProject, projectOfFolder } from '../registry';
import { tempHome } from './harness';

const NOW = Date.UTC(2026, 9, 21, 12);

/** A project folder the person moved or re-cloned is picked up, not lost. */
describe('a runner links a project again from another folder', () => {
  const fixture: { home?: string; db?: Db } = {};

  beforeEach(() => {
    fixture.home = tempHome();
    fixture.db = openDb(path.join(fixture.home, 'mothership.db'));
    addRunner(
      fixture.db,
      { id: 'rnr_macbook', name: "Leslie's MacBook", publicKey: 'unused' },
      NOW
    );
  });

  afterEach(() => {
    fixture.db?.close();

    if (fixture.home !== undefined) {
      fs.rmSync(fixture.home, { recursive: true, force: true });
    }
  });

  const db = (): Db => {
    if (fixture.db === undefined) {
      throw new Error('No database.');
    }

    return fixture.db;
  };

  it('keeps one row, now naming the new folder', () => {
    const link = { runnerId: 'rnr_macbook', name: 'Pawnee Parks site' };
    const projectId = linkProject(
      db(),
      { ...link, folder: '/home/leslie/pawnee-parks' },
      NOW
    );
    linkProject(db(), { ...link, folder: '/home/leslie/code/pawnee' }, NOW);

    const rows = db()
      .prepare('SELECT folder FROM runner_projects WHERE runner_id = ?')
      .all('rnr_macbook');
    expect(rows).toEqual([{ folder: '/home/leslie/code/pawnee' }]);
    expect(folderOf(db(), 'rnr_macbook', projectId)).toBe(
      '/home/leslie/code/pawnee'
    );
    expect(
      projectOfFolder(db(), 'rnr_macbook', '/home/leslie/code/pawnee')
    ).toBe(projectId);
  });
});
