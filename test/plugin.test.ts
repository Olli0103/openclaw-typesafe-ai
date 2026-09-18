import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getToolPluginMetadata } from 'openclaw/plugin-sdk/tool-plugin';
import { buildSecretInputSchema } from 'openclaw/plugin-sdk/secret-input';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-runtime';
import { Ajv } from 'ajv';
import plugin from '../src/index.js';
import { configSchema, requireCredential, SECRET_OWNER } from '../src/credentials.js';
import { FAKE_KEY, jsonResponse, noulInput, noulResult } from './fixtures.js';

const guard = vi.hoisted(() => vi.fn());
vi.mock('openclaw/plugin-sdk/secret-input-runtime', async importOriginal => ({
  ...await importOriginal<typeof import('openclaw/plugin-sdk/secret-input-runtime')>(),
  assertPluginCapabilitySecretAvailable: guard,
}));
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); guard.mockReset(); });

function registered(config: unknown = { apiKey: FAKE_KEY }) {
  const registerTool = vi.fn();
  const registerProvider = vi.fn();
  const api = {
    pluginConfig: config, registerTool, registerProvider,
    get config() { throw new Error('Implicit context access is prohibited'); },
    get runtime() { throw new Error('Implicit runtime context access is prohibited'); },
  } as unknown as OpenClawPluginApi;
  plugin.register!(api);
  expect(registerTool).toHaveBeenCalledTimes(1); expect(registerProvider).not.toHaveBeenCalled();
  return { tool: registerTool.mock.calls[0]![0], options: registerTool.mock.calls[0]![1] };
}

describe('registration, SecretRef and metadata', () => {
  it('registers exactly one optional tool and invokes it end to end with mocked HTTP', async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse(noulResult)); vi.stubGlobal('fetch', fetch);
    const { tool, options } = registered();
    expect(tool.name).toBe('typesafe_decide'); expect(tool.label).toBe('TypeSafe Decide'); expect(options).toEqual({ optional: true });
    const result = await tool.execute('call-1', noulInput, new AbortController().signal);
    expect(result.details).toEqual(noulResult); expect(JSON.parse(result.content[0].text)).toEqual(noulResult);
    expect(guard).toHaveBeenCalledWith(SECRET_OWNER);
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual({ ...noulInput, model: 'jev-latest' });
  });
  it.each([undefined, '', ' ', { source: 'env', provider: 'default', id: 'TYPESAFE_API_KEY' }, '${TYPESAFE_API_KEY}', '$TYPESAFE_API_KEY', 'secretref-env:TYPESAFE_API_KEY', '__env__:TYPESAFE_API_KEY', 'oc-sent-v2.fake.end', 'fake\r\nheader'])('rejects missing or unresolved credential %# before network access', async value => {
    vi.stubEnv('TYPESAFE_API_KEY', FAKE_KEY);
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const { tool } = registered({ apiKey: value });
    await expect(tool.execute('call', noulInput)).rejects.toThrow('missing, blocked or unresolved');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('checks unavailable capability ownership even when a stale string is present', async () => {
    guard.mockImplementation(() => { throw new Error(`blocked ${FAKE_KEY}`); });
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await expect(registered().tool.execute('call', noulInput)).rejects.toThrow('blocked');
    expect(fetch).not.toHaveBeenCalled();
    expect(() => requireCredential(FAKE_KEY)).toThrow(expect.not.stringContaining(FAKE_KEY));
  });
  it('accepts documented SecretRefs in config and rejects malformed refs or extra config', () => {
    const validate = new Ajv({ strict: false }).compile(configSchema);
    for (const source of ['env', 'store', 'file', 'exec'] as const) {
      const ref = { source, provider: 'default', id: source === 'file' ? '/apiKey' : 'TYPESAFE_API_KEY' };
      expect(buildSecretInputSchema().safeParse(ref).success).toBe(true);
      expect(validate({ apiKey: ref })).toBe(true);
    }
    expect(validate({ apiKey: { source: 'env', provider: 'default', id: 'bad-lowercase' } })).toBe(false);
    expect(validate({ apiKey: { source: 'unknown', provider: 'default', id: 'TYPESAFE_API_KEY' } })).toBe(false);
    expect(validate({ apiKey: FAKE_KEY, baseURL: 'https://elsewhere.invalid' })).toBe(false);
  });
  it('matches generated manifest to runtime metadata and secret ownership', () => {
    const manifest = JSON.parse(readFileSync(new URL('../openclaw.plugin.json', import.meta.url), 'utf8'));
    const meta = getToolPluginMetadata(plugin)!;
    expect(manifest.id).toBe(meta.id); expect(manifest.contracts).toEqual({ tools: ['typesafe_decide'] });
    expect(meta.tools).toHaveLength(1); expect(meta.tools[0]!.optional).toBe(true);
    expect(manifest.activation).toEqual({ onStartup: false });
    expect(manifest.configSchema).toEqual(meta.configSchema);
    expect(manifest.toolMetadata.typesafe_decide).toMatchObject({ optional: true, sideEffecting: true, replaySafe: false });
    expect(manifest.configContracts.secretInputs.paths).toEqual([{ path: 'apiKey', expected: 'string', ownerKind: 'capability' }]);
    expect(manifest.uiHints.apiKey.sensitive).toBe(true);
    expect(SECRET_OWNER).toBe(`plugins.entries.${manifest.id}.config.apiKey`);
    expect(manifest).not.toHaveProperty('providers');
  });
  it('propagates the registered execution signal', async () => {
    const fetch = vi.fn(() => new Promise<Response>(() => {})); vi.stubGlobal('fetch', fetch);
    const controller = new AbortController();
    const pending = registered().tool.execute('call', noulInput, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow('cancelled');
    expect((fetch.mock.calls as unknown as [string, RequestInit][])[0]![1].signal?.aborted).toBe(true);
  });
  it('ignores ambient endpoint/model/logging controls and never writes to console', async () => {
    vi.stubEnv('TYPESAFE_BASE_URL', 'https://elsewhere.invalid'); vi.stubEnv('TYPESAFE_DEFAULT_MODEL', 'other-model'); vi.stubEnv('TYPESAFE_LOG_LEVEL', 'debug');
    const logs = ['log', 'info', 'warn', 'error', 'debug'].map(method => vi.spyOn(console, method as 'log').mockImplementation(() => {}));
    const fetch = vi.fn().mockResolvedValue(jsonResponse(noulResult)); vi.stubGlobal('fetch', fetch);
    await registered().tool.execute('call', noulInput);
    expect(fetch.mock.calls[0]![0]).toBe('https://api.typesafe.ai/v1/systemone');
    expect(JSON.parse(fetch.mock.calls[0]![1].body).model).toBe('jev-latest');
    logs.forEach(log => expect(log).not.toHaveBeenCalled());
  });
});
