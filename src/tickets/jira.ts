/**
 * Tickets in Jira Cloud (REST v3), signed in with an email + API token.
 *
 * Queue order is Jira's rank (`ORDER BY Rank ASC`); `reorder` and `place` use
 * the Jira Software rank endpoint. "A blocked by B" is a "Blocks" issue link
 * posted with B as `outwardIssue` and A as `inwardIssue` (the link runs from
 * B, "B blocks A"); each side's GET shows the other issue under the role it
 * plays for this one, so A sees B as its `inwardIssue` ("is blocked by").
 * Only issues in `tickets.project` are tickets. Descriptions and comments are ADF, converted
 * to and from markdown (`jira-adf.ts`). Every answer is checked against the
 * shape read from it before it's used.
 */
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';

import { statusNameOf } from '../config/projectConfig';
import { type SourceContext, pulledDir } from './context';
import {
  type AdfDoc,
  type AdfNode,
  adfToMarkdown,
  firstPlaceholder,
  markdownToAdf,
} from './jira-adf';
import {
  type Attached,
  type CommentOptions,
  type CreateInput,
  type ListOptions,
  PRIORITIES,
  type Priority,
  type Reporter,
  TICKET_STATES,
  type Ticket,
  type TicketSource,
  type TicketState,
  type TicketWithDescription,
  type UpdateInput,
  assertTicketId,
  attachImages,
  attachableFile,
  attachedName,
  blockMarkerComment,
  checkPlace,
  checkReorder,
  filterByReporter,
  findNext,
  httpError,
  parsePriority,
  pulledImages,
  pushedImagesNote,
  readBlockMarker,
  resolveJiraCredentials,
  rewriteImageLinks,
  sameName,
  stillHasChildren,
  trackerStatusOf,
  unknownTicket,
  withImages,
} from './source';

// ── the answers read from Jira ─────────────────────────────────────────────

const AdfMarkSchema = z
  .object({ type: z.string(), attrs: z.record(z.unknown()).optional() })
  .passthrough();

// Unknown keys are kept: a node markdown can't carry is pulled whole into a
// placeholder.
const AdfNodeSchema: z.ZodType<AdfNode, z.ZodTypeDef, unknown> = z.lazy(() =>
  z
    .object({
      type: z.string(),
      text: z.string().optional(),
      attrs: z.record(z.unknown()).optional(),
      marks: z.array(AdfMarkSchema).optional(),
      content: z.array(AdfNodeSchema).optional(),
    })
    .passthrough()
);

const StatusSchema = z.object({
  name: z.string(),
  statusCategory: z.object({ key: z.string().optional() }).optional(),
});

/** The other issue on a link, with the status Jira sends along with it. */
const LinkedIssueSchema = z.object({
  key: z.string(),
  fields: z.object({ status: StatusSchema.nullish() }).optional(),
});

const LinkSchema = z.object({
  id: z.string(),
  type: z.object({ name: z.string().optional() }).optional(),
  inwardIssue: LinkedIssueSchema.optional(),
  outwardIssue: LinkedIssueSchema.optional(),
});

const CommentSchema = z.object({
  id: z.string().optional(),
  author: z.object({ displayName: z.string().optional() }).nullish(),
  body: AdfNodeSchema.nullish(),
  created: z.string().optional(),
});

const IssueSchema = z.object({
  key: z.string(),
  fields: z.object({
    summary: z.string().nullish(),
    project: z.object({ key: z.string() }).nullish(),
    status: StatusSchema.nullish(),
    labels: z.array(z.string()).nullish(),
    parent: z.object({ key: z.string() }).nullish(),
    issuelinks: z.array(LinkSchema).nullish(),
    reporter: z
      .object({
        displayName: z.string().optional(),
        emailAddress: z.string().optional(),
      })
      .nullish(),
    priority: z.object({ name: z.string() }).nullish(),
    updated: z.string().nullish(),
    assignee: z
      .object({
        accountId: z.string().optional(),
        displayName: z.string().optional(),
        emailAddress: z.string().optional(),
      })
      .nullish(),
    description: AdfNodeSchema.nullish(),
    comment: z
      .object({
        comments: z.array(CommentSchema),
        total: z.number().optional(),
      })
      .nullish(),
    attachment: z
      .array(
        z.object({
          id: z.string().optional(),
          filename: z.string().optional(),
          content: z.string().optional(),
        })
      )
      .nullish(),
  }),
});

const SearchPageSchema = z.object({
  issues: z.array(IssueSchema),
  nextPageToken: z.string().optional(),
  isLast: z.boolean().optional(),
});

const ProjectStatusesSchema = z.array(
  z.object({ statuses: z.array(StatusSchema).optional() })
);

const TransitionsSchema = z.object({
  transitions: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      to: z.object({ name: z.string().optional() }).optional(),
    })
  ),
});

const IssueTypeSchema = z.object({
  id: z.string(),
  name: z.string(),
  subtask: z.boolean(),
});

const CreateMetaSchema = z.object({ issueTypes: z.array(IssueTypeSchema) });

const CreatedSchema = z.object({ key: z.string() });

/** What `POST …/attachments` answers: the files it took. */
const AttachmentsSchema = z
  .array(z.object({ content: z.string() }).passthrough())
  .min(1);

