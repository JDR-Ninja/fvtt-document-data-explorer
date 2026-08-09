/**
 * The explorer window itself.
 * @module document-data-explorer/explorer
 */

import {
  acceptsFreeKeys, buildInput, coerceValue, describeField, isAtDefault, readInput, referenceUuid,
  validateValue
} from "./schema.js";
import { MODE, childrenOf, createRootNode, embeddedDocumentOf, findMatchingPaths } from "./tree.js";
import {
  MODULE_ID, ancestorPaths, copyText, downloadJson, isExpandable, previewOf, t, valuesEqual
} from "./util.js";

const { ApplicationV2, DialogV2 } = foundry.applications.api;

/** Cap on how many branches "expand all" will open, so huge documents cannot lock the client. */
const EXPAND_ALL_LIMIT = 2000;

/**
 * An ApplicationV2 window that walks a document's data structure and lets a GM edit it.
 */
export class DocumentDataExplorer extends ApplicationV2 {

  /**
   * @param {foundry.abstract.Document} doc
   * @param {object} [options]
   */
  constructor(doc, options = {}) {
    super({ id: `dde-${doc.uuid.replace(/[^\w-]/g, "-")}`, ...options });
    this.#document = doc;
    this.#reset();
  }

  /* -------------------------------------------- */

  /** @override */
  static DEFAULT_OPTIONS = {
    classes: ["document-data-explorer"],
    tag: "form",
    window: {
      icon: "fa-solid fa-code",
      resizable: true,
      minimizable: true
    },
    position: { width: 780, height: 700 },
    form: {
      handler: DocumentDataExplorer.#onSubmitForm,
      submitOnChange: false,
      closeOnSubmit: false
    },
    actions: {
      addKey: DocumentDataExplorer.#onAddKey,
      collapseAll: DocumentDataExplorer.#onCollapseAll,
      copyMacro: DocumentDataExplorer.#onCopyMacro,
      copyPath: DocumentDataExplorer.#onCopyPath,
      copyUuid: DocumentDataExplorer.#onCopyUuid,
      copyValue: DocumentDataExplorer.#onCopyValue,
      deleteKey: DocumentDataExplorer.#onDeleteKey,
      discard: DocumentDataExplorer.#onDiscard,
      editJson: DocumentDataExplorer.#onEditJson,
      expandAll: DocumentDataExplorer.#onExpandAll,
      exportJson: DocumentDataExplorer.#onExportJson,
      openEmbedded: DocumentDataExplorer.#onOpenEmbedded,
      openReference: DocumentDataExplorer.#onOpenReference,
      revert: DocumentDataExplorer.#onRevert,
      setMode: DocumentDataExplorer.#onSetMode,
      toggleDefaults: DocumentDataExplorer.#onToggleDefaults,
      toggleNode: DocumentDataExplorer.#onToggleNode,
      toggleReview: DocumentDataExplorer.#onToggleReview
    }
  };

  /* -------------------------------------------- */
  /*  Instance state                              */
  /* -------------------------------------------- */

  /** @type {foundry.abstract.Document} */
  #document;

  /** The pristine source data, used to tell what actually changed. @type {object} */
  #original;

  /** A mutable copy of the source data reflecting every staged edit. @type {object} */
  #working;

  /** Staged edits, keyed by the update path that will be sent. @type {Map<string, *>} */
  #changes = new Map();

  /** Paths of keys staged for deletion. @type {Set<string>} */
  #deletions = new Set();

  /** Paths whose object value must be wiped before being re-set. @type {Set<string>} */
  #replacements = new Set();

  /** Paths of expanded branches. @type {Set<string>} */
  #expanded = new Set(["system", "flags"]);

  /** Nodes rendered in the current tree, keyed by path. @type {Map<string, object>} */
  #nodes = new Map();

  /** @type {string} */
  #mode = MODE.SOURCE;

  /** @type {string} */
  #filter = "";

  /** Whether rows still holding their schema default are hidden. @type {boolean} */
  #hideDefaults = false;

  /** Whether the pending-change review panel is open. @type {boolean} */
  #reviewOpen = false;

  /** Hook registrations to clean up on close. @type {Array<[string, number]>} */
  #hooks = [];

  /** True while our own update is in flight, so the update hook stays quiet. @type {boolean} */
  #applying = false;

  /** @type {number} */
  #scrollTop = 0;

  /** Caret position of the filter box when a render interrupts typing. @type {?{start: number, end: number}} */
  #searchFocus = null;

  /** @type {boolean} */
  #listening = false;

  /* -------------------------------------------- */
  /*  Accessors                                   */
  /* -------------------------------------------- */

  /** The document being explored. @type {foundry.abstract.Document} */
  get document() {
    return this.#document;
  }

  /** @override */
  get title() {
    const doc = this.#document;
    return t("DDE.WindowTitle", { name: doc.name ?? doc.id ?? doc.documentName });
  }

  /** Whether the document may be modified by the current user. @type {boolean} */
  get isEditable() {
    const doc = this.#document;
    if (doc.pack && game.packs.get(doc.pack)?.locked) return false;
    return doc.canUserModify?.(game.user, "update") ?? game.user.isGM;
  }

  /** The number of staged changes. @type {number} */
  get pendingCount() {
    return this.#changes.size + this.#deletions.size;
  }

  /* -------------------------------------------- */
  /*  Window management                           */
  /* -------------------------------------------- */

  /** Open windows, keyed by document uuid. @type {Map<string, DocumentDataExplorer>} */
  static #instances = new Map();

  /**
   * Open (or focus) the explorer for a document.
   * @param {foundry.abstract.Document} doc
   * @returns {Promise<DocumentDataExplorer>}
   */
  static async open(doc) {
    let app = DocumentDataExplorer.#instances.get(doc.uuid);
    if (!app) {
      app = new DocumentDataExplorer(doc);
      DocumentDataExplorer.#instances.set(doc.uuid, app);
    }
    await app.render({ force: true });
    app.bringToFront?.();
    return app;
  }

