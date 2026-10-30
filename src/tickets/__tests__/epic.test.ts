import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { createTicketSource } from '../context';
import { findEpic, listEpicChildren } from '../epic';
import { createLinearSource } from '../linear';
import { type TicketSource } from '../source';
import { PAWNEE_STATUSES, createLinearFake } from './fakes/linearFake';

const pawnee = (tasks: string, files: Record<string, string>): TicketSource => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-epic-'))
  );
  fs.writeFileSync(path.join(root, 'TASKS.md'), tasks);
  Object.entries(files).forEach(([file, text]) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  });

  return createTicketSource({
    root,
    config: { source: 'markdown', prefix: 'PAWNEE' },
    tokens: undefined,
    env: {},
    fetch: async () => {
      throw new Error('No network call expected.');
    },
    runner: null,
  });
};

const TASKS = [
  '- [ ] PAWNEE-1: Park map page',
  '  - [x] PAWNEE-1a: Map tiles',
  '  - [ ] PAWNEE-1b: Pins for each park',
  '  - [ ] PAWNEE-1c: Ice Town rink layer',
  '  - [B] PAWNEE-1d: Lot 48 overlay (blocked: Ann Perkins is out)',
  '- [ ] PAWNEE-2: Volunteer sign-up form',
  '',
].join('\n');

const FILES = {
  'tickets/PAWNEE-1c.md': '---\nstatus: canceled\n---\n# Ice Town rink layer\n',
};

describe('epics through the ticket interface', () => {
  it('finds an epic with its children in queue order', async () => {
    expect(await findEpic(pawnee(TASKS, FILES), 'PAWNEE-1')).toEqual({
      id: 'PAWNEE-1',
      title: 'Park map page',
      children: ['PAWNEE-1a', 'PAWNEE-1b', 'PAWNEE-1c', 'PAWNEE-1d'],
    });
  });

  it('a lone ticket is an epic with no children', async () => {
    expect(await findEpic(pawnee(TASKS, FILES), 'PAWNEE-2')).toEqual({
      id: 'PAWNEE-2',
      title: 'Volunteer sign-up form',
      children: [],
    });
  });

  it('lists the live children, done and blocked included, canceled ones left out', async () => {
    expect(await listEpicChildren(pawnee(TASKS, FILES), 'PAWNEE-1')).toEqual([
      { id: 'PAWNEE-1a', title: 'Map tiles' },
      { id: 'PAWNEE-1b', title: 'Pins for each park' },
      { id: 'PAWNEE-1d', title: 'Lot 48 overlay' },
    ]);
  });

  it('refuses an unknown epic and a bad id', async () => {
    const source = pawnee(TASKS, FILES);

    await expect(listEpicChildren(source, 'PAWNEE-9')).rejects.toThrow(
      "PAWNEE-9 isn't a ticket I can read."
    );
    await expect(findEpic(source, '../evil')).rejects.toThrow(
      "isn't a ticket id"
    );
  });

  it('lists an epic’s children from one scan of the tracker', async () => {
    const fake = createLinearFake();
    const parkMap = fake.add({
      identifier: 'PAWNEE-1',
      title: 'Park map page',
    });
    fake.add({
      identifier: 'PAWNEE-2',
      title: 'Map tiles',
      parentId: parkMap.id,
      subIssueSortOrder: 1,
    });
    fake.add({
      identifier: 'PAWNEE-3',
      title: 'Pins for each park',
      parentId: parkMap.id,
      subIssueSortOrder: 2,
    });
    const source = createLinearSource({
      root: fs.realpathSync(os.tmpdir()),
      config: { source: 'linear', team: 'PAWNEE', statuses: PAWNEE_STATUSES },
      tokens: { linear: 'lin_api_test' },
      env: {},
      fetch: fake.fetch,
      runner: null,
    });

    expect(await listEpicChildren(source, 'PAWNEE-1')).toEqual([
      { id: 'PAWNEE-2', title: 'Map tiles' },
      { id: 'PAWNEE-3', title: 'Pins for each park' },
    ]);
    expect(fake.operations()).toEqual(['LambdaTeam', 'LambdaIssues']);
  });
});
