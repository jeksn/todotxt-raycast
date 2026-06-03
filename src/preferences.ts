import { getPreferenceValues } from "@raycast/api";
import type { SortOrder, GroupBy } from "./types";

export interface Preferences {
  /** Path to the todo.txt file */
  todoFilePath: string;
  /** Path to the done.txt file (optional) */
  doneFilePath?: string;
  /** Whether to move completed tasks to done.txt */
  archiveDone: boolean;
  /** Default sort order for the list view */
  defaultSort: SortOrder;
  /** Whether to show completed tasks in the list */
  showCompleted: boolean;
  /** How to group tasks in the list view */
  groupBy: GroupBy;
}

export function getPreferences(): Preferences {
  return getPreferenceValues<Preferences>();
}
