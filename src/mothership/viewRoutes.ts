import type * as http from 'http';
import { z } from 'zod';

import type { Db } from './db';
import { json, readBody, str } from './http';
import { folderOf, listProjects } from './registry';
import { HttpError, type Relay } from './relay';
import type { Route } from './routes';
import { TICKETS_LIST_TIMEOUT_MS } from './ticketRoutes';
import {
  FAVORITE_KINDS,
  VISIBILITIES,
  addFavorite,
  createView,
  deleteView,
  getView,
  listFavorites,
  listViews,
  orderFavorites,
  removeFavorite,
  updateView,
  viewByLinearId,
} from './views';

/**
 * Saved views and favorites (`/api/views…`, `/api/favorites…`), and the
 * import of a tracker's own: each codebase's computer reads its tracker's
 * views and its key's favorites; they're kept here, translated, an imported
 * view updated in place when imported again.
 */

export interface ViewRoutesContext {
  db: Db;
  relay: Relay;
  runnerForProject: (projectId: string) => string;
  /** Whose views and favorites these are: the signed-in owner, by email. */
  owner: () => string;
  now: () => number;
  broadcast: () => void;
  log: (line: string) => void;
}

const ok = (response: http.ServerResponse, result: unknown): void =>
  json(response, 200, { ok: true, result });

const Chip = z.object({
  field: z.string().min(1).max(40),
  value: z.string().max(300),
});

const Settings = z.object({
  groupBy: z.string().min(1).max(40),
  chips: z.array(Chip).max(50),
});

const NewView = z
  .object({
    name: z.string().trim().min(1, 'A view needs a name.').max(120),
    icon: z.string().max(80).nullable().optional(),
    description: z.string().max(2000).optional(),
    visibility: z.enum(VISIBILITIES).optional(),
    settings: Settings,
  })
  .strict();

const ViewChange = NewView.partial().strict();

const FavoriteBody = z
  .object({
    kind: z.enum(FAVORITE_KINDS),
    ref: z.string().min(1).max(400),
    label: z.string().max(300).optional(),
  })
  .strict();

