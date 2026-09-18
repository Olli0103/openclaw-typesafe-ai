// Opt-in developer smoke test. Never used by the Gateway or the normal test suite.
import { resolveReadOnlyEnvSecretRef } from 'openclaw/plugin-sdk/secret-ref-readonly';
import plugin from '../dist/index.js';

if (process.env.TYPESAFE_LIVE_SMOKE_APPROVED !== '1') {
  console.error('Live smoke not run. Obtain operator approval, then set TYPESAFE_LIVE_SMOKE_APPROVED=1.');
  process.exitCode = 2;
} else {
  try {
    const resolved = resolveReadOnlyEnvSecretRef({
      value: { source: 'env', provider: 'default', id: 'TYPESAFE_API_KEY' },
      path: 'plugins.entries.typesafe-ai.config.apiKey',
      expectedEnvId: 'TYPESAFE_API_KEY',
      cfg: { secrets: { providers: { default: { source: 'env', allowlist: ['TYPESAFE_API_KEY'] } } } },
      normalizeValue: value => typeof value === 'string' && value.trim() ? value.trim() : undefined,
    });
    if (resolved.status !== 'available') throw new Error('credential unavailable');
    let tool;
    plugin.register({ pluginConfig: { apiKey: resolved.value }, registerTool(value) { tool = value; } });
    if (!tool) throw new Error('tool unavailable');
    const result = await tool.execute('approved-live-smoke', {
      state: 'The service is unavailable. Please help today.',
      model: 'jev-latest',
      questions: { urgent: { type: 'noul', instructions: 'Does this message express urgency?' } },
    });
    // Do not print raw vendor content, headers, exceptions, or credentials.
    if (!result.details?.answers?.urgent) throw new Error('result unavailable');
    console.log('Live smoke passed: registered tool returned a validated Noul result.');
  } catch {
    console.error('Live smoke failed. Check the protected credential, network and TypeSafe account. No request, response or credential was printed.');
    process.exitCode = 1;
  }
}