  /* -------------------------------------------- */

  /** @override */
  _onFirstRender(context, options) {
    super._onFirstRender(context, options);
    const name = this.#document.documentName;
    this.#hooks.push(
      [`update${name}`, Hooks.on(`update${name}`, doc => this.#onDocumentChanged(doc))],
      [`delete${name}`, Hooks.on(`delete${name}`, doc => {
        if (doc.uuid === this.#document.uuid) this.close();
      })]
    );
  }

  /** @override */
  _onClose(options) {
    super._onClose(options);
    for (const [hook, id] of this.#hooks) Hooks.off(hook, id);
    this.#hooks = [];
    this.#listening = false; // A re-render after close builds a fresh element.
    DocumentDataExplorer.#instances.delete(this.#document.uuid);
  }

  /* -------------------------------------------- */
  /*  Rendering                                   */
  /* -------------------------------------------- */

  /** @override */
  async _prepareContext(options) {
    return {
      document: this.#document,
      mode: this.#mode,
      editable: this.isEditable
    };
  }

  /** @override */
  _preRender(context, options) {
    this.#scrollTop = this.element?.querySelector(".dde-scroller")?.scrollTop ?? this.#scrollTop;

    // Filtering re-renders while the user is still typing, which would otherwise drop the caret.
    const search = this.element?.querySelector(".dde-search");
    this.#searchFocus = (search && (search.ownerDocument.activeElement === search))
      ? { start: search.selectionStart, end: search.selectionEnd }
      : null;
  }

  /** @override */
  async _renderHTML(context, options) {
    this.#nodes.clear();

    const root = document.createElement("div");
    root.className = "dde-wrapper";
    root.append(this.#renderToolbar(), this.#renderScroller(), this.#renderReview(), this.#renderFooter());
    return root;
  }

  /** @override */
  _replaceHTML(result, content, options) {
    content.replaceChildren(result);
  }

  /** @override */
  _onRender(context, options) {
    super._onRender(context, options);

    const scroller = this.element.querySelector(".dde-scroller");
    if (scroller) scroller.scrollTop = this.#scrollTop;

    if (this.#searchFocus) {
      const search = this.element.querySelector(".dde-search");
      const { start, end } = this.#searchFocus;
      this.#searchFocus = null;
      search?.focus();
      try {
        search?.setSelectionRange(start, end);
      } catch {
        // Some browsers refuse selection ranges on search inputs; the focus alone is enough.
      }
    }

    if (!this.#listening) {
      this.#listening = true;
      this.element.addEventListener("change", this.#onValueChange.bind(this));
      this.element.addEventListener("input", this.#onFilterInput.bind(this));
      this.element.addEventListener("keydown", event => {
        // Enter inside the filter box would otherwise submit the staged changes.
        if ((event.key === "Enter") && event.target.classList.contains("dde-search")) event.preventDefault();
      });
    }
  }

  /* -------------------------------------------- */

  /**
   * The header strip: document identity, view mode, filter and global actions.
   * @returns {HTMLElement}
   */
  #renderToolbar() {
    const doc = this.#document;
    const toolbar = document.createElement("header");
    toolbar.className = "dde-toolbar";

    const identity = document.createElement("div");
    identity.className = "dde-identity";

    const label = document.createElement("span");
    label.className = "dde-doc-type";
    label.textContent = doc.type ? `${doc.documentName} · ${doc.type}` : doc.documentName;
    identity.append(label);

    const uuid = document.createElement("code");
    uuid.className = "dde-uuid";
    uuid.dataset.action = "copyUuid";
    uuid.title = t("DDE.Action.CopyUuid");
    uuid.textContent = doc.uuid;
    identity.append(uuid);

    if (!this.isEditable) {
      const lock = document.createElement("span");
      lock.className = "dde-lock";
      lock.innerHTML = `<i class="fa-solid fa-lock"></i> ${t("DDE.ReadOnly")}`;
      identity.append(lock);
    }

    const controls = document.createElement("div");
    controls.className = "dde-controls";
    controls.append(this.#renderModeToggle(), this.#renderSearch());

    // Hiding defaults only means anything against stored data; derived values have no schema default.
    if (this.#mode === MODE.SOURCE) {
      const defaults = iconButton("fa-solid fa-filter", "toggleDefaults", t("DDE.Action.HideDefaults"));
      defaults.classList.toggle("active", this.#hideDefaults);
      controls.append(defaults);
    }

    for (const [action, icon, key] of [
      ["expandAll", "fa-solid fa-angles-down", "DDE.Action.ExpandAll"],
      ["collapseAll", "fa-solid fa-angles-up", "DDE.Action.CollapseAll"],
      ["exportJson", "fa-solid fa-download", "DDE.Action.ExportJson"]
    ]) controls.append(iconButton(icon, action, t(key)));

    toolbar.append(identity, controls);
    return toolbar;
  }

  /**
   * Source / derived view switch.
   * @returns {HTMLElement}
   */
  #renderModeToggle() {
    const group = document.createElement("div");
    group.className = "dde-mode";
    for (const [mode, key, hint] of [
      [MODE.SOURCE, "DDE.Mode.Source", "DDE.Mode.SourceHint"],
      [MODE.DERIVED, "DDE.Mode.Derived", "DDE.Mode.DerivedHint"]
    ]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "dde-btn dde-mode-btn";
      button.dataset.action = "setMode";
      button.dataset.mode = mode;
      button.title = t(hint);
      button.textContent = t(key);
      if (this.#mode === mode) button.classList.add("active");
      group.append(button);
    }
    return group;
  }

  /**
   * @returns {HTMLElement}
   */
  #renderSearch() {
    const search = document.createElement("input");
    search.type = "search";
    search.className = "dde-search";
    search.placeholder = t("DDE.Action.Filter");
    search.value = this.#filter;
    return search;
  }

  /* -------------------------------------------- */

  /**
   * The scrolling tree area.
   * @returns {HTMLElement}
   */
  #renderScroller() {
    const scroller = document.createElement("div");
    scroller.className = "dde-scroller";

    const root = createRootNode(this.#document, this.#mode, this.#working);
    this.#nodes.set("", root);

    const query = this.#filter.trim().toLowerCase();
    let matches = null;
    let visible = null;
    if (query) {
      matches = findMatchingPaths(root, query);
      visible = new Set();
      for (const path of matches) for (const ancestor of ancestorPaths(path)) visible.add(ancestor);
      for (const path of visible) if (!matches.has(path)) this.#expanded.add(path);
    }

    const tree = document.createElement("ul");
    tree.className = "dde-tree";
    const children = childrenOf(root);

    for (const child of children) {
      const li = this.#renderNode(child, { matches, visible, unfiltered: !query });
      if (li) tree.append(li);
    }

    if (!tree.childElementCount) {
      const empty = document.createElement("p");
      empty.className = "dde-empty";
      empty.textContent = query ? t("DDE.NoMatch") : t("DDE.Empty");
      scroller.append(empty);
      return scroller;
    }

    scroller.append(tree);
    return scroller;
  }

  /**
   * Render one node and, when it is expanded, its children.
   * @param {object} node
   * @param {object} filterState
   * @returns {HTMLElement|null}  Null when the node is filtered out.
   */
  #renderNode(node, filterState) {
    const { matches, visible, unfiltered } = filterState;
    if (!unfiltered && !visible.has(node.path)) return null;

    const expandable = isExpandable(node.value);
    const dirty = this.#isDirty(node);
    const atDefault = !expandable && (this.#mode === MODE.SOURCE) && isAtDefault(node.field, node.value);
    if (atDefault && this.#hideDefaults && !dirty) return null;

    this.#nodes.set(node.path, node);

    const li = document.createElement("li");
    li.className = "dde-node";
    li.dataset.path = node.path;
    if (expandable) li.classList.add("dde-branch");
    if (dirty) li.classList.add("dde-dirty");
    if (atDefault) li.classList.add("dde-default");
    if (matches?.has(node.path)) li.classList.add("dde-match");

    li.append(this.#renderRow(node, expandable));

    if (expandable) {
      const list = document.createElement("ul");
      list.className = "dde-children";
      li.append(list);

      const childState = { matches, visible, unfiltered: unfiltered || !!matches?.has(node.path) };
      if (this.#expanded.has(node.path)) this.#fillChildren(node, li, childState);
      else list.hidden = true;
    }

    return li;
  }

  /**
   * Populate a branch's children, once.
   * @param {object} node
   * @param {HTMLElement} li
   * @param {object} filterState
   */
  #fillChildren(node, li, filterState) {
    const list = li.querySelector(":scope > .dde-children");
    if (!list) return;
    if (!list.dataset.loaded) {
      for (const child of childrenOf(node)) {
        const childLi = this.#renderNode(child, filterState);
        if (childLi) list.append(childLi);
      }
      list.dataset.loaded = "1";
    }
    list.hidden = false;
    li.classList.add("dde-open");
    this.#expanded.add(node.path);
  }

  /* -------------------------------------------- */

  /**
   * One row: toggle, key, type chip, value and per-row actions.
   * @param {object} node
   * @param {boolean} expandable
   * @returns {HTMLElement}
   */
  #renderRow(node, expandable) {
    const row = document.createElement("div");
    row.className = "dde-row";

    if (expandable) {
      const toggle = iconButton("fa-solid fa-caret-right", "toggleNode", t("DDE.Action.Toggle"), "dde-toggle");
      row.append(toggle);
    } else {
      const spacer = document.createElement("span");
      spacer.className = "dde-spacer";
      row.append(spacer);
    }

    const key = document.createElement("span");
    key.className = "dde-key";
    key.textContent = node.key;
    row.append(key);

    const description = describeField(node.field, node.value);
    const chip = document.createElement("span");
    chip.className = `dde-type${description.schemaed ? "" : " dde-free"}`;
    chip.textContent = description.type;
    chip.title = description.tooltip;
    row.append(chip);

    row.append(this.#renderValue(node, expandable));
    row.append(this.#renderRowActions(node, expandable));
    return row;
  }

  /**
   * The value cell: an editing widget for editable leaves, a preview otherwise.
   * @param {object} node
   * @param {boolean} expandable
   * @returns {HTMLElement}
   */
  #renderValue(node, expandable) {
    const cell = document.createElement("div");
    cell.className = "dde-value";

    // Empty objects and arrays are not expandable but are still containers: they get a preview and
    // the JSON / add-key actions rather than a value widget.
    if (expandable || ((node.value !== null) && (typeof node.value === "object"))) {
      const preview = document.createElement("span");
      preview.className = "dde-preview";
      preview.textContent = previewOf(node.value);
      cell.append(preview);
      return cell;
    }

    const editable = this.isEditable && (this.#mode === MODE.SOURCE) && !node.readonly;
    if (editable) {
      cell.append(buildInput({ field: node.field, value: node.value, name: node.path, disabled: false }));
    } else {
      const code = document.createElement("code");
      code.className = "dde-static";
      code.textContent = previewOf(node.value);
      cell.append(code);
    }

    const derived = this.#derivedValue(node);
    if (derived !== undefined) {
      const ghost = document.createElement("span");
      ghost.className = "dde-derived";
      ghost.textContent = `→ ${previewOf(derived)}`;
      ghost.title = t("DDE.DerivedHint");
      cell.append(ghost);
    }

    const reference = this.#renderReference(node);
    if (reference) cell.append(reference);

    return cell;
  }

  /**
   * The value data preparation ends up with at this path, when it differs from what is stored.
   * This is where a system's clamping and derivation becomes visible without leaving the source view.
   * @param {object} node
   * @returns {*}  Undefined when there is nothing worth showing.
   */
  #derivedValue(node) {
    if (this.#mode !== MODE.SOURCE) return undefined;
    let derived;
    try {
      derived = foundry.utils.getProperty(this.#document, node.path);
    } catch {
      return undefined;
    }
    // Embedded collections are Maps on the live document, so their members never resolve by path.
    if ((derived === undefined) || (derived === null) || (typeof derived === "object")) return undefined;
    const stored = foundry.utils.getProperty(this.#original, node.path);
    return valuesEqual(derived, stored) ? undefined : derived;
  }

  /**
   * A badge for a value that points at another document: a link when it resolves, a warning when it
   * does not. Broken references are how a deleted compendium or module leaves rubble behind.
   * @param {object} node
   * @returns {HTMLElement|null}
   */
  #renderReference(node) {
    const uuid = referenceUuid(node.field, node.value);
    if (!uuid) return null;

    let target = null;
    try {
      target = fromUuidSync(uuid);
    } catch {
      target = null;
    }

    if (!target) {
      const broken = document.createElement("span");
      broken.className = "dde-ref dde-ref-broken";
      broken.title = t("DDE.Reference.Broken", { uuid });
      broken.innerHTML = `<i class="fa-solid fa-link-slash"></i>`;
      return broken;
    }

    const link = iconButton("fa-solid fa-arrow-up-right-from-square", "openReference",
      t("DDE.Reference.Open", { name: target.name ?? uuid }), "dde-ref");
    link.dataset.uuid = uuid;
    return link;
  }

  /**
   * @param {object} node
   * @param {boolean} expandable
   * @returns {HTMLElement}
   */
  #renderRowActions(node, expandable) {
    const actions = document.createElement("div");
    actions.className = "dde-actions";

    actions.append(iconButton("fa-solid fa-link", "copyPath", t("DDE.Action.CopyPath")));
    actions.append(iconButton("fa-regular fa-copy", "copyValue", t("DDE.Action.CopyValue")));

    if (embeddedDocumentOf(node)) {
      actions.append(iconButton("fa-solid fa-up-right-from-square", "openEmbedded", t("DDE.Action.OpenEmbedded")));
    }

    const editable = this.isEditable && (this.#mode === MODE.SOURCE) && !node.readonly;
    if (editable) {
      const isContainer = (node.value !== null) && (typeof node.value === "object");
      if (isContainer) {
        actions.append(iconButton("fa-solid fa-code", "editJson", t("DDE.Action.EditJson")));
        if (Array.isArray(node.value) || acceptsFreeKeys(node.container)) {
          actions.append(iconButton("fa-solid fa-plus", "addKey", t("DDE.Action.AddKey")));
        }
      }
      if (this.#canDelete(node)) {
        actions.append(iconButton("fa-solid fa-trash", "deleteKey", t("DDE.Action.DeleteKey"), "dde-danger"));
      }
      // Always built, revealed by CSS once the row is dirty: editing a value marks the row without
      // re-rendering it, so the affordance has to already be there.
      actions.append(iconButton("fa-solid fa-rotate-left", "revert", t("DDE.Action.Revert"), "dde-revert"));
    }

    return actions;
  }

  /* -------------------------------------------- */

  /**
   * The collapsible panel listing every staged change as stored → pending.
   * @returns {HTMLElement}
   */
  #renderReview() {
    const panel = document.createElement("div");
    panel.className = "dde-review";
    panel.hidden = !this.#reviewOpen;
    this.#fillReview(panel);
    return panel;
  }

  /**
   * Rebuild the review table. Called whenever a change is staged, since staging does not re-render.
   * @param {HTMLElement} [panel]
   */
  #fillReview(panel) {
    panel ??= this.element?.querySelector(".dde-review");
    if (!panel || panel.hidden) return;
    panel.replaceChildren();

    const table = document.createElement("table");
    table.className = "dde-review-table";

    for (const [path, value] of this.#changes) {
      table.append(reviewRow(path, foundry.utils.getProperty(this.#original, path), previewOf(value),
        this.#replacements.has(path) ? "dde-review-replace" : ""));
    }
    for (const path of this.#deletions) {
      table.append(reviewRow(path, foundry.utils.getProperty(this.#original, path),
        t("DDE.Review.Removed"), "dde-review-delete"));
    }

    if (!table.childElementCount) {
      const empty = document.createElement("p");
      empty.className = "dde-empty";
      empty.textContent = t("DDE.NoChanges");
      panel.append(empty);
      return;
    }
    panel.append(table);
  }

  /**
   * The exact payloads `apply` will send. Shared with the macro export so the two cannot drift.
   * @returns {{deletions: object, updates: object}}
   */
  #buildPayloads() {
    const deletions = {};
    for (const path of this.#deletions) deletions[deletionPath(path)] = null;
    for (const path of this.#replacements) if (this.#changes.has(path)) deletions[deletionPath(path)] = null;
    return { deletions, updates: Object.fromEntries(this.#changes) };
  }

  /**
   * The staged changes as a runnable script, so a one-off fix can become a reusable macro.
   * @returns {string}
   */
  #buildMacro() {
    const { deletions, updates } = this.#buildPayloads();
    const lines = [`const doc = await fromUuid(${JSON.stringify(this.#document.uuid)});`];
    // Deletions run first, exactly as `apply` orders them.
    if (Object.keys(deletions).length) lines.push(`await doc.update(${JSON.stringify(deletions, null, 2)});`);
    if (Object.keys(updates).length) lines.push(`await doc.update(${JSON.stringify(updates, null, 2)});`);
    return lines.join("\n");
  }

  /**
   * The footer: pending change count, discard and apply.
   * @returns {HTMLElement}
   */
  #renderFooter() {
    const footer = document.createElement("footer");
    footer.className = "dde-footer";

    const status = document.createElement("span");
    status.className = "dde-status";
    footer.append(status);

    if (this.isEditable) {
      const review = iconButton("fa-solid fa-list-check", "toggleReview", t("DDE.Action.Review"));
      review.classList.toggle("active", this.#reviewOpen);
      const macro = iconButton("fa-solid fa-scroll", "copyMacro", t("DDE.Action.CopyMacro"));

      const discard = document.createElement("button");
      discard.type = "button";
      discard.className = "dde-btn";
      discard.dataset.action = "discard";
      discard.innerHTML = `<i class="fa-solid fa-xmark"></i> ${t("DDE.Action.Discard")}`;

      footer.append(review, macro);

      const apply = document.createElement("button");
      apply.type = "submit";
      apply.className = "dde-btn dde-apply";
      apply.innerHTML = `<i class="fa-solid fa-floppy-disk"></i> ${t("DDE.Action.Apply")}`;

      footer.append(discard, apply);
    }

    this.#updateFooter(footer);
    return footer;
  }

  /**
   * Refresh the footer status text and button state.
   * @param {HTMLElement} [footer]
   */
  #updateFooter(footer) {
    footer ??= this.element?.querySelector(".dde-footer");
    if (!footer) return;
    const count = this.pendingCount;
    const status = footer.querySelector(".dde-status");
    if (status) {
      status.textContent = count ? t("DDE.PendingChanges", { count }) : t("DDE.NoChanges");
      status.classList.toggle("dde-has-changes", count > 0);
    }
    // The review toggle stays live so an open panel can always be closed again.
    for (const button of footer.querySelectorAll("button")) {
      if (button.dataset.action !== "toggleReview") button.disabled = !count;
    }
    this.#fillReview();
  }

  /* -------------------------------------------- */
  /*  Change staging                              */
  /* -------------------------------------------- */

  /** Rebuild the working copy from the document and drop every staged edit. */
  #reset() {
    this.#original = this.#document.toObject();
    this.#working = foundry.utils.deepClone(this.#original);
    this.#changes.clear();
    this.#deletions.clear();
    this.#replacements.clear();
  }

  /**
   * Whether a node's staged value differs from what is stored.
   * @param {object} node
   * @returns {boolean}
   */
  #isDirty(node) {
    if (!node.path || (this.#mode !== MODE.SOURCE)) return false;
    return !valuesEqual(node.value, foundry.utils.getProperty(this.#original, node.path));
  }

  /**
   * Whether a node's key may be removed. Only free-form object keys and array members can be:
   * removing a schemaed key would just be reinstated at its initial value on the next update.
   * @param {object} node
   * @returns {boolean}
   */
  #canDelete(node) {
    if (!node.path) return false;
    const parent = this.#nodes.get(parentPathOf(node.path));
    if (!parent) return false;
    if (Array.isArray(parent.value)) return true;
    return acceptsFreeKeys(parent.container);
  }

  /**
   * The shallowest array on the path to a node. Arrays cannot be updated through dotted paths, so
   * any edit inside one is staged as a whole-array replacement.
   * @param {string} path
   * @returns {string|null}
   */
  #enclosingArrayPath(path) {
    const parts = path.split(".");
    for (let i = 1; i < parts.length; i++) {
      const candidate = parts.slice(0, i).join(".");
      if (Array.isArray(foundry.utils.getProperty(this.#working, candidate))) return candidate;
    }
    return null;
  }

  /**
   * Drop staged changes nested under a path.
   * @param {string} path
   */
  #clearChangesUnder(path) {
    const prefix = `${path}.`;
    for (const key of [...this.#changes.keys()]) if (key.startsWith(prefix)) this.#changes.delete(key);
    for (const key of [...this.#deletions]) if (key.startsWith(prefix)) this.#deletions.delete(key);
    for (const key of [...this.#replacements]) if (key.startsWith(prefix)) this.#replacements.delete(key);
  }

  /**
   * Write a value into the working copy and record the update path it will be sent under.
   * @param {string} path
   * @param {*} value
   */
  #stage(path, value) {
    foundry.utils.setProperty(this.#working, path, value);
    const target = this.#enclosingArrayPath(path) ?? path;
    this.#clearChangesUnder(target);

    const staged = foundry.utils.deepClone(foundry.utils.getProperty(this.#working, target));
    const original = foundry.utils.getProperty(this.#original, target);
    if (valuesEqual(staged, original) && !this.#replacements.has(target)) this.#changes.delete(target);
    else this.#changes.set(target, staged);

    this.#updateFooter();
  }

  /**
   * Remove a key from the working copy and record the deletion.
   * @param {object} node
   */
  #stageDeletion(node) {
    const parentPath = parentPathOf(node.path);
    const parent = parentPath ? foundry.utils.getProperty(this.#working, parentPath) : this.#working;
    if (!parent) return;

    if (Array.isArray(parent)) {
      parent.splice(Number(node.key), 1);
      this.#stage(parentPath, parent);
      return;
    }

    delete parent[node.key];
    this.#clearChangesUnder(node.path);
    this.#changes.delete(node.path);
    // A key that never existed in the stored data only needs dropping from the working copy.
    if (foundry.utils.getProperty(this.#original, node.path) !== undefined) this.#deletions.add(node.path);
    this.#updateFooter();
  }

  /* -------------------------------------------- */
  /*  Applying                                    */
  /* -------------------------------------------- */

  /**
   * The first staged value its field refuses, if any.
   * @returns {{path: string, error: string}|null}
   */
  #firstInvalidChange() {
    for (const [path, value] of this.#changes) {
      const field = this.#nodes.get(path)?.field;
      if (!field) continue;
      const error = validateValue(field, value);
      if (error) return { path, error };
    }
    return null;
  }

  /**
   * Send the staged changes to the document.
   * @returns {Promise<void>}
   */
  async apply() {
    if (!this.pendingCount) {
      ui.notifications.info(t("DDE.Notify.NoChanges"));
      return;
    }

    // Core logs a validation failure and then discards the update rather than rejecting it, which
    // would leave this window reporting a success that never happened.
    const invalid = this.#firstInvalidChange();
    if (invalid) {
      ui.notifications.error(t("DDE.Notify.InvalidValue", invalid));
      return;
    }

    const { deletions, updates } = this.#buildPayloads();
    const count = this.pendingCount;

    this.#applying = true;
    try {
      // Deletions go first: clearing a key and re-setting it in one payload is order-dependent.
      if (Object.keys(deletions).length) await this.#document.update(deletions);
      if (Object.keys(updates).length) await this.#document.update(updates);
      ui.notifications.info(t("DDE.Notify.Applied", { count, name: this.#document.name ?? this.#document.id }));
      this.#reset();
    } catch (err) {
      console.error(`${MODULE_ID} |`, err);
      ui.notifications.error(t("DDE.Notify.ApplyFailed", { error: err.message }));
    } finally {
      this.#applying = false;
    }

    await this.render();
  }

  /**
   * React to the document being changed by anything other than this window.
   * @param {foundry.abstract.Document} doc
   */
  #onDocumentChanged(doc) {
    if (doc.uuid !== this.#document.uuid) return;
    if (this.#applying) return; // Our own apply re-renders when it settles.
    if (this.pendingCount) ui.notifications.warn(t("DDE.Notify.ExternalUpdate"));
    this.#reset();
    this.render();
  }

  /* -------------------------------------------- */
  /*  Listeners                                   */
  /* -------------------------------------------- */

  /**
   * Stage an edit whenever one of the value widgets changes.
   * @param {Event} event
   */
  #onValueChange(event) {
    const holder = event.target.closest?.(".dde-input");
    if (!holder) return;
    // A field that built several elements is wrapped; read the element that actually changed.
    const input = holder.classList.contains("dde-input-group") ? event.target : holder;
    const li = input.closest(".dde-node");
    const node = this.#nodes.get(li?.dataset.path);
    if (!node) return;

    const value = coerceValue(node.field, readInput(input), node.value);
    node.value = value;
    this.#stage(node.path, value);
    // `DataField#clean` normalizes: it clamps to a field's range, drops unparseable numbers to
    // null, trims strings. The widget must show what will actually be sent, not what was typed.
    syncInput(input, value);

    li.classList.toggle("dde-dirty", this.#isDirty(node));
    const error = validateValue(node.field, value);
    this.#showRowError(li, error);
  }

  /**
   * Show or clear the validation message under a row.
   * @param {HTMLElement} li
   * @param {string|null} error
   */
  #showRowError(li, error) {
    li.querySelector(":scope > .dde-error")?.remove();
    li.classList.toggle("dde-invalid", !!error);
    if (!error) return;
    const message = document.createElement("p");
    message.className = "dde-error";
    message.textContent = error;
    li.querySelector(":scope > .dde-row").after(message);
  }

  /**
   * Debounced filtering.
   * @param {Event} event
   */
  #onFilterInput(event) {
    if (!event.target.classList?.contains("dde-search")) return;
    this.#filter = event.target.value;
    this.#debouncedFilter();
  }

  /** @type {Function} */
  #debouncedFilter = foundry.utils.debounce(() => this.render(), 300);

  /* -------------------------------------------- */
  /*  Actions                                     */
  /* -------------------------------------------- */

  /**
   * @this {DocumentDataExplorer}
   * @param {SubmitEvent} event
   */
  static async #onSubmitForm(event) {
    event.preventDefault();
    await this.apply();
  }

  /**
   * @this {DocumentDataExplorer}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static #onToggleNode(event, target) {
    const li = target.closest(".dde-node");
    const node = this.#nodes.get(li.dataset.path);
    if (!node) return;

    if (li.classList.contains("dde-open")) {
      li.classList.remove("dde-open");
      li.querySelector(":scope > .dde-children").hidden = true;
      this.#expanded.delete(node.path);
      return;
    }
    this.#fillChildren(node, li, { matches: null, visible: null, unfiltered: true });
  }

  /**
   * @this {DocumentDataExplorer}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static #onSetMode(event, target) {
    if (this.#mode === target.dataset.mode) return;
    this.#mode = target.dataset.mode;
    this.render();
  }

  /**
   * @this {DocumentDataExplorer}
   */
  static #onExpandAll() {
    const root = createRootNode(this.#document, this.#mode, this.#working);
    const queue = [root];
    let budget = EXPAND_ALL_LIMIT;

    while (queue.length && (budget > 0)) {
      const node = queue.shift();
      for (const child of childrenOf(node)) {
        if (!isExpandable(child.value)) continue;
        this.#expanded.add(child.path);
        queue.push(child);
        budget--;
      }
    }
    if (budget <= 0) ui.notifications.warn(t("DDE.Notify.ExpandTruncated", { limit: EXPAND_ALL_LIMIT }));
    this.render();
  }

  /**
   * @this {DocumentDataExplorer}
   */
  static #onCollapseAll() {
    this.#expanded.clear();
    this.render();
  }

  /**
   * @this {DocumentDataExplorer}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static #onCopyPath(event, target) {
    copyText(target.closest(".dde-node").dataset.path);
  }

  /**
   * @this {DocumentDataExplorer}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static #onCopyValue(event, target) {
    const node = this.#nodes.get(target.closest(".dde-node").dataset.path);
    if (!node) return;
    copyText(stringify(node.value));
  }

  /**
   * @this {DocumentDataExplorer}
   */
  static #onCopyUuid() {
    copyText(this.#document.uuid);
  }

  /**
   * @this {DocumentDataExplorer}
   */
  static #onExportJson() {
    const doc = this.#document;
    const name = String(doc.name ?? doc.id).replace(/[^\w.-]+/g, "_");
    downloadJson(`${doc.documentName}-${name}.json`, doc.toObject());
  }

  /**
   * @this {DocumentDataExplorer}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static async #onOpenEmbedded(event, target) {
    const node = this.#nodes.get(target.closest(".dde-node").dataset.path);
    const embedded = node && embeddedDocumentOf(node);
    if (!embedded) return ui.notifications.warn(t("DDE.Notify.EmbeddedMissing"));
    await DocumentDataExplorer.open(embedded);
  }

  /**
   * @this {DocumentDataExplorer}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static #onRevert(event, target) {
    const node = this.#nodes.get(target.closest(".dde-node").dataset.path);
    if (!node) return;

    this.#clearChangesUnder(node.path);
    this.#changes.delete(node.path);
    this.#replacements.delete(node.path);
    this.#deletions.delete(node.path);

    const original = foundry.utils.getProperty(this.#original, node.path);
    // A key that was staged for creation is reverted by removing it again.
    if (original === undefined) this.#stageDeletion(node);
    else this.#stage(node.path, foundry.utils.deepClone(original));
    this.render();
  }

  /**
   * @this {DocumentDataExplorer}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static #onToggleReview(event, target) {
    this.#reviewOpen = !this.#reviewOpen;
    target.classList.toggle("active", this.#reviewOpen);
    const panel = this.element.querySelector(".dde-review");
    panel.hidden = !this.#reviewOpen;
    this.#fillReview(panel);
  }

  /**
   * @this {DocumentDataExplorer}
   */
  static #onCopyMacro() {
    if (!this.pendingCount) return ui.notifications.info(t("DDE.Notify.NoChanges"));
    copyText(this.#buildMacro());
  }

  /**
   * @this {DocumentDataExplorer}
   */
  static #onToggleDefaults() {
    this.#hideDefaults = !this.#hideDefaults;
    this.render();
  }

  /**
   * @this {DocumentDataExplorer}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static async #onOpenReference(event, target) {
    const referenced = await fromUuid(target.dataset.uuid);
    if (!(referenced instanceof foundry.abstract.Document)) {
      return ui.notifications.warn(t("DDE.Reference.Broken", { uuid: target.dataset.uuid }));
    }
    await DocumentDataExplorer.open(referenced);
  }

  /**
   * @this {DocumentDataExplorer}
   */
  static #onDiscard() {
    this.#reset();
    this.render();
  }

  /**
   * @this {DocumentDataExplorer}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static async #onDeleteKey(event, target) {
    const node = this.#nodes.get(target.closest(".dde-node").dataset.path);
    if (!node) return;

    const confirmed = await DialogV2.confirm({
      window: { title: t("DDE.Dialog.Delete.Title") },
      content: `<p>${t("DDE.Dialog.Delete.Content", { path: node.path })}</p>`,
      rejectClose: false,
      modal: true
    });
    if (!confirmed) return;

    this.#stageDeletion(node);
    this.render();
  }

  /**
   * @this {DocumentDataExplorer}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static async #onAddKey(event, target) {
    const node = this.#nodes.get(target.closest(".dde-node").dataset.path);
    if (!node) return;

    const isArray = Array.isArray(node.value);
    const result = await promptNewEntry(node.path, isArray);
    if (!result) return;

    const key = isArray ? String(node.value.length) : result.key;
    if (!key) return ui.notifications.warn(t("DDE.Notify.KeyRequired"));
    if (!isArray && (key in node.value)) return ui.notifications.warn(t("DDE.Notify.KeyExists", { key }));

    this.#stage(node.path ? `${node.path}.${key}` : key, result.value);
    this.#expanded.add(node.path);
    this.render();
  }

  /**
   * @this {DocumentDataExplorer}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static async #onEditJson(event, target) {
    const node = this.#nodes.get(target.closest(".dde-node").dataset.path);
    if (!node) return;

    const result = await promptJson(node.path, node.value);
    if (!result) return;

    this.#clearChangesUnder(node.path);
    // Replacement only means anything for an object updated in place. Anything inside an array is
    // already sent as a whole-array replacement, and an array itself always replaces.
    const replaceable = !Array.isArray(result.value) && !this.#enclosingArrayPath(node.path);
    if (result.replace && replaceable) this.#replacements.add(node.path);
    else this.#replacements.delete(node.path);
    this.#stage(node.path, result.value);
    this.render();
  }
}

/* -------------------------------------------- */
/*  Helpers                                     */
/* -------------------------------------------- */

/**
 * Build a small icon-only button.
 * @param {string} icon
 * @param {string} action
 * @param {string} label
 * @param {string} [extraClass]
 * @returns {HTMLButtonElement}
 */
function iconButton(icon, action, label, extraClass = "") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `dde-btn dde-icon ${extraClass}`.trim();
  button.dataset.action = action;
  button.title = label;
  button.setAttribute("aria-label", label);
  const glyph = document.createElement("i");
  glyph.className = icon;
  button.append(glyph);
  return button;
}

/**
 * Write a coerced value back into the widget it came from, so the row shows what will be sent.
 * @param {HTMLElement} element
 * @param {*} value
 */
function syncInput(element, value) {
  if ((element instanceof HTMLInputElement) && (element.type === "checkbox")) {
    element.checked = !!value;
    return;
  }
  // Multi-valued widgets manage their own display; only scalars are written back.
  if ((value !== null) && (typeof value === "object")) return;
  const display = (value === null) || (value === undefined) ? "" : String(value);
  if (("value" in element) && (element.value !== display)) element.value = display;
}

/**
 * One row of the review table: the path, what is stored, and what will replace it.
 * @param {string} path
 * @param {*} before
 * @param {string} after   Already rendered for display.
 * @param {string} [extraClass]
 * @returns {HTMLTableRowElement}
 */
function reviewRow(path, before, after, extraClass = "") {
  const row = document.createElement("tr");
  if (extraClass) row.className = extraClass;
  for (const [cls, text] of [
    ["dde-review-path", path],
    ["dde-review-before", previewOf(before)],
    ["dde-review-arrow", "→"],
    ["dde-review-after", after]
  ]) {
    const cell = document.createElement("td");
    cell.className = cls;
    cell.textContent = text;
    row.append(cell);
  }
  return row;
}

/**
 * The parent of a dot path; the empty string for a top-level key.
 * @param {string} path
 * @returns {string}
 */
function parentPathOf(path) {
  const index = path.lastIndexOf(".");
  return index === -1 ? "" : path.slice(0, index);
}

/**
 * Turn `a.b.c` into the `a.b.-=c` form that Foundry uses to delete a key.
 * @param {string} path
 * @returns {string}
 */
function deletionPath(path) {
  const parts = path.split(".");
  const key = parts.pop();
  return [...parts, `-=${key}`].join(".");
}

/**
 * @param {*} value
 * @returns {string}
 */
function stringify(value) {
  if ((value === null) || (typeof value !== "object")) return String(value);
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * Build a labelled form row for the dialogs.
 * @param {string} label
 * @param {HTMLElement} input
 * @returns {HTMLElement}
 */
function formGroup(label, input) {
  const group = document.createElement("div");
  group.className = "form-group";
  const caption = document.createElement("label");
  caption.textContent = label;
  const fields = document.createElement("div");
  fields.className = "form-fields";
  fields.append(input);
  group.append(caption, fields);
  return group;
}

/**
 * Ask for a new key (or array entry) and its initial value.
 * @param {string} path
 * @param {boolean} isArray
 * @returns {Promise<{key: string, value: *}|null>}
 */
async function promptNewEntry(path, isArray) {
  const content = document.createElement("div");
  const hint = document.createElement("p");
  hint.className = "notes";
  hint.textContent = t(isArray ? "DDE.Dialog.Add.HintArray" : "DDE.Dialog.Add.Hint", { path: path || "root" });
  content.append(hint);

  const keyInput = document.createElement("input");
  keyInput.type = "text";
  keyInput.name = "key";
  keyInput.autofocus = true;
  if (!isArray) content.append(formGroup(t("DDE.Dialog.Add.Key"), keyInput));

  const typeInput = document.createElement("select");
  typeInput.name = "type";
  for (const [value, label] of [
    ["string", "String"], ["number", "Number"], ["boolean", "Boolean"],
    ["object", "Object {}"], ["array", "Array []"], ["null", "null"]
  ]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    typeInput.append(option);
  }
  content.append(formGroup(t("DDE.Dialog.Add.Type"), typeInput));

  const valueInput = document.createElement("input");
  valueInput.type = "text";
  valueInput.name = "value";
  content.append(formGroup(t("DDE.Dialog.Add.Value"), valueInput));

  return DialogV2.wait({
    window: { title: t("DDE.Dialog.Add.Title") },
    content,
    modal: true,
    rejectClose: false,
    buttons: [
      {
        action: "ok",
        icon: "fa-solid fa-plus",
        label: t("DDE.Action.Add"),
        default: true,
        callback: (event, button) => {
          const form = button.form;
          return {
            key: form.elements.key?.value.trim() ?? "",
            value: castLiteral(form.elements.type.value, form.elements.value.value)
          };
        }
      },
      { action: "cancel", icon: "fa-solid fa-xmark", label: t("DDE.Action.Cancel") }
    ]
  }).then(result => (result && (result !== "cancel")) ? result : null);
}

/**
 * Convert the raw text of the "add entry" dialog into the chosen type.
 * @param {string} type
 * @param {string} raw
 * @returns {*}
 */
function castLiteral(type, raw) {
  switch (type) {
    case "number": {
      const number = Number(raw);
      return Number.isNaN(number) ? 0 : number;
    }
    case "boolean": return ["true", "1", "yes"].includes(raw.trim().toLowerCase());
    case "object": return {};
    case "array": return [];
    case "null": return null;
    default: return raw;
  }
}

/**
 * Edit an object or array as raw JSON.
 * @param {string} path
 * @param {*} value
 * @returns {Promise<{value: *, replace: boolean}|null>}
 */
async function promptJson(path, value) {
  // DialogV2 rejects a content element that carries any attribute of its own, so the styling hook
  // goes on an inner wrapper.
  const content = document.createElement("div");
  const body = document.createElement("div");
  body.className = "dde-json-dialog";
  content.append(body);

  const hint = document.createElement("p");
  hint.className = "notes";
  hint.textContent = t("DDE.Dialog.Json.Hint", { path: path || "root" });
  body.append(hint);

  const area = document.createElement("textarea");
  area.name = "json";
  area.rows = 18;
  // The dialog re-serializes its content to markup, where a textarea's `value` property is not
  // reflected, so the initial text has to be its child text node.
  area.textContent = stringify(value);
  body.append(area);

  const replaceLabel = document.createElement("label");
  replaceLabel.className = "checkbox dde-replace";
  const replaceInput = document.createElement("input");
  replaceInput.type = "checkbox";
  replaceInput.name = "replace";
  replaceLabel.append(replaceInput, document.createTextNode(` ${t("DDE.Dialog.Json.Replace")}`));
  if (!Array.isArray(value)) body.append(replaceLabel);

  return DialogV2.wait({
    window: { title: t("DDE.Dialog.Json.Title") },
    position: { width: 640 },
    content,
    modal: true,
    rejectClose: false,
    buttons: [
      {
        action: "ok",
        icon: "fa-solid fa-check",
        label: t("DDE.Action.Stage"),
        default: true,
        callback: (event, button) => {
          const form = button.form;
          try {
            return {
              value: JSON.parse(form.elements.json.value),
              replace: form.elements.replace?.checked ?? false
            };
          } catch (err) {
            ui.notifications.error(t("DDE.Notify.InvalidJson", { error: err.message }));
            return null;
          }
        }
      },
      { action: "cancel", icon: "fa-solid fa-xmark", label: t("DDE.Action.Cancel") }
    ]
  }).then(result => (result && (result !== "cancel")) ? result : null);
}
