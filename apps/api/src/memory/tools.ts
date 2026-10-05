import { Ajv } from "ajv";
import { setCollections, type DeployedTool, type DeploymentRecord, type MemoryTopic } from "../store.js";
import {
  MAX_BODY,
  MAX_COLLECTION,
  MAX_TITLE,
  MemoryError,
  collectionName,
  countByCollection,
  deleteRecord,
  getRecord,
  listRecords,
  saveRecord,
  searchRecords,
  updateRecord,
  type MemoryRecord,
} from "./records.js";

// What a memory store offers over MCP: a fixed set of tools for finding and
// keeping notes. Every call's input is validated against its schema before
// anything is read or written.

/** A topic: a name, optionally what belongs in it, and whether an agent created it. */
export type MemoryCollection = MemoryTopic;

/** The most topics a memory can have. */
export const MAX_TOPICS = 30;

/**
 * Makes sure a topic an app or agent is writing to is on the memory's list,
 * adding it marked as created by the agent if it's new. This is how a memory
 * grows topics through use.
 */
async function ensureAgentTopic(store: DeploymentRecord, name: string, description = ""): Promise<MemoryCollection> {
  const topic = collectionName(name);
  const topics = await collectionsOf(store);
  const existing = topics.find((t) => t.name === topic);
  if (existing) return existing;
  if (topics.length >= MAX_TOPICS) {
    throw new MemoryError(`This memory already has ${MAX_TOPICS} topics, the most it can hold. Use one of them: ${topics.map((t) => t.name).join(", ")}.`);
  }
  const added: MemoryCollection = { name: topic, description: description.replace(/\s+/g, " ").trim().slice(0, 500), createdBy: "agent" };
  const saved = [...(store.collections ?? []), added];
  await setCollections(store.id, store.userId, saved);
  // So later calls in the same request see it.
  store.collections = saved;
  return added;
}

interface MemoryTool {
  name: string;
  description: string;
  readOnly: boolean;
  destructive: boolean;
  inputSchema: { type: "object"; additionalProperties: false; required?: string[]; properties: Record<string, Record<string, unknown>> };
  run: (store: DeploymentRecord, args: Record<string, any>) => Promise<unknown>;
}

const collection = { type: "string", minLength: 1, maxLength: MAX_COLLECTION, description: "The topic the note belongs to, e.g. \"Technical skills\"." };
const id = { type: "string", description: "The note's id, as returned by search, list or save." };
const limit = { type: "integer", minimum: 1, maximum: 50, description: "How many notes to return at most (default 20)." };
const tags = { type: "array", maxItems: 20, items: { type: "string", maxLength: 40 }, description: "Optional short labels to find the note by later." };

/** Lists show a note's start, not all of it; `memory.get` returns the whole text. */
function preview(record: MemoryRecord) {
  const { body, ...rest } = record;
  return body.length > 400 ? { ...rest, body: `${body.slice(0, 400)}…`, truncated: true } : record;
}

function notFound(noteId: string): never {
  throw new MemoryError(`There's no note with id "${noteId}" in this store.`);
}

