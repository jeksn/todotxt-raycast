import {
  List,
  ActionPanel,
  Action,
  Icon,
  Color,
  showToast,
  Toast,
  useNavigation,
  confirmAlert,
  Alert,
  Keyboard,
  openExtensionPreferences,
} from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";
import { useState, useCallback } from "react";
import type { TodoItem, SortOrder, GroupBy } from "./types";
import { getPriorityColor, PRIORITIES } from "./types";
import {
  readTodos,
  completeTodo,
  deleteTodo,
  updateTodo,
  sortTodos,
  serializeItem,
} from "./storage";
import { getPreferences } from "./preferences";
import EditTodoForm from "./edit-todo-form";
import AddTodo from "./add-todo";

// ---------------------------------------------------------------------------
// Priority badge helpers
// ---------------------------------------------------------------------------

function priorityTag(
  priority: string | undefined,
): List.Item.Accessory | undefined {
  if (!priority) return undefined;
  return {
    tag: {
      value: priority,
      color: getPriorityColor(priority) as Color,
    },
    tooltip: `Priority: ${priority}`,
  };
}

function dueTag(dueDate: string | undefined): List.Item.Accessory | undefined {
  if (!dueDate) return undefined;
  const today = new Date().toISOString().split("T")[0];
  const overdue = dueDate < today;
  const dueToday = dueDate === today;
  return {
    tag: {
      value: dueDate,
      color: overdue
        ? Color.Red
        : dueToday
          ? Color.Orange
          : Color.SecondaryText,
    },
    tooltip: overdue ? `Overdue (was ${dueDate})` : `Due: ${dueDate}`,
  };
}

// ---------------------------------------------------------------------------
// Item accessories
// ---------------------------------------------------------------------------

function buildAccessories(item: TodoItem): List.Item.Accessory[] {
  const accessories: List.Item.Accessory[] = [];

  const p = priorityTag(item.priority);
  if (p) accessories.push(p);

  const due = dueTag(item.tags["due"]);
  if (due) accessories.push(due);

  if (item.projects.length > 0) {
    accessories.push({
      text: item.projects.map((p) => `+${p}`).join(" "),
      icon: Icon.Tag,
      tooltip: `Projects: ${item.projects.join(", ")}`,
    });
  }

  if (item.contexts.length > 0) {
    accessories.push({
      text: item.contexts.map((c) => `@${c}`).join(" "),
      icon: Icon.Person,
      tooltip: `Contexts: ${item.contexts.join(", ")}`,
    });
  }

  if (item.completed && item.completionDate) {
    accessories.push({
      date: new Date(item.completionDate),
      tooltip: `Completed: ${item.completionDate}`,
    });
  }

  return accessories;
}

// ---------------------------------------------------------------------------
// Grouping helpers
// ---------------------------------------------------------------------------

type Sections = { title: string; items: TodoItem[] }[];

function groupItems(items: TodoItem[], groupBy: GroupBy): Sections {
  if (groupBy === "none") {
    return [{ title: "All Tasks", items }];
  }

  if (groupBy === "priority") {
    const map = new Map<string, TodoItem[]>();
    for (const item of items) {
      const key = item.completed
        ? "Completed"
        : item.priority
          ? `Priority ${item.priority}`
          : "No Priority";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(item);
    }
    // Sort sections: A, B, C … No Priority, Completed
    const ordered: Sections = [];
    for (const p of PRIORITIES) {
      const key = `Priority ${p}`;
      if (map.has(key)) ordered.push({ title: key, items: map.get(key)! });
    }
    if (map.has("No Priority"))
      ordered.push({ title: "No Priority", items: map.get("No Priority")! });
    if (map.has("Completed"))
      ordered.push({ title: "Completed", items: map.get("Completed")! });
    return ordered;
  }

  if (groupBy === "project") {
    const map = new Map<string, TodoItem[]>();
    for (const item of items) {
      const keys = item.projects.length > 0 ? item.projects : ["No Project"];
      for (const key of keys) {
        if (!map.has(key)) map.set(key, []);
        map.get(key)!.push(item);
      }
    }
    return Array.from(map.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([title, items]) => ({ title: `+${title}`, items }));
  }

  if (groupBy === "context") {
    const map = new Map<string, TodoItem[]>();
    for (const item of items) {
      const keys = item.contexts.length > 0 ? item.contexts : ["No Context"];
      for (const key of keys) {
        if (!map.has(key)) map.set(key, []);
        map.get(key)!.push(item);
      }
    }
    return Array.from(map.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([title, items]) => ({ title: `@${title}`, items }));
  }

  return [{ title: "All Tasks", items }];
}

