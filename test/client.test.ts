import { afterEach, describe, expect, it, vi } from 'vitest';
import { ATTEMPT_TIMEOUT_MS, decide, ENDPOINT, MAX_BODY_BYTES, retryAfter } from '../src/client.js';
import { choiceInput, choiceResult, FAKE_KEY, jsonResponse, noulInput, noulResult, PRIVATE_STATE, scoreInput, scoreResult } from './fixtures.js';
afterEach(() => vi.useRealTimers());

describe('HTTP contract and privacy', () => {
  it.each([[noulInput, noulResult], [choiceInput, choiceResult], [scoreInput, scoreResult]] as const)('returns the complete typed response', async (input, result) => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse(result));
    expect(await decide(input, FAKE_KEY, undefined, fetch)).toEqual(result);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(ENDPOINT); expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ Authorization: `Bearer ${FAKE_KEY}`, 'Content-Type': 'application/json' });
    expect(init.redirect).toBe('error'); expect(init.credentials).toBe('omit');
    expect(JSON.parse(init.body)).toEqual({ ...input, model: 'jev-latest' });
  });
  it('mixes all question types and preserves explicit model selection', async () => {
    const input = { state: 'Only this explicit state', model: 'jev-1.13.0', questions: { ...noulInput.questions, ...choiceInput.questions, ...scoreInput.questions } };
    const output = { ...noulResult, answers: { ...noulResult.answers, ...choiceResult.answers, ...scoreResult.answers } };
    const fetch = vi.fn().mockResolvedValue(jsonResponse(output));
    expect(await decide(input, FAKE_KEY, undefined, fetch)).toEqual(output);
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual(input);
  });
  it('rejects invalid input without network access', async () => {
    const fetch = vi.fn();
    await expect(decide({ ...noulInput, questions: {} }, FAKE_KEY, undefined, fetch)).rejects.toThrow('Invalid');
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([401, 400, 403, 404, 408, 422, 500, 502, 503, 302])('does not retry HTTP %s or expose an upstream body', async status => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse({ error: `${FAKE_KEY} ${PRIVATE_STATE}` }, status));
    const error = await decide(noulInput, FAKE_KEY, undefined, fetch).catch(e => e);
    expect(error.status).toBe(status); expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(error)).not.toContain(FAKE_KEY); expect(JSON.stringify(error)).not.toContain(PRIVATE_STATE);
    expect(error).not.toHaveProperty('cause');
    if (status === 401) expect(error.message).toContain('SecretRef');
  });
  it('keeps useful 422 validation location and type without echoing input or dynamic IDs', async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse({ detail: [
      { loc: ['body', 'questions', PRIVATE_STATE, 'criteria'], type: 'too_short', msg: FAKE_KEY, input: PRIVATE_STATE },
      { loc: ['body', 'state'], type: FAKE_KEY, msg: PRIVATE_STATE },
    ] }, 422));
    const error = await decide(noulInput, FAKE_KEY, undefined, fetch).catch(e => e);
    expect(error.validation).toEqual(['body.questions.*.criteria: too_short', 'body.state: invalid_value']);
    expect(error.message).toContain('32k'); expect(error.message).not.toContain(PRIVATE_STATE); expect(error.message).not.toContain(FAKE_KEY);
  });
  it('sanitizes transport errors and response-schema errors', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error(`${FAKE_KEY} ${PRIVATE_STATE}`));
    await expect(decide(noulInput, FAKE_KEY, undefined, fetch)).rejects.toThrow('transport failed');
    fetch.mockResolvedValue(jsonResponse({ ...noulResult, secret: FAKE_KEY }));
    await expect(decide(noulInput, FAKE_KEY, undefined, fetch)).rejects.toThrow('malformed response');
  });
  it('rejects a credential echoed in an otherwise valid response', async () => {
    await expect(decide(noulInput, FAKE_KEY, undefined, vi.fn().mockResolvedValue(jsonResponse({ ...noulResult, model: FAKE_KEY })))).rejects.toThrow('unsafe response');
  });
  it('rejects an echoed key even when JSON serialization escapes its characters', async () => {
    const fakeEscapedKey = 'fake-key-with-"quote-and-\\slash';
    await expect(decide(noulInput, fakeEscapedKey, undefined, vi.fn().mockResolvedValue(jsonResponse({ ...noulResult, model: fakeEscapedKey })))).rejects.toThrow('unsafe response');
  });
  it('rejects malformed JSON', async () => {
    await expect(decide(noulInput, FAKE_KEY, undefined, vi.fn().mockResolvedValue(new Response(`not-json ${PRIVATE_STATE}`)))).rejects.toThrow('malformed JSON');
  });
  it('bounds request and response sizes', async () => {
    const fetch = vi.fn();
    await expect(decide({ ...noulInput, state: 'x'.repeat(MAX_BODY_BYTES) }, FAKE_KEY, undefined, fetch)).rejects.toThrow('4 MiB');
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockResolvedValue(new Response('x'.repeat(MAX_BODY_BYTES + 1)));
    await expect(decide(noulInput, FAKE_KEY, undefined, fetch)).rejects.toThrow('4 MiB');
  });
});

