import { Ajv } from 'ajv';
import { Type } from 'typebox';
import type { EntryType, JsonValue, Question, Questions, SystemOneResult } from '@typesafe-ai/sdk';
import { DecideError } from './errors.js';

export type RequiredQuestion = Question & { instructions: EntryType };
export type DecideInput = { state: Exclude<EntryType, null>; questions: Record<string, RequiredQuestion>; model?: string };
export type DecideResult = SystemOneResult<Questions>;
export const DEFAULT_MODEL = 'jev-latest';
export const CONTEXT_LIMITS = 'Jev: 64k tokens for all state and questions; 32k for state plus the longest question. Token limits are enforced by TypeSafe, not estimated from characters.';
const ref = (name: string) => ({ $ref: `#/$defs/${name}` });
const closed = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const record = (value: unknown, extra = {}) => ({ type: 'object', additionalProperties: value, ...extra });
const probability = { type: 'number', minimum: 0, maximum: 1 };
const definitions = {
  json: { anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }, { type: 'null' }, { type: 'array', items: ref('json') }, record(ref('json'))] },
  entry: { anyOf: [{ type: 'string' }, { type: 'null' }, { type: 'array', items: ref('json') }, record(ref('json'))] },
};
const question = {
  oneOf: [
    closed({ type: { const: 'noul' }, instructions: ref('entry'), criteria: closed({ true: ref('entry'), false: ref('entry') }, []) }, ['type', 'instructions']),
    closed({ type: { const: 'choice' }, instructions: ref('entry'), criteria: record(ref('entry'), { minProperties: 1, maxProperties: 255, description: 'Map of 1–255 option names to text, JSON descriptions or null.' }) }),
    closed({ type: { const: 'score' }, instructions: ref('entry'), criteria: { type: 'array', items: ref('entry'), minItems: 2, maxItems: 10, description: 'Ordered descriptions for 2–10 levels, indexed from zero.' } }),
  ],
};
export const inputSchema = Type.Unsafe<DecideInput>({
  ...closed({
    state: { anyOf: [{ type: 'string' }, { type: 'array', items: ref('json') }, record(ref('json'))], description: 'Explicit text or JSON state only. No media decoding, conversation, memory or files are added. ' + CONTEXT_LIMITS },
    questions: record(question, { minProperties: 1 }),
    model: { type: 'string', minLength: 1, pattern: '\\S', description: 'Defaults to jev-latest. Aliases move; pin a version for repeatability.' },
  }, ['state', 'questions']),
  $defs: definitions,
});
export const outputSchema = Type.Unsafe<DecideResult>({
  ...closed({
    model: { type: 'string', minLength: 1, pattern: '\\S' },
    answers: record({ oneOf: [
      closed({ type: { const: 'noul' }, noul: probability }),
      closed({ type: { const: 'choice' }, choice: { type: 'string' }, confidence: probability, probabilities: record(probability, { minProperties: 1, maxProperties: 255 }) }),
      closed({ type: { const: 'score' }, score: { type: 'number', minimum: 0, maximum: 9 }, confidence: probability, probabilities: record(probability, { minProperties: 2, maxProperties: 10 }), legend: record(ref('entry'), { minProperties: 2, maxProperties: 10 }) }),
    ] }, { minProperties: 1 }),
    usage: closed({ input_tokens: { type: 'integer', minimum: 0 }, output_tokens: { type: 'integer', minimum: 0 } }),
  }),
  $defs: definitions,
});

const ajv = new Ajv({ strict: false, allErrors: false, ownProperties: true });
const checkInput = ajv.compile<DecideInput>(inputSchema);
const checkOutput = ajv.compile<DecideResult>(outputSchema);

// JSON-only values prevent implicit serialization through getters or toJSON.
function assertJson(value: unknown, ancestors = new Set<object>(), depth = 0): asserts value is JsonValue {
  if (depth > 128) throw new DecideError('TypeSafe input exceeds the local JSON nesting limit of 128.');
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return;
  if (typeof value !== 'object' || ancestors.has(value)) throw new DecideError('TypeSafe input must contain only finite JSON values without cycles.');
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new DecideError('TypeSafe input must contain plain JSON objects.');
  if (Array.isArray(value) && Object.getPrototypeOf(value) !== Array.prototype) throw new DecideError('TypeSafe input must contain plain JSON arrays.');
  ancestors.add(value);
  for (const key of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && key === 'length') continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (typeof key !== 'string' || !descriptor.enumerable || !('value' in descriptor)) throw new DecideError('TypeSafe input must contain plain JSON properties.');
    if (Array.isArray(value) && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) throw new DecideError('TypeSafe arrays must contain only indexed JSON values.');
    assertJson(descriptor.value, ancestors, depth + 1);
  }
  if (Array.isArray(value) && Object.keys(value).length !== value.length) throw new DecideError('TypeSafe input cannot contain sparse arrays.');
  ancestors.delete(value);
}

export function parseInput(value: unknown): DecideInput & { model: string } {
  assertJson(value);
  if (!checkInput(value)) throw new DecideError('Invalid TypeSafe input. Supply state and non-empty questions with required instructions; only noul, choice and score are accepted. Choice criteria must be a map of 1–255 options; Score criteria must be an array of 2–10 levels. Unknown fields are rejected. ' + CONTEXT_LIMITS);
  return { state: value.state, questions: value.questions, model: value.model ?? DEFAULT_MODEL };
}

function sameKeys(value: object, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

export function parseResult(value: unknown, input: DecideInput): DecideResult {
  const fail = () => { throw new DecideError('TypeSafe returned a malformed response. No result was accepted.'); };
  if (!checkOutput(value) || !sameKeys(value.answers, Object.keys(input.questions))) return fail();
  for (const [id, q] of Object.entries(input.questions)) {
    const answer = value.answers[id]!;
    if (q.type !== answer.type) return fail();
    if (answer.type === 'noul') continue;
    const keys = q.type === 'choice' ? Object.keys(q.criteria) : q.type === 'score' ? q.criteria.map((_, i) => String(i)) : [];
    if (!sameKeys(answer.probabilities, keys)) return fail();
    const sum = Object.values(answer.probabilities).reduce((a, b) => a + b, 0);
    // Floating point serialization can round a normalized distribution.
    if (Math.abs(sum - 1) > 0.0001) return fail();
    if (answer.type === 'choice' && !Object.hasOwn(answer.probabilities, answer.choice)) return fail();
    if (answer.type === 'score') {
      if (!sameKeys(answer.legend, keys) || answer.score > keys.length - 1) return fail();
    }
  }
  return value;
}
