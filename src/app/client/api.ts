import type { Question, RenderMode } from '../../pod-store';
import type { FolderListing } from '../../setup/folders';
import type { SetupState } from '../../setup/routes';
import type { TicketsBodyType } from '../../setup/schemas';
import type {
  SharedTrackerUser,
  TrackerIdentity,
} from '../../tickets/assignees';
import type {
  BuildingPodDetail,
  NewTicket,
  TicketChanges,
  TicketListItem,
  TicketPage,
  TicketsResponse,
  TrackerProjectsResponse,
} from '../shared/building';
import type {
  DesignSystemPage,
  MadeDesignSystem,
} from '../shared/designSystem';
import type { Made } from '../shared/prototypes';
import type {
  Favorite,
  FavoriteKind,
  ListSettings,
  SavedView,
  Visibility,
} from '../shared/savedViews';
import type { AppState, ClipStatus, Panes, PodDetail } from '../shared/types';
import type { NewPodRequest } from './NewPodForm';

/** Fired when a request comes back 401: the page shows the sign-in screen. */
export const SIGNED_OUT_EVENT = 'lambda:signed-out';

/**
 * The body as JSON — or a plain error saying the server didn't answer. An
 * empty or non-JSON body never comes from our server (it always answers with
 * JSON); it means the request died on the way, e.g. the Tailscale proxy
 * giving up on a busy server, which `response.json()` reports as the
 * baffling "Unexpected end of JSON input".
 */
const readJson = async (response: Response, path: string): Promise<unknown> => {
  if (response.status === 401) {
    window.dispatchEvent(new Event(SIGNED_OUT_EVENT));
  }

  const text = await response.text();

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `The inbox server didn't answer ${path} (HTTP ${response.status}) — try again.`
    );
  }
};

/**
 * The server said no (`{ ok: false, error }`): its words, with the HTTP
 * status — 409 is "Leslie's Mac mini is offline.", 400 the runner's own
 * answer (a tmux window that's gone).
 */
export class ServerError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const refusal = (response: Response, data: unknown): ServerError | null =>
  typeof data === 'object' &&
  data !== null &&
  'ok' in data &&
  data.ok === false &&
  'error' in data
    ? new ServerError(response.status, String(data.error))
    : null;

/** POST JSON; answers the `result` as it is, or throws the server's error text. */
const postFor = async (path: string, body: unknown): Promise<unknown> => {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await readJson(response, path);

  const refused = refusal(response, data);

  if (refused !== null) {
    throw refused;
  }

  return typeof data === 'object' && data !== null && 'result' in data
    ? data.result
    : undefined;
};

/** `postFor`, with the same top-level shape check `getJson` makes. */
const postAs = async <T>(
  path: string,
  body: unknown,
  guard: (value: unknown) => value is T
): Promise<T> => {
  const result = await postFor(path, body);

  if (!guard(result)) {
    throw new Error(`Unexpected response from ${path}`);
  }

  return result;
};

const post = async (path: string, body: unknown): Promise<string> => {
  const result = await postFor(path, body);

  return result === undefined ? '' : String(result);
};

/** Upload one image; answers its absolute path on this machine (for the agent). */
const uploadImage = async (file: File): Promise<string> => {
  const response = await fetch('/api/upload', {
    method: 'POST',
    headers: {
      'content-type': file.type === '' ? 'application/octet-stream' : file.type,
      // The server reads the type from the name when the browser gives none
      // (a HEIC from Finder).
      'x-file-name': encodeURIComponent(file.name),
    },
    body: file,
  });
  const data = await readJson(response, '/api/upload');

  if (
    typeof data !== 'object' ||
    data === null ||
    !('result' in data) ||
    typeof data.result !== 'string'
  ) {
    throw new Error(
      typeof data === 'object' && data !== null && 'error' in data
        ? String(data.error)
        : 'The image did not upload.'
    );
  }

  return data.result;
};

