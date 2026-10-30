/**
 * Linear as a ticket source, over Linear's GraphQL API.
 *
 * Status and label names come from the project's `tickets.statuses` and
 * `tickets.labels`; the team from `tickets.team`. Queue order is Linear's
 * manual order: top-level issues by `sortOrder`, children by
 * `subIssueSortOrder`. "Blocked by" is a Linear `blocks` relation.
 *
 * The key is sent only to api.linear.app, and with an image only when its
 * host (port included) is exactly uploads.linear.app. No message ever includes it.
 */
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';

import { type TicketState, statusNameOf } from '../config/projectConfig';
import { type SourceContext, pulledDir } from './context';
import { type FilterContext, translateIssueFilter } from './linearViews';
import {
  type Attached,
  BLOCK_MARKER,
  type CommentOptions,
  type CreateInput,
  type ListOptions,
  PRIORITIES,
  type Priority,
  TICKET_STATES,
  type Ticket,
  type TicketSource,
  type TicketWithDescription,
  type TrackerFavorite,
  type TrackerProject,
  type TrackerView,
  type UpdateInput,
  assertTicketId,
  attachImages,
  attachableFile,
  attachedName,
  blockMarkerComment,
  checkReorder,
  filterByReporter,
  findNext,
  httpError,
  parsePriority,
  placeAfter,
  pulledImages,
  pushedImagesNote,
  readBlockMarker,
  resolveLinearKey,
  rewriteImageLinks,
  sameName,
  stillHasChildren,
  trackerStatusOf,
  unknownTicket,
  withImages,
} from './source';

export const LINEAR_API_URL = 'https://api.linear.app/graphql';
const LINEAR_UPLOADS_HOST = 'uploads.linear.app';

// ── queries ─────────────────────────────────────────────────────────────────

/**
 * What `list` and `next` read of every issue, kept flat: Linear refuses a
 * query whose estimated cost passes 10,000 (each object 1, each scalar 0.1, a
 * connection multiplies what it holds by its `first`), and a page of issues
 * multiplies all of this by its own `first`. Comments are read only where
 * they're needed: a blocked ticket's reason, and `pull`.
 */
const RELATION_FIELDS = `
  id
  type
  issue { identifier archivedAt trashed state { id name type } }
`;

const ISSUE_FIELDS = `
  id
  identifier
  title
  url
  sortOrder
  subIssueSortOrder
  state { id name type }
  labels(first: 20) { nodes { id name } pageInfo { hasNextPage } }
  parent { id identifier }
  priority
  updatedAt
  assignee { id name email }
  project { id name }
  inverseRelations(first: 20) {
    nodes { ${RELATION_FIELDS} }
    pageInfo { hasNextPage endCursor }
  }
  creator { name email }
`;

/** The workspace's saved views (the team's and everyone's). */
const VIEWS_QUERY = `
  query LambdaViews {
    customViews(first: 100) {
      nodes { id name description icon shared filterData team { key } }
    }
  }
`;

const ViewsResponse = z.object({
  customViews: z.object({
    nodes: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        description: z.string().nullable().optional(),
        icon: z.string().nullable().optional(),
        shared: z.boolean().nullable().optional(),
        filterData: z.unknown(),
        team: z.object({ key: z.string() }).nullable().optional(),
      })
    ),
  }),
});

/** Linear users by id: who a view's assignee filter names. */
const USERS_BY_ID_QUERY = `
  query LambdaUsersById($ids: [ID!]) {
    users(first: 100, filter: { id: { in: $ids } }) {
      nodes { id name email }
    }
  }
`;

const UsersByIdResponse = z.object({
  users: z.object({
    nodes: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        email: z.string().nullable().optional(),
      })
    ),
  }),
});

/** The key's own user's favorites. */
const FAVORITES_QUERY = `
  query LambdaFavorites {
    favorites(first: 100) {
      nodes {
        type
        sortOrder
        customView { id }
        project { name }
        issue { identifier }
      }
    }
  }
`;

const FavoritesResponse = z.object({
  favorites: z.object({
    nodes: z.array(
      z.object({
        type: z.string(),
        sortOrder: z.number(),
        customView: z.object({ id: z.string() }).nullable().optional(),
        project: z.object({ name: z.string() }).nullable().optional(),
        issue: z.object({ identifier: z.string() }).nullable().optional(),
      })
    ),
  }),
});

/** The team's projects, for the Projects page and the picker. */
const PROJECTS_QUERY = `
  query LambdaProjects($key: String!) {
    teams(first: 1, filter: { key: { eq: $key } }) {
      nodes {
        projects(first: 100) {
          nodes {
            id
            name
            icon
            color
            progress
            targetDate
            url
            description
            status { name type }
            lead { name }
          }
        }
      }
    }
  }
`;

const ProjectsResponse = z.object({
  teams: z.object({
    nodes: z.array(
      z.object({
        projects: z.object({
          nodes: z.array(
            z.object({
              id: z.string(),
              name: z.string(),
              icon: z.string().nullable().optional(),
              color: z.string().nullable().optional(),
              progress: z.number().nullable().optional(),
              targetDate: z.string().nullable().optional(),
              url: z.string().nullable().optional(),
              description: z.string().nullable().optional(),
              status: z
                .object({ name: z.string(), type: z.string() })
                .nullable()
                .optional(),
              lead: z.object({ name: z.string() }).nullable().optional(),
            })
          ),
        }),
      })
    ),
  }),
});

const TEAM_QUERY = `
  query LambdaTeam($key: String!) {
    teams(first: 1, filter: { key: { eq: $key } }) {
      nodes {
        id
        key
        states(first: 250) { nodes { id name type } pageInfo { hasNextPage } }
        labels(first: 250) { nodes { id name } pageInfo { hasNextPage } }
      }
    }
  }
`;

