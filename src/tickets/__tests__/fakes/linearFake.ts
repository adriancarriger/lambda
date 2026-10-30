/**
 * An in-memory Linear, answering exactly the GraphQL operations `linear.ts`
 * sends (by operation name), so tests and the shared contract suite run with
 * no network. Images and any other URL answer from `files`.
 */
import { z } from 'zod';

export interface FakeState {
  id: string;
  name: string;
  type: string;
}

export interface FakeIssue {
  id: string;
  identifier: string;
  title: string;
  description: string;
  stateId: string;
  labelIds: string[];
  parentId: string | null;
  sortOrder: number;
  subIssueSortOrder: number | null;
  creator: { name: string; email: string | null } | null;
  trashed: boolean;
  /** Set when Linear archived it (it does that to closed issues on its own). */
  archivedAt: string | null;
  /** The team's key. */
  team: string;
  /** Linear's number: 0 none, 1 urgent … 4 low. */
  priority: number;
  assigneeId: string | null;
}

export interface FakeUser {
  id: string;
  name: string;
  email: string;
}

export interface FakeRequest {
  url: string;
  operation: string | undefined;
  variables: Record<string, unknown>;
  headers: Record<string, string>;
  /** Linear's estimate of the query's cost (GraphQL requests only). */
  complexity?: number;
}

interface FakeRelation {
  id: string;
  type: string;
  issueId: string;
  relatedIssueId: string;
}

/** A file put to the presigned URL a `fileUpload` handed out. */
export interface FakeUpload {
  filename: string;
  contentType: string;
  assetUrl: string;
  /** The PUT's headers: the presigned ones, never the key. */
  headers: Record<string, string>;
  body: string;
}

interface FakeComment {
  id: string;
  issueId: string;
  body: string;
  createdAt: string;
  user: { name: string };
}

export interface LinearFakeOptions {
  teamKey?: string;
  states?: FakeState[];
  labels?: Array<{ id: string; name: string }>;
  /** Who `issueCreate` records as creator. */
  viewer?: { name: string; email: string | null };
  /** The workspace's users, for assignees. */
  users?: FakeUser[];
  /** Answers for any non-API URL (images). */
  files?: Record<string, string>;
  /** File names whose presigned upload (the PUT after `fileUpload`) fails. */
  rejectUploads?: string[];
  /** Lists Linear reports as cut off (more pages), e.g. 'team.labels'. */
  truncated?: Array<
    | 'team.states'
    | 'team.labels'
    | 'issue.labels'
    | 'issue.children'
    | 'issue.comments'
  >;
  /** How many issues a page of `issues` holds (Linear's `first`, 50 here). */
  issuesPageSize?: number;
  /**
   * Answer every GraphQL request with this error, the way Linear reports most
   * refusals: an HTTP 400 whose real reason is `errors[].extensions.code`.
   */
  refuse?: {
    status: number;
    code: string;
    message: string;
    /** Only this operation is refused (every one when not given). */
    operation?: string;
  };
}

/** The six statuses a Pawnee team uses, in Linear's terms. */
export const PAWNEE_STATES: FakeState[] = [
  { id: 'st-backlog', name: 'Backlog', type: 'backlog' },
  { id: 'st-todo', name: 'Todo', type: 'unstarted' },
  { id: 'st-progress', name: 'In Progress', type: 'started' },
  { id: 'st-blocked', name: 'Blocked', type: 'started' },
  { id: 'st-done', name: 'Done', type: 'completed' },
  { id: 'st-canceled', name: 'Canceled', type: 'canceled' },
];

/** `tickets.statuses` naming PAWNEE_STATES. */
export const PAWNEE_STATUSES = {
  planning: 'Backlog',
  ready: 'Todo',
  building: 'In Progress',
  blocked: 'Blocked',
  done: 'Done',
  canceled: 'Canceled',
};

const RequestBody = z.object({
  query: z.string(),
  variables: z.record(z.unknown()).optional(),
});

const Input = z.record(z.unknown());

/** Linear refuses any query its estimate puts over this. */
export const LINEAR_MAX_COMPLEXITY = 10_000;

const TOKEN =
  /"(?:[^"\\]|\\.)*"|\.\.\.|\$?[A-Za-z_][A-Za-z0-9_]*|-?\d+(?:\.\d+)?|[{}():,!=[\]]/g;