/** A section's clip, rendered now if it isn't cached (POST /api/tts/clip). */
const ttsClip = async (
  podId: string,
  text: string,
  /** `now`: the player is waiting to play it; `soon`: look-ahead. */
  need: 'now' | 'soon'
): Promise<ClipStatus> => {
  const response = await fetch('/api/tts/clip', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ podId, text, need }),
  });
  const data = await readJson(response, '/api/tts/clip');
  const result =
    typeof data === 'object' && data !== null && 'result' in data
      ? data.result
      : undefined;

  if (
    typeof result === 'object' &&
    result !== null &&
    'status' in result &&
    result.status === 'ready' &&
    'url' in result &&
    typeof result.url === 'string' &&
    'duration' in result &&
    typeof result.duration === 'number'
  ) {
    return { status: 'ready', url: result.url, duration: result.duration };
  }

  return { status: 'unavailable', reason: 'not rendered' };
};

const getJson = async <T>(
  path: string,
  guard: (value: unknown) => value is T
): Promise<T> => {
  const response = await fetch(path);
  const data = await readJson(response, path);

  if (!guard(data)) {
    throw (
      refusal(response, data) ?? new Error(`Unexpected response from ${path}`)
    );
  }

  return data;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// The server is ours and local; a shape check on the top-level keys is enough.
const isAppState = (value: unknown): value is AppState =>
  isObject(value) && Array.isArray(value.pods) && Array.isArray(value.inbox);

const isVersions = (value: unknown): value is { versions: Question[] } =>
  isObject(value) && Array.isArray(value.versions);

const isPodDetail = (value: unknown): value is PodDetail =>
  isObject(value) && isObject(value.pod) && Array.isArray(value.thread);

const isBuildingDetail = (value: unknown): value is BuildingPodDetail =>
  isObject(value) &&
  isObject(value.pod) &&
  Array.isArray(value.thread) &&
  isObject(value.building) &&
  Array.isArray(value.steps);

const isTickets = (value: unknown): value is TicketsResponse =>
  isObject(value) && Array.isArray(value.projects);

const isTicketItem = (value: unknown): value is TicketListItem =>
  isObject(value) &&
  typeof value.id === 'string' &&
  typeof value.title === 'string' &&
  typeof value.status === 'string';

const isTicketPage = (value: unknown): value is TicketPage =>
  isObject(value) && isObject(value.ticket) && isObject(value.summary);

/** `GET /api/tickets` also lists who holds which project. */
export interface Holding {
  runnerId: string;
  computer: string;
  projectId: string;
  connected: boolean;
}

const isMade = (value: unknown): value is Made =>
  isObject(value) &&
  Array.isArray(value.prototypes) &&
  Array.isArray(value.pictures);

const isPanes = (value: unknown): value is Panes =>
  isObject(value) &&
  Array.isArray(value.others) &&
  Array.isArray(value.working);

const isScreen = (
  value: unknown
): value is { screen: string; cols: number; rows: number } =>
  isObject(value) &&
  typeof value.screen === 'string' &&
  typeof value.cols === 'number' &&
  typeof value.rows === 'number';

const isSetupState = (value: unknown): value is SetupState =>
  isObject(value) && isObject(value.steps) && 'claudeExpiresOn' in value;

const isFolderListing = (value: unknown): value is FolderListing =>
  isObject(value) &&
  typeof value.path === 'string' &&
  Array.isArray(value.folders);

const isProjectResult = (value: unknown): value is { folder: string } =>
  isObject(value) && typeof value.folder === 'string';

/**
 * Asked after a key connects whose login isn't the owner's yet: is it?
 * (`yourEmail`: the email they sign in with, offered for a No.)
 */
export interface AskWho {
  login: { name: string; email: string | null };
  yourEmail: string | null;
}

export interface TicketsResult {
  connectedAs: string | null;
  askWho: AskWho | null;
}

const isTicketsResult = (value: unknown): value is TicketsResult =>
  isObject(value) && 'connectedAs' in value && 'askWho' in value;

const isYouResult = (value: unknown): value is { counts: string } =>
  isObject(value) && typeof value.counts === 'string';

/** First run (`/setup`): every step's work runs on the mothership. */
export const setupApi = {
  state: (options: { retryBrowser?: boolean } = {}) =>
    getJson(
      options.retryBrowser === true
        ? '/api/setup/state?retry=browser'
        : '/api/setup/state',
      isSetupState
    ),
  connectClaude: () => postFor('/api/setup/claude', {}),
  sendCode: (code: string) => postFor('/api/setup/claude/code', { code }),
  folders: async (folder: string): Promise<FolderListing> => {
    const path = `/api/setup/folders?path=${encodeURIComponent(folder)}`;
    const response = await fetch(path);
    const data = await readJson(response, path);
    const refused = refusal(response, data);

    if (refused !== null) {
      throw refused;
    }

    const result = isObject(data) ? data.result : undefined;

    if (!isFolderListing(result)) {
      throw new Error(`Unexpected response from ${path}`);
    }

    return result;
  },
  project: (body: { folder: string } | { name: string }) =>
    postAs('/api/setup/project', body, isProjectResult),
  tickets: (body: TicketsBodyType) =>
    postAs('/api/setup/tickets', body, isTicketsResult),
  /** "That login is me": an email or a name, counted as the owner's. */
  you: (login: string) =>
    postAs('/api/setup/tickets/you', { login }, isYouResult),
};

const isSavedView = (value: unknown): value is SavedView =>
  isObject(value) &&
  typeof value.id === 'string' &&
  typeof value.name === 'string';

const isFavorites = (value: unknown): value is { favorites: Favorite[] } =>
  isObject(value) && Array.isArray(value.favorites);

export const api = {
  uploadImage,
  /** An image dragged from a web page: the server fetches the link. */
  uploadImageUrl: (url: string) => post('/api/upload-url', { url }),
  state: () => getJson('/api/state', isAppState),
  pod: (podId: string) =>
    getJson(`/api/pod/${encodeURIComponent(podId)}`, isPodDetail),
  /** What the pod has made: its prototypes and pictures (Made here). */
  made: (podId: string) =>
    getJson(`/api/made/${encodeURIComponent(podId)}`, isMade),
  /** A checkpoint card's kept earlier versions, oldest first. */
  versions: (podId: string, qid: string) =>
    getJson(
      `/api/versions?podId=${encodeURIComponent(
        podId
      )}&qid=${encodeURIComponent(qid)}`,
      isVersions
    ).then((data) => data.versions),
  /** The Agents panel's other windows, and which agents are mid-turn. */
  panes: (podId: string) =>
    getJson(`/api/panes/${encodeURIComponent(podId)}`, isPanes),
  term: (podId: string, window: string) =>
    getJson(
      `/api/term?podId=${encodeURIComponent(podId)}&window=${encodeURIComponent(
        window
      )}`,
      isScreen
    ),
  answer: (podId: string, qid: string, text: string) =>
    post('/api/answer', { podId, qid, text }),
  acceptRec: (podId: string, qid: string) =>
    post('/api/answer', { podId, qid, acceptRec: true }),
  checkpointComplete: (podId: string, cp: number, keepOne = false) =>
    post('/api/checkpoint-complete', { podId, cp, keepOne }),
  /** To the dev directly; `about`: the item that's up (context, not an answer). */
  chat: (podId: string, text: string, about?: string | null) =>
    post('/api/chat', {
      podId,
      text,
      ...(about === null || about === undefined ? {} : { about }),
    }),
  carryOn: (podId: string) => post('/api/carry-on', { podId }),
  rename: (podId: string, title: string) =>
    post('/api/rename', { podId, title }),
  deletePod: (podId: string) => post('/api/delete', { podId }),
  nudge: (podId: string) => post('/api/nudge', { podId }),
  newPod: (request: NewPodRequest) => post('/api/pods/new', { ...request }),
  /** A freeform pod → the structured flow, keeping the conversation. */
  structure: (podId: string) => post('/api/structure', { podId }),
  /** Skip a stage of the pod's flow (the workflow panel). */
  skip: (podId: string, stage: string) => post('/api/skip', { podId, stage }),
  /** The workflow panel's Render Full | ASCII switch. */
  renderMode: (podId: string, mode: RenderMode) =>
    post('/api/render-mode', { podId, mode }),
  priority: (order: string[]) => post('/api/priority', { order }),
  /** `hold`: sent with ⌘⏎ — the pod steps aside until the chat replies. */
  chatSend: (podId: string, about: string | null, text: string, hold = false) =>
    post('/api/chat/send', {
      podId,
      text,
      ...(about === null ? {} : { about }),
      ...(hold ? { hold: true } : {}),
    }),
  chatWarm: (podId: string) => post('/api/chat/warm', { podId }),
  /** Ticks on a final checkpoint's suggested judgements (saved as they make them). */
  keepJudgements: (podId: string, qid: string, kept: number[]) =>
    post('/api/judgements/keep', { podId, qid, kept }),
  requestAdd: (
    podId: string,
    summary: string,
    quote: string,
    qid: string | null
  ) =>
    post('/api/request/add', {
      podId,
      summary,
      quote,
      ...(qid === null ? {} : { qid }),
    }),
  forkWarm: (podId: string, qid: string) =>
    post('/api/fork/warm', { podId, qid }),
  forkSend: (podId: string, qid: string, text: string) =>
    post('/api/fork/send', { podId, qid, text }),
  forkClose: (podId: string, qid: string, text: string) =>
    post('/api/fork/close', { podId, qid, text }),
  forkPark: (podId: string, qid: string) =>
    post('/api/fork/park', { podId, qid }),
  forkDiscard: (podId: string, qid: string) =>
    post('/api/fork/discard', { podId, qid }),
  termKeys: (podId: string, window: string, hex: string[]) =>
    post('/api/term/keys', { podId, window, hex }),
  ttsClip,
  /** What's on screen — re-prioritizes the audio queue at once. */
  focus: (podId: string | null, key: string | null): Promise<void> =>
    fetch('/api/focus', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ podId, key }),
    }).then(() => undefined),

  // ── you, your devices and computers, your projects ──────────────────────
  /** Signed in? `null` when not. */
  session: async (): Promise<Session | null> => {
    const response = await fetch('/api/session');

    if (response.status === 401) {
      return null;
    }

    const data = await readJson(response, '/api/session');

    if (!isSession(data)) {
      throw new Error('Unexpected response from /api/session');
    }

    return data;
  },
  /** Sign this device in with a code from Add a device. */
  pair: (code: string) => postFor('/api/auth/pair', { code }),
  signOut: () => postFor('/api/auth/signout', {}),
  devices: () => getJson('/api/devices', isList<'devices', Device>('devices')),
  deviceCode: () => postAs('/api/devices/code', {}, isCode),
  signOutDevice: (deviceId: string) =>
    post('/api/devices/signout', { deviceId }),
  computers: () =>
    getJson(
      '/api/computers',
      (
        value: unknown
      ): value is { computers: Computer[]; shared?: SharedTrackerUser[] } =>
        isObject(value) && Array.isArray(value.computers)
    ),
  computerCode: () => postAs('/api/computers/code', {}, isComputerCode),
  tailscale: () => getJson('/api/computers/tailscale', isTailscaleStep),
  listenOnTailscale: () =>
    postAs('/api/computers/tailscale/listen', {}, isJoinServer),
  addProject: (folder: string) =>
    postAs('/api/projects/add', { folder }, isAddedProject),
  newProject: (name: string, idea: string) =>
    postAs('/api/projects/new', { name, idea }, isNewProject),
  process: (projectId: string) =>
    getJson(
      `/api/process?projectId=${encodeURIComponent(projectId)}`,
      isProcess
    ),
  switchStep: (
    projectId: string,
    process: 'planning' | 'building',
    step: string,
    on: boolean
  ) =>
    postAs('/api/process/switch', { projectId, process, step, on }, isProcess),
  designSystem: (projectId: string) =>
    getJson(
      `/api/projects/${encodeURIComponent(projectId)}/design-system`,
      isDesignSystemPage
    ),
  /** Make it: the setup ticket, or the open one (`existing`). */
  makeDesignSystem: (projectId: string) =>
    postAs(
      `/api/projects/${encodeURIComponent(projectId)}/design-system/make`,
      {},
      isMadeDesignSystem
    ),
  // ── building pods and the Tickets screen ────────────────────────────────
  building: (podId: string) =>
    getJson(`/api/building/${encodeURIComponent(podId)}`, isBuildingDetail),
  /** Start building a runner's project; refused when it's already building. */
  buildingStart: (projectId: string, runnerId: string) =>
    post('/api/building/start', { projectId, runnerId }),
  pause: (podId: string) => post('/api/pause', { podId }),
  resume: (podId: string) => post('/api/resume', { podId }),
  /** To a building pod's Product manager. */
  pmChat: (podId: string, text: string) =>
    post('/api/pm-chat', { podId, text }),
  tickets: () =>
    getJson(
      '/api/tickets',
      (value: unknown): value is TicketsResponse & { holdings?: Holding[] } =>
        isTickets(value)
    ),
  /** `opened`: the page's first load, not a refresh (a failed summary retries). */
  ticketPage: (projectId: string, ticketId: string, opened = false) =>
    getJson(
      `/api/tickets/${encodeURIComponent(projectId)}/${encodeURIComponent(
        ticketId
      )}${opened ? '?opened=1' : ''}`,
      isTicketPage
    ),
  /** Each codebase's tracker projects (Linear's, or a markdown codebase's). */
  trackerProjects: () =>
    getJson(
      '/api/tracker-projects',
      (value: unknown): value is { result: TrackerProjectsResponse } =>
        isObject(value) &&
        isObject(value.result) &&
        Array.isArray(value.result.codebases)
    ).then((data) => data.result),
  views: () =>
    getJson(
      '/api/views',
      (value: unknown): value is { result: { views: SavedView[] } } =>
        isObject(value) &&
        isObject(value.result) &&
        Array.isArray(value.result.views)
    ).then((data) => data.result.views),
  newView: (view: {
    name: string;
    icon?: string | null;
    description?: string;
    visibility?: Visibility;
    settings: ListSettings;
  }) => postAs('/api/views/new', view, isSavedView),
  updateView: (
    id: string,
    changes: Partial<{
      name: string;
      icon: string | null;
      description: string;
      visibility: Visibility;
      settings: ListSettings;
    }>
  ) => postAs('/api/views/update', { id, changes }, isSavedView),
  deleteView: (id: string) => postFor('/api/views/delete', { id }),
  /** Import from Linear: what came in, and what didn't translate. */
  importViews: () =>
    postAs(
      '/api/views/import',
      {},
      (
        value: unknown
      ): value is {
        added: number;
        updated: number;
        favorites: number;
        notes: Array<{ view: string; dropped: string[] }>;
      } => isObject(value) && typeof value.added === 'number'
    ),
  favorites: () =>
    getJson(
      '/api/favorites',
      (value: unknown): value is { result: { favorites: Favorite[] } } =>
        isObject(value) &&
        isObject(value.result) &&
        Array.isArray(value.result.favorites)
    ).then((data) => data.result.favorites),
  favorite: (kind: FavoriteKind, ref: string, on: boolean, label?: string) =>
    postAs(
      on ? '/api/favorites/add' : '/api/favorites/remove',
      on && label !== undefined ? { kind, ref, label } : { kind, ref },
      isFavorites
    ).then((data) => data.favorites),
  orderFavorites: (ids: string[]) =>
    postAs('/api/favorites/order', { ids }, isFavorites).then(
      (data) => data.favorites
    ),
  /** A change from the Tickets screen: the ticket after it. */
  updateTicket: (projectId: string, ticketId: string, changes: TicketChanges) =>
    postAs(
      '/api/tickets/update',
      { projectId, ticketId, changes },
      isTicketItem
    ),
  /** A new ticket from the New ticket dialog. */
  newTicket: (projectId: string, ticket: NewTicket) =>
    postAs('/api/tickets/new', { projectId, ticket }, isTicketItem),
  /** "Plan more": reopen the planning pod with this ask; tickets back to Planning. */
  planMore: (
    projectId: string,
    podId: string,
    ticketIds: string[],
    text: string
  ) => postFor('/api/lambdas/plan-more', { projectId, podId, ticketIds, text }),
  /** Moves a ticket right after `after` among its siblings (null: first). */
  moveTicket: (projectId: string, ticketId: string, after: string | null) =>
    postFor('/api/tickets/move', { projectId, ticketId, after }),
  /** "Talk about this ticket": who it went to. */
  talkTicket: (projectId: string, ticketId: string, text: string) =>
    postFor('/api/tickets/talk', { projectId, ticketId, text }),
  analytics: (projectId: string) =>
    getJson(
      `/api/analytics?projectId=${encodeURIComponent(projectId)}`,
      (value: unknown): value is { analytics: Analytics } =>
        isObject(value) && isObject(value.analytics)
    ).then((data) => data.analytics),
};