const ISSUES_QUERY = `
  query LambdaIssues($team: String!, $after: String) {
    issues(first: 50, after: $after, filter: { team: { key: { eq: $team } } }) {
      nodes { ${ISSUE_FIELDS} }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

/**
 * Only Lambda's tickets (tickets.lambdaLabel): labelled, or under an epic
 * (or an epic's epic) that is. The rest of the team never leaves Linear.
 */
const MEMBER_ISSUES_QUERY = `
  query LambdaMemberIssues($team: String!, $label: String!, $after: String) {
    issues(
      first: 50
      after: $after
      filter: {
        team: { key: { eq: $team } }
        or: [
          { labels: { some: { name: { eq: $label } } } }
          { parent: { labels: { some: { name: { eq: $label } } } } }
          { parent: { parent: { labels: { some: { name: { eq: $label } } } } } }
        ]
      }
    ) {
      nodes { ${ISSUE_FIELDS} }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const ISSUE_QUERY = `
  query LambdaIssue($id: String!) {
    issue(id: $id) {
      ${ISSUE_FIELDS}
      description
      trashed
      team { key }
      children(first: 50) {
        nodes { identifier subIssueSortOrder }
        pageInfo { hasNextPage }
      }
    }
  }
`;

/** An issue's labels, and its epic's and that epic's: is it Lambda's? */
const MEMBERSHIP_QUERY = `
  query LambdaMembership($id: String!) {
    issue(id: $id) {
      labels(first: 100) { nodes { name } }
      parent {
        labels(first: 100) { nodes { name } }
        parent { labels(first: 100) { nodes { name } } }
      }
    }
  }
`;

const LabelNames = z.object({
  labels: z.object({ nodes: z.array(z.object({ name: z.string() })) }),
});

const MembershipResponse = z.object({
  issue: LabelNames.extend({
    parent: LabelNames.extend({
      parent: LabelNames.nullable().optional(),
    })
      .nullable()
      .optional(),
  }).nullable(),
});

/** The rest of one issue's relations, after the page the issue came with. */
const RELATIONS_QUERY = `
  query LambdaRelations($id: String!, $after: String) {
    issue(id: $id) {
      inverseRelations(first: 100, after: $after) {
        nodes { ${RELATION_FIELDS} }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

/** Only Lambda's own block markers, so a busy issue's comments never count. */
const BLOCK_MARKERS_QUERY = `
  query LambdaBlockMarkers($id: String!, $marker: String!) {
    issue(id: $id) {
      comments(first: 100, filter: { body: { startsWith: $marker } }) {
        nodes { body createdAt }
        pageInfo { hasNextPage }
      }
    }
  }
`;

const COMMENTS_QUERY = `
  query LambdaComments($id: String!) {
    issue(id: $id) {
      comments(first: 250) {
        nodes { id body createdAt user { name } }
        pageInfo { hasNextPage }
      }
    }
  }
`;

/** A user an assignee names, by email or name. */
const USERS_QUERY = `
  query LambdaUsers($who: String!) {
    users(
      first: 5
      filter: {
        or: [
          { email: { eqIgnoreCase: $who } }
          { name: { eqIgnoreCase: $who } }
          { displayName: { eqIgnoreCase: $who } }
        ]
      }
    ) {
      nodes { id name email }
    }
  }
`;

const CREATE_MUTATION = `
  mutation LambdaCreate($input: IssueCreateInput!) {
    issueCreate(input: $input) { success issue { identifier } }
  }
`;

const UPDATE_MUTATION = `
  mutation LambdaUpdate($id: String!, $input: IssueUpdateInput!) {
    issueUpdate(id: $id, input: $input) { success }
  }
`;

const COMMENT_MUTATION = `
  mutation LambdaComment($issueId: String!, $body: String!) {
    commentCreate(input: { issueId: $issueId, body: $body }) { success }
  }
`;

const RELATE_MUTATION = `
  mutation LambdaRelate($blocker: String!, $blocked: String!) {
    issueRelationCreate(
      input: { issueId: $blocker, relatedIssueId: $blocked, type: blocks }
    ) { success }
  }
`;

const UNRELATE_MUTATION = `
  mutation LambdaUnrelate($id: String!) {
    issueRelationDelete(id: $id) { success }
  }
`;

/** A presigned upload URL for one file, and the asset URL it becomes. */
const FILE_UPLOAD_MUTATION = `
  mutation LambdaFileUpload($contentType: String!, $filename: String!, $size: Int!) {
    fileUpload(contentType: $contentType, filename: $filename, size: $size) {
      success
      uploadFile { assetUrl uploadUrl headers { key value } }
    }
  }
`;

const ATTACHMENT_MUTATION = `
  mutation LambdaAttachmentCreate($issueId: String!, $url: String!, $title: String!) {
    attachmentCreate(input: { issueId: $issueId, url: $url, title: $title }) { success }
  }
`;

const TRASH_MUTATION = `
  mutation LambdaTrash($id: String!) {
    issueDelete(id: $id) { success }
  }
`;

// ── shapes ──────────────────────────────────────────────────────────────────

const nodes = <T extends z.ZodTypeAny>(schema: T) =>
  z.object({
    nodes: z.array(schema),
    pageInfo: z.object({ hasNextPage: z.boolean() }),
  });

/**
 * A list Linear cut off is refused rather than read short: a missing label
 * would be dropped on the next write, a missing blocker would let `next` run
 * a ticket early.
 */
const whole = (list: { pageInfo: { hasNextPage: boolean } }, what: string) => {
  if (list.pageInfo.hasNextPage) {
    throw new Error(
      `Linear has more ${what} than Lambda reads in one go, so it stopped rather than work from part of them.`
    );
  }
};

const StateSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
});
const LabelSchema = z.object({ id: z.string(), name: z.string() });

const TeamSchema = z.object({
  id: z.string(),
  key: z.string(),
  states: nodes(StateSchema),
  labels: nodes(LabelSchema),
});

const RelationsSchema = z.object({
  nodes: z.array(
    z.object({
      id: z.string(),
      type: z.string(),
      issue: z.object({
        identifier: z.string(),
        archivedAt: z.string().nullable(),
        trashed: z.boolean().nullable(),
        state: StateSchema,
      }),
    })
  ),
  pageInfo: z.object({
    hasNextPage: z.boolean(),
    endCursor: z.string().nullable(),
  }),
});

const UserSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().nullable().optional(),
});

const UsersResponse = z.object({
  users: z.object({ nodes: z.array(UserSchema) }),
});

/** Linear's priority numbers: 0 is no priority. */
const LINEAR_PRIORITY: Record<Priority, number> = {
  none: 0,
  urgent: 1,
  high: 2,
  medium: 3,
  low: 4,
};

const lambdaPriority = (value: number | null | undefined): Priority =>
  PRIORITIES.find((priority) => LINEAR_PRIORITY[priority] === value) ?? 'none';

const IssueSchema = z.object({
  id: z.string(),
  identifier: z.string(),
  title: z.string(),
  url: z.string().nullable(),
  sortOrder: z.number(),
  subIssueSortOrder: z.number().nullable(),
  state: StateSchema,
  labels: nodes(LabelSchema),
  parent: z.object({ id: z.string(), identifier: z.string() }).nullable(),
  priority: z.number().nullable().optional(),
  updatedAt: z.string().nullable().optional(),
  assignee: UserSchema.nullable().optional(),
  project: z.object({ id: z.string(), name: z.string() }).nullable().optional(),
  inverseRelations: RelationsSchema,
  creator: z
    .object({ name: z.string(), email: z.string().nullable().optional() })
    .nullable(),
});

/** One issue read on its own: with what the list leaves out. */
const FullIssueSchema = IssueSchema.extend({
  description: z.string().nullable(),
  trashed: z.boolean().nullable(),
  team: z.object({ key: z.string() }),
  children: nodes(
    z.object({
      identifier: z.string(),
      subIssueSortOrder: z.number().nullable(),
    })
  ),
});

const CommentSchema = z.object({
  id: z.string(),
  body: z.string(),
  createdAt: z.string(),
  user: z.object({ name: z.string() }).nullable(),
});

// Filtered to one key, so never more than a page.
const TeamsResponse = z.object({
  teams: z.object({ nodes: z.array(TeamSchema) }),
});
const IssuesResponse = z.object({
  issues: z.object({
    nodes: z.array(IssueSchema),
    pageInfo: z.object({
      hasNextPage: z.boolean(),
      endCursor: z.string().nullable(),
    }),
  }),
});
const IssueResponse = z.object({ issue: FullIssueSchema.nullable() });
const RelationsResponse = z.object({
  issue: z.object({ inverseRelations: RelationsSchema }).nullable(),
});
const BlockMarkersResponse = z.object({
  issue: z
    .object({
      comments: nodes(z.object({ body: z.string(), createdAt: z.string() })),
    })
    .nullable(),
});
const CommentsResponse = z.object({
  issue: z.object({ comments: nodes(CommentSchema) }).nullable(),
});
const FileUploadResponse = z.object({
  fileUpload: z.object({
    success: z.boolean(),
    uploadFile: z
      .object({
        assetUrl: z.string(),
        uploadUrl: z.string(),
        headers: z.array(z.object({ key: z.string(), value: z.string() })),
      })
      .nullable(),
  }),
});

/** The content type `fileUpload` is told; anything not a picture is bytes. */
const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
};

const CreateResponse = z.object({
  issueCreate: z.object({
    success: z.boolean(),
    issue: z.object({ identifier: z.string() }).nullable(),
  }),
});
const MutationResponse = z.record(
  z.object({ success: z.boolean() }).nullable()
);
const GraphqlError = z.object({
  message: z.string(),
  extensions: z.object({ code: z.string().optional() }).optional(),
});

const GraphqlResponse = z.object({
  data: z.unknown().optional(),
  errors: z.array(GraphqlError).optional(),
});

/** Linear's codes for a key it won't take (it sends them on an HTTP 400). */
const REFUSED_KEY_CODES = ['AUTHENTICATION_ERROR', 'FORBIDDEN'];

const parseErrors = (body: string): Array<z.infer<typeof GraphqlError>> => {
  try {
    return GraphqlResponse.parse(JSON.parse(body)).errors ?? [];
  } catch {
    return [];
  }
};

/**
 * What Linear's GraphQL errors mean, whatever the HTTP status carried them: a
 * refused key or an unknown id. Anything else is for the caller to report.
 */
const knownRefusal = (
  errors: Array<z.infer<typeof GraphqlError>>,
  status: number,
  id: string | undefined
): Error | undefined => {
  if (
    errors.some((error) =>
      REFUSED_KEY_CODES.includes(error.extensions?.code ?? '')
    )
  ) {
    return new Error(`Linear refused the key (${status}).`);
  }

  if (id !== undefined && errors.some((e) => /not found/i.test(e.message))) {
    return unknownTicket(id);
  }

  return undefined;
};

type LinearState = z.infer<typeof StateSchema>;
type LinearTeam = z.infer<typeof TeamSchema>;
type LinearIssue = z.infer<typeof IssueSchema>;
type FullIssue = z.infer<typeof FullIssueSchema>;

/** A Linear state Lambda's map doesn't name, read by its kind. */
const STATE_BY_TYPE: Record<string, TicketState> = {
  triage: 'inbox',
  backlog: 'planning',
  unstarted: 'ready',
  started: 'building',
  completed: 'done',
  canceled: 'canceled',
};

// ── the source ──────────────────────────────────────────────────────────────

export const createLinearSource = (context: SourceContext): TicketSource => {
  const { config } = context;
  const statuses = config.statuses ?? {};
  const labelNames = config.labels ?? {};
  /** The label that makes a ticket Lambda's; never shown as a label. */
  const memberLabel = config.lambdaLabel;
  const assigneeUsers = config.assignees ?? {};
  const teamCache = new Map<string, Promise<LinearTeam>>();

  const request = async <T>(
    query: string,
    variables: Record<string, unknown>,
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
    id?: string
  ): Promise<T> => {
    const key = resolveLinearKey(context.tokens, context.env);
    const response = await context.fetch(LINEAR_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: key },
      body: JSON.stringify({ query, variables }),
    });

    if (!response.ok) {
      const refusal = knownRefusal(
        parseErrors(await response.clone().text()),
        response.status,
        id
      );

      throw refusal ?? (await httpError('Linear', response, id));
    }

    const result = GraphqlResponse.parse(await response.json());
    const errors = result.errors ?? [];

    if (errors.length > 0) {
      const refusal = knownRefusal(errors, response.status, id);

      if (refusal !== undefined) {
        throw refusal;
      }

      throw new Error(
        `Linear answered: ${errors.map((error) => error.message).join('; ')}`
      );
    }

    if (result.data === undefined || result.data === null) {
      throw new Error('Linear answered with no data.');
    }

    const parsed = schema.safeParse(result.data);

    if (!parsed.success) {
      throw new Error(
        `Linear answered in a shape Lambda doesn't read: ${parsed.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; ')}`
      );
    }

    return parsed.data;
  };

  const mutate = async (
    query: string,
    variables: Record<string, unknown>,
    what: string
  ): Promise<void> => {
    const data = await request(query, variables, MutationResponse);

    if (Object.values(data)[0]?.success !== true) {
      throw new Error(`Linear refused to ${what}.`);
    }
  };

  const teamKey = (): string => {
    if (config.team === undefined) {
      throw new Error(
        'tickets.team isn\'t set in lambda.json: name the Linear team\'s key, e.g. "PAWNEE".'
      );
    }

    return config.team;
  };

  const team = (): Promise<LinearTeam> => {
    const key = teamKey();
    const cached = teamCache.get(key);

    if (cached !== undefined) {
      return cached;
    }

    const loaded = request(TEAM_QUERY, { key }, TeamsResponse).then(
      ({ teams }) => {
        const [found] = teams.nodes;

        if (found === undefined) {
          throw new Error(
            `Linear has no team with the key ${key} (tickets.team).`
          );
        }

        whole(found.states, `team ${key}'s statuses`);
        whole(found.labels, `team ${key}'s labels`);

        return found;
      }
    );
    teamCache.set(key, loaded);
    // A failed load isn't kept: the next call asks Linear again.
    loaded.catch(() => teamCache.delete(key));

    return loaded;
  };

  /**
   * Every mapped status and label name exists in the team, checked once on
   * the first call of any method: a misspelt name is refused up front rather
   * than silently read by its kind.
   */
  const ready = (): Promise<LinearTeam> =>
    team().then((found) => {
      const missingState = TICKET_STATES.find(
        (state) =>
          statuses[state] !== undefined &&
          !found.states.nodes.some((s) => s.name === statuses[state])
      );

      if (missingState !== undefined) {
        throw missingStatus(found, missingState);
      }

      const missingLabel = [
        ...Object.keys(labelNames),
        ...(memberLabel === undefined ? [] : [memberLabel]),
      ].find(
        (key) =>
          !found.labels.nodes.some((l) => l.name === (labelNames[key] ?? key))
      );

      if (missingLabel !== undefined) {
        throw missingLabelError(found, missingLabel);
      }

      return found;
    });

  const missingStatus = (found: LinearTeam, state: TicketState): Error =>
    new Error(
      `Linear team ${teamKey()} has no status "${
        statuses[state] ?? state
      }" (tickets.statuses.${state}). Its statuses: ${found.states.nodes
        .map((candidate) => candidate.name)
        .join(', ')}.`
    );

  const missingLabelError = (found: LinearTeam, key: string): Error =>
    new Error(
      `Linear team ${teamKey()} has no label "${labelNames[key] ?? key}"${
        labelNames[key] !== undefined
          ? ` (tickets.labels.${key})`
          : key === memberLabel
          ? ' (tickets.lambdaLabel)'
          : ''
      }. Its labels: ${found.labels.nodes
        .map((candidate) => candidate.name)
        .join(', ')}.`
    );

  /** Lambda's state → the team's Linear state, refused when it's missing. */
  const linearState = async (state: TicketState): Promise<LinearState> => {
    const name = statusNameOf(statuses, state) ?? state;
    const loaded = await team();
    const found = loaded.states.nodes.find(
      (candidate) => candidate.name === name
    );

    if (found === undefined) {
      throw missingStatus(loaded, state);
    }

    return found;
  };

  const lambdaState = (state: LinearState): TicketState =>
    TICKET_STATES.find((candidate) => statuses[candidate] === state.name) ??
    STATE_BY_TYPE[state.type] ??
    'planning';

  /** Lambda label key → the team's Linear label, refused when it's missing. */
  const linearLabel = async (
    key: string
  ): Promise<{ id: string; name: string }> => {
    const name = labelNames[key] ?? key;
    const loaded = await team();
    const found = loaded.labels.nodes.find(
      (candidate) => candidate.name === name
    );

    if (found === undefined) {
      throw missingLabelError(loaded, key);
    }

    return found;
  };

  const lambdaLabel = (name: string): string =>
    Object.entries(labelNames).find(([, mapped]) => mapped === name)?.[0] ??
    name;

  /**
   * The rest of an issue's relations, page by page from `after`. Any type
   * counts toward Linear's page, so a busy issue's `related` and `duplicate`
   * links can push a `blocks` past the first one.
   */
  const relationsAfter = async (
    issue: LinearIssue,
    after: string | null
  ): Promise<LinearIssue['inverseRelations']['nodes']> => {
    if (after === null) {
      throw new Error(
        `Linear said ${issue.identifier} has more relations but gave no place to read on from.`
      );
    }

    const { issue: found } = await request(
      RELATIONS_QUERY,
      { id: issue.id, after },
      RelationsResponse,
      issue.identifier
    );

    if (found === null) {
      throw unknownTicket(issue.identifier);
    }

    const { nodes: page, pageInfo } = found.inverseRelations;

    return pageInfo.hasNextPage
      ? [...page, ...(await relationsAfter(issue, pageInfo.endCursor))]
      : page;
  };

  /**
   * An issue with every label and relation: labels Linear cut off are
   * refused (a write would drop the rest), relations are read to the end.
   */
  const wholeIssue = async <T extends LinearIssue>(issue: T): Promise<T> => {
    whole(issue.labels, `labels on ${issue.identifier}`);

    const { nodes: first, pageInfo } = issue.inverseRelations;

    if (!pageInfo.hasNextPage) {
      return issue;
    }

    return {
      ...issue,
      inverseRelations: {
        nodes: [...first, ...(await relationsAfter(issue, pageInfo.endCursor))],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    };
  };

  /** The latest block marker's reason, while the ticket is blocked. */
  const blockReasonOf = async (issue: LinearIssue): Promise<string | null> => {
    if (lambdaState(issue.state) !== 'blocked') {
      return null;
    }

    const { issue: found } = await request(
      BLOCK_MARKERS_QUERY,
      { id: issue.id, marker: BLOCK_MARKER },
      BlockMarkersResponse,
      issue.identifier
    );

    if (found === null) {
      throw unknownTicket(issue.identifier);
    }

    whole(found.comments, `block notes on ${issue.identifier}`);

    const latest = [...found.comments.nodes]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((comment) => readBlockMarker(comment.body))
      .filter((marker): marker is { reason: string | null } => marker !== null)
      .at(-1);

    return latest?.reason ?? null;
  };

  const same = sameName;

  /** The team's projects, read once per source. */
  const projectsCache: { loaded: Promise<TrackerProject[]> | null } = {
    loaded: null,
  };

  const projectsOfTeam = (): Promise<TrackerProject[]> => {
    if (projectsCache.loaded === null) {
      projectsCache.loaded = request(
        PROJECTS_QUERY,
        { key: teamKey() },
        ProjectsResponse
      ).then(({ teams }) =>
        (teams.nodes[0]?.projects.nodes ?? []).map((project) => ({
          id: project.id,
          name: project.name,
          icon: project.icon ?? null,
          color: project.color ?? null,
          status: project.status ?? null,
          progress: project.progress ?? null,
          lead: project.lead?.name ?? null,
          targetDate: project.targetDate ?? null,
          description: project.description ?? '',
          url: project.url ?? null,
        }))
      );
      projectsCache.loaded.catch(() => {
        projectsCache.loaded = null;
      });
    }

    return projectsCache.loaded;
  };

  /** The team's saved views (and the workspace's), in Lambda's filters. */
  const savedViews = async (): Promise<TrackerView[]> => {
    const [{ customViews }, projects] = await Promise.all([
      request(VIEWS_QUERY, {}, ViewsResponse),
      projectsOfTeam(),
    ]);
    const ours = customViews.nodes.filter(
      (view) =>
        view.team === null ||
        view.team === undefined ||
        view.team.key === teamKey()
    );
    const ids = [
      ...new Set(
        ours.flatMap(
          (view) =>
            JSON.stringify(view.filterData ?? {}).match(
              /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g
            ) ?? []
        )
      ),
    ];
    const users =
      ids.length === 0
        ? []
        : (await request(USERS_BY_ID_QUERY, { ids }, UsersByIdResponse)).users
            .nodes;
    const context: FilterContext = {
      assigneeOf: (userId) => {
        const user = users.find((one) => one.id === userId);

        return user === undefined ? null : computerOf(user);
      },
      labelKey: lambdaLabel,
      projectName: (projectId) =>
        projects.find((project) => project.id === projectId)?.name ?? null,
      stateOf: (nameOrType) =>
        TICKET_STATES.find((state) => statuses[state] === nameOrType) ??
        STATE_BY_TYPE[nameOrType] ??
        null,
      priorityOf: lambdaPriority,
    };

    return ours.map((view) => ({
      trackerId: view.id,
      name: view.name,
      description: view.description ?? '',
      icon: view.icon ?? null,
      shared: view.shared ?? false,
      ...translateIssueFilter(view.filterData, context),
    }));
  };

  /** The key's user's favorites: views, projects and tickets. */
  const savedFavorites = async (): Promise<TrackerFavorite[]> =>
    (await request(FAVORITES_QUERY, {}, FavoritesResponse)).favorites.nodes
      .flatMap((favorite): TrackerFavorite[] =>
        favorite.customView !== null && favorite.customView !== undefined
          ? [
              {
                kind: 'view',
                ref: favorite.customView.id,
                position: favorite.sortOrder,
              },
            ]
          : favorite.project !== null && favorite.project !== undefined
          ? [
              {
                kind: 'project',
                ref: favorite.project.name,
                position: favorite.sortOrder,
              },
            ]
          : favorite.issue !== null && favorite.issue !== undefined
          ? [
              {
                kind: 'ticket',
                ref: favorite.issue.identifier,
                position: favorite.sortOrder,
              },
            ]
          : []
      )
      .sort((a, b) => a.position - b.position);

  /** A project's id by its name (null: none), refused when the team has none such. */
  const linearProject = async (name: string | null): Promise<string | null> => {
    if (name === null || name.trim() === '') {
      return null;
    }

    const found = (await projectsOfTeam()).find(
      (project) => project.name.toLowerCase() === name.trim().toLowerCase()
    );

    if (found === undefined) {
      throw new Error(`${teamKey()} has no Linear project "${name}".`);
    }

    return found.id;
  };

  /** The computer a Linear user stands for (tickets.assignees), or null. */
  const computerOf = (
    user: z.infer<typeof UserSchema> | null
  ): string | null => {
    if (user === null) {
      return null;
    }

    return (
      Object.entries(assigneeUsers).find(
        ([, who]) => same(user.email, who) || same(user.name, who)
      )?.[0] ?? null
    );
  };

  /** A computer's Linear user id (null: unassigned), refused when unmapped. */
  const linearUser = async (
    computer: string | null
  ): Promise<string | null> => {
    if (computer === null) {
      return null;
    }

    const who = Object.entries(assigneeUsers).find(([name]) =>
      same(name, computer)
    )?.[1];

    if (who === undefined) {
      throw new Error(
        `${computer} has no Linear user: add it to tickets.assignees in lambda.json (the computer's or person's name → their Linear user's email).`
      );
    }

    const { users } = await request(USERS_QUERY, { who }, UsersResponse);
    const [found] = users.nodes;

    if (found === undefined) {
      throw new Error(
        `Linear has no user "${who}" (tickets.assignees.${computer}).`
      );
    }

    return found.id;
  };

  /**
   * `reasons: false` leaves blockReason null rather than read it: one request
   * per blocked ticket, which only list and get show.
   */
  const toTicket = async (
    issue: LinearIssue,
    children: string[],
    { reasons }: { reasons: boolean }
  ): Promise<Ticket> => ({
    id: issue.identifier,
    title: issue.title,
    status: lambdaState(issue.state),
    labels: issue.labels.nodes
      .filter((label) => label.name !== memberLabel)
      .map((label) => lambdaLabel(label.name)),
    parent: issue.parent?.identifier ?? null,
    children,
    blockedBy: issue.inverseRelations.nodes
      .filter((relation) => relation.type === 'blocks')
      .map((relation) => relation.issue.identifier),
    blockReason: reasons ? await blockReasonOf(issue) : null,
    reporter:
      issue.creator === null
        ? null
        : issue.creator.email === null || issue.creator.email === ''
        ? { name: issue.creator.name }
        : { name: issue.creator.name, email: issue.creator.email },
    url: issue.url,
    priority: lambdaPriority(issue.priority),
    assignee: computerOf(issue.assignee ?? null),
    updatedAt: issue.updatedAt ?? null,
    project: issue.project?.name ?? null,
    trackerStatus: trackerStatusOf(
      issue.state.name,
      lambdaState(issue.state),
      statuses
    ),
  });

  const fetchIssues = async (
    after: string | null = null
  ): Promise<LinearIssue[]> => {
    const { issues } = await request(
      memberLabel === undefined ? ISSUES_QUERY : MEMBER_ISSUES_QUERY,
      memberLabel === undefined
        ? { team: teamKey(), after }
        : { team: teamKey(), label: memberLabel, after },
      IssuesResponse
    );

    const page = await Promise.all(issues.nodes.map(wholeIssue));

    return issues.pageInfo.hasNextPage && issues.pageInfo.endCursor !== null
      ? [...page, ...(await fetchIssues(issues.pageInfo.endCursor))]
      : page;
  };

  /**
   * Every issue in queue order, raw (for the sort orders) and as tickets;
   * block reasons only when `reasons` is set.
   */
  const queue = async ({
    fetched,
    reasons = false,
  }: { fetched?: LinearIssue[]; reasons?: boolean } = {}): Promise<
    Array<{ issue: LinearIssue; ticket: Ticket }>
  > => {
    const issues = fetched ?? (await fetchIssues());
    const present = new Set(issues.map((issue) => issue.identifier));
    const childrenOf = (identifier: string): LinearIssue[] =>
      issues
        .filter((issue) => issue.parent?.identifier === identifier)
        .sort(
          (a, b) => (a.subIssueSortOrder ?? 0) - (b.subIssueSortOrder ?? 0)
        );
    const entry = async (issue: LinearIssue) => ({
      issue,
      ticket: await toTicket(
        issue,
        childrenOf(issue.identifier).map((child) => child.identifier),
        { reasons }
      ),
    });
    const tops = issues
      .filter((issue) => issue.parent === null)
      .sort((a, b) => a.sortOrder - b.sortOrder);
    const orphans = issues.filter(
      (issue) => issue.parent !== null && !present.has(issue.parent.identifier)
    );
    const subtree = (issue: LinearIssue): LinearIssue[] => [
      issue,
      ...childrenOf(issue.identifier).flatMap(subtree),
    ];

    return Promise.all([...tops, ...orphans].flatMap(subtree).map(entry));
  };

  /**
   * Blockers missing from the list: archived ones (Linear archives closed
   * issues on its own) and other teams' issues. Their status is read off the
   * relation, so a done blocker outside the list doesn't block forever. A
   * trashed one stays unknown, so it counts as not done.
   */
  const outsideBlockers = (issues: LinearIssue[]): Map<string, TicketState> => {
    const present = new Set(issues.map((issue) => issue.identifier));

    return new Map(
      issues
        .flatMap((issue) => issue.inverseRelations.nodes)
        .filter(
          (relation) =>
            relation.type === 'blocks' &&
            !present.has(relation.issue.identifier) &&
            relation.issue.trashed !== true
        )
        .map((relation): [string, TicketState] => [
          relation.issue.identifier,
          lambdaState(relation.issue.state),
        ])
    );
  };

  /**
   * One issue of this team. Linear's `issue(id:)` also finds trashed issues
   * (and lets them be edited) and other teams' issues: neither is a ticket of
   * this project.
   */
  const fetchIssue = async (id: string): Promise<FullIssue> => {
    const { issue } = await request(
      ISSUE_QUERY,
      { id: assertTicketId(id) },
      IssueResponse,
      id
    );

    if (
      issue === null ||
      issue.trashed === true ||
      issue.team.key !== teamKey()
    ) {
      throw unknownTicket(id);
    }

    whole(issue.children, `children under ${issue.identifier}`);

    return wholeIssue(issue);
  };

  const childrenOf = (issue: FullIssue): string[] =>
    [...issue.children.nodes]
      .sort((a, b) => (a.subIssueSortOrder ?? 0) - (b.subIssueSortOrder ?? 0))
      .map((child) => child.identifier);

  const getTicket = async (id: string): Promise<TicketWithDescription> => {
    const issue = await fetchIssue(id);

    return {
      ...(await toTicket(issue, childrenOf(issue), { reasons: true })),
      description: issue.description ?? '',
    };
  };

  const list = async (options: ListOptions = {}): Promise<Ticket[]> =>
    filterByReporter(
      (await queue({ reasons: true })).map((entry) => entry.ticket),
      options
    );

  const create = async (input: CreateInput): Promise<Ticket> => {
    const [{ id: teamId }, state, parent, assigneeId, labels, projectId] =
      await Promise.all([
        team(),
        linearState(input.status ?? 'inbox'),
        input.parent === undefined ? undefined : fetchIssue(input.parent),
        linearUser(input.assignee ?? null),
        // Everything Lambda makes is Lambda's: it gets the member label.
        Promise.all(
          [
            ...(input.labels ?? []),
            ...(memberLabel === undefined ? [] : [memberLabel]),
          ].map(linearLabel)
        ),
        linearProject(input.project ?? null),
      ]);
    const { issueCreate } = await request(
      CREATE_MUTATION,
      {
        input: {
          teamId,
          title: input.title,
          stateId: state.id,
          ...(input.description === undefined
            ? {}
            : { description: input.description }),
          ...(parent === undefined ? {} : { parentId: parent.id }),
          ...(input.priority === undefined
            ? {}
            : { priority: LINEAR_PRIORITY[parsePriority(input.priority)] }),
          ...(assigneeId === null ? {} : { assigneeId }),
          ...(projectId === null ? {} : { projectId }),
          ...(labels.length === 0
            ? {}
            : { labelIds: labels.map((label) => label.id) }),
        },
      },
      CreateResponse
    );

    if (!issueCreate.success || issueCreate.issue === null) {
      throw new Error(`Linear refused to create "${input.title}".`);
    }

    return getTicket(issueCreate.issue.identifier);
  };

  const update = async (id: string, input: UpdateInput): Promise<Ticket> => {
    const issue = await fetchIssue(id);
    const state =
      input.status === undefined ? undefined : await linearState(input.status);
    const added =
      input.labels === undefined
        ? []
        : await Promise.all(input.labels.map(linearLabel));
    const current = issue.labels.nodes.map((label) => label.id);
    const removed = new Set(
      issue.labels.nodes
        .filter((label) =>
          (input.removeLabels ?? []).includes(lambdaLabel(label.name))
        )
        .map((label) => label.id)
    );
    const labelIds = Array.from(
      new Set([...current, ...added.map((label) => label.id)])
    ).filter((labelId) => !removed.has(labelId));
    const labelsChanged =
      labelIds.length !== current.length ||
      labelIds.some((labelId) => !current.includes(labelId));
    const assigneeId =
      input.assignee === undefined
        ? undefined
        : await linearUser(input.assignee);
    const parentId =
      input.parent === undefined
        ? undefined
        : input.parent === null
        ? null
        : (await fetchIssue(input.parent)).id;
    const projectId =
      input.project === undefined
        ? undefined
        : await linearProject(input.project);
    const changes = {
      ...(state === undefined ? {} : { stateId: state.id }),
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.description === undefined
        ? {}
        : { description: input.description }),
      ...(input.priority === undefined
        ? {}
        : { priority: LINEAR_PRIORITY[parsePriority(input.priority)] }),
      ...(assigneeId === undefined ? {} : { assigneeId }),
      ...(parentId === undefined ? {} : { parentId }),
      ...(projectId === undefined ? {} : { projectId }),
      ...(labelsChanged ? { labelIds } : {}),
    };

    if (Object.keys(changes).length > 0) {
      await mutate(
        UPDATE_MUTATION,
        { id: issue.id, input: changes },
        `update ${issue.identifier}`
      );
    }

    if (input.status === 'blocked') {
      await mutate(
        COMMENT_MUTATION,
        { issueId: issue.id, body: blockMarkerComment(input.reason ?? null) },
        `comment on ${issue.identifier}`
      );
    }

    return getTicket(issue.identifier);
  };

  /**
   * Uploads a file through `fileUpload`: Linear hands out a presigned URL,
   * the file is PUT there (with Linear's headers, never the key), and the
   * asset URL is the ref.
   */
  const upload = async (filePath: string, name?: string): Promise<Attached> => {
    const file = attachableFile(filePath);
    const filename = attachedName(file, name);
    const contentType =
      CONTENT_TYPES[path.extname(file).toLowerCase()] ??
      'application/octet-stream';
    const body = fs.readFileSync(file);
    const { fileUpload } = await request(
      FILE_UPLOAD_MUTATION,
      { contentType, filename, size: body.length },
      FileUploadResponse
    );

    if (!fileUpload.success || fileUpload.uploadFile === null) {
      throw new Error(`Linear refused to take ${filename}.`);
    }

    const { assetUrl, uploadUrl, headers } = fileUpload.uploadFile;

    if (new URL(uploadUrl).protocol !== 'https:') {
      throw new Error(
        `Linear handed out an upload URL that isn't https for ${filename}; nothing sent.`
      );
    }

    const response = await context.fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(body.length),
        ...Object.fromEntries(headers.map(({ key, value }) => [key, value])),
      },
      body,
    });

    if (!response.ok) {
      throw new Error(
        `Linear's storage refused ${filename} (${response.status}); nothing attached.`
      );
    }

    return { ref: assetUrl };
  };

  const attach = async (
    id: string,
    filePath: string,
    name?: string
  ): Promise<Attached> => {
    const title = attachedName(attachableFile(filePath), name);
    const issue = await fetchIssue(id);
    const attached = await upload(filePath, name);
    // An upload alone is an asset no issue knows about.
    await mutate(
      ATTACHMENT_MUTATION,
      { issueId: issue.id, url: attached.ref, title },
      `attach ${title} to ${issue.identifier}`
    );

    return attached;
  };

  const comment = async (
    id: string,
    text: string,
    options: CommentOptions = {}
  ): Promise<void> => {
    const issue = await fetchIssue(id);
    const images = await attachImages(options.images ?? [], (file) =>
      upload(file)
    );

    await mutate(
      COMMENT_MUTATION,
      { issueId: issue.id, body: withImages(text, images) },
      `comment on ${issue.identifier}`
    );
  };

  /** If Linear moved the parent's status (its auto-close), put it back. */
  const restoreState = async (parent: FullIssue): Promise<void> => {
    const after = await fetchIssue(parent.identifier);

    if (after.state.id !== parent.state.id) {
      await mutate(
        UPDATE_MUTATION,
        { id: parent.id, input: { stateId: parent.state.id } },
        `put ${parent.identifier} back to ${parent.state.name}`
      );
    }
  };

  const messageOf = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

  /**
   * To Linear's trash. A child is detached first, then trashed, and only then
   * is the reason posted on its parent, so a refused trash leaves no false
   * note: the child goes back under its parent, and if that fails too both
   * failures are named. If detaching moved the parent's status (Linear's
   * auto-close), it is put back.
   */
  const remove = async (id: string, reason: string): Promise<void> => {
    const issue = await fetchIssue(id);
    const children = childrenOf(issue);

    if (children.length > 0) {
      throw stillHasChildren(issue.identifier, children);
    }

    const parent =
      issue.parent === null ? null : await fetchIssue(issue.parent.identifier);

    if (parent === null) {
      await mutate(
        TRASH_MUTATION,
        { id: issue.id },
        `delete ${issue.identifier}`
      );

      return;
    }

    await mutate(
      UPDATE_MUTATION,
      { id: issue.id, input: { parentId: null } },
      `detach ${issue.identifier}`
    );

    try {
      await mutate(
        TRASH_MUTATION,
        { id: issue.id },
        `delete ${issue.identifier}`
      );
    } catch (trashError) {
      try {
        await mutate(
          UPDATE_MUTATION,
          {
            id: issue.id,
            input: {
              parentId: parent.id,
              ...(issue.subIssueSortOrder === null
                ? {}
                : { subIssueSortOrder: issue.subIssueSortOrder }),
            },
          },
          `put ${issue.identifier} back under ${parent.identifier}`
        );
        await restoreState(parent);
      } catch (putBackError) {
        throw new Error(
          `Couldn't delete ${issue.identifier}: ${messageOf(
            trashError
          )} Putting it back under ${parent.identifier} failed too: ${messageOf(
            putBackError
          )} ${issue.identifier} is still live; check its parent and ${
            parent.identifier
          }'s status in Linear.`
        );
      }

      throw trashError;
    }

    await restoreState(parent);
    await mutate(
      COMMENT_MUTATION,
      {
        issueId: parent.id,
        body: `Deleted ${issue.identifier} ("${issue.title}"): ${reason}`,
      },
      `comment on ${parent.identifier}`
    );
  };

  const block = async (id: string, by: string): Promise<void> => {
    const [blocked, blocker] = await Promise.all([
      fetchIssue(id),
      fetchIssue(by),
    ]);
    const already = blocked.inverseRelations.nodes.some(
      (relation) =>
        relation.type === 'blocks' &&
        relation.issue.identifier === blocker.identifier
    );

    if (already) {
      return;
    }

    await mutate(
      RELATE_MUTATION,
      { blocker: blocker.id, blocked: blocked.id },
      `block ${blocked.identifier} by ${blocker.identifier}`
    );
  };

  const unblock = async (id: string, by: string): Promise<void> => {
    const blocked = await fetchIssue(id);
    // Only the id: the blocker may be trashed or another team's, and
    // unblocking is the way out.
    const blocker = assertTicketId(by);
    const relations = blocked.inverseRelations.nodes.filter(
      (relation) =>
        relation.type === 'blocks' && relation.issue.identifier === blocker
    );

    await relations.reduce(async (previous, relation) => {
      await previous;
      await mutate(
        UNRELATE_MUTATION,
        { id: relation.id },
        `unblock ${blocked.identifier}`
      );
    }, Promise.resolve());
  };

  const setOrders = async (
    entries: Array<{ id: string; order: number }>,
    field: 'sortOrder' | 'subIssueSortOrder'
  ): Promise<void> =>
    entries.reduce(async (previous, entry) => {
      await previous;
      await mutate(
        UPDATE_MUTATION,
        { id: entry.id, input: { [field]: entry.order } },
        'reorder'
      );
    }, Promise.resolve());

  const reorder = async (parent: string, order: string[]): Promise<void> => {
    order.forEach(assertTicketId);
    const all = await queue();
    const parentEntry = all.find((entry) => entry.ticket.id === parent);

    if (parentEntry === undefined) {
      throw unknownTicket(parent);
    }

    checkReorder(parent, parentEntry.ticket.children, order);
    await setOrders(
      order.map((id, index) => ({
        id: all.find((entry) => entry.ticket.id === id)?.issue.id ?? id,
        order: index + 1,
      })),
      'subIssueSortOrder'
    );
  };

  /**
   * The block goes between `after` and whatever followed it, at its level:
   * top-level by `sortOrder`, a parent's children by `subIssueSortOrder`.
   */
  const place = async (ids: string[], after: string): Promise<void> => {
    [...ids, after].forEach(assertTicketId);
    const all = await queue();
    const find = (id: string) => {
      const found = all.find((entry) => entry.ticket.id === id);

      if (found === undefined) {
        throw unknownTicket(id);
      }

      return found;
    };
    const anchor = find(after);
    const moving = ids.map(find);
    const level = anchor.ticket.parent;
    const misplaced = moving.filter((entry) => entry.ticket.parent !== level);

    if (misplaced.length > 0) {
      throw new Error(
        `${misplaced
          .map((entry) => entry.ticket.id)
          .join(
            ', '
          )} and ${after} aren't at the same level: place moves tickets among their siblings.`
      );
    }

    const field = level === null ? 'sortOrder' : 'subIssueSortOrder';
    const orderOf = (issue: LinearIssue): number =>
      (level === null ? issue.sortOrder : issue.subIssueSortOrder) ?? 0;
    const siblings = all.filter((entry) => entry.ticket.parent === level);
    const arranged = placeAfter(
      siblings.map((entry) => entry.ticket.id),
      ids,
      after
    );
    const nextId = arranged[arranged.indexOf(after) + ids.length + 1];
    const low = orderOf(anchor.issue);
    const high =
      nextId === undefined ? low + ids.length + 1 : orderOf(find(nextId).issue);
    const step = (high - low) / (ids.length + 1);

    await setOrders(
      moving.map((entry, index) => ({
        id: entry.issue.id,
        order: low + step * (index + 1),
      })),
      field
    );
  };

  // ── pull / push ───────────────────────────────────────────────────────────

  const IMAGE = /!\[([^\]]*)\]\(([^)\s]+)\)/g;
  const MAP_FILE = 'images.json';
  /** The pictures push uploaded: where each was and its content's hash. */
  const PUSHED_FILE = 'pushed.json';
  const PushedSchema = z.record(
    z.object({ file: z.string(), sha256: z.string() })
  );
  const sha256Of = (file: string): string =>
    createHash('sha256').update(fs.readFileSync(file)).digest('hex');

  /** Only Linear's own upload host ever sees the key, and only over https. */
  const imageHeaders = (url: string): Record<string, string> => {
    try {
      const parsed = new URL(url);

      return parsed.protocol === 'https:' && parsed.host === LINEAR_UPLOADS_HOST
        ? { Authorization: resolveLinearKey(context.tokens, context.env) }
        : {};
    } catch {
      return {};
    }
  };

  const imageName = (url: string, index: number): string => {
    const base = (() => {
      try {
        return path.posix.basename(new URL(url).pathname);
      } catch {
        return '';
      }
    })().replace(/[^A-Za-z0-9._-]/g, '');

    return `image-${index + 1}${
      /\.[A-Za-z0-9]+$/.test(base) ? base.slice(base.lastIndexOf('.')) : '.png'
    }`;
  };

  /** Downloads every web image; the text gets local names, the map the URLs. */
  const localizeImages = async (
    markdown: string,
    dir: string,
    taken: Record<string, string>
  ): Promise<{ text: string; map: Record<string, string> }> => {
    const urls = Array.from(markdown.matchAll(IMAGE), (match) => match[2] ?? '')
      .filter((url) => /^https?:\/\//.test(url))
      .filter((url, index, all) => all.indexOf(url) === index)
      .filter((url) => !Object.values(taken).includes(url));
    const map = await urls.reduce<Promise<Record<string, string>>>(
      async (sofar, url) => {
        const done = await sofar;
        // Numbered by the names handed out so far, so no two images share one.
        const name = imageName(url, Object.keys({ ...taken, ...done }).length);
        const response = await context.fetch(url, {
          headers: imageHeaders(url),
        });

        if (!response.ok) {
          throw new Error(
            `Couldn't download ${url} (${response.status}). Fix or remove that image in Linear and pull again.`
          );
        }

        fs.writeFileSync(
          path.join(dir, name),
          Buffer.from(await response.arrayBuffer())
        );

        return { ...done, [name]: url };
      },
      Promise.resolve({})
    );
    const all = { ...taken, ...map };
    const text = markdown.replace(IMAGE, (whole, alt: string, url: string) => {
      const local = Object.entries(all).find(([, remote]) => remote === url);

      return local === undefined ? whole : `![${alt}](${local[0]})`;
    });

    return { text, map: all };
  };

  const pull = async (id: string): Promise<string> => {
    const issue = await fetchIssue(id);
    const { issue: withComments } = await request(
      COMMENTS_QUERY,
      { id: issue.identifier },
      CommentsResponse,
      issue.identifier
    );

    if (withComments !== null) {
      whole(withComments.comments, `comments on ${issue.identifier}`);
    }

    const dir = pulledDir(context.root, issue.identifier);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });

    const description = await localizeImages(issue.description ?? '', dir, {});
    const comments = [...(withComments?.comments.nodes ?? [])].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt)
    );
    const commentText = await comments.reduce<
      Promise<{ parts: string[]; map: Record<string, string> }>
    >(async (sofar, item) => {
      const done = await sofar;
      const body = await localizeImages(item.body, dir, done.map);

      return {
        parts: [
          ...done.parts,
          `## ${item.user?.name ?? 'Someone'} · ${
            item.createdAt
          }\n\n${body.text.trim()}`,
        ],
        map: body.map,
      };
    }, Promise.resolve({ parts: [], map: description.map }));

    fs.writeFileSync(path.join(dir, 'description.md'), description.text);
    fs.writeFileSync(
      path.join(dir, 'comments.md'),
      comments.length === 0
        ? `# Comments for ${issue.identifier}\n\nNo comments.\n`
        : `# Comments for ${issue.identifier}\n\n${commentText.parts.join(
            '\n\n---\n\n'
          )}\n`
    );
    fs.writeFileSync(
      path.join(dir, MAP_FILE),
      `${JSON.stringify(commentText.map, null, 2)}\n`
    );

    return dir;
  };

  const commentBodies = async (id: string): Promise<string[]> => {
    const issue = await fetchIssue(id);
    const { issue: withComments } = await request(
      COMMENTS_QUERY,
      { id: issue.identifier },
      CommentsResponse,
      issue.identifier
    );

    return [...(withComments?.comments.nodes ?? [])]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((node) => node.body);
  };

  const push = async (id: string): Promise<string> => {
    const issue = await fetchIssue(id);
    const dir = pulledDir(context.root, issue.identifier);
    const file = path.join(dir, 'description.md');

    if (!fs.existsSync(file)) {
      throw new Error(
        `Nothing pulled for ${issue.identifier}: run lambda tickets pull ${issue.identifier} first.`
      );
    }

    const mapFile = path.join(dir, MAP_FILE);
    const pulledMap = fs.existsSync(mapFile)
      ? z.record(z.string()).parse(JSON.parse(fs.readFileSync(mapFile, 'utf8')))
      : {};
    // A picture this push uploaded before counts as known only while its
    // content is the same: a re-rendered one is uploaded again.
    const pushedFile = path.join(dir, PUSHED_FILE);
    const pushed = fs.existsSync(pushedFile)
      ? PushedSchema.parse(JSON.parse(fs.readFileSync(pushedFile, 'utf8')))
      : {};
    const changed = Object.entries(pushed)
      .filter(
        ([, entry]) =>
          fs.existsSync(entry.file) && sha256Of(entry.file) !== entry.sha256
      )
      .map(([src]) => src);
    const map = Object.fromEntries(
      Object.entries(pulledMap).filter(([src]) => !changed.includes(src))
    );
    const text = fs.readFileSync(file, 'utf8');
    // Refuses a missing in-folder picture before anything is sent.
    const pictures = pulledImages(issue.identifier, dir, text, map);
    const attached = await pictures.upload.reduce<
      Promise<Record<string, string>>
    >(
      async (sofar, picture) => ({
        ...(await sofar),
        [picture.src]: (await upload(picture.file)).ref,
      }),
      Promise.resolve({})
    );
    const description = rewriteImageLinks(text, { ...map, ...attached });

    await mutate(
      UPDATE_MUTATION,
      { id: issue.id, input: { description } },
      `update ${issue.identifier}`
    );
    // Known from now on, so pushing again doesn't upload them again.
    fs.writeFileSync(
      mapFile,
      `${JSON.stringify({ ...map, ...attached }, null, 2)}\n`
    );
    fs.writeFileSync(
      pushedFile,
      `${JSON.stringify(
        {
          ...pushed,
          ...Object.fromEntries(
            pictures.upload.map((picture) => [
              picture.src,
              { file: picture.file, sha256: sha256Of(picture.file) },
            ])
          ),
        },
        null,
        2
      )}\n`
    );

    return [
      `Pushed ${issue.identifier}'s description to Linear.`,
      ...pushedImagesNote(Object.keys(attached), pictures.left),
    ].join('\n');
  };

  /** Ids are checked before anything is sent; then the team, once. */
  const checked = async (ids: string[]): Promise<void> => {
    ids.forEach(assertTicketId);
    await ready();
  };

  /** Every ticket in queue order, and the blockers kept out of it. */
  const readQueue = async () => {
    await checked([]);

    const issues = await fetchIssues();
    const tickets = (await queue({ fetched: issues })).map(
      (entry) => entry.ticket
    );

    return { tickets, outside: outsideBlockers(issues) };
  };

  return {
    kind: 'linear',
    list: async (options) => {
      await checked([]);

      return list(options);
    },
    projects: () => projectsOfTeam(),
    views: () => savedViews(),
    favorites: () => savedFavorites(),
    isMember: async (id) => {
      if (memberLabel === undefined) {
        return true;
      }

      const { issue } = await request(
        MEMBERSHIP_QUERY,
        { id: assertTicketId(id) },
        MembershipResponse,
        id
      );

      return [issue, issue?.parent, issue?.parent?.parent].some(
        (one) =>
          one !== null &&
          one !== undefined &&
          one.labels.nodes.some((label) => label.name === memberLabel)
      );
    },
    get: async (id) => {
      await checked([id]);

      return getTicket(id);
    },
    pull: async (id) => {
      await checked([id]);

      return pull(id);
    },
    push: async (id) => {
      await checked([id]);

      return push(id);
    },
    create: async (input) => {
      await checked(input.parent === undefined ? [] : [input.parent]);

      return create(input);
    },
    update: async (id, input) => {
      await checked([id]);

      return update(id, input);
    },
    attach: async (id, filePath, options) => {
      await checked([id]);

      return attach(id, filePath, options?.name);
    },
    comment: async (id, text, options) => {
      await checked([id]);

      return comment(id, text, options);
    },
    comments: async (id) => {
      await checked([id]);

      return commentBodies(id);
    },
    delete: async (id, reason) => {
      await checked([id]);

      return remove(id, reason);
    },
    block: async (id, by) => {
      await checked([id, by]);

      return block(id, by);
    },
    unblock: async (id, by) => {
      await checked([id, by]);

      return unblock(id, by);
    },
    reorder: async (parent, order) => {
      await checked([parent, ...order]);

      return reorder(parent, order);
    },
    place: async (ids, after) => {
      await checked([...ids, after]);

      return place(ids, after);
    },
    // `next` decides from `queue`, so a building pod's queue can't drift.
    next: async (options = {}) => {
      const { tickets, outside } = await readQueue();

      return findNext(tickets, options, outside);
    },
    queue: readQueue,
  };
};
