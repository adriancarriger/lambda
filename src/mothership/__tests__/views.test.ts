import { required } from '../../__tests__/required';
import { type SavedView as StoredView, createView } from '../views';
import {
  type FakeRunner,
  type Harness,
  connectRunner,
  holdProject,
  startHarness,
} from './harness';

/**
 * Saved views and favorites: kept on the mothership, each its owner's (a
 * personal view is theirs alone), and imported from a codebase's tracker
 * through the computer holding it — updated in place when imported again.
 */

const PARKS = '/home/leslie/pawnee-parks';

/** A view as the list sends it: whether it's the signed-in owner's own. */
type SavedView = StoredView & { mine?: boolean };

interface Ok<T> {
  ok: true;
  result: T;
}

describe('saved views and favorites', () => {
  const fixture: {
    harness?: Harness;
    laptop?: FakeRunner;
    parks?: string;
    cookie?: string;
  } = {};
  const harness = (): Harness => required(fixture.harness, 'harness');
  const laptop = (): FakeRunner => required(fixture.laptop, 'laptop');
  const parks = (): string => required(fixture.parks, 'parks');
  const cookie = (): string => required(fixture.cookie, 'cookie');

  const post = async <T>(path: string, body: unknown): Promise<T> => {
    const response = await harness().request('POST', path, {
      cookie: cookie(),
      body: JSON.stringify(body),
    });

    if (response.status !== 200) {
      throw new Error(`${path}: ${response.status} ${response.text}`);
    }

    return response.json<Ok<T>>().result;
  };

  const get = async <T>(path: string): Promise<T> => {
    const response = await harness().request('GET', path, {
      cookie: cookie(),
    });

    return response.json<Ok<T>>().result;
  };

  beforeEach(async () => {
    fixture.harness = await startHarness();
    fixture.laptop = await connectRunner(harness(), {
      name: "Leslie's MacBook",
    });
    await laptop().next('owner');
    fixture.parks = holdProject(harness(), laptop().runnerId, {
      folder: PARKS,
    });
    fixture.cookie = harness().signIn();
  });

  afterEach(async () => {
    await laptop().close();
    await harness().close();
  });

  it('saves a view, changes it, and lists it as yours', async () => {
    const made = await post<SavedView>('/api/views/new', {
      name: 'Parks bugs',
      settings: {
        groupBy: 'status',
        chips: [{ field: 'label', value: 'bug' }],
      },
    });

    expect(made).toMatchObject({
      name: 'Parks bugs',
      owner: 'leslie@pawnee.gov',
      visibility: 'workspace',
    });

    await post('/api/views/update', {
      id: made.id,
      changes: { description: 'For the Lot 48 crew', visibility: 'personal' },
    });

    const { views } = await get<{ views: SavedView[] }>('/api/views');

    expect(views).toEqual([
      expect.objectContaining({
        id: made.id,
        description: 'For the Lot 48 crew',
        visibility: 'personal',
        mine: true,
        settings: {
          groupBy: 'status',
          chips: [{ field: 'label', value: 'bug' }],
        },
      }),
    ]);
  });

  it("never shows or changes someone else's personal view", async () => {
    const theirs = createView(
      harness().db,
      'ron@pawnee.gov',
      {
        name: "Ron's woodshop",
        visibility: 'personal',
        settings: { groupBy: 'status', chips: [] },
      },
      harness().clock.now
    );
    createView(
      harness().db,
      'ron@pawnee.gov',
      {
        name: 'Parks dept',
        settings: { groupBy: 'status', chips: [] },
      },
      harness().clock.now
    );

    const { views } = await get<{ views: SavedView[] }>('/api/views');

    expect(views.map((view) => [view.name, view.mine])).toEqual([
      ['Parks dept', false],
    ]);

    const response = await harness().request('POST', '/api/views/delete', {
      cookie: cookie(),
      body: JSON.stringify({ id: theirs.id }),
    });

    expect(response.status).toBe(404);
  });

  it('stars, orders and unstars, and a deleted view leaves Favorites', async () => {
    const made = await post<SavedView>('/api/views/new', {
      name: 'Harvest festival',
      settings: { groupBy: 'status', chips: [] },
    });
    await post('/api/favorites/add', { kind: 'view', ref: made.id });
    await post('/api/favorites/add', {
      kind: 'project',
      ref: `${parks()}/Lot 48`,
    });
    const { favorites } = await post<{
      favorites: Array<{ id: string; kind: string; ref: string }>;
    }>('/api/favorites/add', { kind: 'lambda', ref: 'lambda-1' });

    expect(favorites.map((one) => one.kind)).toEqual([
      'view',
      'project',
      'lambda',
    ]);

    const reordered = await post<{ favorites: Array<{ kind: string }> }>(
      '/api/favorites/order',
      { ids: [...favorites].reverse().map((one) => one.id) }
    );

    expect(reordered.favorites.map((one) => one.kind)).toEqual([
      'lambda',
      'project',
      'view',
    ]);

    await post('/api/views/delete', { id: made.id });
    const left = await post<{ favorites: Array<{ kind: string }> }>(
      '/api/favorites/remove',
      { kind: 'lambda', ref: 'lambda-1' }
    );

    expect(left.favorites.map((one) => one.kind)).toEqual(['project']);

    // A ticket keeps the title it was starred with: the mothership never reads it.
    const titled = await post<{
      favorites: Array<{ kind: string; label: string | null }>;
    }>('/api/favorites/add', {
      kind: 'ticket',
      ref: `${parks()}/PAWNEE-3`,
      label: 'Trail markers',
    });

    expect(titled.favorites.map((one) => [one.kind, one.label])).toEqual([
      ['project', null],
      ['ticket', 'Trail markers'],
    ]);
  });

  it("imports a tracker's views and favorites, and updates them in place the next time", async () => {
    laptop().on('tracker-views', (message) => {
      expect(message.folder).toBe(PARKS);

      return {
        views: [
          {
            trackerId: 'lin-trails',
            name: 'Trail work',
            description: 'Open trail tickets',
            icon: ':evergreen_tree:',
            shared: true,
            chips: [{ field: 'label', value: 'trails' }],
            dropped: [],
          },
          {
            trackerId: 'lin-ron',
            name: "Ron's woodshop",
            icon: null,
            shared: false,
            chips: [],
            dropped: ['the milestone'],
          },
        ],
        favorites: [
          { kind: 'view', ref: 'lin-trails', position: 1 },
          { kind: 'project', ref: 'Lot 48', position: 2 },
          { kind: 'ticket', ref: 'PAWNEE-3', position: 3 },
          // Not a view this import kept: skipped.
          { kind: 'view', ref: 'lin-gone', position: 4 },
        ],
      };
    });

    const first = await post<{
      added: number;
      updated: number;
      favorites: number;
      notes: unknown[];
    }>('/api/views/import', {});

    expect(first).toEqual({
      added: 2,
      updated: 0,
      favorites: 3,
      notes: [{ view: "Ron's woodshop", dropped: ['the milestone'] }],
    });

    const again = await post<{ added: number; updated: number }>(
      '/api/views/import',
      {}
    );

    expect(again).toMatchObject({ added: 0, updated: 2 });

    const { views } = await get<{ views: SavedView[] }>('/api/views');

    expect(views).toEqual([
      expect.objectContaining({
        name: "Ron's woodshop",
        visibility: 'personal',
        linearId: 'lin-ron',
      }),
      expect.objectContaining({
        name: 'Trail work',
        icon: ':evergreen_tree:',
        visibility: 'workspace',
        // Scoped to the codebase it came from.
        settings: {
          groupBy: 'status',
          chips: [
            { field: 'codebase', value: parks() },
            { field: 'label', value: 'trails' },
          ],
        },
      }),
    ]);

    const queue = required(
      views.find((view) => view.name === 'Trail work'),
      'Trail work'
    );
    const { favorites } = await get<{
      favorites: Array<{ kind: string; ref: string }>;
    }>('/api/favorites');

    expect(favorites.map((one) => [one.kind, one.ref])).toEqual([
      ['view', queue.id],
      ['project', `${parks()}/Lot 48`],
      ['ticket', `${parks()}/PAWNEE-3`],
    ]);
  });
});
