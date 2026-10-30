import type { Db } from './db';
import { SESSION_LIFETIME_MS } from './sessions';

/**
 * How long a receipt is kept. A resend is an outbox item the runner hasn't
 * seen acknowledged, minutes or hours old, never a week: an older one is
 * stored again, which every outbox item survives (a pod-state replaces, an
 * event's own key dedupes it).
 */
export const RECEIPT_KEPT_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Drop what can never be used again: old receipts, pairing codes and login
 * links that are used or expired, and sessions unused for 30 days with the
 * devices they leave with none (`useSession` refuses those anyway; a device
 * never seen again would otherwise stay listed forever). Without it these
 * tables only ever grow (a receipt for every pod-state). Answers the rows
 * removed.
 */
export const pruneSpent = (db: Db, now: number): number =>
  db.transaction(
    () =>
      db.prepare('DELETE FROM received WHERE at < ?').run(now - RECEIPT_KEPT_MS)
        .changes +
      db
        .prepare(
          'DELETE FROM pairing_codes WHERE used_at IS NOT NULL OR expires_at <= ?'
        )
        .run(now).changes +
      db
        .prepare(
          'DELETE FROM login_links WHERE used_at IS NOT NULL OR expires_at <= ?'
        )
        .run(now).changes +
      db
        .prepare('DELETE FROM sessions WHERE last_seen_at <= ?')
        .run(now - SESSION_LIFETIME_MS).changes +
      // A session goes with its device (ON DELETE CASCADE), not the other
      // way round: the device left with none is deleted here.
      db
        .prepare(
          'DELETE FROM devices WHERE id NOT IN (SELECT device_id FROM sessions)'
        )
        .run().changes
  )();
