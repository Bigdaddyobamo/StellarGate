// Small DOM helpers shared by the dashboard modules.
// Extracted from dashboard.js as part of #676.

/** Query a single element. */
export function $(selector, root = document) {
  return root.querySelector(selector);
}

/** Create an element with optional attributes and children. */
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === "class") {
      node.className = value;
    } else if (key === "text") {
      node.textContent = value;
    } else if (key === "html") {
      node.innerHTML = value;
    } else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) {
      node.setAttribute(key, "");
    } else {
      node.setAttribute(key, value);
    }
  }
  for (const child of [].concat(children)) {
    if (child == null) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** Toggle an element's visibility via the `hidden` attribute. */
export function show(node, visible = true) {
  if (!node) return;
  node.hidden = !visible;
}

/** Remove all children from an element. */
export function clear(node) {
  if (!node) return;
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** Show or clear an error message on an element. */
export function setError(node, message) {
  if (!node) return;
  if (message) {
    node.textContent = message;
    node.hidden = false;
  } else {
    node.textContent = "";
    node.hidden = true;
  }
}

/**
 * Report a sign-in failure accessibly: link the error to the input via
 * `aria-describedby`, mark the input `aria-invalid`, and return focus to it.
 * The error element gets a stable id so assistive tech can reference it.
 */
export function setFieldError(input, errorNode, message, id = "signin-error") {
  if (errorNode) {
    if (!errorNode.id) errorNode.id = id;
    setError(errorNode, message);
  }
  if (!input) return;
  if (message) {
    if (errorNode && errorNode.id) input.setAttribute("aria-describedby", errorNode.id);
    input.setAttribute("aria-invalid", "true");
    if (typeof input.focus === "function") input.focus();
  } else {
    input.removeAttribute("aria-describedby");
    input.removeAttribute("aria-invalid");
  }
}

/**
 * Build a table row (`<tr>`) from an array of cell values.
 *
 * Each value becomes a `<td>` whose content is set with `textContent` only —
 * never `innerHTML` — so untrusted values (merchant ids, key prefixes, …) can
 * never be interpreted as markup. A value may be a string, number, or a
 * pre-built `Node` (e.g. a button); `null`/`undefined` render as empty cells.
 * Nothing is logged.
 */
export function row(cells = []) {
  const tr = document.createElement("tr");
  for (const value of [].concat(cells)) {
    const td = document.createElement("td");
    if (value instanceof Node) {
      td.append(value);
    } else if (value != null) {
      td.textContent = String(value);
    }
    tr.append(td);
  }
  return tr;
}

/**
 * Wipe an element and detach it from the DOM.
 *
 * Used for the one-time API key reveal: clears the text content first so the
 * value is dropped from the rendered tree, then removes the node so no
 * reference lingers in the document. Safe to call with `null`.
 */
export function wipe(node) {
  if (!node) return;
  node.textContent = "";
  if (node.parentNode) node.parentNode.removeChild(node);
}

/**
 * Set `aria-sort` on a table header cell and reflect the state on its button.
 *
 * `direction` is one of `"ascending"`, `"descending"` or `"none"`. The header
 * gets the matching `aria-sort` value (removed when `"none"`), and the button
 * inside it is marked `aria-pressed` so assistive tech announces the toggle.
 */
export function setSort(header, direction = "none") {
  if (!header) return;
  const dir = direction === "ascending" || direction === "descending" ? direction : "none";
  if (dir === "none") {
    header.removeAttribute("aria-sort");
  } else {
    header.setAttribute("aria-sort", dir);
  }
  const button = header.querySelector("button");
  if (button) {
    button.setAttribute("aria-pressed", dir === "none" ? "false" : "true");
  }
}