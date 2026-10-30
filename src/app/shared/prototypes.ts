/**
 * The line that ties a chat message to a prototype (the snapshot command):
 * `[Prototype: <slug> v<n>]` on its own line in Lambda's message shows
 * version n as a card (the snapshot command prints it).
 */
import type { PrototypeGroup } from '../../pod-store';

/** A picture a pod made (GET /api/made/<pod>). */
export interface MadePicture {
  /** Pod-relative (`designs/home/C/busy.png`, `shots/home.png`). */
  path: string;
  /** Its folder, pod-relative: what the rail groups by. */
  group: string;
  at: string;
}

/** Everything a pod made, newest first: the Made here rail. */
export interface Made {
  prototypes: PrototypeGroup[];
  pictures: MadePicture[];
  /**
   * `<slug>/v<n>` → the version's folder with its access token
   * (`/proto/<token>/<pod>/<slug>/v<n>/`): set by the mothership, the only
   * way the app learns a prototype's URL.
   */
  bases?: Record<string, string>;
}

export interface PrototypeRef {
  slug: string;
  version: number;
}

export type Device = 'desktop' | 'phone';

const PROTOTYPE_LINE = /^\[Prototype: ([a-z0-9-]+) v([1-9]\d*)\]$/;
export const prototypeLine = ({ slug, version }: PrototypeRef): string =>
  `[Prototype: ${slug} v${version}]`;

/** A message's words, and the prototypes it shows. */
export const splitPrototypeLines = (
  text: string
): { text: string; prototypes: PrototypeRef[] } => {
  const lines = text.split('\n');
  const prototypes = lines.flatMap((line) => {
    const match = PROTOTYPE_LINE.exec(line.trim());

    return match === null
      ? []
      : [{ slug: match[1] ?? '', version: Number(match[2]) }];
  });

  return {
    text: lines
      .filter((line) => !PROTOTYPE_LINE.test(line.trim()))
      .join('\n')
      .trim(),
    prototypes,
  };
};

/**
 * Where a pod-relative picture sits on a prototype: `designs/<slug>/<L>/<situation>.png`
 * (a board of several) or `designs/<slug>/<situation>.png` (a lone board).
 */
export const pictureOnPrototype = (
  picture: string
): { slug: string; letter: string | null; situation: string } | null => {
  const several = /^designs\/([a-z0-9-]+)\/([A-Z])\/([a-z0-9-]+)\.png$/.exec(
    picture
  );

  if (several !== null) {
    return {
      slug: several[1] ?? '',
      letter: several[2] ?? null,
      situation: several[3] ?? '',
    };
  }

  const lone = /^designs\/([a-z0-9-]+)\/([a-z0-9-]+)\.png$/.exec(picture);

  return lone === null
    ? null
    : { slug: lone[1] ?? '', letter: null, situation: lone[2] ?? '' };
};

/** A picture's pod and pod-relative path, from where the inbox serves it. */
export const podFileOf = (
  src: string
): { podId: string; path: string } | null => {
  const match = /^\/api\/pod-file\/([a-z0-9][a-z0-9-]*)\/(.+)$/.exec(src);

  return match === null
    ? null
    : { podId: match[1] ?? '', path: decodeURIComponent(match[2] ?? '') };
};

/** Did this message send the prototype version or picture? */
export const messageShows = (
  text: string,
  item: { prototype: PrototypeRef } | { picture: string }
): boolean =>
  'prototype' in item
    ? splitPrototypeLines(text).prototypes.some(
        (ref) =>
          ref.slug === item.prototype.slug &&
          ref.version === item.prototype.version
      )
    : text.includes(`/${item.picture}`) || text.includes(`(${item.picture})`);