export interface Session {
  owner: { name: string; initials: string };
  deviceId: string;
}

export interface Device {
  id: string;
  label: string;
  lastSeenAt: number;
  current: boolean;
}

export interface Code {
  code: string;
  expiresAt: number;
}

/** Add a computer's step 1, as the mothership found Tailscale. */
export interface TailscaleStep {
  step: string;
  state: 'up' | 'signed-out' | 'missing';
  /** With `up`: this computer's tailnet address and short name. */
  address?: string;
  label?: string;
}

export interface Computer {
  id: string;
  name: string;
  project: string | null;
  connected: boolean;
  state: string;
  /** Who it is in each tracker it has a key for. Left out by an older Lambda. */
  trackers?: TrackerIdentity[];
}

export interface ProcessStep {
  id: string;
  label: string;
  setting: 'on' | 'off' | 'locked';
  added: boolean;
}

export interface ProcessStage {
  id: string;
  label: string;
  steps: ProcessStep[];
}

export interface ProcessSettings {
  planning: ProcessStage[];
  building: ProcessStage[];
}

export interface Average {
  name: string;
  averageMs: number;
  count: number;
}

export interface Analytics {
  warnings: string[];
  steps: Average[];
  stages: Average[];
  ships: {
    name: string;
    totalMs: number;
    runsUntilGreen: number;
    fixingMs: number | null;
  }[];
  empty: boolean;
  /** The line shown instead, when there's nothing to show (the server's). */
  notice: string | null;
}

