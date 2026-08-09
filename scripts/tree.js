/**
 * The node model behind the explorer tree.
 *
 * Two views are supported:
 *  - `source`  walks `document.toObject()`, the data actually stored in the database. Editable.
 *  - `derived` walks the live document instance, including everything systems and modules compute
 *              during data preparation. Read-only, since none of it is persisted.
 *
 * @module document-data-explorer/tree
 */

import { childFieldOf, containerFor, isEmbeddedField, isReadonlyField } from "./schema.js";
import { LIVE_SKIP_KEYS, MAX_DERIVED_DEPTH, isExpandable } from "./util.js";

/** @enum {string} */
export const MODE = {
  SOURCE: "source",
  DERIVED: "derived"
};

/**
 * @typedef {object} DataNode
 * @property {string} key          The property key, or the index for array members.
 * @property {string} path         The full dot path from the document root ("" for the root).
 * @property {*} value             The value held at this path.
 * @property {DataField|null} field      The declared field, when the path is schemaed.
 * @property {DataField|null} container  The field that resolves this node's children.
 * @property {foundry.abstract.Document} doc
 * @property {string} mode
 * @property {number} depth
 * @property {boolean} readonly    Whether this subtree may be edited.
 * @property {boolean} embedded    Whether this node sits inside an embedded document collection.
 * @property {string|null} embeddedCollection  The collection key when `embedded` is true.
 * @property {object[]} ancestors  Object references on the path to this node, for cycle detection.
 */

/**
 * Build the root node for a document.
 * @param {foundry.abstract.Document} doc
 * @param {string} mode
 * @param {object} [sourceData]  The working copy of the source data, when one is being edited.
 * @returns {DataNode}
 */
export function createRootNode(doc, mode, sourceData) {
  const derived = mode === MODE.DERIVED;
  const value = derived ? doc : (sourceData ?? doc.toObject());
  return {
    key: "",
    path: "",
    value,
    field: null,
    container: doc.constructor.schema ?? null,
    doc,
    mode,
    depth: 0,
    readonly: derived,
    embedded: false,
    embeddedCollection: null,
    ancestors: []
  };
}

/**
 * List the children of a node.
 * @param {DataNode} node
 * @returns {DataNode[]}
 */
export function childrenOf(node) {
  if (!isExpandable(node.value)) return [];
  if (node.depth >= MAX_DERIVED_DEPTH) return [];

  const entries = node.mode === MODE.DERIVED ? liveEntries(node.value) : sourceEntries(node.value);
  const ancestors = [...node.ancestors, node.value];

  return entries.reduce((children, [key, value]) => {
    // A value already seen on this branch is a cycle; the live document graph is full of them.
    if ((value !== null) && (typeof value === "object") && ancestors.includes(value)) return children;

    const field = childFieldOf(node.container, key);
    const path = node.path ? `${node.path}.${key}` : key;
    const embedded = node.embedded || isEmbeddedField(field);

    children.push({
      key,
      path,
      value,
      field,
      container: containerFor(field, value, node.value, node.doc, path),
      doc: node.doc,
      mode: node.mode,
      depth: node.depth + 1,
      readonly: node.readonly || embedded || isReadonlyField(field),
      embedded,
      embeddedCollection: isEmbeddedField(field) ? key : node.embeddedCollection,
      ancestors
    });
    return children;
  }, []);
}

/* -------------------------------------------- */

/**
 * Entries of a plain source value.
 * @param {object|Array} value
 * @returns {Array<[string, *]>}
 */
function sourceEntries(value) {
  if (Array.isArray(value)) return value.map((entry, index) => [String(index), entry]);
  return Object.entries(value);
}

/**
 * Entries of a live value, which may be a DataModel, a Collection, a Set, or a plain object.
 * Functions and known plumbing keys are dropped.
 * @param {*} value
 * @returns {Array<[string, *]>}
 */
function liveEntries(value) {
  let entries;

  if (Array.isArray(value)) entries = value.map((entry, index) => [String(index), entry]);
  else if (value instanceof Map) entries = [...value.entries()].map(([key, entry]) => [String(key), entry]);
  else if (value instanceof Set) entries = [...value].map((entry, index) => [String(index), entry]);
  else if (value instanceof foundry.abstract.DataModel) {
    // Derived properties are assigned directly on the model, so the own keys are the source of
    // truth; the schema keys are merged in to catch fields left at their initial value.
    const keys = new Set([...Object.keys(value), ...Object.keys(value.schema?.fields ?? {})]);
    entries = [...keys].map(key => [key, value[key]]);
  }
  else entries = Object.entries(value);

  return entries.filter(([key, entry]) => {
    if (LIVE_SKIP_KEYS.has(key) || key.startsWith("#")) return false;
    return typeof entry !== "function";
  });
}

/* -------------------------------------------- */

/**
 * Resolve the embedded document a node belongs to, so it can be opened in its own explorer.
 * @param {DataNode} node
 * @returns {foundry.abstract.Document|null}
 */
export function embeddedDocumentOf(node) {
  if (node.value instanceof foundry.abstract.Document) return node.value;
  const id = node.value?._id;
  if (!id || !node.embeddedCollection) return null;
  const collection = node.doc[node.embeddedCollection];
  return collection?.get?.(id) ?? null;
}

/**
 * Collect every dot path in a value whose path segment or stringified value matches a query.
 * Used by the filter box to decide which branches to reveal.
 * @param {DataNode} root
 * @param {string} query  A lowercased search string.
 * @returns {Set<string>}
 */
export function findMatchingPaths(root, query) {
  const matches = new Set();
  const queue = [root];
  let budget = SEARCH_NODE_BUDGET;

  while (queue.length && (budget > 0)) {
    const node = queue.shift();
    for (const child of childrenOf(node)) {
      if (--budget <= 0) break;
      if (matchesQuery(child, query)) matches.add(child.path);
      if (isExpandable(child.value)) queue.push(child);
    }
  }
  return matches;
}

/** How many nodes the filter will visit before giving up, so huge documents stay responsive. */
const SEARCH_NODE_BUDGET = 20000;

/**
 * @param {DataNode} node
 * @param {string} query
 * @returns {boolean}
 */
function matchesQuery(node, query) {
  if (node.path.toLowerCase().includes(query)) return true;
  const { value } = node;
  if ((value === null) || (typeof value === "object")) return false;
  return String(value).toLowerCase().includes(query);
}
