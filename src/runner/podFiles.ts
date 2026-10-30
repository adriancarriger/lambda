import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';

import { MANIFEST, isPng, podFilePath } from '../app/server/podFile';
import { contentTypeOf, prototypeFilePath } from '../app/server/prototypes';
import { ID_PATTERN } from '../pod-store';
import { POD_FILE_FOLDERS, type PodFileFolder } from '../protocol';

/**
 * The runner's answer to `pod-file`: one file from one of a pod's folders,
 * as base64 for the mothership to pass on. Only the folders it was given are
 * served; anything it won't serve is null (the app's 404), so the mothership
 * never needs to read a pod's files itself.
 */

const isFolder = (value: string): value is PodFileFolder =>
  POD_FILE_FOLDERS.some((folder) => folder === value);

export interface PodFileRequest {
  podId: string;
  folder: string;
  path: string;
}

const PodFileRequestSchema = z.object({
  podId: z.string().min(1),
  folder: z.string().min(1),
  path: z.string().min(1),
});

/** The mothership's `pod-file` message, by its shape: a gap is refused. */
export const podFileRequestOf = (message: unknown): PodFileRequest => {
  const parsed = PodFileRequestSchema.safeParse(message);

  if (!parsed.success) {
    throw new Error('A pod-file request needs a podId, a folder and a path.');
  }

  return parsed.data;
};

export interface PodFileAnswer {
  base64: string;
  headers: Record<string, string>;
}

const answer = (
  file: string,
  headers: Record<string, string>
): PodFileAnswer => ({
  base64: fs.readFileSync(file).toString('base64'),
  headers,
});

export const servePodFile = (
  root: string,
  request: PodFileRequest
): PodFileAnswer | null => {
  // A folder outside the list is a 404 like any missing file: the answer
  // never names what the computer does serve.
  if (!isFolder(request.folder) || !ID_PATTERN.test(request.podId)) {
    return null;
  }

  if (request.folder === 'prototype') {
    const file = prototypeFilePath(root, `${request.podId}/${request.path}`);
    const type = file === null ? null : contentTypeOf(file);

    return file === null || type === null
      ? null
      : answer(file, { 'content-type': type });
  }

  const file = podFilePath(
    root,
    request.podId,
    `${request.folder}/${request.path}`
  );

  if (file === null) {
    return null;
  }

  if (path.basename(file) === MANIFEST) {
    return answer(file, {
      'content-type': 'application/json',
      'cache-control': 'no-cache',
    });
  }

  // Named .png is not enough: only a real PNG goes out as one.
  return isPng(file)
    ? answer(file, { 'content-type': 'image/png', 'cache-control': 'no-cache' })
    : null;
};
