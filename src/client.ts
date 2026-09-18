import { DecideError, httpError } from './errors.js';
import { parseInput, parseResult, type DecideResult } from './schema.js';

export const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const TOTAL_TIMEOUT_MS = 30_000;
export const ATTEMPT_TIMEOUT_MS = 10_000;
export const MAX_RETRIES = 2;
export const MAX_BODY_BYTES = 4 * 1024 * 1024;
type Transport = (url: string, init: RequestInit) => Promise<Response>;

function containsCredential(value: unknown, key: string): boolean {
  if (typeof value === 'string') return value.includes(key);
  if (value && typeof value === 'object') return Object.entries(value).some(([name, child]) => name.includes(key) || containsCredential(child, key));
  return false;
}

function abortError(): DecideError { return new DecideError('TypeSafe call was cancelled.'); }
function checkAbort(signal?: AbortSignal): void { if (signal?.aborted) throw abortError(); }

function cancellable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(abortError());
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await cancellable(new Promise<void>(resolve => { timer = setTimeout(resolve, ms); }), signal); }
  finally { clearTimeout(timer); }
}

export function retryAfter(headers: Headers, now: number): number | undefined {
  const rawMs = headers.get('retry-after-ms');
  if (rawMs !== null && /^\d+(\.\d+)?$/.test(rawMs)) return Number(rawMs);
  const raw = headers.get('retry-after');
  if (raw === null || raw.trim() === '') return undefined;
  if (/^\d+(\.\d+)?$/.test(raw.trim())) return Number(raw) * 1000;
  // A date must be an HTTP-date, not Date.parse's lenient numeric input.
  if (!/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(raw)) return undefined;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? Math.max(0, parsed - now) : undefined;
}

async function readBody(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) throw new DecideError('TypeSafe returned an empty response.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await cancellable(reader.read(), signal);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BODY_BYTES) throw new DecideError('TypeSafe response exceeds the local 4 MiB transport limit.');
      chunks.push(value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new DecideError('TypeSafe returned malformed JSON. No result was accepted.'); }
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
}

// Transport injection is a code-level testing seam, never plugin configuration.
export async function decide(raw: unknown, apiKey: string, callerSignal?: AbortSignal, transport: Transport = (url, init) => globalThis.fetch(url, init)): Promise<DecideResult> {
  checkAbort(callerSignal);
  const input = parseInput(raw);
  const body = JSON.stringify(input);
  if (Buffer.byteLength(body) > MAX_BODY_BYTES) throw new DecideError('TypeSafe request exceeds the local 4 MiB transport limit. Reduce the supplied state and questions.');
  const total = new AbortController();
  const timer = setTimeout(() => total.abort(), TOTAL_TIMEOUT_MS);
  const signal = callerSignal ? AbortSignal.any([callerSignal, total.signal]) : total.signal;
  const deadline = Date.now() + TOTAL_TIMEOUT_MS;
  try {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      checkAbort(signal);
      const attemptController = new AbortController();
      const attemptTimer = setTimeout(() => attemptController.abort(), ATTEMPT_TIMEOUT_MS);
      const requestSignal = AbortSignal.any([signal, attemptController.signal]);
      let response: Response;
      let payload: unknown;
      try {
        response = await cancellable(transport(ENDPOINT, {
          method: 'POST', redirect: 'error', credentials: 'omit',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body, signal: requestSignal,
        }), requestSignal);
        if (response.status === 200 || response.status === 422) {
          try { payload = await readBody(response, requestSignal); }
          catch (error) { if (response.status === 200 || requestSignal.aborted) throw error; }
        } else { void response.body?.cancel().catch(() => {}); }
      } catch (error) {
        if (callerSignal?.aborted) throw abortError();
        if (total.signal.aborted || attemptController.signal.aborted) throw new DecideError('TypeSafe call timed out. It was not retried.');
        if (error instanceof DecideError) throw error;
        throw new DecideError('TypeSafe transport failed. Check network access to api.typesafe.ai. No automatic retry was made.');
      } finally { clearTimeout(attemptTimer); }
      if (response.status === 200) {
        const result = parseResult(payload, input);
        // A corrupt or hostile upstream response must not echo the bearer key.
        if (containsCredential(result, apiKey)) throw new DecideError('TypeSafe returned an unsafe response. No result was accepted.');
        return result;
      }
      const error = httpError(response.status, payload);
      if (![429, 529].includes(response.status) || attempt === MAX_RETRIES) throw error;
      const delay = Math.max(500 * 2 ** attempt, retryAfter(response.headers, Date.now()) ?? 0);
      if (!Number.isFinite(delay) || delay >= deadline - Date.now()) throw new DecideError(`TypeSafe HTTP ${response.status}. Retry-After exceeds the remaining call deadline; retry later.`, response.status);
      await sleep(delay, signal);
    }
    throw new DecideError('TypeSafe retries exhausted.');
  } catch (error) {
    if (callerSignal?.aborted) throw abortError();
    if (total.signal.aborted) throw new DecideError('TypeSafe call exceeded the 30-second total deadline.');
    if (error instanceof DecideError) throw error;
    throw new DecideError('TypeSafe call failed. No result was accepted.');
  } finally { clearTimeout(timer); }
}