/** 204 with no body when every issue moved; 207 naming the ones that didn't. */
const RankSchema = z
  .object({
    entries: z
      .array(
        z.object({
          issueKey: z.string().optional(),
          status: z.number().optional(),
          errors: z.array(z.string()).optional(),
        })
      )
      .optional(),
  })
  .nullable();

/** An answer whose body isn't read (or there is none). */
const AnySchema = z.unknown();

type JiraStatus = z.infer<typeof StatusSchema>;
type JiraLink = z.infer<typeof LinkSchema>;
type JiraIssue = z.infer<typeof IssueSchema>;
type IssueType = z.infer<typeof IssueTypeSchema>;

/** What `list` and `next` read; comments only for a blocked issue. */
const LIST_FIELDS = [
  'summary',
  'status',
  'labels',
  'parent',
  'issuelinks',
  'reporter',
  'priority',
  'assignee',
  'updated',
];

/**
 * Jira's default priority names. Lowest is read as no priority, since Jira
 * gives every issue one; a name a project made up reads as none too.
 */
const JIRA_PRIORITY: Record<Priority, string> = {
  urgent: 'Highest',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  none: 'Lowest',
};

const priorityOfName = (name: string | undefined): Priority =>
  PRIORITIES.find(
    (priority) =>
      JIRA_PRIORITY[priority].toLowerCase() === (name ?? '').toLowerCase()
  ) ?? 'none';

const UserSearchSchema = z.array(
  z.object({ accountId: z.string(), emailAddress: z.string().optional() })
);

/** What one ticket's `get` and `pull` read. */
const TICKET_FIELDS = [...LIST_FIELDS, 'comment', 'description'];

const PAGE_SIZE = 100;
const RANK_BATCH = 50;
/** Blocked issues whose comments `list` reads at once. */
const COMMENT_READS = 5;

const CATEGORY_STATE: Record<string, TicketState> = {
  new: 'planning',
  indeterminate: 'building',
  done: 'done',
};

/** The link where `by` blocks this issue: `by` is its inward issue. */
const isBlockedBy = (
  link: JiraLink
): link is JiraLink & {
  inwardIssue: z.infer<typeof LinkedIssueSchema>;
} => link.type?.name === 'Blocks' && link.inwardIssue !== undefined;

const same = (a: string, b: string): boolean =>
  a.toLowerCase() === b.toLowerCase();

const chunks = <T>(items: T[], size: number): T[][] =>
  items.length <= size
    ? [items]
    : [items.slice(0, size), ...chunks(items.slice(size), size)];

/** `name` safe to write into the pulled folder, or null when none is left. */
const safeName = (name: string): string | null => {
  const clean = name.replace(/[^A-Za-z0-9._-]/g, '_');

  return clean === '' || clean === '.' || clean === '..' ? null : clean;
};

/**
 * A comment's text exactly as typed: its text nodes run together, a hard
 * break or a new paragraph as a line break. No markdown is read or written.
 */
const rawText = (node: AdfNode | null | undefined): string => {
  if (node === null || node === undefined) {
    return '';
  }

  if (node.type === 'text') {
    return node.text ?? '';
  }

  if (node.type === 'hardBreak') {
    return '\n';
  }

  return (node.content ?? [])
    .map(rawText)
    .join(node.type === 'doc' ? '\n' : '');
};

/** A comment holding `text` as one literal text node per line. */
const literalAdf = (text: string): AdfDoc => ({
  type: 'doc',
  version: 1,
  content: [
    {
      type: 'paragraph',
      content: text
        .split('\n')
        .flatMap((line, index) => [
          ...(index === 0 ? [] : [{ type: 'hardBreak' }]),
          ...(line === '' ? [] : [{ type: 'text', text: line }]),
        ]),
    },
  ],
});

