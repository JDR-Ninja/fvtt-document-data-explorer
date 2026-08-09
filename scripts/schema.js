/**
 * Introspection helpers over Foundry's DataField schema layer.
 *
 * Everything here is defensive: systems and modules define their own DataModels, and a document's
 * `system` data is not always backed by a schema at all. Any lookup that cannot be resolved returns
 * `null`, which the tree renders as a free-form (unschemaed) value.
 *
 * @module document-data-explorer/schema
 */

import { t, valuesEqual } from "./util.js";

/** Shorthand for the field namespace. */
const F = () => foundry.data.fields;

/**
 * A string shaped like a document UUID. Foundry ids are exactly sixteen alphanumeric characters,
 * which is strict enough to keep ordinary free-form strings from being mistaken for references.
 * @type {RegExp}
 */
const UUID_PATTERN =
  /^(?:Compendium\.[\w.-]+\.[A-Za-z]+\.[A-Za-z0-9]{16}|[A-Za-z]+\.[A-Za-z0-9]{16})(?:\.[A-Za-z]+\.[A-Za-z0-9]{16})*$/;

/* -------------------------------------------- */
/*  Field resolution                            */
/* -------------------------------------------- */

/**
 * Resolve the field definition of a child key within a container field.
 * @param {DataField|null} container  The field that holds the children (a SchemaField, ArrayField, …).
 * @param {string} key                The child key or array index.
 * @returns {DataField|null}
 */
export function childFieldOf(container, key) {
  if (!container) return null;
  const fields = F();
  // SchemaField also covers EmbeddedDataField and EmbeddedDocumentField, which extend it.
  if (container instanceof fields.SchemaField) return container.fields?.[key] ?? null;
  // TypedObjectField extends ObjectField, so it must be tested first.
  if (fields.TypedObjectField && (container instanceof fields.TypedObjectField)) return elementFieldOf(container);
  // ArrayField also covers SetField and EmbeddedCollectionField.
  if (container instanceof fields.ArrayField) return elementFieldOf(container);
  return null;
}

/**
 * The field describing a collection's members. `EmbeddedCollectionField#element` is the embedded
 * Document class rather than a field, so its schema has to be unwrapped to keep the members typed
 * instead of degrading to free-form values.
 * @param {DataField} container
 * @returns {DataField|null}
 */
function elementFieldOf(container) {
  const element = container.element ?? null;
  if (!element) return null;
  if (element instanceof F().DataField) return element;
  return element.schema ?? null;
}

/**
 * Resolve the container to use when listing a node's children. Most fields are their own container,
 * but fields whose shape depends on runtime data (the `system` TypeDataField, TypedSchemaField)
 * need the concrete sub-schema for the document's current type.
 * @param {DataField|null} field       The declared field for this node.
 * @param {*} value                    The node's value.
 * @param {*} parentValue              The value of the node's parent, used to read a discriminator `type`.
 * @param {foundry.abstract.Document} doc  The explored document.
 * @param {string} path                The node's dot path.
 * @returns {DataField|null}
 */
export function containerFor(field, value, parentValue, doc, path) {
  const fields = F();
  // A live DataModel carries its own resolved schema, the most accurate source available.
  if (value instanceof foundry.abstract.DataModel) return value.schema ?? null;
  if (!field) return null;

  if (fields.TypeDataField && (field instanceof fields.TypeDataField)) {
    if ((path === "system") && (doc?.system instanceof foundry.abstract.DataModel)) return doc.system.schema;
    const type = parentValue?.type ?? doc?.type;
    const model = field.getModelForType?.(type);
    return model?.schema ?? null;
  }

  if (fields.TypedSchemaField && (field instanceof fields.TypedSchemaField)) {
    return field.types?.[value?.type] ?? null;
  }

  return field;
}

/**
 * Whether a field holds embedded documents, which must be edited through their own sheet rather
 * than through the parent's update payload.
 * @param {DataField|null} field
 * @returns {boolean}
 */
export function isEmbeddedField(field) {
  if (!field) return false;
  const fields = F();
  return !!((fields.EmbeddedCollectionField && (field instanceof fields.EmbeddedCollectionField))
    || (fields.EmbeddedCollectionDeltaField && (field instanceof fields.EmbeddedCollectionDeltaField)));
}

/**
 * Whether new keys may be created underneath this container. Only free-form object storage accepts
 * arbitrary keys; a SchemaField would silently discard them on update.
 * @param {DataField|null} container
 * @returns {boolean}
 */
export function acceptsFreeKeys(container) {
  if (!container) return true; // Unschemaed data (loose `system`, flags of an unknown module).
  const fields = F();
  if (container instanceof fields.SchemaField) return false;
  if (fields.TypedObjectField && (container instanceof fields.TypedObjectField)) return true;
  if (container instanceof fields.ArrayField) return false;
  return container instanceof fields.ObjectField;
}

