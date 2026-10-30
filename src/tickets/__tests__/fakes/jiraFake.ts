/**
 * An in-memory Jira Cloud, answering exactly the REST calls `jira.ts` makes,
 * so the Jira source runs the shared contract suite with no network.
 *
 * Use with `JIRA_FAKE_SITE`, project `PAWNEE` and `JIRA_FAKE_STATUSES` as the
 * lambda.json `tickets` block. Every request is recorded in `requests`.
 * Like Jira, an issue comes back with only the fields asked for, and a search
 * on `project = "X"` finds only keys starting `X-`, in any case, alone or
 * with `parent = "…"`; an issue's project is the part of its key before the
 * dash, in capitals. A Blocks link shows on each side as the
 * OTHER issue: the blocked issue sees its blocker as `inwardIssue` ("is
 * blocked by"), the blocker sees the blocked issue as `outwardIssue`
 * ("blocks"), each carrying its summary and status as Jira's do.
 */
import { type TicketState } from '../../source';

export const JIRA_FAKE_SITE = 'https://pawnee.atlassian.net';
export const JIRA_FAKE_PROJECT = 'PAWNEE';

/** The lambda.json `tickets.statuses` the fake's workflow uses. */
export const JIRA_FAKE_STATUSES: Record<
  Exclude<TicketState, 'inbox'>,
  string
> = {
  planning: 'Backlog',
  ready: 'Selected for Development',
  building: 'In Progress',
  blocked: 'Blocked',
  done: 'Done',
  canceled: "Won't Do",
};

const CATEGORY: Record<string, 'new' | 'indeterminate' | 'done'> = {
  Backlog: 'new',
  'Selected for Development': 'new',
  'In Progress': 'indeterminate',
  Blocked: 'indeterminate',
  Done: 'done',
  "Won't Do": 'done',
};

export interface FakeAccount {
  displayName: string;
  emailAddress?: string;
}

export interface FakeIssue {
  key: string;
  summary: string;
  status: string;
  labels: string[];
  parent?: string;
  description: unknown;
  reporter: FakeAccount | null;
  comments: {
    id: string;
    author: FakeAccount;
    body: unknown;
    created: string;
  }[];
  attachments: { id: string; filename: string; content: string }[];
  /** Jira's priority name; every issue has one (Medium by default). */
  priority?: string;
  /** The assignee's account id. */
  assignee?: string | null;
}

/** The site's users, for assignees. */
export const JIRA_FAKE_USERS = [
  {
    accountId: 'acct-leslie',
    displayName: 'Leslie Knope',
    emailAddress: 'leslie@pawnee.gov',
  },
  {
    accountId: 'acct-ann',
    displayName: 'Ann Perkins',
    emailAddress: 'ann@pawnee.gov',
  },
];