const parsed = <T>(
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  value: unknown
): T => {
  const result = schema.safeParse(value);

  if (!result.success) {
    throw new HttpError(
      400,
      result.error.issues.map((issue) => issue.message).join(' ')
    );
  }

  return result.data;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** One imported view's note: what Linear's filter said that Lambda can't. */
export interface ImportNote {
  view: string;
  dropped: string[];
}

export const createViewRoutes = (context: ViewRoutesContext): Route[] => {
  const { db, relay } = context;

  /** A view `owner` may change: theirs, or the workspace's. */
  const changeable = (id: string) => {
    const view = getView(db, id);

    if (
      view === null ||
      (view.visibility === 'personal' && view.owner !== context.owner())
    ) {
      throw new HttpError(404, 'No such view.');
    }

    return view;
  };

  /**
   * Every codebase's tracker views and favorites, kept: a view already
   * imported (by its tracker id) is updated, not added again. Each view is
   * scoped to its codebase; a favorite of a view, project or ticket is
   * starred here, keeping the tracker's order.
   */
  const importFromTrackers = async () => {
    const owner = context.owner();
    const notes = new Map<string, string[]>();
    const counts = { added: 0, updated: 0, favorites: 0 };

    await Promise.all(
      listProjects(db).map(async (project) => {
        const runnerId = context.runnerForProject(project.id);
        const folder = folderOf(db, runnerId, project.id);

        if (folder === null) {
          return;
        }

        const answer = await relay.request(
          runnerId,
          { type: 'tracker-views', folder },
          TICKETS_LIST_TIMEOUT_MS
        );

        if (!isRecord(answer)) {
          return;
        }

        const views = Array.isArray(answer.views) ? answer.views : [];
        const byTrackerId = new Map<string, string>();
        views.forEach((raw: unknown) => {
          if (
            !isRecord(raw) ||
            typeof raw.trackerId !== 'string' ||
            typeof raw.name !== 'string'
          ) {
            return;
          }

          const chips = (Array.isArray(raw.chips) ? raw.chips : []).flatMap(
            (chip: unknown) =>
              isRecord(chip) &&
              typeof chip.field === 'string' &&
              typeof chip.value === 'string'
                ? [{ field: chip.field, value: chip.value }]
                : []
          );
          const settings = {
            groupBy: 'status',
            chips: [{ field: 'codebase', value: project.id }, ...chips],
          };
          const input = {
            name: raw.name,
            icon: typeof raw.icon === 'string' ? raw.icon : null,
            description:
              typeof raw.description === 'string' ? raw.description : '',
            visibility: raw.shared === false ? 'personal' : 'workspace',
            settings,
          } as const;
          const before = viewByLinearId(db, raw.trackerId);
          const kept =
            before === null
              ? createView(
                  db,
                  owner,
                  { ...input, linearId: raw.trackerId },
                  context.now()
                )
              : updateView(db, before.id, input, context.now());

          if (before === null) {
            counts.added += 1;
          } else {
            counts.updated += 1;
          }

          if (kept !== null) {
            byTrackerId.set(raw.trackerId, kept.id);
          }

          const dropped = Array.isArray(raw.dropped)
            ? raw.dropped.filter(
                (one: unknown): one is string => typeof one === 'string'
              )
            : [];

          if (dropped.length > 0) {
            notes.set(raw.name, dropped);
          }
        });

        (Array.isArray(answer.favorites) ? answer.favorites : []).forEach(
          (raw: unknown) => {
            if (
              !isRecord(raw) ||
              typeof raw.kind !== 'string' ||
              typeof raw.ref !== 'string'
            ) {
              return;
            }

            const ref =
              raw.kind === 'view'
                ? byTrackerId.get(raw.ref)
                : `${project.id}/${raw.ref}`;

            if (
              ref !== undefined &&
              (raw.kind === 'view' ||
                raw.kind === 'project' ||
                raw.kind === 'ticket')
            ) {
              addFavorite(db, owner, raw.kind, ref, context.now());
              counts.favorites += 1;
            }
          }
        );
      })
    );

    return {
      ...counts,
      notes: [...notes].map(
        ([view, dropped]): ImportNote => ({ view, dropped })
      ),
    };
  };

  return [
    {
      method: 'GET',
      path: '/api/views',
      sample: '/api/views',
      handle: async ({ response }) => {
        const owner = context.owner();
        ok(response, {
          views: listViews(db, owner).map((view) => ({
            ...view,
            mine: view.owner === owner,
          })),
        });
      },
    },
    {
      method: 'POST',
      path: '/api/views/new',
      sample: '/api/views/new',
      handle: async ({ request, response }) => {
        const input = parsed(NewView, await readBody(request));
        const made = createView(db, context.owner(), input, context.now());
        context.broadcast();
        ok(response, made);
      },
    },
    {
      method: 'POST',
      path: '/api/views/update',
      sample: '/api/views/update',
      handle: async ({ request, response }) => {
        const body = await readBody(request);
        const id = str(body, 'id');
        changeable(id);
        const after = updateView(
          db,
          id,
          parsed(ViewChange, body.changes),
          context.now()
        );
        context.broadcast();
        ok(response, after);
      },
    },
    {
      method: 'POST',
      path: '/api/views/delete',
      sample: '/api/views/delete',
      handle: async ({ request, response }) => {
        const id = str(await readBody(request), 'id');
        changeable(id);
        deleteView(db, id);
        context.broadcast();
        ok(response, { deleted: id });
      },
    },
    {
      method: 'POST',
      path: '/api/views/import',
      sample: '/api/views/import',
      handle: async ({ response }) => {
        const result = await importFromTrackers();
        context.broadcast();
        ok(response, result);
      },
    },
    {
      method: 'GET',
      path: '/api/favorites',
      sample: '/api/favorites',
      handle: async ({ response }) =>
        ok(response, { favorites: listFavorites(db, context.owner()) }),
    },
    {
      method: 'POST',
      path: '/api/favorites/add',
      sample: '/api/favorites/add',
      handle: async ({ request, response }) => {
        const { kind, ref, label } = parsed(
          FavoriteBody,
          await readBody(request)
        );
        const favorites = addFavorite(
          db,
          context.owner(),
          kind,
          ref,
          context.now(),
          label ?? null
        );
        context.broadcast();
        ok(response, { favorites });
      },
    },
    {
      method: 'POST',
      path: '/api/favorites/remove',
      sample: '/api/favorites/remove',
      handle: async ({ request, response }) => {
        const { kind, ref } = parsed(FavoriteBody, await readBody(request));
        const favorites = removeFavorite(db, context.owner(), kind, ref);
        context.broadcast();
        ok(response, { favorites });
      },
    },
    {
      method: 'POST',
      path: '/api/favorites/order',
      sample: '/api/favorites/order',
      handle: async ({ request, response }) => {
        const ids = parsed(
          z.array(z.string().min(1).max(100)).max(500),
          (await readBody(request)).ids
        );
        const favorites = orderFavorites(db, context.owner(), ids);
        context.broadcast();
        ok(response, { favorites });
      },
    },
  ];
};
