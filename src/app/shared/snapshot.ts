import type { Question } from '../../pod-store';
import type { InboxEntry, PodSummary, TtsStatus } from './types';

/**
 * What a runner pushes about each pod (`pod-state`), and what the mothership
 * keeps in its `pods` table to answer `GET /api/state` without asking.
 */

/** What decides whether a computer is idle (the idle project switch). */
export interface PodActivity {
  /** Any agent mid-turn (`turn.startedAt > turn.endedAt`). */
  midTurn: boolean;
  /** A work request `queued` or `working`. */
  openRequest: boolean;
  /** The latest turn end or request change, ms. */
  lastActivityAt: number;
}

export interface PodSnapshot {
  podId: string;
  summary: PodSummary;
  /** This pod's inbox items, in order. */
  inbox: InboxEntry[];
  questions: Question[];
  /** Its place in its project's priority order. */
  rank: number;
  activity: PodActivity;
}

export interface PodStateMessage {
  type: 'pod-state';
  id: string;
  /** The project folder on the runner. */
  folder: string;
  /** Pods that changed. */
  pods: PodSnapshot[];
  /** Pods that are gone (deleted). */
  removed: string[];
  /** Every pod id in the folder: anything else the mothership has is gone. */
  all?: string[];
  tts?: TtsStatus;
}

/** A waiting pod's stored intake: what `lambda pod new` gets once it starts. */
export interface PodIntake {
  text: string;
  freeform: boolean;
  single: boolean;
}
