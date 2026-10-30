import type { Migration } from '.';

/**
 * Saved views (a Tickets list's filters and grouping, named) and favorites
 * (the sidebar's starred views, projects, tickets and Lambdas). Each has an
 * owner, by email, so they're a person's once Lambda has teammates; a view
 * is `personal` or shared with the whole `workspace`. `linear_id`: one
 * imported from Linear, so importing again updates it rather than adding.
 * A favorite's `label` is its name when starred (a ticket's title), for the
 * sidebar: the mothership never reads a ticket.
 */
export const migration008: Migration = {
  version: 8,
  name: 'views and favorites',
  sql: `
    CREATE TABLE views (
      id TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      name TEXT NOT NULL,
      icon TEXT,
      description TEXT NOT NULL DEFAULT '',
      visibility TEXT NOT NULL DEFAULT 'workspace',
      settings TEXT NOT NULL,
      linear_id TEXT UNIQUE,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE favorites (
      id TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      kind TEXT NOT NULL,
      ref TEXT NOT NULL,
      position REAL NOT NULL,
      label TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE (owner, kind, ref)
    );
  `,
};