/** Skips a balanced `( … )` at `at`, keeping its own `first: <n>`. */
const readArgs = (
  tokens: string[],
  at: number
): { first: number | undefined; at: number } => {
  const scan = (
    depth: number,
    index: number,
    first: number | undefined
  ): { first: number | undefined; at: number } => {
    const token = tokens[index];

    if (token === undefined) {
      throw new Error('The query has an unclosed (.');
    }

    if (token === ')' && depth === 1) {
      return { first, at: index + 1 };
    }

    const value = tokens[index + 2] ?? '';
    const found =
      depth === 1 &&
      token === 'first' &&
      tokens[index + 1] === ':' &&
      /^\d+$/.test(value)
        ? Number(value)
        : first;
    const opens = token === '(' || token === '{' ? 1 : 0;
    const closes = token === ')' || token === '}' ? 1 : 0;

    return scan(depth + opens - closes, index + 1, found);
  };

  return tokens[at] === '('
    ? scan(1, at + 1, undefined)
    : { first: undefined, at };
};

interface Selection {
  cost: number;
  fields: string[];
  at: number;
}

const readField = (
  tokens: string[],
  at: number
): { name: string; cost: number; at: number } => {
  const name = tokens[at];

  if (name === undefined) {
    throw new Error('The query has an unclosed {.');
  }

  const args = readArgs(tokens, at + 1);

  if (tokens[args.at] !== '{') {
    return { name, cost: 0.1, at: args.at };
  }

  const selection = readSelection(tokens, args.at);
  const connection =
    args.first !== undefined || selection.fields.includes('nodes');

  return {
    name,
    cost: 1 + (connection ? args.first ?? 50 : 1) * selection.cost,
    at: selection.at,
  };
};

const readSelection = (tokens: string[], at: number): Selection => {
  const scan = (index: number, cost: number, fields: string[]): Selection => {
    if (tokens[index] === '}') {
      return { cost, fields, at: index + 1 };
    }

    const field = readField(tokens, index);

    return scan(field.at, cost + field.cost, [...fields, field.name]);
  };

  return scan(at + 1, 0, []);
};

/**
 * Linear's documented estimate: each scalar field 0.1, each object 1, and a
 * connection multiplies what it holds by its `first` (50 when not given).
 */