// ---------------------------------------------------------------------------
// Actions for a single item
// ---------------------------------------------------------------------------

function TodoActions({
  item,
  onComplete,
  onDelete,
  onUpdate,
}: {
  item: TodoItem;
  onComplete: (item: TodoItem) => Promise<void>;
  onDelete: (item: TodoItem) => Promise<void>;
  onUpdate: (item: TodoItem) => void;
}) {
  const { push } = useNavigation();

  return (
    <ActionPanel>
      <ActionPanel.Section title="Task">
        {!item.completed && (
          <Action
            title="Mark as Complete"
            icon={Icon.Checkmark}
            shortcut={{ modifiers: ["cmd"], key: "d" }}
            onAction={() => onComplete(item)}
          />
        )}
        <Action
          title="Edit Task"
          icon={Icon.Pencil}
          shortcut={{ modifiers: ["cmd"], key: "e" }}
          onAction={() => push(<EditTodoForm item={item} onSave={onUpdate} />)}
        />
      </ActionPanel.Section>

      <ActionPanel.Section title="Priority">
        {PRIORITIES.slice(0, 6).map((p) => (
          <Action
            key={p}
            title={`Set Priority ${p}`}
            icon={{
              source: Icon.Circle,
              tintColor: getPriorityColor(p) as Color,
            }}
            shortcut={
              p === "A" ? { modifiers: ["cmd", "shift"], key: "a" } : undefined
            }
            onAction={() => onUpdate({ ...item, priority: p })}
          />
        ))}
        <Action
          title="Remove Priority"
          icon={Icon.XMarkCircle}
          onAction={() => onUpdate({ ...item, priority: undefined })}
        />
      </ActionPanel.Section>

      <ActionPanel.Section title="Manage">
        <Action.CopyToClipboard
          title="Copy Task Text"
          content={item.text}
          shortcut={Keyboard.Shortcut.Common.Copy}
        />
        <Action.CopyToClipboard
          title="Copy Raw Line"
          content={serializeItem(item)}
        />
        <Action
          title="Delete Task"
          icon={Icon.Trash}
          style={Action.Style.Destructive}
          shortcut={Keyboard.Shortcut.Common.Remove}
          onAction={() => onDelete(item)}
        />
      </ActionPanel.Section>

      <ActionPanel.Section>
        <Action
          title="Open Preferences"
          icon={Icon.Gear}
          onAction={openExtensionPreferences}
        />
      </ActionPanel.Section>
    </ActionPanel>
  );
}

// ---------------------------------------------------------------------------
// Main command
// ---------------------------------------------------------------------------

