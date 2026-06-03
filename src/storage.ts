import { readFile, writeFile, access, appendFile } from "fs/promises";
import { dirname, join, resolve } from "path";
import { homedir } from "os";
import { randomUUID } from "crypto";
import type { TodoItem, SortOrder } from "./types";

// ---------------------------------------------------------------------------
// Path utilities
// ---------------------------------------------------------------------------

export function expandPath(filePath: string): string {
  if (filePath.startsWith("~")) {
    return resolve(homedir(), filePath.slice(2));
  }
  return resolve(filePath);
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse a single todo.txt line into a TodoItem.
 * Returns null for blank/empty lines.
 */
export function parseLine(line: string, lineNumber: number): TodoItem | null {
  if (!line.trim()) return null;

  let rest = line;
  let completed = false;
  let completionDate: string | undefined;
  let priority: string | undefined;
  let creationDate: string | undefined;

  // Completed task: "x " prefix
  if (rest.startsWith("x ")) {
    completed = true;
    rest = rest.slice(2).trimStart();

    // Optional completion date
    const [maybeCompDate, ...afterCompDate] = rest.split(" ");
    if (DATE_RE.test(maybeCompDate)) {
      completionDate = maybeCompDate;
      rest = afterCompDate.join(" ");
    }
  }

  // Priority: (A) at start
  const priorityMatch = rest.match(/^\(([A-Z])\) /);
  if (priorityMatch) {
    priority = priorityMatch[1];
    rest = rest.slice(4); // "(A) ".length === 4
  }

  // Creation date
  const [maybeCreation, ...afterCreation] = rest.split(" ");
  if (DATE_RE.test(maybeCreation)) {
    creationDate = maybeCreation;
    rest = afterCreation.join(" ");
  }

  const description = rest;

  // Extract +projects, @contexts, and key:value tags
  const projects: string[] = [];
  const contexts: string[] = [];
  const tags: Record<string, string> = {};

  const words = description.split(" ");
  const textWords: string[] = [];

  for (const word of words) {
    if (word.startsWith("+") && word.length > 1 && !/\s/.test(word)) {
      projects.push(word.slice(1));
    } else if (word.startsWith("@") && word.length > 1 && !/\s/.test(word)) {
      contexts.push(word.slice(1));
    } else if (
      /^[a-zA-Z][a-zA-Z0-9_-]*:[^\s/]+$/.test(word) &&
      !word.startsWith("http")
    ) {
      const colonIdx = word.indexOf(":");
      tags[word.slice(0, colonIdx)] = word.slice(colonIdx + 1);
    } else {
      textWords.push(word);
    }
  }

  const text = textWords.join(" ").trim();

  return {
    id: randomUUID(),
    raw: line,
    completed,
    completionDate,
    priority,
    creationDate,
    text,
    description,
    projects,
    contexts,
    tags,
    lineNumber,
  };
}

// ---------------------------------------------------------------------------
// Serializer
// ---------------------------------------------------------------------------

/**
 * Serialize a TodoItem back into a todo.txt line.
 */
export function serializeItem(item: TodoItem): string {
  const parts: string[] = [];

  if (item.completed) {
    parts.push("x");
    if (item.completionDate) parts.push(item.completionDate);
  }

  if (item.priority && !item.completed) {
    parts.push(`(${item.priority})`);
  }

  if (item.creationDate) parts.push(item.creationDate);

  parts.push(item.description);

  return parts.join(" ");
}

/**
 * Build a description string from structured fields.
 * Merges text, projects, contexts, and tags back into the description.
 */
export function buildDescription(opts: {
  text: string;
  projects?: string[];
  contexts?: string[];
  tags?: Record<string, string>;
}): string {
  const parts = [opts.text];

  for (const p of opts.projects ?? []) {
    if (!parts[0].includes(`+${p}`)) parts.push(`+${p}`);
  }
  for (const c of opts.contexts ?? []) {
    if (!parts[0].includes(`@${c}`)) parts.push(`@${c}`);
  }
  for (const [k, v] of Object.entries(opts.tags ?? {})) {
    if (!parts[0].includes(`${k}:${v}`)) parts.push(`${k}:${v}`);
  }

  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

/**
 * Read and parse the todo.txt file. Returns an empty array if the file
 * does not exist.
 */
export async function readTodos(todoFilePath: string): Promise<TodoItem[]> {
  const path = expandPath(todoFilePath);
  const exists = await fileExists(path);
  if (!exists) return [];

  const content = await readFile(path, "utf-8");
  const lines = content.split("\n");
  const items: TodoItem[] = [];

  for (let i = 0; i < lines.length; i++) {
    const item = parseLine(lines[i], i + 1);
    if (item) items.push(item);
  }

  return items;
}

/**
 * Write the provided list of TodoItems back to the todo.txt file,
 * preserving the original line order. Items without a raw representation
 * (newly created) are appended at the end.
 */
export async function writeTodos(
  todoFilePath: string,
  items: TodoItem[],
): Promise<void> {
  const path = expandPath(todoFilePath);

  // Reconstruct lines: sort by lineNumber so we maintain file order
  const sorted = [...items].sort((a, b) => a.lineNumber - b.lineNumber);
  const lines = sorted.map(serializeItem);

  await writeFile(
    path,
    lines.join("\n") + (lines.length > 0 ? "\n" : ""),
    "utf-8",
  );
}

/**
 * Append a single raw todo.txt line to the todo file.
 */
export async function appendTodo(
  todoFilePath: string,
  line: string,
): Promise<void> {
  const path = expandPath(todoFilePath);

  // Ensure file exists; if not, create it
  const exists = await fileExists(path);
  if (!exists) {
    await writeFile(path, line + "\n", "utf-8");
    return;
  }

  // Read to check if file ends with a newline
  const content = await readFile(path, "utf-8");
  const prefix = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
  await appendFile(path, prefix + line + "\n", "utf-8");
}

/**
 * Mark a todo item as complete and optionally archive it to done.txt.
 *
 * @param todoFilePath    Path to todo.txt
 * @param doneFilePath    Path to done.txt (or undefined to derive from todoFilePath dir)
 * @param item            The item to complete
 * @param archive         If true, move to done.txt; if false, keep in todo.txt
 */
export async function completeTodo(
  todoFilePath: string,
  doneFilePath: string | undefined,
  item: TodoItem,
  archive: boolean,
): Promise<TodoItem[]> {
  const today = new Date().toISOString().split("T")[0];

  const completedItem: TodoItem = {
    ...item,
    completed: true,
    completionDate: today,
    // Remove priority on completion (todo.txt spec: priority is removed on completion)
    priority: undefined,
    raw: serializeItem({
      ...item,
      completed: true,
      completionDate: today,
      priority: undefined,
    }),
  };

  const allItems = await readTodos(todoFilePath);
  const remaining = allItems.filter((t) => t.id !== item.id);

  if (archive) {
    // Remove from todo.txt
    await writeTodos(todoFilePath, remaining);

    // Append to done.txt
    const resolvedDone = doneFilePath
      ? expandPath(doneFilePath)
      : join(dirname(expandPath(todoFilePath)), "done.txt");

    const doneExists = await fileExists(resolvedDone);
    const content = doneExists ? await readFile(resolvedDone, "utf-8") : "";
    const prefix = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
    await appendFile(
      resolvedDone,
      prefix + serializeItem(completedItem) + "\n",
      "utf-8",
    );

    return remaining;
  } else {
    // Replace the item in place with the completed version
    const updated = allItems.map((t) => (t.id === item.id ? completedItem : t));
    await writeTodos(todoFilePath, updated);
    return updated;
  }
}

/**
 * Delete a todo item by id and write the result back to disk.
 */
export async function deleteTodo(
  todoFilePath: string,
  item: TodoItem,
): Promise<TodoItem[]> {
  const allItems = await readTodos(todoFilePath);
  const remaining = allItems.filter((t) => t.lineNumber !== item.lineNumber);
  await writeTodos(todoFilePath, remaining);
  return remaining;
}

/**
 * Update a todo item in-place and write back to disk.
 */
export async function updateTodo(
  todoFilePath: string,
  updated: TodoItem,
): Promise<TodoItem[]> {
  const allItems = await readTodos(todoFilePath);
  const newItems = allItems.map((t) =>
    t.lineNumber === updated.lineNumber ? updated : t,
  );
  await writeTodos(todoFilePath, newItems);
  return newItems;
}

// ---------------------------------------------------------------------------
// Sorting helpers
// ---------------------------------------------------------------------------

const MAX_DATE = "9999-99-99";

export function sortTodos(items: TodoItem[], order: SortOrder): TodoItem[] {
  const copy = [...items];

  switch (order) {
    case "priority":
      return copy.sort((a, b) => {
        // Completed tasks go to the bottom
        if (a.completed !== b.completed) return a.completed ? 1 : -1;
        const pa = a.priority ?? "ZZ";
        const pb = b.priority ?? "ZZ";
        return pa.localeCompare(pb);
      });

    case "creation-date-desc":
      return copy.sort((a, b) => {
        const da = a.creationDate ?? "";
        const db = b.creationDate ?? "";
        return db.localeCompare(da);
      });

    case "creation-date-asc":
      return copy.sort((a, b) => {
        const da = a.creationDate ?? MAX_DATE;
        const db = b.creationDate ?? MAX_DATE;
        return da.localeCompare(db);
      });

    case "due-date":
      return copy.sort((a, b) => {
        const da = a.tags["due"] ?? MAX_DATE;
        const db = b.tags["due"] ?? MAX_DATE;
        return da.localeCompare(db);
      });

    case "alpha":
      return copy.sort((a, b) =>
        a.text.toLowerCase().localeCompare(b.text.toLowerCase()),
      );

    default:
      return copy;
  }
}
