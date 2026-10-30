import * as fs from 'fs';
import * as path from 'path';

import {
  ID_PATTERN,
  PROTOTYPE_SLUG,
  listPrototypes,
  prototypeVersionDir,
} from '../../pod-store';
import type { Made, MadePicture } from '../shared/prototypes';

/**
 * A pod's prototypes, live in the inbox (the snapshot command keeps them):
 *
 * - `GET /proto/<pod>/<slug>/v<n>/<file>` serves a version's `files/`. The
 *   page frames it with `sandbox="allow-scripts"` (no same-origin: it can't
 *   read the inbox or its storage) and every response forbids fetching,
 *   posting forms and loading anything but itself and Google Fonts. Each
 *   artboard gets BRIDGE_SCRIPT, the only way the inbox talks to it.
 * - `GET /api/made/<pod>` lists what the pod has made, for the Made here
 *   rail: its prototypes (every version) and its pictures.
 */

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
};

export const contentTypeOf = (file: string): string | null =>
  CONTENT_TYPES[path.extname(file).toLowerCase()] ?? null;

/**
 * The file a `/proto/` path names, or null: a known type, inside that
 * version's `files/` (symlinks resolved), of a pod and slug we'd name.
 */
export const prototypeFilePath = (
  root: string,
  rest: string
): string | null => {
  const [podId, slug, version, ...segments] = rest.split('/');

  if (
    podId === undefined ||
    !ID_PATTERN.test(podId) ||
    slug === undefined ||
    !PROTOTYPE_SLUG.test(slug) ||
    version === undefined ||
    !/^v[1-9]\d*$/.test(version) ||
    segments.length === 0 ||
    !segments.every((segment) => SEGMENT.test(segment)) ||
    contentTypeOf(segments.at(-1) ?? '') === null
  ) {
    return null;
  }

  const podDir = path.join(root, podId);
  const files = path.join(
    prototypeVersionDir(podDir, slug, Number(version.slice(1))),
    'files'
  );
  const file = path.join(files, ...segments);

  if (!fs.existsSync(file) || !fs.existsSync(files)) {
    return null;
  }

  // Inside the pod's own folder: no folder on the way to `files/` may be a
  // symlink, or the root moves wherever it points.
  const realFiles = path.join(
    fs.realpathSync(podDir),
    path.relative(podDir, files)
  );
  const real = fs.realpathSync(file);

  return fs.realpathSync(files) === realFiles &&
    real.startsWith(`${realFiles}${path.sep}`) &&
    fs.statSync(real).isFile()
    ? real
    : null;
};

const HOST = /^[A-Za-z0-9.-]+(?::\d+)?$|^\[[0-9a-fA-F:]+\](?::\d+)?$/;

/** A version's folder, with or without its link token (base36 expiry `.` HMAC). */
export const PROTO_BASE =
  /^\/proto\/(?:[a-z0-9]+\.[A-Za-z0-9_-]+\/)?[a-z0-9-]+\/[a-z0-9-]+\/v\d+\/$/;

/**
 * The headers on every prototype file. `host` (the inbox as the browser
 * reached it, e.g. through Tailscale) names "this server" for a sandboxed
 * page, whose own origin is opaque.
 */
export const prototypeHeaders = (
  file: string,
  host: string | undefined,
  /**
   * The version's own folder, all it may fetch: on the mothership
   * `/proto/<token>/<pod>/<slug>/v<n>/` (the token is what lets the sandboxed
   * frame in), else `/proto/<pod>/<slug>/v<n>/`.
   */
  base: string
): Record<string, string> => {
  const trusted = host !== undefined && HOST.test(host);
  const self = trusted ? `'self' http://${host} https://${host}` : "'self'";
  // The runtime reads its own artboard back; nothing else on the inbox.
  const ownFolder =
    trusted && PROTO_BASE.test(base)
      ? `http://${host}${base} https://${host}${base}`
      : "'none'";

  return {
    'content-type': contentTypeOf(file) ?? 'application/octet-stream',
    'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff',
    // Fonts are fetched in CORS mode, and a sandboxed page's origin is opaque.
    'access-control-allow-origin': '*',
    'content-security-policy': [
      "default-src 'none'",
      // The Design runtime compiles its templates.
      `script-src ${self} 'unsafe-inline' 'unsafe-eval'`,
      `style-src ${self} 'unsafe-inline' https://fonts.googleapis.com`,
      `font-src ${self} data: https://fonts.gstatic.com`,
      `img-src ${self} data: blob:`,
      `connect-src ${ownFolder}`,
      "form-action 'none'",
      "base-uri 'none'",
      // Sandboxed in its own tab too: an opaque origin, never the inbox's.
      'sandbox allow-scripts',
      `frame-ancestors ${self}`,
    ].join('; '),
  };
};

/**
 * Runs inside every artboard. It only answers the inbox (its parent):
 * `state` clicks the board's own `[data-state]` switch (once it has
 * rendered, if asked before). It reports the situations it has (`ready`),
 * a switch they clicked inside the board (`switched`), and Esc.
 */