export default function ListTodos() {
  const prefs = getPreferences();
  const [sortOrder, setSortOrder] = useState<SortOrder>(prefs.defaultSort);
  const [groupBy, setGroupBy] = useState<GroupBy>(prefs.groupBy);
  const [showCompleted, setShowCompleted] = useState<boolean>(
    prefs.showCompleted,
  );
  const [filterContext, setFilterContext] = useState<string | null>(null);
  const [filterProject, setFilterProject] = useState<string | null>(null);

  const {
    data: todos,
    isLoading,
    revalidate,
    mutate,
  } = useCachedPromise(() => readTodos(prefs.todoFilePath), [], {
    keepPreviousData: true,
  });

  // ---------------------------------------------------------------------------
  // Mutations
  // ---------------------------------------------------------------------------

  const handleComplete = useCallback(
    async (item: TodoItem) => {
      const toast = await showToast({
        style: Toast.Style.Animated,
        title: "Completing task…",
      });
      try {
        await mutate(
          completeTodo(
            prefs.todoFilePath,
            prefs.doneFilePath,
            item,
            prefs.archiveDone,
          ),
          {
            optimisticUpdate: (current) => {
              if (!current) return current;
              if (prefs.archiveDone)
                return current.filter((t) => t.id !== item.id);
              const today = new Date().toISOString().split("T")[0];
              return current.map((t) =>
                t.id === item.id
                  ? {
                      ...t,
                      completed: true,
                      completionDate: today,
                      priority: undefined,
                    }
                  : t,
              );
            },
          },
        );
        toast.style = Toast.Style.Success;
        toast.title = prefs.archiveDone
          ? "Task archived to done.txt"
          : "Task marked complete";
      } catch (err) {
        toast.style = Toast.Style.Failure;
        toast.title = "Failed to complete task";
        toast.message = err instanceof Error ? err.message : String(err);
      }
    },
    [prefs, mutate],
  );

  const handleDelete = useCallback(
    async (item: TodoItem) => {
      const confirmed = await confirmAlert({
        title: "Delete Task",
        message: `"${item.text}" will be permanently deleted.`,
        primaryAction: {
          title: "Delete",
          style: Alert.ActionStyle.Destructive,
        },
      });
      if (!confirmed) return;

      const toast = await showToast({
        style: Toast.Style.Animated,
        title: "Deleting task…",
      });
      try {
        await mutate(deleteTodo(prefs.todoFilePath, item), {
          optimisticUpdate: (current) =>
            current?.filter((t) => t.id !== item.id),
        });
        toast.style = Toast.Style.Success;
        toast.title = "Task deleted";
      } catch (err) {
        toast.style = Toast.Style.Failure;
        toast.title = "Failed to delete task";
        toast.message = err instanceof Error ? err.message : String(err);
      }
    },
    [prefs, mutate],
  );

  const handleUpdate = useCallback(
    async (updated: TodoItem) => {
      // Rebuild raw from the updated item
      const newRaw = serializeItem(updated);
      const itemWithRaw = { ...updated, raw: newRaw };

      const toast = await showToast({
        style: Toast.Style.Animated,
        title: "Updating task…",
      });
      try {
        await mutate(updateTodo(prefs.todoFilePath, itemWithRaw), {
          optimisticUpdate: (current) =>
            current?.map((t) => (t.id === itemWithRaw.id ? itemWithRaw : t)),
        });
        toast.style = Toast.Style.Success;
        toast.title = "Task updated";
      } catch (err) {
        toast.style = Toast.Style.Failure;
        toast.title = "Failed to update task";
        toast.message = err instanceof Error ? err.message : String(err);
      }
    },
    [prefs, mutate],
  );

  // ---------------------------------------------------------------------------
  // Filtering and sorting
  // ---------------------------------------------------------------------------

  const allItems = todos ?? [];

  const filtered = allItems.filter((item) => {
    if (!showCompleted && item.completed) return false;
    if (filterContext && !item.contexts.includes(filterContext)) return false;
    if (filterProject && !item.projects.includes(filterProject)) return false;
    return true;
  });

  const sorted = sortTodos(filtered, sortOrder);
  const sections = groupItems(sorted, groupBy);

  // Collect unique contexts and projects for filter dropdowns
  const allContexts = Array.from(
    new Set(allItems.flatMap((i) => i.contexts)),
  ).sort();
  const allProjects = Array.from(
    new Set(allItems.flatMap((i) => i.projects)),
  ).sort();
  const pendingCount = allItems.filter((i) => !i.completed).length;

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <List
      isLoading={isLoading}
      searchBarPlaceholder={`Search ${pendingCount} task${pendingCount !== 1 ? "s" : ""}…`}
      searchBarAccessory={
        <List.Dropdown
          tooltip="Filter & Sort Options"
          storeValue
          onChange={(val) => {
            if (val.startsWith("sort:")) {
              setSortOrder(val.slice(5) as SortOrder);
            } else if (val.startsWith("group:")) {
              setGroupBy(val.slice(6) as GroupBy);
            } else if (val.startsWith("context:")) {
              setFilterContext(val.slice(8) || null);
            } else if (val.startsWith("project:")) {
              setFilterProject(val.slice(8) || null);
            } else if (val === "show-completed") {
              setShowCompleted((v) => !v);
            }
          }}
        >
          <List.Dropdown.Section title="Sort By">
            <List.Dropdown.Item
              title="Priority"
              value="sort:priority"
              icon={Icon.ArrowUp}
            />
            <List.Dropdown.Item
              title="Due Date"
              value="sort:due-date"
              icon={Icon.Calendar}
            />
            <List.Dropdown.Item
              title="Creation Date (newest)"
              value="sort:creation-date-desc"
              icon={Icon.Clock}
            />
            <List.Dropdown.Item
              title="Creation Date (oldest)"
              value="sort:creation-date-asc"
              icon={Icon.Clock}
            />
            <List.Dropdown.Item
              title="Alphabetical"
              value="sort:alpha"
              icon={Icon.Text}
            />
          </List.Dropdown.Section>

          <List.Dropdown.Section title="Group By">
            <List.Dropdown.Item
              title="Priority"
              value="group:priority"
              icon={Icon.BarChart}
            />
            <List.Dropdown.Item
              title="Project"
              value="group:project"
              icon={Icon.Folder}
            />
            <List.Dropdown.Item
              title="Context"
              value="group:context"
              icon={Icon.Person}
            />
            <List.Dropdown.Item
              title="None"
              value="group:none"
              icon={Icon.Minus}
            />
          </List.Dropdown.Section>

          {allContexts.length > 0 && (
            <List.Dropdown.Section title="Filter by Context">
              <List.Dropdown.Item
                title="All Contexts"
                value="context:"
                icon={Icon.XMarkCircle}
              />
              {allContexts.map((ctx) => (
                <List.Dropdown.Item
                  key={ctx}
                  title={`@${ctx}`}
                  value={`context:${ctx}`}
                  icon={Icon.Person}
                />
              ))}
            </List.Dropdown.Section>
          )}

          {allProjects.length > 0 && (
            <List.Dropdown.Section title="Filter by Project">
              <List.Dropdown.Item
                title="All Projects"
                value="project:"
                icon={Icon.XMarkCircle}
              />
              {allProjects.map((proj) => (
                <List.Dropdown.Item
                  key={proj}
                  title={`+${proj}`}
                  value={`project:${proj}`}
                  icon={Icon.Tag}
                />
              ))}
            </List.Dropdown.Section>
          )}
        </List.Dropdown>
      }
      actions={
        <ActionPanel>
          <Action.Push
            title="Add New Todo"
            icon={Icon.Plus}
            shortcut={{ modifiers: ["cmd"], key: "n" }}
            target={<AddTodoPlaceholder onAdd={revalidate} />}
          />
          <Action
            title="Refresh"
            icon={Icon.ArrowClockwise}
            onAction={revalidate}
            shortcut={{ modifiers: ["cmd"], key: "r" }}
          />
          <Action
            title={showCompleted ? "Hide Completed" : "Show Completed"}
            icon={showCompleted ? Icon.EyeSlash : Icon.Eye}
            onAction={() => setShowCompleted((v) => !v)}
          />
        </ActionPanel>
      }
    >
      {sections.map((section) => (
        <List.Section
          key={section.title}
          title={section.title}
          subtitle={`${section.items.length}`}
        >
          {section.items.map((item) => (
            <List.Item
              key={item.id}
              id={item.id}
              icon={
                item.completed
                  ? { source: Icon.CheckCircle, tintColor: Color.Green }
                  : item.priority
                    ? {
                        source: Icon.Circle,
                        tintColor: getPriorityColor(item.priority) as Color,
                      }
                    : Icon.Circle
              }
              title={item.text || item.description}
              subtitle={
                item.completed
                  ? item.completionDate
                    ? `Completed ${item.completionDate}`
                    : "Completed"
                  : item.creationDate
                    ? `Created ${item.creationDate}`
                    : undefined
              }
              accessories={buildAccessories(item)}
              actions={
                <TodoActions
                  item={item}
                  onComplete={handleComplete}
                  onDelete={handleDelete}
                  onUpdate={handleUpdate}
                />
              }
            />
          ))}
        </List.Section>
      ))}

      {!isLoading && allItems.length === 0 && (
        <List.EmptyView
          title="No Todos Found"
          description="Press ⌘N to add your first task, or check your todo.txt file path in preferences."
          icon={Icon.Checkmark}
          actions={
            <ActionPanel>
              <Action
                title="Open Preferences"
                icon={Icon.Gear}
                onAction={openExtensionPreferences}
              />
            </ActionPanel>
          }
        />
      )}
    </List>
  );
}

// ---------------------------------------------------------------------------
// Thin placeholder to push add-todo from within the list
// ---------------------------------------------------------------------------

function AddTodoPlaceholder({ onAdd }: { onAdd: () => void }) {
  const { pop } = useNavigation();
  return (
    <AddTodo
      onAdd={() => {
        onAdd();
        pop();
      }}
    />
  );
}