export interface FakeRequest {
  method: string;
  url: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface JiraFakeOptions {
  /** Issues there from the start, in rank order. */
  issues?: (Partial<FakeIssue> & { key: string; summary: string })[];
  /** From status → the statuses a transition reaches (default: all others). */
  transitions?: Record<string, string[]>;
  /** createmeta's issue types (default Task, Bug and Sub-task). */
  issueTypes?: { id: string; name: string; subtask: boolean }[];
  /** The codebase's statuses (default the six in JIRA_FAKE_STATUSES). */
  statuses?: string[];
  /** Whoever "makes the call": Jira's reporter on create. */
  caller?: FakeAccount;
  /**
   * How many comments an issue's embedded `comment` field holds; `total`
   * still counts them all, as Jira's does when it cuts the list off.
   */
  embeddedComments?: number;
  /** Answer every request with this status. */
  failWith?: number;
  /** The body sent with `failWith` (default Jira's error shape, "Refused"). */
  failBody?: unknown;
  /** Search page size. */
  pageSize?: number;
  /** Bodies for URLs outside the API (attachments), by full URL. */
  files?: Record<string, string>;
  /**
   * Issues the rank endpoint refuses, with Jira's error for each: it answers
   * 207, moving the others.
   */
  rankErrors?: Record<string, string>;
  /** File names whose `POST …/attachments` upload Jira refuses (500). */
  rejectAttachments?: string[];
  /** A raw answer for every request to this API path, in place of the fake's. */
  answers?: Record<string, { status?: number; body: string }>;
}

const DEFAULT_TYPES = [
  { id: '10001', name: 'Task', subtask: false },
  { id: '10002', name: 'Bug', subtask: false },
  { id: '10003', name: 'Sub-task', subtask: true },
];

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const record = (value: unknown): Json => (isRecord(value) ? value : {});

const field = (value: unknown, key: string): string | undefined => {
  const found = record(value)[key];

  return typeof found === 'string' ? found : undefined;
};

interface FakeState {
  issues: FakeIssue[];
  /** Blocks links: `blocker` blocks `blocked`. */
  links: { id: string; blocker: string; blocked: string }[];
  requests: FakeRequest[];
  counter: number;
}

const keyNumber = (key: string): number =>
  Number(/-(\d+)$/.exec(key)?.[1] ?? 0);

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const empty = (status = 204): Response => new Response(null, { status });

const notFound = (): Response =>
  json(
    {
      errorMessages: [
        'Issue does not exist or you do not have permission to see it.',
      ],
      errors: {},
    },
    404
  );

const headersOf = (init: RequestInit | undefined): Record<string, string> =>
  Object.fromEntries(new Headers(init?.headers).entries());

/** A multipart upload's file, as `bodyOf` records it. */
const uploadedFile = (
  body: FormData
): { file: string; size: number; text: Promise<string> } | undefined => {
  const file = body.get('file');

  return typeof file === 'string' || file === null
    ? undefined
    : { file: file.name, size: file.size, text: file.text() };
};

const bodyOf = (init: RequestInit | undefined): unknown => {
  if (init?.body instanceof FormData) {
    const file = uploadedFile(init.body);

    return file === undefined ? {} : { file: file.file, size: file.size };
  }

  return typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
};

export const createJiraFake = (options: JiraFakeOptions = {}) => {
  const statuses = options.statuses ?? Object.values(JIRA_FAKE_STATUSES);
  const issueTypes = options.issueTypes ?? DEFAULT_TYPES;
  const caller = options.caller ?? {
    displayName: 'Leslie Knope',
    emailAddress: 'leslie@pawnee.gov',
  };
  const state: FakeState = {
    issues: (options.issues ?? []).map(
      (issue): FakeIssue => ({
        status: 'Backlog',
        labels: [],
        description: null,
        reporter: caller,
        comments: [],
        attachments: [],
        ...issue,
      })
    ),
    links: [],
    requests: [],
    counter: 100,
  };
  const nextId = (): string => {
    state.counter += 1;

    return String(state.counter);
  };
  const find = (key: string): FakeIssue | undefined =>
    state.issues.find((issue) => issue.key === key);
  const transitionsFrom = (from: string): string[] =>
    options.transitions?.[from] ?? statuses.filter((name) => name !== from);

  const render = (issue: FakeIssue, only?: string[]) => ({
    id: `id-${issue.key}`,
    key: issue.key,
    self: `${JIRA_FAKE_SITE}/rest/api/3/issue/${issue.key}`,
    fields: pick(allFields(issue), only),
  });

  const pick = (fields: Json, only: string[] | undefined): Json =>
    only === undefined
      ? fields
      : Object.fromEntries(
          Object.entries(fields).filter(([key]) => only.includes(key))
        );

  const linked = (key: string): Json => {
    const issue = find(key);

    return issue === undefined
      ? { key }
      : {
          key,
          fields: {
            summary: issue.summary,
            status: {
              name: issue.status,
              statusCategory: { key: CATEGORY[issue.status] ?? 'new' },
            },
          },
        };
  };

  const BLOCKS = {
    name: 'Blocks',
    inward: 'is blocked by',
    outward: 'blocks',
  };

  const allFields = (issue: FakeIssue): Json => ({
    summary: issue.summary,
    project: { key: issue.key.split('-')[0] ?? '' },
    status: {
      name: issue.status,
      statusCategory: { key: CATEGORY[issue.status] ?? 'new' },
    },
    labels: issue.labels,
    parent: issue.parent === undefined ? undefined : { key: issue.parent },
    issuelinks: [
      ...state.links
        .filter((link) => link.blocked === issue.key)
        .map((link) => ({
          id: link.id,
          type: BLOCKS,
          inwardIssue: linked(link.blocker),
        })),
      ...state.links
        .filter((link) => link.blocker === issue.key)
        .map((link) => ({
          id: link.id,
          type: BLOCKS,
          outwardIssue: linked(link.blocked),
        })),
    ],
    reporter: issue.reporter,
    priority: { name: issue.priority ?? 'Medium' },
    assignee:
      JIRA_FAKE_USERS.find((user) => user.accountId === issue.assignee) ?? null,
    description: issue.description,
    comment: {
      comments: issue.comments.slice(
        0,
        options.embeddedComments ?? issue.comments.length
      ),
      maxResults: options.embeddedComments ?? issue.comments.length,
      total: issue.comments.length,
      startAt: 0,
    },
    attachment: issue.attachments,
  });

  const search = (body: Json): Response => {
    const jql = String(body.jql ?? '');
    const parent = /parent\s*=\s*"?([A-Za-z0-9_-]+)"?/.exec(jql)?.[1];
    const parents = /parent in \(([^)]*)\)/
      .exec(jql)?.[1]
      ?.split(',')
      .map((key) => key.trim().replace(/^"|"$/g, ''));
    const label = /labels\s*=\s*"((?:[^"\\]|\\.)*)"/.exec(jql)?.[1];
    const project = /project\s*=\s*"?([A-Za-z0-9_]+)"?/.exec(jql)?.[1];
    const found = state.issues.filter(
      (issue) =>
        (parent === undefined || issue.parent === parent) &&
        (parents === undefined || parents.includes(issue.parent ?? '')) &&
        (label === undefined || issue.labels.includes(label)) &&
        (project === undefined ||
          issue.key.toUpperCase().startsWith(`${project.toUpperCase()}-`))
    );
    const only = Array.isArray(body.fields) ? body.fields.map(String) : [];
    // `state.issues` is rank order; without `ORDER BY Rank ASC` Jira answers
    // in creation order, which the fake takes as the key's number.
    const matching = /\bORDER BY Rank ASC\s*$/i.test(jql)
      ? found
      : [...found].sort((a, b) => keyNumber(a.key) - keyNumber(b.key));
    const start = Number(body.nextPageToken ?? 0);
    const size = Math.min(
      Number(body.maxResults ?? 50),
      options.pageSize ?? Number.MAX_SAFE_INTEGER
    );
    const page = matching.slice(start, start + size);
    const end = start + page.length;

    return json({
      issues: page.map((issue) => render(issue, only)),
      ...(end < matching.length ? { nextPageToken: String(end) } : {}),
      isLast: end >= matching.length,
    });
  };

  const rank = (body: Json): Response => {
    const keys = Array.isArray(body.issues) ? body.issues.map(String) : [];
    const anchor = String(body.rankAfterIssue ?? body.rankBeforeIssue ?? '');
    const moving = keys
      .map(find)
      .filter((issue): issue is FakeIssue => issue !== undefined);

    if (moving.length !== keys.length || find(anchor) === undefined) {
      return json({ errorMessages: ['Issue does not exist'] }, 400);
    }

    const refused = options.rankErrors ?? {};
    const moved = moving.filter((issue) => refused[issue.key] === undefined);
    const rest = state.issues.filter(
      (issue) => !moved.some((candidate) => candidate.key === issue.key)
    );
    const at = rest.findIndex((issue) => issue.key === anchor);
    const index = body.rankAfterIssue === undefined ? at : at + 1;
    state.issues = [...rest.slice(0, index), ...moved, ...rest.slice(index)];

    if (moved.length === moving.length) {
      return empty();
    }

    return json(
      {
        entries: keys.map((key) => {
          const error = refused[key];

          return error === undefined
            ? { issueId: `id-${key}`, issueKey: key, status: 200 }
            : {
                issueId: `id-${key}`,
                issueKey: key,
                status: 400,
                errors: [error],
              };
        }),
      },
      207
    );
  };

  const createIssue = (body: Json): Response => {
    const fields = record(body.fields);
    const known = issueTypes.find(
      (candidate) =>
        candidate.name === field(fields.issuetype, 'name') ||
        candidate.id === field(fields.issuetype, 'id')
    );

    if (known === undefined) {
      return json({ errors: { issuetype: 'Specify a valid issue type' } }, 400);
    }

    if ('reporter' in fields) {
      return json({ errors: { reporter: 'Field cannot be set.' } }, 400);
    }

    const parent = field(fields.parent, 'key');

    if (parent !== undefined && find(parent) === undefined) {
      return json({ errors: { parent: 'Could not find issue' } }, 400);
    }

    const number =
      state.issues
        .map((issue) => Number(/-(\d+)$/.exec(issue.key)?.[1] ?? 0))
        .reduce((max, value) => Math.max(max, value), 0) + 1;
    const key = `${JIRA_FAKE_PROJECT}-${number}`;
    state.issues = [
      ...state.issues,
      {
        key,
        summary: String(fields.summary ?? ''),
        status: 'Backlog',
        ...(parent === undefined ? {} : { parent }),
        description: fields.description ?? null,
        reporter: caller,
        comments: [],
        attachments: [],
        priority: field(fields.priority, 'name') ?? 'Medium',
        labels: Array.isArray(fields.labels) ? fields.labels.map(String) : [],
      },
    ];

    return json(
      {
        id: `id-${key}`,
        key,
        self: `${JIRA_FAKE_SITE}/rest/api/3/issue/${key}`,
      },
      201
    );
  };

  const editIssue = (issue: FakeIssue, body: Json): Response => {
    const fields = record(body.fields);
    const { labels } = record(body.update);
    const added = Array.isArray(labels)
      ? labels.flatMap((op: unknown) => {
          const add = field(op, 'add');

          return add === undefined ? [] : [add];
        })
      : [];
    const removed = Array.isArray(labels)
      ? labels.flatMap((op: unknown) => {
          const remove = field(op, 'remove');

          return remove === undefined ? [] : [remove];
        })
      : [];
    const priority = field(fields.priority, 'name');

    if (priority !== undefined) {
      issue.priority = priority;
    }

    if (typeof fields.summary === 'string') {
      issue.summary = fields.summary;
    }

    if ('description' in fields) {
      issue.description = fields.description;
    }

    if ('parent' in fields) {
      const parent = field(fields.parent, 'key');

      if (parent === undefined) {
        delete issue.parent;
      } else {
        issue.parent = parent;
      }
    }

    issue.labels = [
      ...issue.labels,
      ...added.filter((label: string) => !issue.labels.includes(label)),
    ].filter((label) => !removed.includes(label));

    return empty();
  };

  const issueRoute = (
    method: string,
    key: string,
    sub: string | undefined,
    body: Json,
    only: string[] | undefined
  ): Response => {
    const issue = find(key);

    if (issue === undefined) {
      return notFound();
    }

    if (sub === undefined) {
      if (method === 'GET') {
        return json(render(issue, only));
      }

      if (method === 'PUT') {
        return editIssue(issue, body);
      }

      if (method === 'DELETE') {
        state.issues = state.issues.filter((candidate) => candidate !== issue);
        state.links = state.links.filter(
          (link) => link.blocker !== key && link.blocked !== key
        );

        return empty();
      }
    }

    if (sub === 'transitions') {
      const targets = transitionsFrom(issue.status);

      if (method === 'GET') {
        return json({
          transitions: targets.map((name) => ({
            id: String(statuses.indexOf(name) + 11),
            name,
            to: { name, statusCategory: { key: CATEGORY[name] ?? 'new' } },
          })),
        });
      }

      const id = field(body.transition, 'id');
      const target = targets.find(
        (name) => String(statuses.indexOf(name) + 11) === id
      );

      if (target === undefined) {
        return json({ errorMessages: ['Transition is not valid'] }, 400);
      }

      issue.status = target;

      return empty();
    }

    if (sub === 'assignee' && method === 'PUT') {
      const { accountId } = body;
      issue.assignee = typeof accountId === 'string' ? accountId : null;

      return empty();
    }

    if (sub === 'comment' && method === 'POST') {
      const comment = {
        id: nextId(),
        author: caller,
        body: body.body,
        created: '2026-10-22T10:00:00.000+0000',
      };
      issue.comments = [...issue.comments, comment];

      return json(comment, 201);
    }

    return json({ errorMessages: [`No fake route for ${method} ${sub}`] }, 400);
  };

  const route = (method: string, url: URL, body: Json): Response => {
    const path = url.pathname;
    const project = /^\/rest\/api\/3\/project\/([^/]+)\/statuses$/.exec(path);

    if (project !== null) {
      return project[1]?.toUpperCase() === JIRA_FAKE_PROJECT
        ? json([
            {
              name: 'Task',
              statuses: statuses.map((name) => ({
                name,
                statusCategory: { key: CATEGORY[name] ?? 'new' },
              })),
            },
          ])
        : json({ errorMessages: ['No project could be found.'] }, 404);
    }

    if (path === '/rest/api/3/user/search' && method === 'GET') {
      const query = (url.searchParams.get('query') ?? '').toLowerCase();

      return json(
        JIRA_FAKE_USERS.filter(
          (user) =>
            user.emailAddress.toLowerCase() === query ||
            user.displayName.toLowerCase() === query
        )
      );
    }

    if (path === '/rest/api/3/search/jql' && method === 'POST') {
      return search(body);
    }

    if (/^\/rest\/api\/3\/issue\/createmeta\/[^/]+\/issuetypes$/.test(path)) {
      return json({
        issueTypes,
        maxResults: 50,
        startAt: 0,
        total: issueTypes.length,
      });
    }

    if (path === '/rest/api/3/issue' && method === 'POST') {
      return createIssue(body);
    }

    if (path === '/rest/api/3/issueLink' && method === 'POST') {
      // Jira's POST direction: the link runs from the outward issue, which
      // blocks the inward one.
      const blocker = field(body.outwardIssue, 'key') ?? '';
      const blocked = field(body.inwardIssue, 'key') ?? '';

      if (find(blocker) === undefined || find(blocked) === undefined) {
        return notFound();
      }

      state.links = [...state.links, { id: nextId(), blocker, blocked }];

      return empty(201);
    }

    const link = /^\/rest\/api\/3\/issueLink\/([^/]+)$/.exec(path);

    if (link !== null && method === 'DELETE') {
      state.links = state.links.filter((candidate) => candidate.id !== link[1]);

      return empty();
    }

    if (path === '/rest/agile/1.0/issue/rank' && method === 'PUT') {
      return rank(body);
    }

    const issue = /^\/rest\/api\/3\/issue\/([^/]+)(?:\/([^/]+))?$/.exec(path);

    if (issue !== null) {
      const only = url.searchParams.get('fields')?.split(',');

      return issueRoute(method, issue[1] ?? '', issue[2], body, only);
    }

    return json(
      { errorMessages: [`No fake route for ${method} ${path}`] },
      400
    );
  };

  /** What each uploaded attachment's `content` URL answers. */
  const uploadedText = new Map<string, string>();

  /** `POST /rest/api/3/issue/{key}/attachments`, multipart, as Jira's. */
  const attach = async (
    key: string,
    body: FormData,
    headers: Record<string, string>
  ): Promise<Response> => {
    const issue = find(key);

    if (issue === undefined) {
      return notFound();
    }

    // Jira refuses an attachment upload without this header (XSRF check).
    if (headers['x-atlassian-token'] !== 'no-check') {
      return json({ errorMessages: ['XSRF check failed'] }, 403);
    }

    const file = uploadedFile(body);

    if (file === undefined) {
      return json({ errorMessages: ['No file in the upload'] }, 400);
    }

    if ((options.rejectAttachments ?? []).includes(file.file)) {
      return json({ errorMessages: ['Attachment refused'] }, 500);
    }

    const id = nextId();
    const content = `${JIRA_FAKE_SITE}/rest/api/3/attachment/content/${id}`;
    const attachment = { id, filename: file.file, content };
    issue.attachments = [...issue.attachments, attachment];
    uploadedText.set(content, await file.text);

    return json([{ ...attachment, size: file.size }]);
  };
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = bodyOf(init);
    state.requests = [
      ...state.requests,
      {
        method,
        url: url.toString(),
        path: url.pathname,
        headers: headersOf(init),
        body,
      },
    ];

    if (options.failWith !== undefined) {
      return json(
        options.failBody ?? { errorMessages: ['Refused'] },
        options.failWith
      );
    }

    const attachTo = /^\/rest\/api\/3\/issue\/([^/]+)\/attachments$/.exec(
      url.pathname
    );

    if (
      attachTo !== null &&
      method === 'POST' &&
      init?.body instanceof FormData
    ) {
      return attach(attachTo[1] ?? '', init.body, headersOf(init));
    }

    const answer = options.answers?.[url.pathname];

    if (answer !== undefined) {
      return new Response(answer.body, { status: answer.status ?? 200 });
    }

    const file =
      options.files?.[url.toString()] ?? uploadedText.get(url.toString());

    if (file !== undefined) {
      return new Response(file, { status: 200 });
    }

    if (url.origin !== JIRA_FAKE_SITE) {
      return new Response('Not found', { status: 404 });
    }

    return route(method, url, record(body));
  };

  return {
    fetch: fakeFetch,
    state,
    /** Requests other than the reads every call makes. */
    writes: (): FakeRequest[] =>
      state.requests.filter(
        (request) =>
          request.method !== 'GET' && request.path !== '/rest/api/3/search/jql'
      ),
  };
};

export type JiraFake = ReturnType<typeof createJiraFake>;
