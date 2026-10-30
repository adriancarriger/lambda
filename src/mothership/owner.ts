import { isOwnersReporter } from '../building/owner';
import type { MachineConfig } from '../config/machineConfig';
import type { Db } from './db';

export interface Alias {
  kind: 'email' | 'name';
  value: string;
}

export interface Owner {
  name: string;
  initials: string;
  /** Trimmed and lowercased, as it's read. */
  email: string | null;
}

/** "Leslie Knope" → "LK"; one word → its first letter. */
export const initialsOf = (name: string): string => {
  const words = name
    .trim()
    .split(/\s+/)
    .filter((word) => word !== '');
  const first = words[0]?.[0] ?? '';
  const last = words.length > 1 ? words.at(-1)?.[0] ?? '' : '';

  return `${first}${last}`.toUpperCase() || '?';
};

/**
 * The one person this Lambda belongs to: `owner` in the mothership
 * machine's ~/.lambda/config.json. There's no accounts table.
 */
export const ownerFromConfig = (config: MachineConfig | null): Owner => {
  const name = config?.owner?.name?.trim() || 'Owner';
  const email = config?.owner?.email?.trim().toLowerCase();

  return {
    name,
    initials: initialsOf(name),
    email: email === undefined || email === '' ? null : email,
  };
};

export const listAliases = (db: Db): Alias[] =>
  db.prepare<[], Alias>('SELECT kind, value FROM aliases ORDER BY id').all();

/** Stored trimmed and lowercased; with an `@` it's an email. */
export const aliasOf = (typed: string): Alias | null => {
  const value = typed.trim().toLowerCase();

  return value === ''
    ? null
    : { kind: value.includes('@') ? 'email' : 'name', value };
};

/** Counts as the owner from now on; answers whether it's new. */
export const addAliasTo = (db: Db, alias: Alias): boolean =>
  db
    .prepare(
      'INSERT OR IGNORE INTO aliases (kind, value, created_at) VALUES (?, ?, ?)'
    )
    .run(alias.kind, alias.value, Date.now()).changes === 1;

/**
 * Is this tracker login already the owner's, so a building computer takes
 * the tickets it reports? Matched as a reporter is: its email, then its name.
 */
export const isOwnersLogin = (
  db: Db,
  owner: Owner,
  login: { name: string; email: string | null }
): boolean =>
  isOwnersReporter(
    {
      name: login.name,
      ...(login.email === null ? {} : { email: login.email }),
    },
    { name: owner.name, email: owner.email, aliases: listAliases(db) }
  );