/* -------------------------------------------- */
/*  Field description                           */
/* -------------------------------------------- */

/**
 * Read a field property, which core sets either directly on the instance or inside `options`.
 * @param {DataField} field
 * @param {string} key
 * @returns {*}
 */
function fieldProp(field, key) {
  return field?.[key] ?? field?.options?.[key];
}

/**
 * Whether the field forbids editing (for example `_id`).
 * @param {DataField|null} field
 * @returns {boolean}
 */
export function isReadonlyField(field) {
  return !!fieldProp(field, "readonly");
}

/**
 * Build the display label and tooltip describing a field.
 * @param {DataField|null} field
 * @param {*} value
 * @returns {{type: string, tooltip: string, schemaed: boolean}}
 */
export function describeField(field, value) {
  if (!field) {
    return {
      type: foundry.utils.getType(value),
      tooltip: t("DDE.Field.FreeForm"),
      schemaed: false
    };
  }

  const type = field.constructor?.name ?? "DataField";
  const lines = [type];
  const label = fieldProp(field, "label");
  const hint = fieldProp(field, "hint");
  if (label) lines.push(game.i18n.localize(label));
  if (hint) lines.push(game.i18n.localize(hint));

  const flags = [];
  if (fieldProp(field, "required")) flags.push(t("DDE.Field.Required"));
  if (fieldProp(field, "nullable")) flags.push(t("DDE.Field.Nullable"));
  if (fieldProp(field, "readonly")) flags.push(t("DDE.Field.Readonly"));
  if (fieldProp(field, "integer")) flags.push(t("DDE.Field.Integer"));
  if (fieldProp(field, "positive")) flags.push(t("DDE.Field.Positive"));
  if (flags.length) lines.push(flags.join(", "));

  const min = fieldProp(field, "min");
  const max = fieldProp(field, "max");
  if ((min !== undefined) || (max !== undefined)) {
    lines.push(t("DDE.Field.Range", { min: min ?? "−∞", max: max ?? "∞" }));
  }

  const initial = fieldProp(field, "initial");
  if ((initial !== undefined) && (typeof initial !== "function")) {
    lines.push(t("DDE.Field.Initial", { value: JSON.stringify(initial) }));
  }

  return { type, tooltip: lines.join("\n"), schemaed: true };
}

/**
 * Resolve a field's initial (default) value.
 * @param {DataField|null} field
 * @returns {*}
 */
export function initialValueOf(field) {
  const initial = fieldProp(field, "initial");
  if (typeof initial === "function") {
    try {
      return initial();
    } catch {
      return undefined;
    }
  }
  return initial;
}

/* -------------------------------------------- */
/*  References                                  */
/* -------------------------------------------- */

/**
 * The document UUID a value points at, if it points at one. Covers the two declared reference field
 * types and, for unschemaed data, strings shaped like a UUID, which module flags store constantly.
 * @param {DataField|null} field
 * @param {*} value
 * @returns {string|null}
 */
export function referenceUuid(field, value) {
  if ((typeof value !== "string") || !value) return null;
  const fields = F();

  if (fields.DocumentUUIDField && (field instanceof fields.DocumentUUIDField)) return value;

  if (fields.ForeignDocumentField && (field instanceof fields.ForeignDocumentField)) {
    // These store a bare id; the field's model says which collection it belongs to.
    const documentName = field.model?.documentName;
    return documentName ? `${documentName}.${value}` : null;
  }

  if (!field && UUID_PATTERN.test(value)) return value;
  return null;
}

/* -------------------------------------------- */
/*  Defaults                                    */
/* -------------------------------------------- */

/**
 * Whether a value is exactly what the schema would have put there on its own. Every declared field
 * is present in stored data, so this is what separates data somebody set from data Foundry filled in.
 * @param {DataField|null} field
 * @param {*} value
 * @returns {boolean}
 */
export function isAtDefault(field, value) {
  if (!field) return false;
  let initial;
  try {
    initial = (typeof field.getInitialValue === "function") ? field.getInitialValue({}) : initialValueOf(field);
  } catch {
    return false;
  }
  if (initial === undefined) return false;
  return valuesEqual(initial, value) || (initial === value);
}

/* -------------------------------------------- */
/*  Input construction                          */
/* -------------------------------------------- */

/**
 * Fields whose native widget is too heavy for a dense tree; a plain textarea is used instead.
 * @param {DataField} field
 * @returns {boolean}
 */
function prefersTextarea(field) {
  const fields = F();
  if (fields.HTMLField && (field instanceof fields.HTMLField)) return true;
  if (fields.JavaScriptField && (field instanceof fields.JavaScriptField)) return true;
  return false;
}