export const createJiraSource = (context: SourceContext): TicketSource => {
  const { config } = context;
  const cache: { statuses?: Promise<void> } = {};

  const site = (): URL => {
    if (config.site === undefined) {
      throw new Error('A Jira source needs tickets.site in lambda.json.');
    }

    return new URL(config.site);
  };

  const projectKey = (): string => {
    if (config.project === undefined) {
      throw new Error('A Jira source needs tickets.project in lambda.json.');
    }

    return config.project;
  };

  const baseUrl = (): string => site().toString().replace(/\/+$/, '');

  const authorization = (): string => {
    const { email, apiToken } = resolveJiraCredentials(
      context.tokens,
      context.env
    );

    return `Basic ${Buffer.from(`${email}:${apiToken}`).toString('base64')}`;
  };

  const request = async <T>(
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
    method: string,
    route: string,
    body?: unknown,
    id?: string
  ): Promise<T> => {
    const auth = authorization();
    const response = await context.fetch(`${baseUrl()}${route}`, {
      method,
      headers: {
        Authorization: auth,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    if (!response.ok) {
      throw await httpError('Jira', response, id);
    }

    const where = route.split('?')[0] ?? route;
    const text = await response.text();
    const json = ((): unknown => {
      try {
        return JSON.parse(text === '' ? 'null' : text);
      } catch {
        throw new Error(
          `Jira sent an answer from ${where} that isn't JSON (a sign-in page?). Check tickets.site in lambda.json.`
        );
      }
    })();
    const parsed = schema.safeParse(json);

    if (!parsed.success) {
      throw new Error(`Jira sent an unexpected answer from ${where}.`);
    }

    return parsed.data;
  };

  // ── statuses and labels ──────────────────────────────────────────────────

  const mappedName = (state: TicketState): string => {
    const name = statusNameOf(config.statuses ?? {}, state);

    if (name === undefined) {
      throw new Error(
        `lambda.json: tickets.statuses has no name for "${state}".`
      );
    }

    return name;
  };

  /** Every mapped status must exist in the project; checked once. */
  const checkStatuses = async (): Promise<void> => {
    const key = projectKey();
    const types = await request(
      ProjectStatusesSchema,
      'GET',
      `/rest/api/3/project/${encodeURIComponent(key)}/statuses`
    );
    const names = Array.from(
      new Set(
        types.flatMap((type) =>
          (type.statuses ?? []).map((status) => status.name)
        )
      )
    );
    const missing = TICKET_STATES.find(
      (state) => !names.some((name) => same(name, mappedName(state)))
    );

    if (missing !== undefined) {
      throw new Error(
        `tickets.statuses.${missing} is "${mappedName(
          missing
        )}", but Jira project ${key} has no status by that name. Its statuses: ${names.join(
          ', '
        )}.`
      );
    }
  };

  const ready = (): Promise<void> => {
    if (cache.statuses === undefined) {
      cache.statuses = checkStatuses().catch((error: unknown) => {
        cache.statuses = undefined;

        throw error;
      });
    }

    return cache.statuses;
  };

  const stateOf = (status: JiraStatus | null | undefined): TicketState => {
    if (status === null || status === undefined) {
      return 'planning';
    }

    const mapped = TICKET_STATES.find((state) =>
      same(config.statuses?.[state] ?? '', status.name)
    );

    return (
      mapped ?? CATEGORY_STATE[status.statusCategory?.key ?? ''] ?? 'planning'
    );
  };

  const labelName = (key: string): string => config.labels?.[key] ?? key;

  /** The label that makes a ticket Lambda's; never shown as a label. */
  const memberLabel = config.lambdaLabel;

  /** A value quoted for JQL. */
  const jqlString = (value: string): string =>
    `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

  const labelKey = (name: string): string =>
    Object.entries(config.labels ?? {}).find(
      ([, mapped]) => mapped === name
    )?.[0] ?? name;

  // ── reading ──────────────────────────────────────────────────────────────

  /** The latest block marker's reason; a person's own comment never counts. */
  const blockReasonOf = (issue: JiraIssue): string | null =>
    (issue.fields.comment?.comments ?? [])
      .map((comment) => readBlockMarker(rawText(comment.body)))
      .filter((marker) => marker !== null)
      .at(-1)?.reason ?? null;

  const reporterOf = (issue: JiraIssue): Reporter | null => {
    const { reporter } = issue.fields;

    if (reporter === null || reporter === undefined) {
      return null;
    }

    const name = reporter.displayName ?? reporter.emailAddress;

    if (name === undefined) {
      return null;
    }

    return reporter.emailAddress === undefined
      ? { name }
      : { name, email: reporter.emailAddress };
  };

  const toTicket = (
    issue: JiraIssue,
    children: string[],
    parent: string | null = issue.fields.parent?.key ?? null
  ): Ticket => {
    const status = stateOf(issue.fields.status);

    return {
      id: issue.key,
      title: issue.fields.summary ?? '',
      status,
      labels: (issue.fields.labels ?? [])
        .filter((label) => label !== memberLabel)
        .map(labelKey),
      parent,
      children,
      blockedBy: (issue.fields.issuelinks ?? [])
        .filter(isBlockedBy)
        .map((link) => link.inwardIssue.key),
      blockReason: status === 'blocked' ? blockReasonOf(issue) : null,
      reporter: reporterOf(issue),
      url: `${baseUrl()}/browse/${issue.key}`,
      priority: priorityOfName(issue.fields.priority?.name),
      assignee: computerOf(issue.fields.assignee ?? null),
      updatedAt: issue.fields.updated ?? null,
      trackerStatus: trackerStatusOf(
        issue.fields.status?.name,
        status,
        config.statuses
      ),
    };
  };

  const same = sameName;

  /** The computer a Jira user stands for (tickets.assignees), or null. */
  const computerOf = (
    user: NonNullable<JiraIssue['fields']['assignee']> | null
  ): string | null =>
    user === null
      ? null
      : Object.entries(config.assignees ?? {}).find(
          ([, who]) =>
            same(user.accountId, who) ||
            same(user.emailAddress, who) ||
            same(user.displayName, who)
        )?.[0] ?? null;

  /** A computer's Jira account id (null: unassigned), refused when unmapped. */
  const jiraAccount = async (
    computer: string | null
  ): Promise<string | null> => {
    if (computer === null) {
      return null;
    }

    const who = Object.entries(config.assignees ?? {}).find(([name]) =>
      same(name, computer)
    )?.[1];

    if (who === undefined) {
      throw new Error(
        `${computer} has no Jira user: add it to tickets.assignees in lambda.json (the computer's or person's name → their Jira user's email or account id).`
      );
    }

    if (!who.includes('@')) {
      return who;
    }

    const [found] = await request(
      UserSearchSchema,
      'GET',
      `/rest/api/3/user/search?query=${encodeURIComponent(who)}`
    );

    if (found === undefined) {
      throw new Error(
        `Jira has no user "${who}" (tickets.assignees.${computer}).`
      );
    }

    return found.accountId;
  };

  const assign = async (id: string, computer: string | null): Promise<void> => {
    await request(
      AnySchema,
      'PUT',
      `/rest/api/3/issue/${encodeURIComponent(id)}/assignee`,
      { accountId: await jiraAccount(computer) },
      id
    );
  };

  const search = async (
    jql: string,
    fields: string[],
    token?: string
  ): Promise<JiraIssue[]> => {
    const page = await request(
      SearchPageSchema,
      'POST',
      '/rest/api/3/search/jql',
      {
        jql,
        fields,
        maxResults: PAGE_SIZE,
        ...(token === undefined ? {} : { nextPageToken: token }),
      }
    );
    const issues = page.issues ?? [];

    if (page.isLast === true || page.nextPageToken === undefined) {
      return issues;
    }

    return [...issues, ...(await search(jql, fields, page.nextPageToken))];
  };

  /** Children in this project only: one elsewhere isn't a ticket here. */
  const childKeys = async (id: string): Promise<string[]> =>
    (
      await search(
        `project = "${projectKey()}" AND parent = "${id}" ORDER BY Rank ASC`,
        ['summary']
      )
    ).map((issue) => issue.key);

  /**
   * One issue of this project. Another project's issue isn't a ticket here,
   * so nothing reads or writes it; a comment list Jira cut off is refused
   * rather than read short, as a missing block marker would change the reason.
   */
  const fetchIssue = async (
    id: string,
    fields: string[]
  ): Promise<JiraIssue> => {
    const issue = await request(
      IssueSchema,
      'GET',
      `/rest/api/3/issue/${encodeURIComponent(assertTicketId(id))}?fields=${[
        ...fields,
        'project',
      ].join(',')}`,
      undefined,
      id
    );

    const project = issue.fields.project?.key;

    if (project === undefined || !same(project, projectKey())) {
      throw unknownTicket(id);
    }

    const comments = issue.fields.comment;

    if (
      comments !== null &&
      comments !== undefined &&
      comments.total !== undefined &&
      comments.total > comments.comments.length
    ) {
      throw new Error(
        `Jira has more comments on ${issue.key} than Lambda reads in one go, so it stopped rather than work from part of them.`
      );
    }

    return issue;
  };

  const getTicket = async (id: string): Promise<TicketWithDescription> => {
    await ready();
    const issue = await fetchIssue(id, TICKET_FIELDS);

    return {
      ...toTicket(issue, await childKeys(issue.key)),
      description: adfToMarkdown(issue.fields.description),
    };
  };

  /**
   * Blockers outside the list (another project's issues), by the status Jira
   * sends on the link, so a done one there doesn't block forever.
   */
  const outsideBlockers = (issues: JiraIssue[]): Map<string, TicketState> => {
    const keys = new Set(issues.map((issue) => issue.key));

    return new Map(
      issues
        .flatMap((issue) => (issue.fields.issuelinks ?? []).filter(isBlockedBy))
        .filter((link) => !keys.has(link.inwardIssue.key))
        .flatMap((link) => {
          const status = link.inwardIssue.fields?.status;

          return status === null || status === undefined
            ? []
            : [[link.inwardIssue.key, stateOf(status)] as const];
        })
    );
  };

  /** A blocked issue with its comments, for the reason they hold. */
  const withComments = async (issue: JiraIssue): Promise<JiraIssue> =>
    stateOf(issue.fields.status) === 'blocked'
      ? {
          ...issue,
          fields: {
            ...issue.fields,
            comment: (await fetchIssue(issue.key, ['comment'])).fields.comment,
          },
        }
      : issue;

  /** `withComments` over every issue, a few requests at a time. */
  const allWithComments = (issues: JiraIssue[]): Promise<JiraIssue[]> =>
    chunks(issues, COMMENT_READS).reduce<Promise<JiraIssue[]>>(
      async (previous, batch) => [
        ...(await previous),
        ...(await Promise.all(batch.map(withComments))),
      ],
      Promise.resolve([])
    );

  /** The issues directly under `parents`, in rank order. */
  const childrenOf = (parents: JiraIssue[]): Promise<JiraIssue[]> =>
    parents.length === 0
      ? Promise.resolve([])
      : search(
          `project = "${projectKey()}" AND parent in (${parents
            .map((issue) => jqlString(issue.key))
            .join(', ')}) ORDER BY Rank ASC`,
          LIST_FIELDS
        );

  /**
   * The project's issues, or with tickets.lambdaLabel only Lambda's: those
   * labelled, and everything up to two levels under one that is (an epic's
   * tasks and their subtasks), as `isMember` looks two levels up. JQL has no
   * "parent has this label", so each level is a search of its own. In rank
   * order either way.
   */
  const memberIssues = async (): Promise<JiraIssue[]> => {
    if (memberLabel === undefined) {
      return search(
        `project = "${projectKey()}" ORDER BY Rank ASC`,
        LIST_FIELDS
      );
    }

    const labelled = await search(
      `project = "${projectKey()}" AND labels = ${jqlString(
        memberLabel
      )} ORDER BY Rank ASC`,
      LIST_FIELDS
    );
    const labelledKeys = new Set(labelled.map((issue) => issue.key));
    const children = (await childrenOf(labelled)).filter(
      (issue) => !labelledKeys.has(issue.key)
    );
    const childKeys = new Set(children.map((issue) => issue.key));
    const grandchildren = (await childrenOf(children)).filter(
      (issue) => !labelledKeys.has(issue.key) && !childKeys.has(issue.key)
    );

    return [...labelled, ...children, ...grandchildren];
  };

  /**
   * Every ticket, in rank order. Comments are read only where a reason is
   * wanted, a blocked issue, and only when `reasons` asks: `next` never does.
   */
  const listAll = async (
    reasons: boolean
  ): Promise<{
    tickets: Ticket[];
    outside: Map<string, TicketState>;
  }> => {
    await ready();
    const found = await memberIssues();
    const issues = reasons ? await allWithComments(found) : found;
    const keys = new Set(issues.map((issue) => issue.key));
    // A parent outside the project (an epic elsewhere) isn't in the list, so
    // the issue is read as top-level, its parent null, and `next` can reach it.
    const parentOf = (issue: JiraIssue): string | null => {
      const parent = issue.fields.parent?.key;

      return parent !== undefined && keys.has(parent) ? parent : null;
    };
    const flatten = (issue: JiraIssue): Ticket[] => {
      const children = issues.filter(
        (candidate) => parentOf(candidate) === issue.key
      );

      return [
        toTicket(
          issue,
          children.map((child) => child.key),
          parentOf(issue)
        ),
        ...children.flatMap(flatten),
      ];
    };

    return {
      tickets: issues
        .filter((issue) => parentOf(issue) === null)
        .flatMap(flatten),
      outside: outsideBlockers(issues),
    };
  };

  // ── writing ──────────────────────────────────────────────────────────────

  /**
   * The transition that takes `id` to `state` in one hop, or null when it's
   * already there; refused when none reaches it. Read before anything is
   * written, so a refused move changes nothing.
   */
  const planMove = async (
    id: string,
    state: TicketState,
    current?: JiraStatus | null
  ): Promise<string | null> => {
    const from = current ?? (await fetchIssue(id, ['status'])).fields.status;
    const target = mappedName(state);

    if (from !== null && from !== undefined && same(from.name, target)) {
      return null;
    }

    const { transitions } = await request(
      TransitionsSchema,
      'GET',
      `/rest/api/3/issue/${encodeURIComponent(id)}/transitions`,
      undefined,
      id
    );
    const transition = transitions.find((candidate) =>
      same(candidate.to?.name ?? '', target)
    );

    if (transition === undefined) {
      const options = transitions.map((candidate) => candidate.name);

      throw new Error(
        `Jira can't move ${id} to "${target}": no transition reaches it from "${
          from?.name ?? 'its status'
        }". Transitions from here: ${
          options.length === 0 ? 'none' : options.join(', ')
        }.`
      );
    }

    return transition.id;
  };

  const applyMove = async (
    id: string,
    transition: string | null
  ): Promise<void> => {
    if (transition === null) {
      return;
    }

    await request(
      AnySchema,
      'POST',
      `/rest/api/3/issue/${encodeURIComponent(id)}/transitions`,
      { transition: { id: transition } },
      id
    );
  };

  const addComment = async (id: string, body: AdfNode): Promise<void> => {
    await request(
      AnySchema,
      'POST',
      `/rest/api/3/issue/${encodeURIComponent(id)}/comment`,
      { body },
      id
    );
  };

  const issueTypes = async (): Promise<IssueType[]> => {
    const meta = await request(
      CreateMetaSchema,
      'GET',
      `/rest/api/3/issue/createmeta/${encodeURIComponent(
        projectKey()
      )}/issuetypes?maxResults=200`
    );

    return meta.issueTypes;
  };

  const pickType = (
    types: IssueType[],
    parent: string | undefined
  ): IssueType => {
    const names = types.map((type) => type.name).join(', ');
    const type =
      parent === undefined
        ? types.find((candidate) => same(candidate.name, 'Task'))
        : types.find((candidate) => candidate.subtask);

    if (type === undefined) {
      throw new Error(
        parent === undefined
          ? `Jira project ${projectKey()} has no "Task" issue type. Its types: ${names}.`
          : `Jira project ${projectKey()} has no sub-task issue type (subtask: true) for a child of ${parent}. Its types: ${names}.`
      );
    }

    return type;
  };

  const create = async (input: CreateInput): Promise<Ticket> => {
    // Everything Lambda makes is Lambda's: it gets the member label.
    const labels = [
      ...(input.labels ?? []).map(labelName),
      ...(memberLabel === undefined ? [] : [memberLabel]),
    ];
    await ready();

    if (input.parent !== undefined) {
      await fetchIssue(input.parent, ['summary']);
    }

    const type = pickType(await issueTypes(), input.parent);
    const created = await request(CreatedSchema, 'POST', '/rest/api/3/issue', {
      fields: {
        project: { key: projectKey() },
        summary: input.title,
        issuetype: { name: type.name },
        ...(input.parent === undefined
          ? {}
          : { parent: { key: input.parent } }),
        ...(input.description === undefined
          ? {}
          : { description: markdownToAdf(input.description) }),
        ...(input.priority === undefined
          ? {}
          : {
              priority: { name: JIRA_PRIORITY[parsePriority(input.priority)] },
            }),
        ...(labels.length === 0 ? {} : { labels }),
      },
    });

    // The issue exists from here on: a failure names it, so a rerun doesn't
    // make a second one.
    await planMove(created.key, input.status ?? 'inbox')
      .then((transition) => applyMove(created.key, transition))
      .then(() =>
        input.assignee === undefined || input.assignee === null
          ? undefined
          : assign(created.key, input.assignee)
      )
      .catch((error: unknown) => {
        throw new Error(
          `Created ${created.key}, but ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      });

    return getTicket(created.key);
  };

  const update = async (id: string, input: UpdateInput): Promise<Ticket> => {
    await ready();
    const issue = await fetchIssue(id, ['status', 'labels']);
    const labels = (input.labels ?? [])
      .map(labelName)
      .filter((label) => !(issue.fields.labels ?? []).includes(label));
    const removing = (input.removeLabels ?? [])
      .map(labelName)
      .filter((label) => (issue.fields.labels ?? []).includes(label));
    const fields = {
      ...(input.title === undefined ? {} : { summary: input.title }),
      ...(input.description === undefined
        ? {}
        : { description: markdownToAdf(input.description) }),
      ...(input.priority === undefined
        ? {}
        : { priority: { name: JIRA_PRIORITY[parsePriority(input.priority)] } }),
      ...(input.parent === undefined
        ? {}
        : { parent: input.parent === null ? null : { key: input.parent } }),
    };
    const labelEdits = [
      ...labels.map((label) => ({ add: label })),
      ...removing.map((label) => ({ remove: label })),
    ];
    const transition =
      input.status === undefined
        ? null
        : await planMove(id, input.status, issue.fields.status);

    if (Object.keys(fields).length > 0 || labelEdits.length > 0) {
      await request(
        AnySchema,
        'PUT',
        `/rest/api/3/issue/${encodeURIComponent(id)}`,
        {
          ...(Object.keys(fields).length === 0 ? {} : { fields }),
          ...(labelEdits.length === 0
            ? {}
            : { update: { labels: labelEdits } }),
        },
        id
      );
    }

    if (input.assignee !== undefined) {
      await assign(id, input.assignee);
    }

    await applyMove(id, transition);

    // Every move into blocked leaves a marker, reason or not, so the reason
    // read back is always this block's. Already blocked, only a new reason
    // replaces the old one.
    if (
      input.status === 'blocked' &&
      (transition !== null || input.reason !== undefined)
    ) {
      await addComment(
        id,
        literalAdf(blockMarkerComment(input.reason ?? null))
      );
    }

    return getTicket(id);
  };

  const blocksLinks = (issue: JiraIssue, by: string): JiraLink[] =>
    (issue.fields.issuelinks ?? [])
      .filter(isBlockedBy)
      .filter((link) => link.inwardIssue.key === by);

  const rank = async (
    issues: string[],
    anchor: { rankAfterIssue: string } | { rankBeforeIssue: string }
  ): Promise<void> => {
    const response = await request(
      RankSchema,
      'PUT',
      '/rest/agile/1.0/issue/rank',
      { issues, ...anchor }
    );
    const failed = (response?.entries ?? []).filter(
      (entry) => entry.status !== undefined && entry.status >= 300
    );

    if (failed.length > 0) {
      throw new Error(
        `Jira couldn't rank ${failed
          .map(
            (entry) =>
              `${entry.issueKey ?? '?'} (${(entry.errors ?? []).join('; ')})`
          )
          .join(', ')}.`
      );
    }
  };

  /** Ranks `order` one after another, starting right after `after`. */
  const rankAfter = async (order: string[], after: string): Promise<void> =>
    chunks(order, RANK_BATCH)
      .reduce<Promise<string>>(async (previous, batch) => {
        const anchor = await previous;
        await rank(batch, { rankAfterIssue: anchor });

        return batch.at(-1) ?? anchor;
      }, Promise.resolve(after))
      .then(() => undefined);

  // ── files and pictures ───────────────────────────────────────────────────

  /**
   * `POST /rest/api/3/issue/{key}/attachments`, multipart, with the
   * `X-Atlassian-Token: no-check` Jira's XSRF check asks for. The ref is the
   * attachment's `content` URL, linked from text (a link mark), never as a
   * media node.
   */
  const upload = async (
    id: string,
    filePath: string,
    name?: string
  ): Promise<Attached> => {
    const file = attachableFile(filePath);
    const form = new FormData();
    form.append(
      'file',
      new Blob([fs.readFileSync(file)]),
      attachedName(file, name)
    );
    const response = await context.fetch(
      `${baseUrl()}/rest/api/3/issue/${encodeURIComponent(id)}/attachments`,
      {
        method: 'POST',
        headers: {
          Authorization: authorization(),
          Accept: 'application/json',
          'X-Atlassian-Token': 'no-check',
        },
        body: form,
      }
    );

    if (!response.ok) {
      throw await httpError('Jira', response, id);
    }

    const parsed = AttachmentsSchema.safeParse(
      await response.json().catch(() => undefined)
    );

    if (!parsed.success) {
      throw new Error(
        `Jira sent an unexpected answer from /rest/api/3/issue/${id}/attachments.`
      );
    }

    return { ref: parsed.data[0]?.content ?? '' };
  };

  /**
   * A Jira upload is a visible attachment at once, so the pictures a push or
   * an image comment attached are remembered (by name and content) beside the
   * pulled ticket: a retry after a later picture failed attaches only what is
   * still missing.
   */
  const UPLOADED_FILE = 'uploaded.json';
  const uploadedFile = (id: string): string =>
    path.join(pulledDir(context.root, assertTicketId(id)), UPLOADED_FILE);
  const readUploaded = (id: string): Record<string, string> => {
    const file = uploadedFile(id);

    return fs.existsSync(file)
      ? z.record(z.string()).parse(JSON.parse(fs.readFileSync(file, 'utf8')))
      : {};
  };
  const uploadOnce = async (
    id: string,
    filePath: string
  ): Promise<Attached> => {
    const file = attachableFile(filePath);
    const key = `${attachedName(file)}:${createHash('sha256')
      .update(fs.readFileSync(file))
      .digest('hex')}`;
    const known = readUploaded(id)[key];

    if (known !== undefined) {
      return { ref: known };
    }

    const attached = await upload(id, file);
    const record = uploadedFile(id);
    fs.mkdirSync(path.dirname(record), { recursive: true });
    fs.writeFileSync(
      record,
      `${JSON.stringify(
        { ...readUploaded(id), [key]: attached.ref },
        null,
        2
      )}\n`
    );

    return attached;
  };

  const attach = async (
    id: string,
    filePath: string,
    name?: string
  ): Promise<Attached> => {
    attachedName(attachableFile(filePath), name);
    await ready();
    await fetchIssue(id, ['summary']);

    return upload(id, filePath, name);
  };

  const comment = async (
    id: string,
    text: string,
    options: CommentOptions = {}
  ): Promise<void> => {
    await ready();
    await fetchIssue(id, ['summary']);
    // Text ADF can't carry is refused before any upload.
    markdownToAdf(text);
    const images = await attachImages(options.images ?? [], (file) =>
      uploadOnce(id, file)
    );

    await addComment(id, markdownToAdf(withImages(text, images)));
  };

  // ── pull and push ────────────────────────────────────────────────────────

  const download = async (url: string): Promise<Buffer> => {
    const target = new URL(url);
    // The token goes only to the configured site, never to another host or
    // port.
    const sameSite =
      target.protocol === 'https:' && target.host === site().host;
    const response = await context.fetch(url, {
      method: 'GET',
      headers: sameSite ? { Authorization: authorization() } : {},
    });

    if (!response.ok) {
      throw await httpError('Jira', response);
    }

    return Buffer.from(await response.arrayBuffer());
  };

  const pull = async (id: string): Promise<string> => {
    await ready();
    const issue = await fetchIssue(id, [...TICKET_FIELDS, 'attachment']);
    const dir = pulledDir(context.root, assertTicketId(id));
    // A fresh folder each time, so nothing from an earlier pull lingers.
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'description.md'),
      `${adfToMarkdown(issue.fields.description)}\n`
    );
    const comments = (issue.fields.comment?.comments ?? []).map(
      (comment) =>
        `## ${comment.author?.displayName ?? 'Someone'}${
          comment.created === undefined ? '' : ` (${comment.created})`
        }\n\n${adfToMarkdown(comment.body)}`
    );
    fs.writeFileSync(
      path.join(dir, 'comments.md'),
      comments.length === 0 ? 'No comments.\n' : `${comments.join('\n\n')}\n`
    );

    const attachments = (issue.fields.attachment ?? []).map(
      (attachment, index) => ({
        ...attachment,
        name:
          safeName(path.basename(attachment.filename ?? '')) ??
          `attachment-${attachment.id ?? index}`,
      })
    );
    // Two attachments may share a name; those get their id in front.
    const shared = (name: string): boolean =>
      attachments.filter((attachment) => attachment.name === name).length > 1;

    if (attachments.length > 0) {
      const files = path.join(dir, 'attachments');
      fs.mkdirSync(files, { recursive: true });
      await Promise.all(
        attachments.map(async (attachment, index) => {
          if (attachment.content === undefined) {
            return;
          }

          // The id comes from Jira too, so the whole name is made safe.
          const name = shared(attachment.name)
            ? `${attachment.id ?? index}-${attachment.name}`
            : attachment.name;
          fs.writeFileSync(
            path.join(files, safeName(name) ?? `attachment-${index}`),
            await download(attachment.content)
          );
        })
      );
    }

    return dir;
  };

  const push = async (id: string): Promise<string> => {
    await ready();
    const file = path.join(
      pulledDir(context.root, assertTicketId(id)),
      'description.md'
    );

    if (!fs.existsSync(file)) {
      throw new Error(
        `Nothing pulled for ${id}: run lambda tickets pull ${id} first.`
      );
    }

    const markdown = fs.readFileSync(file, 'utf8').replace(/\n$/, '');
    const blocked = firstPlaceholder(markdown);

    if (blocked !== undefined) {
      throw new Error(
        `Can't push ${id}: its description holds a Jira "${blocked}" that markdown can't carry back. Edit that part in Jira, and leave the <!-- adf:${blocked}:… --> line as it is.`
      );
    }

    // Converted once first, so text ADF can't carry is refused before any
    // upload; and a missing in-folder picture before anything is sent.
    markdownToAdf(markdown);
    const pictures = pulledImages(id, path.dirname(file), markdown);
    const attached = await pictures.upload.reduce<
      Promise<Record<string, string>>
    >(
      async (sofar, picture) => ({
        ...(await sofar),
        [picture.src]: (await uploadOnce(id, picture.file)).ref,
      }),
      Promise.resolve({})
    );

    const rewritten = rewriteImageLinks(markdown, attached);
    await request(
      AnySchema,
      'PUT',
      `/rest/api/3/issue/${encodeURIComponent(id)}`,
      { fields: { description: markdownToAdf(rewritten) } },
      id
    );
    // Linked to the attachments from now on, so pushing again doesn't
    // attach them again.
    fs.writeFileSync(file, `${rewritten}\n`);

    return [
      `Pushed ${id}'s description to Jira.`,
      ...pushedImagesNote(Object.keys(attached), pictures.left),
    ].join('\n');
  };

  // ── the interface ────────────────────────────────────────────────────────

  /** Every ticket in queue order, and the blockers kept out of it. */
  const readQueue = () => listAll(false);

  return {
    kind: 'jira',

    // A Jira project is a whole codebase's tickets: nothing below it, yet.
    projects: async () => [],
    isMember: async (id) => {
      if (memberLabel === undefined) {
        return true;
      }

      // The issue, its epic and that epic's: labelled at any of them.
      const labelledUp = async (
        key: string,
        levels: number
      ): Promise<boolean> => {
        const issue = await fetchIssue(key, ['labels', 'parent']);
        const parent = issue.fields.parent?.key;

        return (
          (issue.fields.labels ?? []).includes(memberLabel) ||
          (parent !== undefined &&
            levels > 0 &&
            (await labelledUp(parent, levels - 1).catch(() => false)))
        );
      };

      return labelledUp(id, 2);
    },

    list: async (options?: ListOptions) =>
      filterByReporter((await listAll(true)).tickets, options),

    get: getTicket,

    pull,

    push,

    create,

    update,

    attach: async (id, filePath, options) =>
      attach(id, filePath, options?.name),

    comment,

    comments: async (id) => {
      await ready();
      const issue = await fetchIssue(id, ['comment']);

      return (issue.fields.comment?.comments ?? []).map((one) =>
        adfToMarkdown(one.body)
      );
    },

    delete: async (id, _reason) => {
      await ready();
      await fetchIssue(id, ['summary']);
      const children = await childKeys(id);

      if (children.length > 0) {
        throw stillHasChildren(id, children);
      }

      await request(
        AnySchema,
        'DELETE',
        `/rest/api/3/issue/${encodeURIComponent(id)}`,
        undefined,
        id
      );
    },

    block: async (id, by) => {
      await ready();
      const [blocked] = await Promise.all([
        fetchIssue(id, ['issuelinks']),
        fetchIssue(by, ['summary']),
      ]);

      if (blocksLinks(blocked, by).length > 0) {
        return;
      }

      await request(AnySchema, 'POST', '/rest/api/3/issueLink', {
        type: { name: 'Blocks' },
        outwardIssue: { key: by },
        inwardIssue: { key: id },
      });

      // Read back, so a link filed the other way round is never taken as done.
      if (blocksLinks(await fetchIssue(id, ['issuelinks']), by).length === 0) {
        throw new Error(
          `Jira took the link, but ${id} does not read as blocked by ${by}. Check that the "Blocks" link type in Jira reads "blocks" outward and "is blocked by" inward.`
        );
      }
    },

    // The blocker isn't read: one deleted since, or in another project, must
    // still come off.
    unblock: async (id, by) => {
      await ready();
      assertTicketId(by);
      const blocked = await fetchIssue(id, ['issuelinks']);

      await Promise.all(
        blocksLinks(blocked, by).map((link) =>
          request(
            AnySchema,
            'DELETE',
            `/rest/api/3/issueLink/${encodeURIComponent(link.id)}`
          )
        )
      );
    },

    reorder: async (parent, order) => {
      await ready();
      await fetchIssue(parent, ['summary']);
      const children = await childKeys(parent);
      checkReorder(parent, children, order);
      const [first, ...rest] = order;

      if (first === undefined) {
        return;
      }

      if (children[0] !== undefined && children[0] !== first) {
        await rank([first], { rankBeforeIssue: children[0] });
      }

      if (rest.length > 0) {
        await rankAfter(rest, first);
      }
    },

    place: async (ids, after) => {
      await ready();
      checkPlace(ids, after);

      await Promise.all(
        [after, ...ids].map((id) => fetchIssue(id, ['summary']))
      );
      await rankAfter(ids, after);
    },

    // `next` decides from `queue`, so a building pod's queue can't drift.
    next: async (options?: ListOptions) => {
      const { tickets, outside } = await readQueue();

      return findNext(tickets, options, outside);
    },

    queue: readQueue,
  };
};
