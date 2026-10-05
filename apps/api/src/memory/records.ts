import { getSupabase } from "../supabase.js";

// The notes in a memory store. Every function takes the store's id and
// filters by it, so a caller with access to one store can never reach another's.

export const MAX_TITLE = 200;
export const MAX_BODY = 20_000;
export const MAX_COLLECTION = 60;
export const MAX_TAGS = 20;
export const MAX_RECORDS_PER_STORE = 5_000;

/** Thrown for a request the caller can fix; the message is safe to show them. */
export class MemoryError extends Error {}

export interface MemoryRecord {
  id: string;
  collection: string;
  title: string;
  body: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

interface Row {
  id: string;
  collection: string;
  title: string;
  body: string;
  tags: string[];
  created_at: string;
  updated_at: string;
}

const COLUMNS = "id,collection,title,body,tags,created_at,updated_at";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fromRow(row: Row): MemoryRecord {
  return { id: row.id, collection: row.collection, title: row.title, body: row.body, tags: row.tags, createdAt: row.created_at, updatedAt: row.updated_at };
}

/** A collection name as stored: trimmed, one line. */
export function collectionName(value: string): string {
  const name = value.replace(/\s+/g, " ").trim().slice(0, MAX_COLLECTION);
  if (!name) throw new MemoryError("A note needs a collection, e.g. \"Profile\".");
  return name;
}

function cleanTags(tags: string[] | undefined): string[] {
  return [...new Set((tags ?? []).map((t) => t.replace(/\s+/g, " ").trim().toLowerCase().slice(0, 40)).filter(Boolean))].slice(0, MAX_TAGS);
}

function checkText(title: string | undefined, body: string | undefined) {
  if (title !== undefined && (!title.trim() || title.length > MAX_TITLE)) throw new MemoryError(`A note's title must be 1 to ${MAX_TITLE} characters.`);
  if (body !== undefined && body.length > MAX_BODY) throw new MemoryError(`A note's text can be at most ${MAX_BODY} characters. Split it into several notes.`);
}

export async function saveRecord(storeId: string, input: { collection: string; title: string; body?: string; tags?: string[] }): Promise<MemoryRecord> {
  checkText(input.title, input.body);
  const { count, error: countError } = await getSupabase().from("memory_records").select("id", { count: "exact", head: true }).eq("deployment_id", storeId);
  if (countError) throw new Error(`Failed to save note: ${countError.message}`);
  if ((count ?? 0) >= MAX_RECORDS_PER_STORE) throw new MemoryError(`This store is full (${MAX_RECORDS_PER_STORE} notes). Delete some before saving more.`);

  const { data, error } = await getSupabase()
    .from("memory_records")
    .insert({ deployment_id: storeId, collection: collectionName(input.collection), title: input.title.trim(), body: input.body ?? "", tags: cleanTags(input.tags) })
    .select(COLUMNS)
    .single();
  if (error) throw new Error(`Failed to save note: ${error.message}`);
  return fromRow(data as Row);
}

/** Saves several notes at once (an import): all of them, or none if the store hasn't room. */
export async function saveRecords(storeId: string, notes: { collection: string; title: string; body?: string; tags?: string[] }[]): Promise<number> {
  for (const note of notes) checkText(note.title, note.body);
  const { count, error: countError } = await getSupabase().from("memory_records").select("id", { count: "exact", head: true }).eq("deployment_id", storeId);
  if (countError) throw new Error(`Failed to save notes: ${countError.message}`);
  if ((count ?? 0) + notes.length > MAX_RECORDS_PER_STORE) {
    throw new MemoryError(`This store holds ${count} of ${MAX_RECORDS_PER_STORE} notes, so there isn't room for ${notes.length} more.`);
  }
  const { error } = await getSupabase()
    .from("memory_records")
    .insert(notes.map((n) => ({ deployment_id: storeId, collection: collectionName(n.collection), title: n.title.trim(), body: n.body ?? "", tags: cleanTags(n.tags) })));
  if (error) throw new Error(`Failed to save notes: ${error.message}`);
  return notes.length;
}

export async function getRecord(storeId: string, id: string): Promise<MemoryRecord | null> {
  if (!UUID.test(id)) return null;
  const { data, error } = await getSupabase().from("memory_records").select(COLUMNS).eq("deployment_id", storeId).eq("id", id).maybeSingle();
  if (error) throw new Error(`Failed to load note: ${error.message}`);
  return data ? fromRow(data as Row) : null;
}

/** Changes only the fields given. Null if the store has no note with that id. */
export async function updateRecord(
  storeId: string,
  id: string,
  patch: { collection?: string; title?: string; body?: string; tags?: string[] },
): Promise<MemoryRecord | null> {
  if (!UUID.test(id)) return null;
  checkText(patch.title, patch.body);
  const { data, error } = await getSupabase()
    .from("memory_records")
    .update({
      ...(patch.collection !== undefined ? { collection: collectionName(patch.collection) } : {}),
      ...(patch.title !== undefined ? { title: patch.title.trim() } : {}),
      ...(patch.body !== undefined ? { body: patch.body } : {}),
      ...(patch.tags !== undefined ? { tags: cleanTags(patch.tags) } : {}),
      updated_at: new Date().toISOString(),
    })
    .eq("deployment_id", storeId)
    .eq("id", id)
    .select(COLUMNS)
    .maybeSingle();
  if (error) throw new Error(`Failed to update note: ${error.message}`);
  return data ? fromRow(data as Row) : null;
}

/** False if the store has no note with that id. */
export async function deleteRecord(storeId: string, id: string): Promise<boolean> {
  if (!UUID.test(id)) return false;
  const { data, error } = await getSupabase().from("memory_records").delete().eq("deployment_id", storeId).eq("id", id).select("id");
  if (error) throw new Error(`Failed to delete note: ${error.message}`);
  return (data ?? []).length > 0;
}

/** The store's notes, most recently changed first, optionally from one collection. */
export async function listRecords(storeId: string, options: { collection?: string; limit?: number } = {}): Promise<MemoryRecord[]> {
  let query = getSupabase()
    .from("memory_records")
    .select(COLUMNS)
    .eq("deployment_id", storeId)
    .order("updated_at", { ascending: false })
    .limit(Math.min(Math.max(options.limit ?? 50, 1), 200));
  if (options.collection) query = query.eq("collection", options.collection);
  const { data, error } = await query;
  if (error) throw new Error(`Failed to list notes: ${error.message}`);
  return (data as Row[]).map(fromRow);
}

/** Keyword search, best matches first. */
export async function searchRecords(storeId: string, text: string, options: { collection?: string; limit?: number } = {}): Promise<MemoryRecord[]> {
  const query = text.trim().slice(0, 300);
  if (!query) return listRecords(storeId, options);
  const { data, error } = await getSupabase().rpc("search_memory_records", {
    p_deployment_id: storeId,
    p_query: query,
    p_collection: options.collection ?? null,
    p_limit: options.limit ?? 20,
  });
  if (error) throw new Error(`Failed to search notes: ${error.message}`);
  return (data as Row[]).map(fromRow);
}

/** Each collection in use and how many notes it holds. */
export async function countByCollection(storeId: string): Promise<Record<string, number>> {
  const { data, error } = await getSupabase().from("memory_records").select("collection").eq("deployment_id", storeId).limit(MAX_RECORDS_PER_STORE);
  if (error) throw new Error(`Failed to list collections: ${error.message}`);
  const counts: Record<string, number> = {};
  for (const row of data as { collection: string }[]) counts[row.collection] = (counts[row.collection] ?? 0) + 1;
  return counts;
}
