import { describe, expect, it } from 'vitest';
import { parseInput, parseResult, CONTEXT_LIMITS } from '../src/schema.js';
import { choiceInput, choiceResult, noulInput, noulResult, scoreInput, scoreResult } from './fixtures.js';

describe('closed TypeSafe contract', () => {
  it.each([noulInput, choiceInput, scoreInput])('accepts a typed question', input => expect(parseInput(input).questions).toEqual(input.questions));
  it('preserves JSON instructions and criteria from the advanced contract', () => {
    const input = { state: { count: 2, enabled: true, data: [null, 'text'] }, questions: {
      n: { type: 'noul', instructions: null, criteria: { true: { meaning: 'yes' }, false: ['no'] } },
      c: { type: 'choice', instructions: ['classify'], criteria: { a: { examples: ['a'] }, b: null } },
      s: { type: 'score', instructions: { question: 'Rate' }, criteria: [null, { level: 'high' }] },
    } };
    expect(parseInput(input)).toEqual({ ...input, model: 'jev-latest' });
  });
  it.each([
    { ...noulInput, questions: {} }, { ...noulInput, extra: true }, { ...noulInput, state: null },
    { ...noulInput, state: 2 }, { ...noulInput, state: false }, { ...noulInput, model: '' },
    { ...noulInput, model: ' ' }, { ...noulInput, model: null },
    ...[
      { type: 'text', instructions: 'Generate' }, { type: 'noul' },
      { type: 'noul', instructions: 'Yes?', criteria: { maybe: 'Sometimes' } },
      { type: 'noul', instructions: 'Yes?', criteria: null },
      { type: 'noul', instructions: 'Yes?', confidence: true },
      { type: 'choice', instructions: 'Pick', criteria: ['a', 'b'] },
      { type: 'choice', instructions: 'Pick', criteria: {} },
      { type: 'choice', instructions: 'Pick', criteria: { a: 4 } },
      { type: 'choice', instructions: 'Pick', criteria: Object.fromEntries(Array.from({ length: 256 }, (_, i) => [i, null])) },
      { type: 'score', instructions: 'Rate', criteria: { '0': 'low', '1': 'high' } },
      { type: 'score', instructions: 'Rate', criteria: ['one'] },
      { type: 'score', instructions: 'Rate', criteria: Array(11).fill(null) },
      { type: 'score', instructions: 'Rate', criteria: [1, 2] },
      { type: 'score', instructions: 'Rate', criteria: ['low', 'high'], choice: 'low' },
    ].map(q => ({ ...noulInput, questions: { q } })),
  ])('rejects malformed input %#', value => expect(() => parseInput(value)).toThrow('TypeSafe'));
  it('accepts exactly 255 Choice options and 10 Score levels', () => {
    expect(() => parseInput({ state: 'test', questions: {
      c: { type: 'choice', instructions: 'Pick', criteria: Object.fromEntries(Array.from({ length: 255 }, (_, i) => [i, null])) },
      s: { type: 'score', instructions: 'Rate', criteria: Array(10).fill(null) },
    } })).not.toThrow();
  });
  it.each([undefined, NaN, Infinity, new Date(), () => 'hidden', { toJSON() { return 'hidden'; } }, new Array(2)])('rejects non-JSON state %#', state => expect(() => parseInput({ ...noulInput, state })).toThrow());
  it('rejects cycles and accessors without invoking them', () => {
    const cyclic: unknown[] = []; cyclic.push(cyclic);
    expect(() => parseInput({ ...noulInput, state: cyclic })).toThrow();
    let read = false;
    expect(() => parseInput({ ...noulInput, state: { get hidden() { read = true; return 'secret'; } } })).toThrow();
    expect(read).toBe(false);
  });
  it('rejects inherited array serializers and named properties that could mask holes', () => {
    let serialized = false;
    class HiddenArray extends Array<string> { toJSON() { serialized = true; return 'implicit data'; } }
    expect(() => parseInput({ ...noulInput, state: new HiddenArray('explicit') })).toThrow('plain JSON arrays');
    expect(serialized).toBe(false);
    const sparse = Object.assign(new Array(1), { hidden: 'implicit' });
    expect(() => parseInput({ ...noulInput, state: sparse })).toThrow('indexed JSON');
  });
  it('states documented context limits without inventing a character-to-token conversion', () => {
    expect(CONTEXT_LIMITS).toContain('64k'); expect(CONTEXT_LIMITS).toContain('32k');
    expect(() => parseInput({ ...noulInput, state: 'a'.repeat(150_001) })).not.toThrow();
  });
  it.each([[noulInput, noulResult], [choiceInput, choiceResult], [scoreInput, scoreResult]] as const)('preserves a valid response', (input, output) => expect(parseResult(output, input)).toBe(output));
  it('preserves caller IDs even when they match object prototype names', () => {
    const input = JSON.parse('{"state":"text","questions":{"__proto__":{"type":"noul","instructions":"Yes?"},"constructor":{"type":"noul","instructions":"Yes?"}}}');
    const output = JSON.parse('{"model":"jev-1.13.0","answers":{"__proto__":{"type":"noul","noul":0.5},"constructor":{"type":"noul","noul":0.6}},"usage":{"input_tokens":1,"output_tokens":1}}');
    expect(Object.keys(parseResult(output, parseInput(input)).answers)).toEqual(['__proto__', 'constructor']);
  });
  it.each([
    {}, { ...noulResult, model: '' }, { ...noulResult, extra: 'secret' },
    { ...noulResult, answers: {} }, { ...noulResult, answers: { other: { type: 'noul', noul: 0.5 } } },
    { ...noulResult, answers: { urgent: { type: 'noul', noul: 1.01 } } },
    { ...noulResult, answers: { urgent: { type: 'noul', noul: 0.2, text: 'extra' } } },
    { ...noulResult, usage: { input_tokens: -1, output_tokens: 1 } },
    { ...noulResult, usage: { input_tokens: 1.5, output_tokens: 1 } },
  ])('fails closed on malformed response %#', output => expect(() => parseResult(output, noulInput)).toThrow('malformed'));
  it('rejects mismatched answer type, distribution keys, confidence and score bounds', () => {
    expect(() => parseResult({ ...noulResult, answers: { urgent: choiceResult.answers.team } }, noulInput)).toThrow();
    for (const change of [{ choice: 'unknown' }, { confidence: 2 }, { probabilities: { billing: 0.7, support: 0.5 } }, { probabilities: { billing: 1 } }]) {
      expect(() => parseResult({ ...choiceResult, answers: { team: { ...choiceResult.answers.team, ...change } } }, choiceInput)).toThrow();
    }
    for (const change of [{ score: 3 }, { legend: { '0': 'low', '5': 'high' } }, { probabilities: { '0': 0.5, '1': 0.5 } }]) {
      expect(() => parseResult({ ...scoreResult, answers: { severity: { ...scoreResult.answers.severity, ...change } } }, scoreInput)).toThrow();
    }
  });
});
