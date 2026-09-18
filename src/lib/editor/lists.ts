/** The drag handle and move-to-page must agree on what a list is. */

/** A bullet, a numbered item, a todo. */
export const LIST_ITEMS = new Set(["listItem", "taskItem"]);

/** What holds them. */
export const LISTS = new Set(["bulletList", "orderedList", "taskList"]);