export const queryComplexity = (query: string): number => {
  const tokens = Array.from(query.matchAll(TOKEN), (match) => match[0]);
  const start = tokens.indexOf('{');

  if (start === -1) {
    throw new Error('The query has no selection.');
  }

  return Math.round(readSelection(tokens, start).cost * 10) / 10;
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const headerRecord = (init: RequestInit | undefined): Record<string, string> =>
  init?.headers === undefined
    ? {}
    : Object.fromEntries(new Headers(init.headers).entries());

const urlOf = (input: string | URL | Request): string =>
  input instanceof Request ? input.url : input.toString();

export const createLinearFake = (options: LinearFakeOptions = {}) => {
  const teamKey = options.teamKey ?? 'PAWNEE';
  const states = options.states ?? PAWNEE_STATES;
  const labels = options.labels ?? [
    { id: 'lb-planned', name: 'Planned' },
    { id: 'lb-bug', name: 'Bug' },
  ];
  const viewer = options.viewer ?? {
    name: 'Leslie Knope',
    email: 'leslie@pawnee.gov',
  };
  const users = options.users ?? [
    { id: 'user-leslie', name: 'Leslie Knope', email: 'leslie@pawnee.gov' },
    { id: 'user-ann', name: 'Ann Perkins', email: 'ann@pawnee.gov' },
  ];
  const page = (list: string): { pageInfo: { hasNextPage: boolean } } => ({
    pageInfo: {
      hasNextPage: (options.truncated ?? []).some((name) => name === list),
    },
  });

  const db: {
    issues: FakeIssue[];
    relations: FakeRelation[];
    comments: FakeComment[];
    requests: FakeRequest[];
    uploads: FakeUpload[];
    /** What `attachmentCreate` linked to an issue. */
    attachments: Array<{ issueId: string; url: string; title: string }>;
    /** Presigned URL → what `fileUpload` was asked for. */
    presigned: Map<
      string,
      { filename: string; contentType: string; assetUrl: string }
    >;
  } = {
    issues: [],
    relations: [],
    comments: [],
    requests: [],
    uploads: [],
    attachments: [],
    presigned: new Map(),
  };

  /** What Linear's `issues` list returns: not trashed, not archived. */
  const live = (): FakeIssue[] =>
    db.issues.filter(
      (issue) =>
        !issue.trashed && issue.archivedAt === null && issue.team === teamKey
    );
  /** `issue(id:)`, like Linear, finds trashed and archived issues too. */
  const find = (id: unknown): FakeIssue | undefined =>
    db.issues.find((issue) => issue.id === id || issue.identifier === id);

  /**
   * A page of the relations pointing at `issue`, as Linear cuts it:
   * `inverseRelations(first: n)` (50 by default), resumed after a cursor.
   */
  const relationsPage = (
    issue: FakeIssue,
    query: string,
    after: unknown = null
  ) => {
    const first = Number(
      /inverseRelations\(first: (\d+)/.exec(query)?.[1] ?? 50
    );
    const start = typeof after === 'string' ? Number(after) : 0;
    const all = db.relations.filter(
      (relation) => relation.relatedIssueId === issue.id
    );
    const end = start + first;
    const more = end < all.length;

    return {
      nodes: all.slice(start, end).map((relation) => {
        const blocker = db.issues.find(
          (other) => other.id === relation.issueId
        );

        if (blocker === undefined) {
          throw new Error(`Fake has no issue ${relation.issueId}.`);
        }

        return {
          id: relation.id,
          type: relation.type,
          issue: {
            identifier: blocker.identifier,
            archivedAt: blocker.archivedAt,
            trashed: blocker.trashed,
            state: states.find((state) => state.id === blocker.stateId),
          },
        };
      }),
      pageInfo: { hasNextPage: more, endCursor: more ? String(end) : null },
    };
  };

  const render = (issue: FakeIssue, query: string) => {
    const state = states.find((candidate) => candidate.id === issue.stateId);
    const parent = live().find((other) => other.id === issue.parentId);

    return {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description,
      trashed: issue.trashed,
      archivedAt: issue.archivedAt,
      team: { key: issue.team },
      url: `https://linear.app/pawnee/issue/${issue.identifier}`,
      sortOrder: issue.sortOrder,
      subIssueSortOrder: issue.subIssueSortOrder,
      state,
      labels: {
        nodes: labels.filter((label) => issue.labelIds.includes(label.id)),
        ...page('issue.labels'),
      },
      parent:
        parent === undefined
          ? null
          : { id: parent.id, identifier: parent.identifier },
      children: {
        nodes: live()
          .filter((child) => child.parentId === issue.id)
          .map((child) => ({
            identifier: child.identifier,
            subIssueSortOrder: child.subIssueSortOrder,
          })),
        ...page('issue.children'),
      },
      inverseRelations: relationsPage(issue, query),
      creator: issue.creator,
      priority: issue.priority,
      assignee: users.find((user) => user.id === issue.assigneeId) ?? null,
    };
  };

  /** Seed an issue directly; returns it. */
  const add = (
    seed: Partial<FakeIssue> & { identifier: string; title: string }
  ): FakeIssue => {
    const issue: FakeIssue = {
      id: `uuid-${seed.identifier}`,
      description: '',
      stateId: 'st-todo',
      labelIds: [],
      parentId: null,
      sortOrder: db.issues.length + 1,
      subIssueSortOrder: null,
      creator: viewer,
      trashed: false,
      archivedAt: null,
      team: teamKey,
      priority: 0,
      assigneeId: null,
      ...seed,
    };
    db.issues = [...db.issues, issue];

    return issue;
  };

  /** Seed a comment directly, by someone other than the viewer by default. */
  const addComment = (
    identifier: string,
    body: string,
    user: { name: string } = { name: 'Ron Swanson' }
  ): void => {
    const issue = find(identifier);

    if (issue === undefined) {
      throw new Error(`Fake has no issue ${identifier}.`);
    }

    db.comments = [
      ...db.comments,
      {
        id: `comment-${db.comments.length + 1}`,
        issueId: issue.id,
        body,
        createdAt: new Date(
          Date.UTC(2026, 9, 22, 10) + (db.comments.length + 1) * 1000
        ).toISOString(),
        user,
      },
    ];
  };

  /**
   * Linear's auto-close: a parent whose last open child leaves (detached or
   * trashed), so every child it still has is done, closes on its own.
   */
  const autoClose = (parentId: string): void => {
    const parent = db.issues.find((issue) => issue.id === parentId);
    const done = states.find((state) => state.type === 'completed');
    const children = live().filter((issue) => issue.parentId === parentId);
    const closed = (issue: FakeIssue): boolean =>
      ['completed', 'canceled'].includes(
        states.find((state) => state.id === issue.stateId)?.type ?? ''
      );

    if (
      parent === undefined ||
      done === undefined ||
      children.length === 0 ||
      closed(parent) ||
      !children.every(closed)
    ) {
      return;
    }

    parent.stateId = done.id;
  };

  const success = (key: string) => json({ data: { [key]: { success: true } } });

  // Invented from Linear's docs, not recorded: see the header of
  // contract.test.ts for why no recording can be made.
  const notFound = () =>
    json({ data: null, errors: [{ message: 'Entity not found: Issue' }] });

  const nextNumber = (): number =>
    Math.max(
      0,
      ...db.issues.map((issue) =>
        Number(/-(\d+)$/.exec(issue.identifier)?.[1] ?? 0)
      )
    ) + 1;

  /** A page of comments as Linear cuts it: `comments(first: n)`, 50 by default. */
  const commentsPage = (query: string, comments: FakeComment[]) => {
    const first = Number(/comments\(first: (\d+)/.exec(query)?.[1] ?? 50);
    const cut =
      comments.length > first ||
      (options.truncated ?? []).includes('issue.comments');

    return {
      nodes: comments.slice(0, first),
      pageInfo: { hasNextPage: cut },
    };
  };

  const parentOf = (issue: FakeIssue | undefined): FakeIssue | undefined =>
    issue?.parentId === null || issue === undefined
      ? undefined
      : db.issues.find((one) => one.id === issue.parentId);
  const hasLabel = (issue: FakeIssue | undefined, name: string): boolean =>
    issue !== undefined &&
    labels.some(
      (label) => label.name === name && issue.labelIds.includes(label.id)
    );
  /** Labelled, or under an epic (or an epic's epic) that is. */
  const isMember = (issue: FakeIssue, name: string): boolean =>
    hasLabel(issue, name) ||
    hasLabel(parentOf(issue), name) ||
    hasLabel(parentOf(parentOf(issue)), name);

  /** A page of `issues`, as Linear cuts it, resumed after a cursor. */
  const issuesPage = (
    issues: FakeIssue[],
    variables: Record<string, unknown>,
    query: string
  ): Response => {
    const size =
      options.issuesPageSize ??
      Number(/issues\(first: (\d+)/.exec(query)?.[1] ?? 50);
    const start =
      typeof variables.after === 'string' ? Number(variables.after) : 0;
    const end = start + size;
    const more = end < issues.length;

    return json({
      data: {
        issues: {
          nodes: issues.slice(start, end).map((issue) => render(issue, query)),
          pageInfo: {
            hasNextPage: more,
            endCursor: more ? String(end) : null,
          },
        },
      },
    });
  };

  const handlers: Record<
    string,
    (variables: Record<string, unknown>, query: string) => Response
  > = {
    LambdaTeam: (variables) =>
      json({
        data: {
          teams: {
            nodes:
              variables.key === teamKey
                ? [
                    {
                      id: 'team-1',
                      key: teamKey,
                      states: { nodes: states, ...page('team.states') },
                      labels: { nodes: labels, ...page('team.labels') },
                    },
                  ]
                : [],
          },
        },
      }),
    LambdaIssues: (variables, query) => issuesPage(live(), variables, query),
    // Only the member label's issues, and those under an epic (or an epic's
    // epic) that has it: Linear's `or` of `labels` and `parent.labels`.
    LambdaMemberIssues: (variables, query) =>
      issuesPage(
        live().filter((issue) => isMember(issue, String(variables.label))),
        variables,
        query
      ),
    LambdaMembership: (variables) => {
      const issue = find(variables.id);
      const named = (one: FakeIssue | undefined) =>
        one === undefined
          ? null
          : {
              labels: {
                nodes: labels.filter((label) =>
                  one.labelIds.includes(label.id)
                ),
              },
            };
      const parent = parentOf(issue);

      return issue === undefined
        ? notFound()
        : json({
            data: {
              issue: {
                ...named(issue),
                parent:
                  parent === undefined
                    ? null
                    : { ...named(parent), parent: named(parentOf(parent)) },
              },
            },
          });
    },
    LambdaIssue: (variables, query) => {
      const issue = find(variables.id);

      return issue === undefined
        ? notFound()
        : json({ data: { issue: render(issue, query) } });
    },
    LambdaRelations: (variables, query) => {
      const issue = find(variables.id);

      return issue === undefined
        ? notFound()
        : json({
            data: {
              issue: {
                inverseRelations: relationsPage(issue, query, variables.after),
              },
            },
          });
    },
    LambdaComments: (variables, query) => {
      const issue = find(variables.id);

      return issue === undefined
        ? notFound()
        : json({
            data: {
              issue: {
                comments: commentsPage(
                  query,
                  db.comments.filter((comment) => comment.issueId === issue.id)
                ),
              },
            },
          });
    },
    LambdaBlockMarkers: (variables, query) => {
      const issue = find(variables.id);
      const filtered = query.includes('startsWith: $marker');

      return issue === undefined
        ? notFound()
        : json({
            data: {
              issue: {
                comments: commentsPage(
                  query,
                  db.comments.filter(
                    (comment) =>
                      comment.issueId === issue.id &&
                      (!filtered ||
                        comment.body.startsWith(String(variables.marker)))
                  )
                ),
              },
            },
          });
    },
    LambdaCreate: (variables) => {
      const input = Input.parse(variables.input);
      const parentId =
        typeof input.parentId === 'string' ? input.parentId : null;
      const siblings = live().filter((issue) => issue.parentId === parentId);
      const issue = add({
        identifier: `${teamKey}-${nextNumber()}`,
        title: String(input.title),
        description:
          typeof input.description === 'string' ? input.description : '',
        stateId: String(input.stateId),
        parentId,
        sortOrder: Math.max(0, ...live().map((other) => other.sortOrder)) + 1,
        subIssueSortOrder: parentId === null ? null : siblings.length + 1,
        creator: viewer,
        priority: typeof input.priority === 'number' ? input.priority : 0,
        assigneeId:
          typeof input.assigneeId === 'string' ? input.assigneeId : null,
        labelIds: Array.isArray(input.labelIds)
          ? input.labelIds.map(String)
          : [],
      });

      return json({
        data: {
          issueCreate: {
            success: true,
            issue: { identifier: issue.identifier },
          },
        },
      });
    },
    LambdaUsers: (variables) => {
      const who = String(variables.who).toLowerCase();

      return json({
        data: {
          users: {
            nodes: users.filter(
              (user) =>
                user.email.toLowerCase() === who ||
                user.name.toLowerCase() === who
            ),
          },
        },
      });
    },
    LambdaUpdate: (variables) => {
      const issue = find(variables.id);

      if (issue === undefined) {
        return notFound();
      }

      const before = issue.parentId;
      Object.assign(issue, Input.parse(variables.input));

      if (before !== null && issue.parentId !== before) {
        autoClose(before);
      }

      return success('issueUpdate');
    },
    LambdaComment: (variables) => {
      const issue = find(variables.issueId);

      if (issue === undefined) {
        return notFound();
      }

      addComment(issue.identifier, String(variables.body), {
        name: viewer.name,
      });

      return success('commentCreate');
    },
    LambdaAttachmentCreate: (variables) => {
      const issue = find(variables.issueId);

      if (issue === undefined) {
        return notFound();
      }

      db.attachments = [
        ...db.attachments,
        {
          issueId: issue.id,
          url: String(variables.url),
          title: String(variables.title),
        },
      ];

      return success('attachmentCreate');
    },
    LambdaFileUpload: (variables) => {
      const n = db.presigned.size + 1;
      const filename = String(variables.filename);
      const assetUrl = `https://uploads.linear.app/pawnee/${n}/${filename}`;
      const uploadUrl = `https://storage.pawnee.test/put/${n}`;
      db.presigned.set(uploadUrl, {
        filename,
        contentType: String(variables.contentType),
        assetUrl,
      });

      return json({
        data: {
          fileUpload: {
            success: true,
            uploadFile: {
              assetUrl,
              uploadUrl,
              headers: [{ key: 'x-goog-meta-park', value: 'pawnee' }],
            },
          },
        },
      });
    },
    LambdaRelate: (variables) => {
      db.relations = [
        ...db.relations,
        {
          id: `relation-${db.relations.length + 1}`,
          type: 'blocks',
          issueId: String(variables.blocker),
          relatedIssueId: String(variables.blocked),
        },
      ];

      return success('issueRelationCreate');
    },
    LambdaUnrelate: (variables) => {
      db.relations = db.relations.filter(
        (relation) => relation.id !== variables.id
      );

      return success('issueRelationDelete');
    },
    LambdaTrash: (variables) => {
      const issue = find(variables.id);

      if (issue === undefined) {
        return notFound();
      }

      issue.trashed = true;

      if (issue.parentId !== null) {
        autoClose(issue.parentId);
      }

      return success('issueDelete');
    },
  };

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = urlOf(input);
    const headers = headerRecord(init);

    if (url !== 'https://api.linear.app/graphql') {
      db.requests = [
        ...db.requests,
        { url, operation: undefined, variables: {}, headers },
      ];
      const presigned = db.presigned.get(url);

      if (presigned !== undefined && init?.method === 'PUT') {
        if ((options.rejectUploads ?? []).includes(presigned.filename)) {
          return new Response('upload refused', { status: 500 });
        }

        const body = Buffer.from(
          init.body instanceof Uint8Array ? init.body : String(init.body ?? '')
        ).toString('utf8');
        db.uploads = [...db.uploads, { ...presigned, headers, body }];

        return new Response('', { status: 200 });
      }

      const uploaded = db.uploads.find((one) => one.assetUrl === url);

      if (uploaded !== undefined) {
        return new Response(uploaded.body, { status: 200 });
      }

      const file = options.files?.[url];

      return file === undefined
        ? new Response('missing', { status: 404 })
        : new Response(file, { status: 200 });
    }

    const body = RequestBody.parse(JSON.parse(String(init?.body ?? '{}')));
    const operation = /(?:query|mutation)\s+(\w+)/.exec(body.query)?.[1];
    const variables = body.variables ?? {};
    const complexity = queryComplexity(body.query);
    db.requests = [
      ...db.requests,
      { url, operation, variables, headers, complexity },
    ];

    if (complexity > LINEAR_MAX_COMPLEXITY) {
      return json(
        {
          errors: [
            {
              message: 'Query too complex',
              extensions: {
                code: 'QUERY_TOO_COMPLEX',
                complexity,
                maxComplexity: LINEAR_MAX_COMPLEXITY,
              },
            },
          ],
        },
        400
      );
    }

    // Invented, not recorded: see the header of contract.test.ts for why no
    // recording of Linear's responses can be made.
    if (
      options.refuse !== undefined &&
      (options.refuse.operation === undefined ||
        options.refuse.operation === operation)
    ) {
      return json(
        {
          errors: [
            {
              message: options.refuse.message,
              extensions: { code: options.refuse.code },
            },
          ],
        },
        options.refuse.status
      );
    }

    const handler = operation === undefined ? undefined : handlers[operation];

    if (handler === undefined) {
      return json({ errors: [{ message: `Fake has no ${operation}` }] });
    }

    return handler(variables, body.query);
  };

  /**
   * Seed a relation directly (`blocks` unless given), as Linear's own UI can
   * make one between teams (Lambda's `block` refuses another team's blocker).
   */
  const relate = (
    blocker: FakeIssue,
    blocked: FakeIssue,
    type = 'blocks'
  ): void => {
    db.relations = [
      ...db.relations,
      {
        id: `relation-${db.relations.length + 1}`,
        type,
        issueId: blocker.id,
        relatedIssueId: blocked.id,
      },
    ];
  };

  return {
    fetch,
    add,
    addComment,
    relate,
    get issues(): FakeIssue[] {
      return db.issues;
    },
    get relations(): FakeRelation[] {
      return db.relations;
    },
    get comments(): FakeComment[] {
      return db.comments;
    },
    get requests(): FakeRequest[] {
      return db.requests;
    },
    /** Files put to a presigned upload URL, in order. */
    get uploads(): FakeUpload[] {
      return db.uploads;
    },
    /** Files `attachmentCreate` linked to an issue, in order. */
    get attachments(): Array<{ issueId: string; url: string; title: string }> {
      return db.attachments;
    },
    /** Only the GraphQL operations, in order. */
    operations: (): string[] =>
      db.requests
        .map((request) => request.operation)
        .filter((operation): operation is string => operation !== undefined),
  };
};

export type LinearFake = ReturnType<typeof createLinearFake>;