function isList<K extends string, T>(key: K) {
  return (value: unknown): value is Record<K, T[]> =>
    isObject(value) && Array.isArray(value[key]);
}

function isSession(value: unknown): value is Session {
  return isObject(value) && isObject(value.owner);
}

function isCode(value: unknown): value is Code {
  return isObject(value) && typeof value.code === 'string';
}

function isComputerCode(value: unknown): value is Code & { command: string } {
  return (
    isObject(value) &&
    typeof value.code === 'string' &&
    typeof value.command === 'string'
  );
}

function isTailscaleStep(value: unknown): value is TailscaleStep {
  return (
    isObject(value) &&
    typeof value.step === 'string' &&
    (value.state === 'up' ||
      value.state === 'signed-out' ||
      value.state === 'missing')
  );
}

function isJoinServer(value: unknown): value is { server: string } {
  return isObject(value) && typeof value.server === 'string';
}

function isAddedProject(value: unknown): value is { projectId: string } {
  return isObject(value) && typeof value.projectId === 'string';
}

function isNewProject(
  value: unknown
): value is { projectId: string; podId: string | null } {
  return (
    isObject(value) &&
    typeof value.projectId === 'string' &&
    (value.podId === null || typeof value.podId === 'string')
  );
}

function isProcess(value: unknown): value is ProcessSettings {
  return (
    isObject(value) &&
    Array.isArray(value.planning) &&
    Array.isArray(value.building)
  );
}

function isDesignSystemPage(value: unknown): value is DesignSystemPage {
  return (
    isObject(value) &&
    typeof value.project === 'string' &&
    typeof value.dir === 'string' &&
    (value.system === null || isObject(value.system))
  );
}

function isMadeDesignSystem(value: unknown): value is MadeDesignSystem {
  return (
    isObject(value) &&
    typeof value.id === 'string' &&
    typeof value.title === 'string' &&
    typeof value.existing === 'boolean'
  );
}