/**
 * Build the editing widget for a leaf value. Schemaed fields build their own input through
 * `DataField#toInput`, which yields typed widgets (selects for choices, file pickers, colour
 * pickers…). Anything unschemaed or failing falls back to a type-inferred plain input.
 * @param {object} options
 * @param {DataField|null} options.field
 * @param {*} options.value
 * @param {string} options.name       The dot path, used as the input name.
 * @param {boolean} options.disabled
 * @returns {HTMLElement}
 */
export function buildInput({ field, value, name, disabled }) {
  let element = null;

  if (field && !prefersTextarea(field) && (typeof field.toInput === "function")) {
    try {
      const built = field.toInput({ name, value });
      element = normalizeInput(built);
    } catch (err) {
      console.debug("document-data-explorer | toInput failed, falling back", name, err);
      element = null;
    }
  }

  if (!element) element = fallbackInput({ field, value, name });

  element.classList.add("dde-input");
  if (disabled) {
    element.setAttribute("disabled", "disabled");
    element.classList.add("dde-disabled");
  }
  return element;
}

/**
 * `DataField#toInput` may return a single element, a list, or an HTMLCollection. Reduce it to one
 * node so the row layout stays predictable.
 * @param {HTMLElement|HTMLElement[]|HTMLCollection} built
 * @returns {HTMLElement|null}
 */
function normalizeInput(built) {
  if (!built) return null;
  if (built instanceof HTMLElement) return built;
  const list = Array.from(built);
  if (!list.length) return null;
  if (list.length === 1) return list[0];
  const wrapper = document.createElement("div");
  wrapper.className = "dde-input-group";
  wrapper.append(...list);
  return wrapper;
}

/**
 * A plain input inferred from the current value's runtime type.
 * @param {object} options
 * @param {DataField|null} options.field
 * @param {*} options.value
 * @param {string} options.name
 * @returns {HTMLElement}
 */
function fallbackInput({ field, value, name }) {
  if (typeof value === "boolean") {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.name = name;
    input.checked = value;
    return input;
  }

  if (typeof value === "number") {
    const input = document.createElement("input");
    input.type = "number";
    input.name = name;
    input.value = String(value);
    if (field?.integer) input.step = "1";
    return input;
  }

  const text = (value === null) || (value === undefined) ? "" : String(value);
  if (text.includes("\n") || (text.length > 120) || (field && prefersTextarea(field))) {
    const area = document.createElement("textarea");
    area.name = name;
    area.rows = 3;
    area.value = text;
    return area;
  }

  const input = document.createElement("input");
  input.type = "text";
  input.name = name;
  input.value = text;
  if (value === null) input.placeholder = "null";
  return input;
}

/* -------------------------------------------- */
/*  Value reading and coercion                  */
/* -------------------------------------------- */

/**
 * Read the raw value out of an input element, including Foundry's custom form elements which all
 * expose a `value` property.
 * @param {HTMLElement} element
 * @returns {*}
 */
export function readInput(element) {
  if (element instanceof HTMLInputElement) {
    if (element.type === "checkbox") return element.checked;
    if ((element.type === "number") || (element.type === "range")) {
      return element.value === "" ? null : Number(element.value);
    }
    return element.value;
  }
  if (element instanceof HTMLSelectElement) {
    if (element.multiple) return Array.from(element.selectedOptions).map(o => o.value);
    return element.value;
  }
  return element.value;
}

/**
 * Coerce a raw input value into the type the field expects, falling back to the runtime type of the
 * value currently stored.
 * @param {DataField|null} field
 * @param {*} raw
 * @param {*} current  The value currently held at this path.
 * @returns {*}
 */
export function coerceValue(field, raw, current) {
  if (field && (typeof field.clean === "function") && (raw !== undefined)) {
    try {
      const cleaned = field.clean(raw);
      // `clean` discards a value the field refuses to represent at all, such as an empty string on a
      // non-blank field, say. Keeping the raw input lets validation say what is actually wrong.
      if (cleaned !== undefined) return cleaned;
    } catch (err) {
      console.debug("document-data-explorer | clean failed, inferring instead", err);
    }
  }

  if (typeof current === "number") {
    if ((raw === "") || (raw === null)) return null;
    const number = Number(raw);
    return Number.isNaN(number) ? raw : number;
  }
  if (typeof current === "boolean") return (raw === true) || (raw === "true");
  if ((current === null) && (raw === "")) return null;
  return raw;
}

/**
 * Validate a value against its field.
 * @param {DataField|null} field
 * @param {*} value
 * @returns {string|null}  An error message, or null when valid.
 */
export function validateValue(field, value) {
  if (!field || (typeof field.validate !== "function")) return null;
  try {
    const failure = field.validate(value);
    if (!failure) return null;
    return failure.asError?.().message ?? failure.message ?? String(failure);
  } catch (err) {
    return err.message;
  }
}