describe('bounded retries and cancellation', () => {
  it('honors Retry-After on 429', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockResolvedValueOnce(jsonResponse({}, 429, { 'Retry-After': '2' })).mockResolvedValueOnce(jsonResponse(noulResult));
    const pending = decide(noulInput, FAKE_KEY, undefined, fetch);
    await vi.advanceTimersByTimeAsync(1999); expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(await pending).toEqual(noulResult); expect(fetch).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each([429, 529])('bounds HTTP %s to three attempts with exponential backoff', async status => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({}, status)));
    const pending = decide(noulInput, FAKE_KEY, undefined, fetch).catch(e => e);
    await vi.advanceTimersByTimeAsync(499); expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(999); expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1); expect((await pending).status).toBe(status); expect(fetch).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('does not shorten a Retry-After that exceeds the total deadline', async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse({}, 429, { 'Retry-After': '120' }));
    await expect(decide(noulInput, FAKE_KEY, undefined, fetch)).rejects.toThrow('retry later'); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('parses HTTP-date, milliseconds, invalid and past Retry-After values', () => {
    const now = Date.parse('Fri, 18 Sep 2026 12:00:00 GMT');
    expect(retryAfter(new Headers({ 'Retry-After': 'Fri, 18 Sep 2026 12:00:02 GMT' }), now)).toBe(2000);
    expect(retryAfter(new Headers({ 'Retry-After': 'Fri, 18 Sep 2026 11:00:00 GMT' }), now)).toBe(0);
    expect(retryAfter(new Headers({ 'retry-after-ms': '1250', 'Retry-After': '5' }), now)).toBe(1250);
    for (const raw of ['invalid', '-1', '']) expect(retryAfter(new Headers({ 'Retry-After': raw }), now)).toBeUndefined();
  });
  it('propagates abort to fetch and hides arbitrary cancellation reasons', async () => {
    const controller = new AbortController();
    const fetch = vi.fn(() => new Promise<Response>(() => {}));
    const pending = decide(noulInput, FAKE_KEY, controller.signal, fetch).catch(e => e);
    controller.abort(`${FAKE_KEY} ${PRIVATE_STATE}`);
    expect((await pending).message).toBe('TypeSafe call was cancelled.');
    expect((fetch.mock.calls as unknown as [string, RequestInit][])[0]![1].signal?.aborted).toBe(true);
  });
  it('does not start a pre-aborted call', async () => {
    const fetch = vi.fn();
    await expect(decide(noulInput, FAKE_KEY, AbortSignal.abort(PRIVATE_STATE), fetch)).rejects.toThrow('cancelled'); expect(fetch).not.toHaveBeenCalled();
  });
  it('cancels a backoff wait', async () => {
    vi.useFakeTimers(); const controller = new AbortController();
    const fetch = vi.fn().mockResolvedValue(jsonResponse({}, 529));
    const pending = decide(noulInput, FAKE_KEY, controller.signal, fetch).catch(e => e);
    await vi.advanceTimersByTimeAsync(100); controller.abort();
    expect((await pending).message).toContain('cancelled'); expect(fetch).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });
  it('times out an uncooperative fetch without retrying', async () => {
    vi.useFakeTimers(); const fetch = vi.fn(() => new Promise<Response>(() => {}));
    const pending = decide(noulInput, FAKE_KEY, undefined, fetch).catch(e => e);
    await vi.advanceTimersByTimeAsync(ATTEMPT_TIMEOUT_MS);
    expect((await pending).message).toContain('timed out'); expect(fetch).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });
  it('applies timeout while receiving a response body', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockResolvedValue(new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{')); } })));
    const pending = decide(noulInput, FAKE_KEY, undefined, fetch).catch(e => e);
    await vi.advanceTimersByTimeAsync(ATTEMPT_TIMEOUT_MS);
    expect((await pending).message).toContain('timed out'); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('bounds the total deadline across retries and the final request', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockResolvedValueOnce(jsonResponse({}, 529, { 'Retry-After': '25' })).mockImplementation(() => new Promise<Response>(() => {}));
    const pending = decide(noulInput, FAKE_KEY, undefined, fetch).catch(e => e);
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await pending).message).toContain('30-second'); expect(fetch).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
  });
});
