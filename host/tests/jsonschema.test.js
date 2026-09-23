/** dedup-h #238 — minimal JSON Schema validator (--output-schema analogue). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateJsonSchema, validateSchemaSpec, parseJsonReply } from '../src/core/jsonschema.js';

test('validator: type/required/properties/items/enum/additionalProperties', () => {
  const schema = {
    type: 'object',
    required: ['name', 'count'],
    properties: {
      name: { type: 'string' },
      count: { type: 'integer' },
      tags: { type: 'array', items: { type: 'string', enum: ['a', 'b'] } },
      nested: { type: 'object', required: ['x'], properties: { x: { type: 'number' } } },
    },
    additionalProperties: false,
  };
  assert.deepEqual(validateJsonSchema(schema, { name: 'n', count: 2, tags: ['a'], nested: { x: 1 } }), []);
  assert.ok(validateJsonSchema(schema, { count: 2 }).some((e) => /name.*required/.test(e)));
  assert.ok(validateJsonSchema(schema, { name: 'n', count: 2.5 }).some((e) => /count.*integer/.test(e)));
  assert.ok(validateJsonSchema(schema, { name: 'n', count: 1, tags: ['z'] }).some((e) => /enum/.test(e)));
  assert.ok(validateJsonSchema(schema, { name: 'n', count: 1, extra: 1 }).some((e) => /additional/.test(e)));
  assert.ok(validateJsonSchema(schema, { name: 'n', count: 1, nested: {} }).some((e) => /nested\.x.*required/.test(e)));
  assert.ok(validateJsonSchema({ type: 'array', items: { type: 'number' } }, [1, 'x']).some((e) => /\[1\]/.test(e)));
});

test('schema spec admission: honest subset refuses fancy keywords', () => {
  assert.equal(validateSchemaSpec({ type: 'object' }).ok, true);
  assert.equal(validateSchemaSpec('x').ok, false);
  assert.equal(validateSchemaSpec({ $ref: '#/defs/x' }).ok, false);
  assert.equal(validateSchemaSpec({ allOf: [{ type: 'string' }] }).ok, false);
});

test('parseJsonReply: fences stripped, outermost block found, garbage refused', () => {
  assert.deepEqual(parseJsonReply('{"a":1}'), { ok: true, value: { a: 1 } });
  assert.deepEqual(parseJsonReply('```json\n{"a":1}\n```'), { ok: true, value: { a: 1 } });
  assert.deepEqual(parseJsonReply('[1,2]'), { ok: true, value: [1, 2] });
  assert.equal(parseJsonReply('no json here').ok, false);
});
