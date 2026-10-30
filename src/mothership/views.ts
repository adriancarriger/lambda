import { randomId } from './crypto';
import type { Db } from './db';

/**
 * Saved views and favorites, kept on the mothership so they're the same on
 * every device. Each belongs to its owner (by email); a view is `personal`
 * (its owner's alone) or shared with the whole `workspace`. With one owner
 * today every view is theirs, but nothing assumes it.
 */

export const VISIBILITIES = ['personal', 'workspace'] as const;

export type Visibility = (typeof VISIBILITIES)[number];

export const FAVORITE_KINDS = ['view', 'project', 'ticket', 'lambda'] as const;

export type FavoriteKind = (typeof FAVORITE_KINDS)[number];

/** A Tickets list's filters and grouping, as a view keeps them. */
export interface ViewSettings {
  groupBy: string;
  chips: Array<{ field: string; value: string }>;
}

export interface SavedView {
  id: string;
  owner: string;
  name: string;
  icon: string | null;
  description: string;
  visibility: Visibility;
  settings: ViewSettings;
  /** Imported from Linear: its view's id there. */
  linearId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface Favorite {
  id: string;
  kind: FavoriteKind;
  /** A view's id; `<codebase>/<project name>`; `<codebase>/<ticket id>`; a Lambda's key. */
  ref: string;
  position: number;
  /** Its name when starred (a ticket's title); null: the app names it. */
  label: string | null;
}

interface RawView {
  id: string;
  owner: string;
  name: string;
  icon: string | null;
  description: string;
  visibility: string;
  settings: string;
  linear_id: string | null;
  created_at: number;
  updated_at: number;
}

const isVisibility = (value: unknown): value is Visibility =>
  VISIBILITIES.some((one) => one === value);

const settingsOf = (raw: string): ViewSettings => {
  try {
    const parsed: unknown = JSON.parse(raw);

    if (typeof parsed === 'object' && parsed !== null) {
      const groupBy = 'groupBy' in parsed ? parsed.groupBy : undefined;
      const chips = 'chips' in parsed ? parsed.chips : undefined;

      return {
        groupBy: typeof groupBy === 'string' ? groupBy : 'status',
        chips: Array.isArray(chips)
          ? chips.flatMap((chip: unknown) =>
              typeof chip === 'object' &&
              chip !== null &&
              'field' in chip &&
              'value' in chip &&
              typeof chip.field === 'string' &&
              typeof chip.value === 'string'
                ? [{ field: chip.field, value: chip.value }]
                : []
            )
          : [],
      };
    }
  } catch {
    // A row written by hand: read as no filters.
  }

  return { groupBy: 'status', chips: [] };
};

const toView = (row: RawView): SavedView => ({
  id: row.id,
  owner: row.owner,
  name: row.name,
  icon: row.icon,
  description: row.description,
  visibility: isVisibility(row.visibility) ? row.visibility : 'workspace',
  settings: settingsOf(row.settings),
  linearId: row.linear_id,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/** The views `owner` sees: the workspace's, and their own personal ones. */
export const listViews = (db: Db, owner: string): SavedView[] =>
  db
    .prepare<[string], RawView>(
      "SELECT * FROM views WHERE visibility = 'workspace' OR owner = ? ORDER BY name COLLATE NOCASE"
    )
    .all(owner)
    .map(toView);

export const getView = (db: Db, id: string): SavedView | null => {
  const row = db
    .prepare<[string], RawView>('SELECT * FROM views WHERE id = ?')
    .get(id);

  return row === undefined ? null : toView(row);
};

export interface ViewInput {
  name: string;
  icon?: string | null;
  description?: string;
  visibility?: Visibility;
  settings: ViewSettings;
}

export const createView = (
  db: Db,
  owner: string,
  input: ViewInput & { linearId?: string },
  now: number
): SavedView => {
  const id = randomId('view');
  db.prepare(
    'INSERT INTO views (id, owner, name, icon, description, visibility, settings, linear_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    id,
    owner,
    input.name,
    input.icon ?? null,
    input.description ?? '',
    input.visibility ?? 'workspace',
    JSON.stringify(input.settings),
    input.linearId ?? null,
    now,
    now
  );

  const made = getView(db, id);

  if (made === null) {
    throw new Error('The view was not saved.');
  }

  return made;
};

/** A change to a view: only what's given changes. */
export const updateView = (
  db: Db,
  id: string,
  change: Partial<ViewInput>,
  now: number
): SavedView | null => {
  const before = getView(db, id);

  if (before === null) {
    return null;
  }

  db.prepare(
    'UPDATE views SET name = ?, icon = ?, description = ?, visibility = ?, settings = ?, updated_at = ? WHERE id = ?'
  ).run(
    change.name ?? before.name,
    change.icon === undefined ? before.icon : change.icon,
    change.description ?? before.description,
    change.visibility ?? before.visibility,
    JSON.stringify(change.settings ?? before.settings),
    now,
    id
  );

  return getView(db, id);
};

/** A view goes, and so does every favorite of it. */
export const deleteView = (db: Db, id: string): boolean =>
  db.transaction(() => {
    db.prepare("DELETE FROM favorites WHERE kind = 'view' AND ref = ?").run(id);

    return db.prepare('DELETE FROM views WHERE id = ?').run(id).changes > 0;
  })();

export const viewByLinearId = (db: Db, linearId: string): SavedView | null => {
  const row = db
    .prepare<[string], RawView>('SELECT * FROM views WHERE linear_id = ?')
    .get(linearId);

  return row === undefined ? null : toView(row);
};

// ── favorites ─────────────────────────────────────────────────────────────

const isKind = (value: unknown): value is FavoriteKind =>
  FAVORITE_KINDS.some((kind) => kind === value);

export const listFavorites = (db: Db, owner: string): Favorite[] =>
  db
    .prepare<
      [string],
      {
        id: string;
        kind: string;
        ref: string;
        position: number;
        label: string | null;
      }
    >(
      'SELECT id, kind, ref, position, label FROM favorites WHERE owner = ? ORDER BY position, created_at'
    )
    .all(owner)
    .flatMap((row) =>
      isKind(row.kind)
        ? [
            {
              id: row.id,
              kind: row.kind,
              ref: row.ref,
              position: row.position,
              label: row.label,
            },
          ]
        : []
    );

/** Starred: at the end, or where it already is (its label kept fresh). */
export const addFavorite = (
  db: Db,
  owner: string,
  kind: FavoriteKind,
  ref: string,
  now: number,
  label: string | null = null
): Favorite[] => {
  const last = db
    .prepare<[string], { position: number | null }>(
      'SELECT MAX(position) AS position FROM favorites WHERE owner = ?'
    )
    .get(owner)?.position;
  db.prepare(
    'INSERT OR IGNORE INTO favorites (id, owner, kind, ref, position, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(randomId('fav'), owner, kind, ref, (last ?? 0) + 1, now);

  if (label !== null) {
    db.prepare(
      'UPDATE favorites SET label = ? WHERE owner = ? AND kind = ? AND ref = ?'
    ).run(label, owner, kind, ref);
  }

  return listFavorites(db, owner);
};

export const removeFavorite = (
  db: Db,
  owner: string,
  kind: FavoriteKind,
  ref: string
): Favorite[] => {
  db.prepare(
    'DELETE FROM favorites WHERE owner = ? AND kind = ? AND ref = ?'
  ).run(owner, kind, ref);

  return listFavorites(db, owner);
};

/** The sidebar's drag: the favorites in this order (others keep theirs after). */
export const orderFavorites = (
  db: Db,
  owner: string,
  ids: string[]
): Favorite[] =>
  db.transaction(() => {
    const update = db.prepare(
      'UPDATE favorites SET position = ? WHERE id = ? AND owner = ?'
    );
    ids.forEach((id, index) => update.run(index + 1, id, owner));

    return listFavorites(db, owner);
  })();

export { isKind as isFavoriteKind, isVisibility };
