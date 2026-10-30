/**
 * The address bar: every screen has a URL, so Back/Forward, reloads and links
 * work. Lambdas and items are named readably — `/lambda/dog-park-map/checkpoint-4`
 * — and resolved back to ids against the current state.
 *
 *   /                                   New planning Lambda (the front door)
 *   /auto/caught-up                     Auto: nothing waiting
 *   /auto/<lambda>/<item>               Auto: the decision it's on
 *   /lambda/<lambda>                    a Lambda they picked (Auto off)
 *   /lambda/<lambda>/<item>             one of its items
 *   /tickets, /time                     those pages
 *   /tickets/<project>/<ticket>         a ticket's own page
 *   /computers, /analytics              from the account menu
 *   /settings/devices, /settings/process, /settings/design-system
 *   …?v=3                               an earlier version of a checkpoint
 */

/** The account menu's pages. */
export type AccountPage =
  | 'computers'
  | 'analytics'
  | 'settings/devices'
  | 'settings/process'
  | 'settings/design-system';

export const ACCOUNT_PAGES: AccountPage[] = [
  'computers',
  'analytics',
  'settings/devices',
  'settings/process',
  'settings/design-system',
];

export type Route =
  | { page: 'new' }
  | { page: 'time' }
  | { page: 'tickets'; project?: string; ticket?: string; filter?: string }
  /** The tracker's projects, and one project's tickets. */
  | { page: 'projects' }
  | { page: 'project'; codebase: string; name: string; filter?: string }
  /** Saved views, and one view's tickets (its edits in `filter`). */
  | { page: 'views' }
  | { page: 'view'; id: string; filter?: string }
  | { page: 'account'; which: AccountPage }
  | { page: 'auto'; lambda?: string; item?: string; version?: number }
  | { page: 'lambda'; lambda: string; item?: string; version?: number }
  /** A Lambda's page past planning, by its key (`pod:…`, `ticket:…`). */
  | { page: 'work'; lambda: string };

/** "Duck pond water and trail markers" → "duck-pond-water-and-trail-markers". */
export const slugify = (text: string): string =>
  text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');

/**
 * Each Lambda's URL name: its name, slugified; two that would clash get the
 * end of their id added, and a nameless one is its id.
 */
export const lambdaSlugs = (
  lambdas: { id: string; name: string }[]
): Map<string, string> => {
  const base = lambdas.map(({ id, name }) => ({
    id,
    slug: slugify(name) === '' ? id : slugify(name),
  }));
  const counts = new Map<string, number>();
  base.forEach(({ slug }) => counts.set(slug, (counts.get(slug) ?? 0) + 1));

  return new Map(
    base.map(({ id, slug }) => [
      id,
      (counts.get(slug) ?? 0) > 1 ? `${slug}-${id.slice(-4)}` : slug,
    ])
  );
};

/** A URL name back to a Lambda id: by its name, its id, or its own slug. */
export const lambdaFromSlug = (
  slug: string,
  lambdas: { id: string; name: string; slug?: string }[]
): string | undefined => {
  const names = lambdaSlugs(lambdas);

  return lambdas.find(
    (lambda) =>
      names.get(lambda.id) === slug ||
      lambda.id === slug ||
      lambda.slug === slug
  )?.id;
};

export interface ItemLike {
  kind: 'reply' | 'question' | 'checkpoint' | 'stalled' | 'structure';
  qid?: string;
}

/** An item's URL name: checkpoint-4, decision-7, your-turn… */
export const itemSlug = (item: ItemLike, checkpoint?: number): string => {
  if (item.kind === 'reply') {
    return 'your-turn';
  }

  if (item.kind === 'stalled') {
    return 'stalled';
  }

  if (item.kind === 'structure') {
    return 'structured-planning';
  }

  if (item.kind === 'checkpoint' && checkpoint !== undefined) {
    return `checkpoint-${checkpoint}`;
  }

  const id = item.qid ?? '';

  return /^q\d+$/.test(id) ? `decision-${id.slice(1)}` : id;
};

/** A question named by its URL name (checkpoint-4, decision-7, or its id). */
export const questionFromSlug = <
  Q extends { id: string; status: string; checkpoint?: { cp: number } }
