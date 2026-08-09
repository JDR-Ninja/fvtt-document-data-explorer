/**
 * Shared constants and small helpers.
 * @module document-data-explorer/util
 */

export const MODULE_ID = "document-data-explorer";

/** The `data-action` used for the sheet header control. */
export const HEADER_ACTION = "documentDataExplorer";

/** Maximum depth walked when exploring live (derived) data, to guard against runaway structures. */
export const MAX_DERIVED_DEPTH = 12;

/**
 * Keys that are skipped when walking live document data. They are either internal plumbing,
 * or back-references that would make the walk cycle forever.
 * @type {Set<string>}
 */
export const LIVE_SKIP_KEYS = new Set([
  "apps", "collections", "parent", "pack", "sheet", "_sheet", "schema", "_source",
  "document", "object", "_object", "actor", "item", "options", "_initialized"
]);

/* -------------------------------------------- */

/**
 * Log a namespaced message to the console.
 * @param {...*} args
 */
export function log(...args) {
  console.log(`${MODULE_ID} |`, ...args);
}

/**
 * Localize a key, optionally formatting it with data.
 * @param {string} key
 * @param {object} [data]
 * @returns {string}
 */
export function t(key, data) {
  return data ? game.i18n.format(key, data) : game.i18n.localize(key);
}

/* -------------------------------------------- */

/**
 * Copy text to the clipboard, preferring Foundry's helper.
 * @param {string} text
 * @returns {Promise<void>}
 */
export async function copyText(text) {
  try {
    if (game.clipboard?.copyPlainText) await game.clipboard.copyPlainText(text);
    else await navigator.clipboard.writeText(text);
  } catch (err) {
    log("clipboard copy failed", err);
    ui.notifications.warn(t("DDE.Notify.CopyFailed"));
    return;
  }
  ui.notifications.info(t("DDE.Notify.Copied", { text: truncate(text, 60) }));
}

/**
 * Trigger a browser download of a JSON payload.
 * @param {string} filename
 * @param {*} data
 */
export function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* -------------------------------------------- */

/**
 * A short label describing the runtime type of a value.
 * @param {*} value
 * @returns {string}
 */
export function typeOf(value) {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return "array";
  if (value instanceof Set) return "Set";
  if (value instanceof Map) return "Map";
  const type = typeof value;
  if (type === "object") return value.constructor?.name || "object";
  return type;
}

/**
 * Truncate a string for display.
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
export function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * A compact one-line preview of a value, used on collapsed rows.
 * @param {*} value
 * @returns {string}
 */
export function previewOf(value) {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return `"${truncate(value, 60)}"`;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "function") return "ƒ()";
  if (Array.isArray(value)) return `[${value.length}]`;
  if (value instanceof Map || value instanceof Set) return `${value.constructor.name}(${value.size})`;
  if (value instanceof foundry.abstract.Document) return `${value.documentName} "${value.name ?? value.id}"`;
  if (typeof value === "object") return `{${Object.keys(value).length}}`;
  return String(value);
}

/**
 * Whether a value can be expanded into child rows.
 * @param {*} value
 * @returns {boolean}
 */
export function isExpandable(value) {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (value instanceof Map || value instanceof Set) return value.size > 0;
  return true;
}

/**
 * Structural equality good enough for change detection on form values.
 * @param {*} a
 * @param {*} b
 * @returns {boolean}
 */
export function valuesEqual(a, b) {
  if (a === b) return true;
  if ((a === null) || (b === null) || (typeof a !== "object") || (typeof b !== "object")) return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/**
 * Split a dot path into its ancestor paths, from the shallowest to the deepest.
 * `"a.b.c"` yields `["a", "a.b", "a.b.c"]`.
 * @param {string} path
 * @returns {string[]}
 */
export function ancestorPaths(path) {
  if (!path) return [];
  const parts = path.split(".");
  return parts.map((_, i) => parts.slice(0, i + 1).join("."));
}
