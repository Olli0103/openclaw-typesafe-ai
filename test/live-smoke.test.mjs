import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); process.exitCode = 0; });

it('keeps the live script inert without explicit approval', async () => {
  vi.stubEnv('TYPESAFE_LIVE_SMOKE_APPROVED', '');
  vi.stubEnv('TYPESAFE_API_KEY', 'fake-live-smoke-key');
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  await import('../scripts/live-smoke.mjs?no-approval');
  expect(process.exitCode).toBe(2);
  expect(fetch).not.toHaveBeenCalled();
  expect(error).toHaveBeenCalledWith(expect.stringContaining('not run'));
});

it('resolves an explicit env SecretRef and exercises the live script with mocked HTTP only', async () => {
  vi.stubEnv('TYPESAFE_LIVE_SMOKE_APPROVED', '1');
  const fake = 'fake-live-smoke-key';
  vi.stubEnv('TYPESAFE_API_KEY', fake);
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ model: 'jev-1.13.0', answers: { urgent: { type: 'noul', noul: 0.9 } }, usage: { input_tokens: 12, output_tokens: 4 } })));
  vi.stubGlobal('fetch', fetch);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  await import('../scripts/live-smoke.mjs?mock-approved');
  expect(fetch).toHaveBeenCalledOnce();
  expect(fetch.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${fake}`);
  expect(log).toHaveBeenCalledWith(expect.stringContaining('passed'));
  expect(error).not.toHaveBeenCalled();
  expect(JSON.stringify(log.mock.calls)).not.toContain(fake);
});

it('fails closed with a missing approved env credential', async () => {
  vi.stubEnv('TYPESAFE_LIVE_SMOKE_APPROVED', '1');
  vi.stubEnv('TYPESAFE_API_KEY', '');
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await import('../scripts/live-smoke.mjs?missing-key');
  expect(process.exitCode).toBe(1);
  expect(fetch).not.toHaveBeenCalled();
});