export const MEMORY_TOOLS: MemoryTool[] = [
  {
    name: "memory.search",
    description: "Find notes by keyword. Searches titles, tags and text, best matches first. Search before saving, to update an existing note instead of creating a duplicate.",
    readOnly: true,
    destructive: false,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: { query: { type: "string", minLength: 1, maxLength: 300, description: "Words to look for." }, collection: { ...collection, description: "Only search this topic." }, limit },
    },
    run: async (store, args) => ({ notes: (await searchRecords(store.id, args.query, { collection: args.collection, limit: args.limit })).map(preview) }),
  },
  {
    name: "memory.list",
    description: "List notes, most recently changed first, optionally from one topic.",
    readOnly: true,
    destructive: false,
    inputSchema: { type: "object", additionalProperties: false, properties: { collection: { ...collection, description: "Only list this topic." }, limit } },
    run: async (store, args) => ({ notes: (await listRecords(store.id, { collection: args.collection, limit: args.limit ?? 20 })).map(preview) }),
  },
  {
    name: "memory.get",
    description: "Read one note in full.",
    readOnly: true,
    destructive: false,
    inputSchema: { type: "object", additionalProperties: false, required: ["id"], properties: { id } },
    run: async (store, args) => (await getRecord(store.id, args.id)) ?? notFound(args.id),
  },
  {
    name: "memory.collections",
    description: "List the memory's topics with what each is for and how many notes it holds.",
    readOnly: true,
    destructive: false,
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    run: async (store) => ({ collections: await collectionsOf(store) }),
  },
  {
    name: "memory.create_topic",
    description:
      "Add a topic for something this memory has no place for yet, saying what belongs in it. Check memory.collections first: prefer an existing topic, and add one only for a subject that will keep getting notes.",
    readOnly: false,
    destructive: false,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["name"],
      properties: {
        name: { type: "string", minLength: 1, maxLength: MAX_COLLECTION, description: "A short name, e.g. \"Interview feedback\"." },
        description: { type: "string", maxLength: 500, description: "One line on what belongs in this topic." },
      },
    },
    run: async (store, args) => ensureAgentTopic(store, args.name, args.description),
  },
  {
    name: "memory.save",
    description: "Save a new note. Use a clear title, and put one subject per note so it can be found and updated on its own. A topic that doesn't exist yet is created.",
    readOnly: false,
    destructive: false,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["collection", "title"],
      properties: {
        collection,
        title: { type: "string", minLength: 1, maxLength: MAX_TITLE, description: "A short title saying what the note is about." },
        body: { type: "string", maxLength: MAX_BODY, description: "The note's text." },
        tags,
      },
    },
    run: async (store, args) => {
      const topic = await ensureAgentTopic(store, args.collection);
      return saveRecord(store.id, { collection: topic.name, title: args.title, body: args.body, tags: args.tags, createdBy: "agent" });
    },
  },
  {
    name: "memory.update",
    description: "Change an existing note. Only the fields given are changed; `body` replaces the whole text.",
    readOnly: false,
    destructive: false,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: {
        id,
        collection: { ...collection, description: "Move the note to this topic." },
        title: { type: "string", minLength: 1, maxLength: MAX_TITLE },
        body: { type: "string", maxLength: MAX_BODY, description: "The note's new text, replacing the old." },
        tags,
      },
    },
    run: async (store, args) => {
      // Checked first, so moving a note that doesn't exist doesn't leave an empty topic behind.
      if (!(await getRecord(store.id, args.id))) notFound(args.id);
      const collection = args.collection === undefined ? undefined : (await ensureAgentTopic(store, args.collection)).name;
      return (await updateRecord(store.id, args.id, { collection, title: args.title, body: args.body, tags: args.tags })) ?? notFound(args.id);
    },
  },
  {
    name: "memory.delete",
    description: "Delete a note for good.",
    readOnly: false,
    destructive: true,
    inputSchema: { type: "object", additionalProperties: false, required: ["id"], properties: { id } },
    run: async (store, args) => ((await deleteRecord(store.id, args.id)) ? { deleted: true, id: args.id } : notFound(args.id)),
  },
];

const ajv = new Ajv({ allErrors: true, strict: false });
const validators = new Map(MEMORY_TOOLS.map((tool) => [tool.name, ajv.compile(tool.inputSchema)]));

/** Why the arguments don't fit the tool's schema, or null if they do. */
export function invalidInput(tool: string, args: unknown): string | null {
  const validate = validators.get(tool);
  if (!validate) return "Unknown tool.";
  return validate(args ?? {}) ? null : ajv.errorsText(validate.errors, { separator: "; " });
}

/** The tool surface as stored on the store's record, so Agent Creator can offer it. */
export function deployedMemoryTools(): DeployedTool[] {
  return MEMORY_TOOLS.map((t) => ({ name: t.name, description: t.description, destructive: t.destructive, sensitive: false, inputSchema: t.inputSchema }));
}

/** The store's collections: its starter ones plus any that notes were saved under, with counts. */
export async function collectionsOf(store: DeploymentRecord): Promise<Array<MemoryCollection & { notes: number }>> {
  const counts = await countByCollection(store.id);
  const starters = store.collections ?? [];
  const named = new Set(starters.map((c) => c.name));
  return [
    ...starters.map((c) => ({ ...c, notes: counts[c.name] ?? 0 })),
    ...Object.keys(counts)
      .filter((name) => !named.has(name))
      .sort()
      .map((name): MemoryCollection & { notes: number } => ({ name, description: "", notes: counts[name] })),
  ];
}

/** Told to the model when it connects: what the memory is about and how to use and grow it. */
export function storeInstructions(store: DeploymentRecord, collections: Array<MemoryCollection & { notes: number }>): string {
  const list = collections.length
    ? collections.map((c) => `- ${c.name}${c.description ? `: ${c.description}` : ""} (${c.notes} note${c.notes === 1 ? "" : "s"})`).join("\n")
    : "- None yet. Create the first topic when you save the first note.";
  return [
    `"${store.name}" is a memory: notes kept between conversations, grouped into topics.`,
    ...(store.description ? [`What it's about: ${store.description}`] : []),
    "",
    "Treat it like a project's notes file that gets better the more it's used:",
    "- Read before you act: search it at the start of a task and before answering anything it might cover.",
    "- Write down what you learn: a preference the user states, a fact about them or their work, a decision, an outcome, a correction. Save it when you learn it, without being asked.",
    "- Keep it current: when something changes, update the existing note rather than adding a second one that disagrees. Search first to find it.",
    "- Keep it tidy: one subject per note, a title someone would search for, and the user's own words for specifics.",
    "- Grow its shape: when what you've learned doesn't fit any topic, create one with a line saying what belongs in it.",
    "- Leave out what won't matter next time: the passing details of one conversation.",
    "",
    "Topics (a note's `collection` is the topic it belongs to):",
    list,
  ].join("\n");
}
