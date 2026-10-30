/**
 * The page's own trail: what changed on screen and why, sent to the server
 * every few seconds and kept in `<pods root>/_ui.log` (one JSON line each).
 * When something odd happens ("the checkpoint just vanished"), that file says
 * what the page did, instead of us guessing (2026-10-10).
 *
 * Never logs what they type — key names only, and only what had focus.
 */
type Entry = Record<string, unknown> & { at: string; event: string };

const buffer: Entry[] = [];
/** Kept while they can't be sent (signed out, server restarting): newest. */
const MAX_KEPT = 500;
const SESSION = Math.random().toString(36).slice(2, 8);

export const uiLog = (
  event: string,
  data: Record<string, unknown> = {}
): void => {
  buffer.splice(buffer.length, 0, {
    at: new Date().toISOString(),
    event,
    session: SESSION,
    ...data,
  });

  if (buffer.length > MAX_KEPT) {
    buffer.splice(0, buffer.length - MAX_KEPT);
  }
};

/** Signed out, `/api/ui-log` answers 401: entries wait for the session. */
const session = { signedIn: false };

export const setUiLogSignedIn = (value: boolean): void => {
  session.signedIn = value;
};

const flush = (useBeacon = false): void => {
  if (buffer.length === 0 || !session.signedIn) {
    return;
  }

  const entries = buffer.splice(0, buffer.length);
  const body = JSON.stringify({ entries });

  if (useBeacon && typeof navigator.sendBeacon === 'function') {
    navigator.sendBeacon(
      '/api/ui-log',
      new Blob([body], { type: 'application/json' })
    );

    return;
  }

  fetch('/api/ui-log', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  }).catch(() => {
    // The server is restarting: keep them for the next try (newest last).
    buffer.splice(0, 0, ...entries.slice(-MAX_KEPT));
    buffer.splice(0, Math.max(0, buffer.length - MAX_KEPT));
  });
};

/** What had focus, briefly: tag, role, class, and a pod/item hint if any. */
export const describeTarget = (target: EventTarget | null): string => {
  if (!(target instanceof HTMLElement)) {
    return String(target);
  }

  const label =
    target.getAttribute('aria-label') ??
    target.querySelector('.nav-item__title')?.textContent ??
    '';

  return [
    target.tagName.toLowerCase(),
    target.getAttribute('role') ?? '',
    (target.className || '').toString().split(' ').slice(0, 2).join('.'),
    label.slice(0, 40),
  ]
    .filter((part) => part !== '')
    .join(' · ');
};

export const startUiLog = (): void => {
  window.setInterval(() => flush(), 3_000);
  window.addEventListener('pagehide', () => flush(true));
  uiLog('page-load', { url: window.location.pathname });
  document.addEventListener('visibilitychange', () =>
    uiLog('visibility', { state: document.visibilityState })
  );
  window.addEventListener('focus', () => uiLog('window-focus'));
  window.addEventListener('blur', () => uiLog('window-blur'));
  // Capture phase: every key, whatever handles it after.
  window.addEventListener(
    'keydown',
    (event) => {
      const typing =
        event.target instanceof HTMLTextAreaElement ||
        (event.target instanceof HTMLInputElement &&
          event.target.type !== 'checkbox' &&
          event.target.type !== 'radio');

      // In a text box only the keys that DO something are logged.
      if (typing && !['Enter', 'Escape', 'Tab'].includes(event.key)) {
        return;
      }

      uiLog('key', {
        key: event.key,
        mods: [
          event.metaKey ? 'cmd' : '',
          event.ctrlKey ? 'ctrl' : '',
          event.shiftKey ? 'shift' : '',
          event.altKey ? 'alt' : '',
        ]
          .filter((mod) => mod !== '')
          .join('+'),
        focus: describeTarget(event.target),
      });
    },
    true
  );
  window.addEventListener(
    'click',
    (event) => uiLog('click', { on: describeTarget(event.target) }),
    true
  );
  window.addEventListener('error', (event) =>
    uiLog('js-error', { message: event.message })
  );
};
