import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = resolve(dirname(fileURLToPath(import.meta.resolve('openclaw/plugin-sdk/tool-plugin'))), '../..', 'openclaw.mjs');
const temporary = mkdtempSync(join(tmpdir(), 'typesafe-host-smoke-'));
const fake = 'fake-typesafe-host-smoke-key';
const ref = { source: 'env', provider: 'default', id: 'TYPESAFE_API_KEY' };
const cfg = { plugins: { allow: ['typesafe-ai'], load: { paths: [root] }, entries: { 'typesafe-ai': { enabled: true, config: { apiKey: ref } } } }, tools: { allow: ['typesafe_decide'] } };
const configPath = join(temporary, 'openclaw.json');
mkdirSync(join(temporary, 'tmp'), { mode: 0o700 });
const env = { PATH: process.env.PATH, TMPDIR: join(temporary, 'tmp'), XDG_CACHE_HOME: join(temporary, 'cache'), OPENCLAW_STATE_DIR: temporary, OPENCLAW_CONFIG_PATH: configPath, TYPESAFE_API_KEY: fake, NO_COLOR: '1' };
function run(args) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, env, encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
  const output = (result.stdout ?? '') + (result.stderr ?? '');
  assert(!output.includes(fake), 'Host output leaked the fake credential');
  assert.equal(result.status, 0, `Host command failed: ${args.join(' ')}\n${output}`);
  return result.stdout;
}
try {
  writeFileSync(configPath, JSON.stringify(cfg), { mode: 0o600 });
  run(['config', 'validate', '--json']);
  const inspection = run(['plugins', 'inspect', 'typesafe-ai', '--runtime', '--json']);
  writeFileSync(join(temporary, 'inspection.json'), inspection);
  const inspected = JSON.parse(inspection);
  const result = inspected.plugin ?? inspected;
  assert(result.id, `Unexpected inspect response: ${JSON.stringify(inspected).slice(0, 4000)}`);
  assert.equal(result.id, 'typesafe-ai');
  assert.deepEqual(result.toolNames, ['typesafe_decide']);
  assert.deepEqual(inspected.tools, [{ names: ['typesafe_decide'], optional: true }]);
  assert.equal(result.status, 'loaded');
  assert.deepEqual(result.providerIds, []);
  const redacted = run(['config', 'get', 'plugins.entries.typesafe-ai.config', '--json']);
  assert(!redacted.includes('TYPESAFE_API_KEY'), 'SecretRef ID was not redacted');
  assert(redacted.includes('env') && redacted.includes('default'));
  writeFileSync(configPath, JSON.stringify({ ...cfg, plugins: { ...cfg.plugins, entries: { 'typesafe-ai': { enabled: true, config: { apiKey: fake } } } } }), { mode: 0o600 });
  run(['config', 'get', 'plugins.entries.typesafe-ai.config', '--json']);
  // Exercise the supported SecretRef builder only against this disposable config.
  run(['config', 'set', 'plugins.entries.typesafe-ai.config.apiKey', '--ref-provider', 'default', '--ref-source', 'env', '--ref-id', 'TYPESAFE_API_KEY']);
  assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf8')).plugins.entries['typesafe-ai'].config.apiKey, ref);
  run(['config', 'set', 'tools.allow', '["typesafe_decide"]', '--strict-json']);
  run(['plugins', 'enable', 'typesafe-ai']);
  console.log('Host smoke passed: actual loader, tool ownership, config validation, SecretRef redaction, CLI ref builder, allowlist and enable commands. Isolated state only.');
} finally { rmSync(temporary, { recursive: true, force: true }); }
