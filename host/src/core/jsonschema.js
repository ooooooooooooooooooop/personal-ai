/**
 * Minimal JSON Schema validator (dedup-h #238 / --output-schema analogue).
 *
 * Deliberate honest subset — enough for output conformance contracts:
 *   type, required, properties (recursive), items, enum,
 *   additionalProperties:false, integer-as-number.
 * NOT supported (validateSchemaSpec refuses them loudly): $ref/$defs,
 * allOf/anyOf/oneOf/not, if/then/else, patternProperties, dependentSchemas.
 * A schema we cannot check must never pretend to pass.
 */

const typeOf = (v) => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v);

/**
 * @returns {string[]} error paths; empty array = conforms
 */
export function validateJsonSchema(schema, value, path = '$') {
  const errors = [];
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    errors.push(`${path}: invalid schema`);
    return errors;
  }
  if (schema.type != null) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const ok = types.some((t) =>
      typeOf(value) === t || (t === 'integer' && typeOf(value) === 'number' && Number.isInteger(value)));
    if (!ok) {
      errors.push(`${path}: expected ${types.join('|')}, got ${typeOf(value)}`);
      return errors; // deeper checks are meaningless on a type miss
    }
  }
  if (Array.isArray(schema.enum)
    && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
    errors.push(`${path}: value not in enum`);
  }
  if (typeOf(value) === 'object') {
    for (const k of schema.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(value, k)) {
        errors.push(`${path}.${k}: required property missing`);
      }
    }
    const props = schema.properties ?? {};
    for (const [k, sub] of Object.entries(props)) {
      if (Object.prototype.hasOwnProperty.call(value, k)) {
        errors.push(...validateJsonSchema(sub, value[k], `${path}.${k}`));
      }
    }
    if (schema.additionalProperties === false) {
      for (const k of Object.keys(value)) {
        if (!Object.prototype.hasOwnProperty.call(props, k)) {
          errors.push(`${path}.${k}: additional property not allowed`);
        }
      }
    }
  }
  if (typeOf(value) === 'array' && schema.items && typeof schema.items === 'object') {
    value.forEach((v, i) => {
      errors.push(...validateJsonSchema(schema.items, v, `${path}[${i}]`));
    });
  }
  return errors;
}

/** Admission check for an operator-supplied schema — the honest subset only. */
export function validateSchemaSpec(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return { ok: false, error: 'schema must be a JSON object' };
  }
  const s = JSON.stringify(schema);
  if (s.length > 8192) return { ok: false, error: 'schema exceeds 8KiB' };
  if (/"(?:\$ref|\$defs|\$id|allOf|anyOf|oneOf|not|if|then|else|patternProperties|dependentSchemas|contains|propertyNames)"\s*:/.test(s)) {
    return { ok: false, error: 'unsupported keyword — subset is type/properties/required/items/enum/additionalProperties' };
  }
  return { ok: true };
}

/**
 * Extract the JSON payload from an assistant reply: strips ```json fences,
 * tolerates a leading/trailing prose-free body, picks the outermost {...}
 * or [...] block. Returns { ok:true, value } or { ok:false }.
 */
export function parseJsonReply(text) {
  const s = String(text ?? '').trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();
  if (!s) return { ok: false };
  const start = s.search(/[[{]/);
  if (start < 0) return { ok: false };
  const open = s[start];
  const close = open === '{' ? '}' : ']';
  // find the matching closer from the end — outermost balanced block
  const end = s.lastIndexOf(close);
  if (end <= start) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(s.slice(start, end + 1)) };
  } catch { return { ok: false }; }
}
