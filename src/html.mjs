// A tiny HTML templating helper: `html` is a tagged template that escapes
// every interpolated value unless it is itself the result of `html`/`raw`.
// Arrays are joined, and null/undefined/false render as nothing.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escape(value) {
  return String(value).replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

export class Raw {
  constructor(text) {
    this.text = text;
  }
  toString() {
    return this.text;
  }
}

export function raw(text) {
  return new Raw(text);
}

function renderValue(value) {
  if (value === null || value === undefined || value === false) return '';
  if (value instanceof Raw) return value.text;
  if (Array.isArray(value)) return value.map(renderValue).join('');
  return escape(value);
}

export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) {
    out += renderValue(values[i]) + strings[i + 1];
  }
  return new Raw(out);
}
