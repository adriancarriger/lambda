import { z } from 'zod';

import type { PodStateMessage } from '../app/shared/snapshot';
import type { Message } from '../protocol';

/**
 * What the mothership reads of each pushed pod, checked before it's stored:
 * one malformed snapshot in the `pods` table would break `/api/state` for
 * every session until it was replaced. Fields it only passes on are kept as
 * sent.
 */
const PodSnapshotSchema = z
  .object({
    podId: z.string().min(1),
    summary: z
      .object({
        pod: z
          .object({ id: z.string().min(1), createdAt: z.string() })
          .passthrough(),
      })
      .passthrough(),
    inbox: z.array(z.object({ kind: z.string() }).passthrough()),
    questions: z.array(z.unknown()),
    rank: z.number(),
    activity: z
      .object({
        midTurn: z.boolean(),
        openRequest: z.boolean(),
        lastActivityAt: z.number(),
      })
      .passthrough(),
  })
  .passthrough();

const PodStateSchema = z
  .object({
    type: z.literal('pod-state'),
    id: z.string().min(1),
    folder: z.string().min(1),
    pods: z.array(PodSnapshotSchema),
    removed: z.array(z.string()),
    all: z.array(z.string()).optional(),
  })
  .passthrough();

/** Why a `pod-state` can't be stored, or null when it can. */
export const podStateProblem = (message: Message): string | null => {
  const parsed = PodStateSchema.safeParse(message);

  if (parsed.success) {
    return null;
  }

  return parsed.error.issues
    .map((issue) => `${issue.path.join('.') || 'message'}: ${issue.message}`)
    .join('; ');
};

export const isPodState = (
  message: Message
): message is Message & PodStateMessage => podStateProblem(message) === null;
