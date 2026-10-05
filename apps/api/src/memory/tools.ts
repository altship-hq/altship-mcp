import { Ajv } from "ajv";
import type { DeployedTool, DeploymentRecord } from "../store.js";
import {
  MAX_BODY,
  MAX_COLLECTION,
  MAX_TITLE,
  MemoryError,
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

/** A starter collection: a name and what belongs in it. */
export interface MemoryCollection {
  name: string;
  description: string;
}

interface MemoryTool {
  name: string;
  description: string;
  readOnly: boolean;
  destructive: boolean;
  inputSchema: { type: "object"; additionalProperties: false; required?: string[]; properties: Record<string, Record<string, unknown>> };
  run: (store: DeploymentRecord, args: Record<string, any>) => Promise<unknown>;
}

const collection = { type: "string", minLength: 1, maxLength: MAX_COLLECTION, description: "The collection the note belongs to, e.g. \"Profile\"." };
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
      properties: { query: { type: "string", minLength: 1, maxLength: 300, description: "Words to look for." }, collection: { ...collection, description: "Only search this collection." }, limit },
    },
    run: async (store, args) => ({ notes: (await searchRecords(store.id, args.query, { collection: args.collection, limit: args.limit })).map(preview) }),
  },
  {
    name: "memory.list",
    description: "List notes, most recently changed first, optionally from one collection.",
    readOnly: true,
    destructive: false,
    inputSchema: { type: "object", additionalProperties: false, properties: { collection: { ...collection, description: "Only list this collection." }, limit } },
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
    description: "List the store's collections with what each is for and how many notes it holds.",
    readOnly: true,
    destructive: false,
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    run: async (store) => ({ collections: await collectionsOf(store) }),
  },
  {
    name: "memory.save",
    description: "Save a new note. Use a clear title, and put one subject per note so it can be found and updated on its own.",
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
    run: (store, args) => saveRecord(store.id, { collection: args.collection, title: args.title, body: args.body, tags: args.tags }),
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
        collection: { ...collection, description: "Move the note to this collection." },
        title: { type: "string", minLength: 1, maxLength: MAX_TITLE },
        body: { type: "string", maxLength: MAX_BODY, description: "The note's new text, replacing the old." },
        tags,
      },
    },
    run: async (store, args) =>
      (await updateRecord(store.id, args.id, { collection: args.collection, title: args.title, body: args.body, tags: args.tags })) ?? notFound(args.id),
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
      .map((name) => ({ name, description: "", notes: counts[name] })),
  ];
}

/** Told to the model when it connects: what the store is and how to use it well. */
export function storeInstructions(store: DeploymentRecord, collections: Array<MemoryCollection & { notes: number }>): string {
  const list = collections.length
    ? collections.map((c) => `- ${c.name}${c.description ? `: ${c.description}` : ""} (${c.notes} note${c.notes === 1 ? "" : "s"})`).join("\n")
    : "- None yet. Pick a sensible collection name when you save the first note.";
  return [
    `"${store.name}" is a memory store: notes kept between conversations, grouped into collections.`,
    "Search it before answering questions it might cover, and before saving, so you update a note rather than duplicate it.",
    "When the user tells you something worth keeping, save it without being asked twice. Keep one subject per note.",
    "Collections:",
    list,
  ].join("\n");
}

/** Starter sets of collections offered when a store is created. */
export const MEMORY_TEMPLATES: Record<string, MemoryCollection[]> = {
  blank: [],
  "job-search": [
    { name: "Profile", description: "Who the user is professionally: CV, work history, skills, education, links." },
    { name: "Preferences", description: "What they're looking for: roles, locations, salary, companies to target or avoid." },
    { name: "Answers", description: "Reusable answers to common application questions and cover-letter material." },
    { name: "Applications", description: "One note per application: company, role, date, how it was sent, status and next step." },
  ],
};
