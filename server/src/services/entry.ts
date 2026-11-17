import type { Db } from '../db/db.js';
import { requireActiveUser } from './deletion.js';
import { attemptRequestDigest } from '../ai/usage-store.js';

/** Stable random first-launch nonce; duplicates never move the start of the window. */
export async function recordEntry(db: Db, entryId: string, now?: Date) {
  // Live traffic uses the database clock, just like users.created_at. The
  // optional timestamp is only a service fixture hook; the API accepts UUID only.
  await db.query('INSERT INTO usage_entries(entry_id,first_seen_at) VALUES($1,coalesce($2::timestamptz,clock_timestamp())) ON CONFLICT DO NOTHING', [entryId,now ?? null]);
}

/** Only the signed-in account may claim its unguessable nonce; no identity is returned. */
export async function linkEntry(db: Db, userId: string, entryId: string) {
  await db.tx(async q => {
    await requireActiveUser(q,userId);
    await q.query('INSERT INTO usage_actors(user_id) VALUES($1) ON CONFLICT DO NOTHING',[userId]);
    const [actor] = await q.query<{actor_id:string;first_entry_at:Date|null;created_at:Date}>(`SELECT a.actor_id,a.first_entry_at,u.created_at FROM usage_actors a JOIN users u ON u.id=a.user_id WHERE a.user_id=$1 FOR UPDATE OF a`,[userId]);
    const [entry] = await q.query<{actor_id:string|null;first_seen_at:Date}>('SELECT actor_id,first_seen_at FROM usage_entries WHERE entry_id=$1 FOR UPDATE',[entryId]);
    if (!entry || entry.actor_id) return;
    const returning = actor!.first_entry_at !== null || new Date(actor!.created_at) < new Date(entry.first_seen_at);
    await q.query('UPDATE usage_entries SET actor_id=$2,returning_user=$3 WHERE entry_id=$1',[entryId,actor!.actor_id,returning]);
    await q.query('UPDATE usage_actors SET first_entry_at=coalesce(first_entry_at,$2) WHERE user_id=$1',[userId,entry.first_seen_at]);
  },userId);
}

/** Correlate a clarification chain without retaining client-controlled request strings. */
export async function linkRequest(db: Db, userId: string, requestId: string, rootMessageId?: string) {
  try {
    await db.tx(async q => {
      await requireActiveUser(q,userId);
      const [message] = rootMessageId ? await q.query<{client_msg_id:string}>('SELECT client_msg_id FROM messages WHERE id=$1 AND user_id=$2 AND role=\'user\'',[rootMessageId,userId]) : [];
      const requestHash = attemptRequestDigest(userId,requestId), rootHash = attemptRequestDigest(userId,message?.client_msg_id ?? requestId);
      await q.query('INSERT INTO usage_actors(user_id) VALUES($1) ON CONFLICT DO NOTHING',[userId]);
      await q.query(`INSERT INTO usage_request_links(actor_id,request_hash,root_hash)
        SELECT actor_id,$2,$3 FROM usage_actors WHERE user_id=$1 ON CONFLICT DO NOTHING`,[userId,requestHash,rootHash]);
    });
  } catch { /* Correlation is best effort, never a business prerequisite. */ }
}
