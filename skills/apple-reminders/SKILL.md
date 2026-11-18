---
name: apple-reminders
description: Read, manage, and sync personal to-dos and macOS Apple Reminders (shared with DSH), and open the Reminders side panel. Use when the user mentions todos, tasks, reminders, 待办, or 提醒事项.
---

# Apple Reminders (`personal_todos`)

Use the `personal_todos` MCP tool to read, add, update, complete, organize, and sync the user's personal to-do list. All changes share the same local store (`~/.dsh/dsh-apple-reminders/todos.json`) and two-way macOS Apple Reminders sync with DSH and the Antigravity Reminders side-pane UI.

## Operations (`op`)

- `list` (default): Return active items, list metadata, and sync status. Pass `includeTrash: true` to include soft-deleted items.
- `add`: Create a new task (`text` required).
- `toggle`: Flip `done` state for a task (`id` required). Completing a repeating task automatically spawns the next occurrence.
- `update`: Patch fields on an existing task (`id` required).
- `remove`: Soft-delete a task (`id` required) to Recently Deleted (30-day retention), or pass `permanent: true` to delete immediately.
- `restore`: Recover a task from Recently Deleted (`id` required, or `all: true` to restore all).
- `destroy`: Permanently delete a single task from Recently Deleted (`id` required).
- `empty_trash` / `clear_done`: Empty Recently Deleted, or remove completed tasks (`permanent: true` skips trash).
- `create_list` / `update_list` / `delete_list`: Manage lists (`name`, `newName`, `color`, `icon`, `pinned`, `sections`, `deleteReminders`).
- `sync`: Trigger an immediate two-way sync with macOS Apple Reminders.

## Task Fields

- `text`: Task title.
- `list`: Target list name (defaults to primary configured list, e.g. `DSH 待办`).
- `due`: Due date in `YYYY-MM-DD` (empty string clears).
- `dueTime`: 24-hour local time in `HH:MM` (e.g. `15:00`; empty string clears).
- `urgent`: `true` for alarm/urgent reminder.
- `flagged`: `true` to flag the task.
- `priority`: `0` (none), `1` (high), `5` (medium), `9` (low).
- `tags`: Array of tag names without leading `#`.
- `repeat`: `daily`, `weekdays`, `weekly`, `biweekly`, `monthly`, `yearly`, or `none`/`""` to clear.
- `location`: Location label (e.g. `到家时`); empty string clears.
- `url`: Associated URL; empty string clears.
- `notes`: Free-form notes; empty string clears.
- `parentId`: Parent task `id` for subtasks; empty string outdents.
- `section`: Section name within the list; empty string clears.
- `order`: Manual sort order number.
- `done`: Completion state for `update`.

## Side-Pane UI

When opening or referencing the visual Reminders panel would help the user view or manage their tasks interactively, include a clickable side-pane link in your reply. The sidecar id is `<plugin-dir>/reminders` (for example `sidecar://dsh-apple-reminders/reminders/` or `sidecar://apple-reminders/reminders/`, depending on the installed plugin folder name — check the plugin directory name per `ui-plugin-navigation`):

`[Apple Reminders](sidecar://<plugin-dir>/reminders/)`
