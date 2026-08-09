/**
 * Entry point: registers the sheet header control that opens the explorer.
 * @module document-data-explorer/main
 */

import { DocumentDataExplorer } from "./explorer.js";
import { HEADER_ACTION, MODULE_ID, log, t } from "./util.js";

/**
 * The document an application is displaying, if any.
 * @param {ApplicationV2|Application} app
 * @returns {foundry.abstract.Document|null}
 */
function documentOf(app) {
  if (app instanceof DocumentDataExplorer) return null;
  const doc = app?.document ?? app?.object;
  return (doc instanceof foundry.abstract.Document) ? doc : null;
}

/* -------------------------------------------- */

Hooks.once("init", () => {
  const module = game.modules.get(MODULE_ID);
  if (module) {
    module.api = {
      /**
       * Open the explorer on a document.
       * @param {foundry.abstract.Document} doc
       * @returns {Promise<DocumentDataExplorer>}
       */
      open: doc => DocumentDataExplorer.open(doc),
      DocumentDataExplorer
    };
  }
  log("initialized");
});

/* -------------------------------------------- */

/**
 * Add the control to every ApplicationV2 that displays a document. The hook receives the live
 * controls array rather than a copy, so the same entry must not be pushed twice.
 *
 * `onClick` matters: core dispatches a control's `action` to the owning application's own handlers,
 * which know nothing about this module. Both `ApplicationV2#_headerControlContextEntries` and
 * `#_renderHeaderControl` call `onClick` in preference to that dispatch.
 */
Hooks.on("getHeaderControlsApplicationV2", (app, controls) => {
  if (!game.user?.isGM) return;
  const doc = documentOf(app);
  if (!doc) return;
  if (controls.some(control => control.action === HEADER_ACTION)) return;

  controls.push({
    action: HEADER_ACTION,
    icon: "fa-solid fa-code",
    label: t("DDE.HeaderButton"),
    onClick: () => DocumentDataExplorer.open(doc)
  });
});

/* -------------------------------------------- */

/**
 * Sheets still built on the V1 Application framework, which some systems and modules continue to
 * ship. V1 renders header buttons directly in the header rather than behind the controls menu, and
 * dispatches this hook across the whole inheritance chain, so one registration covers every sheet.
 *
 * V1 is deprecated since core v13 and slated for removal in v16, so this block can go once v16 is the
 * minimum supported version.
 */
Hooks.on("getApplicationHeaderButtons", (app, buttons) => {
  if (!game.user?.isGM) return;
  const doc = documentOf(app);
  if (!doc) return;
  if (buttons.some(button => button.class === MODULE_ID)) return;

  buttons.unshift({
    label: t("DDE.HeaderButton"),
    class: MODULE_ID,
    icon: "fa-solid fa-code",
    onclick: () => DocumentDataExplorer.open(doc)
  });
});