>(
  slug: string,
  questions: Q[]
): Q | undefined => {
  const checkpoint = /^checkpoint-(\d+)$/.exec(slug);

  if (checkpoint !== null) {
    const cp = Number(checkpoint[1]);
    const matches = questions.filter(
      (question) => question.checkpoint?.cp === cp
    );

    return (
      matches.find((question) => question.status === 'open') ?? matches.at(-1)
    );
  }

  const decision = /^decision-(\d+)$/.exec(slug);
  const id = decision === null ? slug : `q${decision[1]}`;

  return questions.find((question) => question.id === id);
};

const versionOf = (search: string): number | undefined => {
  const value = Number(new URLSearchParams(search).get('v'));

  return Number.isInteger(value) && value > 0 ? value : undefined;
};

export const parseRoute = (pathname: string, search = ''): Route => {
  const parts = pathname
    .split('/')
    .filter((part) => part !== '')
    .map((part) => decodeURIComponent(part));
  const [first, lambda, item] = parts;
  const version = versionOf(search);

  if (first === 'time') {
    return { page: 'time' };
  }

  const filter = new URLSearchParams(search).get('filter') ?? undefined;
  const filtered = filter === undefined || filter === '' ? {} : { filter };

  if (first === 'tickets') {
    return lambda !== undefined && item !== undefined
      ? { page: 'tickets', project: lambda, ticket: item }
      : { page: 'tickets', ...filtered };
  }

  if (first === 'projects') {
    return lambda !== undefined && item !== undefined
      ? { page: 'project', codebase: lambda, name: item, ...filtered }
      : { page: 'projects' };
  }

  if (first === 'views') {
    return lambda === undefined
      ? { page: 'views' }
      : { page: 'view', id: lambda, ...filtered };
  }

  if (first === 'computers' || first === 'analytics') {
    return { page: 'account', which: first };
  }

  if (first === 'settings') {
    const which: AccountPage =
      lambda === 'process' || lambda === 'design-system'
        ? `settings/${lambda}`
        : 'settings/devices';

    return { page: 'account', which };
  }

  if (first === 'auto') {
    return lambda === undefined || lambda === 'caught-up'
      ? { page: 'auto' }
      : { page: 'auto', lambda, item, version };
  }

  if (first === 'work' && lambda !== undefined) {
    return { page: 'work', lambda };
  }

  if (first === 'lambda' && lambda !== undefined) {
    return { page: 'lambda', lambda, item, version };
  }

  return { page: 'new' };
};

const filterQuery = (filter: string | undefined): string =>
  filter === undefined || filter === '' ? '' : `?filter=${filter}`;

export const formatRoute = (route: Route): string => {
  const tail = (lambda?: string, item?: string, version?: number): string =>
    `${lambda === undefined ? '' : `/${encodeURIComponent(lambda)}`}${
      lambda === undefined || item === undefined
        ? ''
        : `/${encodeURIComponent(item)}`
    }${version === undefined || item === undefined ? '' : `?v=${version}`}`;

  switch (route.page) {
    case 'new':
      return '/';
    case 'time':
      return '/time';
    case 'tickets':
      return route.project === undefined || route.ticket === undefined
        ? `/tickets${filterQuery(route.filter)}`
        : `/tickets/${encodeURIComponent(route.project)}/${encodeURIComponent(
            route.ticket
          )}`;
    case 'projects':
      return '/projects';
    case 'project':
      return `/projects/${encodeURIComponent(
        route.codebase
      )}/${encodeURIComponent(route.name)}${filterQuery(route.filter)}`;
    case 'views':
      return '/views';
    case 'view':
      return `/views/${encodeURIComponent(route.id)}${filterQuery(
        route.filter
      )}`;
    case 'account':
      return `/${route.which}`;
    case 'auto':
      return route.lambda === undefined
        ? '/auto/caught-up'
        : `/auto${tail(route.lambda, route.item, route.version)}`;
    case 'lambda':
      return `/lambda${tail(route.lambda, route.item, route.version)}`;
    case 'work':
      return `/work/${encodeURIComponent(route.lambda)}`;
  }
};