export const BRIDGE_SCRIPT = `(function () {
  var parent = window.parent;
  // Opened in its own tab (?state=<slug>): just that situation, its own
  // switch kept so they can change it there.
  var framed = parent !== window;
  var wanted = null;
  var post = function (message) {
    if (!framed) return;
    message.lambda = 'prototype';
    parent.postMessage(message, '*');
  };
  var switches = function () {
    return Array.prototype.slice.call(document.querySelectorAll('[data-state]'));
  };
  var apply = function () {
    var control = switches().filter(function (el) {
      return el.getAttribute('data-state') === wanted;
    })[0];
    if (control && control.getAttribute('aria-pressed') !== 'true') control.click();
  };
  // The inbox's bar switches situations, so the board's own switch (the
  // [data-state] controls' bar, outside [data-screen]) is hidden; it still
  // works when clicked from here.
  var hideSwitch = function () {
    var controls = switches();
    if (controls.length === 0) return;
    var screen = document.querySelector('[data-screen]');
    var bar = controls[0].parentElement;
    while (bar && !controls.every(function (el) { return bar.contains(el); })) bar = bar.parentElement;
    if (!bar || bar === document.body || (screen && bar.contains(screen))) return;
    while (screen && bar.parentElement && bar.parentElement !== document.body && !(screen && bar.parentElement.contains(screen)) && bar.parentElement.id !== 'dc-root') bar = bar.parentElement;
    bar.setAttribute('data-lambda-hidden', '');
    if (!document.getElementById('lambda-hidden-style')) {
      var style = document.createElement('style');
      style.id = 'lambda-hidden-style';
      style.textContent = '[data-lambda-hidden]{display:none!important}';
      document.head.appendChild(style);
    }
  };
  var report = function () {
    post({
      type: 'ready',
      states: switches().map(function (el) { return el.getAttribute('data-state'); })
    });
  };
  window.addEventListener('message', function (event) {
    if (event.source !== parent) return;
    var data = event.data || {};
    if (data.type === 'state' && typeof data.slug === 'string') {
      wanted = data.slug;
      apply();
    }
    if (data.type === 'hello') report();
  });
  document.addEventListener('click', function (event) {
    var hit = event.target instanceof Element ? event.target : null;
    var control = hit ? hit.closest('[data-state]') : null;
    if (control) {
      wanted = control.getAttribute('data-state');
      post({ type: 'switched', state: wanted });
    }
  }, true);
  window.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') post({ type: 'escape' });
  });
  if (!framed) {
    var asked = /[?&]state=([a-z0-9-]+)/.exec(window.location.search);
    wanted = asked ? asked[1] : null;
  }
  var tries = 0;
  var wait = setInterval(function () {
    tries += 1;
    var root = document.getElementById('dc-root');
    if ((root && root.childElementCount > 0) || tries > 100) {
      clearInterval(wait);
      setTimeout(function () {
        if (framed) hideSwitch();
        apply();
        report();
      }, 60);
    }
  }, 100);
})();`;

/** An artboard with the bridge added at the end of its body. */
export const withBridge = (html: string): string => {
  const script = `<script>${BRIDGE_SCRIPT}</script>`;
  const end = html.lastIndexOf('</body>');

  return end === -1
    ? `${html}${script}`
    : `${html.slice(0, end)}${script}${html.slice(end)}`;
};

const MAX_PICTURES = 400;

/** Round photos are the loop's working drafts; a prototype's stills are in its card. */
const SKIPPED_FOLDERS = new Set(['walk', 'prototype']);

const pngsUnder = (podDir: string, rel: string): MadePicture[] => {
  const dir = path.join(podDir, rel);

  if (!fs.existsSync(dir)) {
    return [];
  }

  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const child = path.posix.join(rel, entry.name);

    if (entry.isDirectory()) {
      return SKIPPED_FOLDERS.has(entry.name) || !SEGMENT.test(entry.name)
        ? []
        : pngsUnder(podDir, child);
    }

    return entry.isFile() &&
      entry.name.endsWith('.png') &&
      SEGMENT.test(entry.name)
      ? [
          {
            path: child,
            group: rel,
            at: fs.statSync(path.join(dir, entry.name)).mtime.toISOString(),
          },
        ]
      : [];
  });
};

/** Everything the pod has made, newest first; null for a pod id we'd never name. */
export const madeHere = (root: string, podId: string): Made | null => {
  if (!ID_PATTERN.test(podId)) {
    return null;
  }

  const podDir = path.join(root, podId);

  return {
    prototypes: listPrototypes(podDir),
    pictures: [...pngsUnder(podDir, 'designs'), ...pngsUnder(podDir, 'shots')]
      .sort((a, b) => b.at.localeCompare(a.at) || a.path.localeCompare(b.path))
      .slice(0, MAX_PICTURES),
  };
};
