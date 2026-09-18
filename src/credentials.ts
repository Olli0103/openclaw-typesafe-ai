import { Type } from 'typebox';
import { z } from 'zod';
import { buildSecretInputSchema, type SecretInput } from 'openclaw/plugin-sdk/secret-input';
import { assertPluginCapabilitySecretAvailable, coerceSecretRef, normalizeResolvedSecretInputString } from 'openclaw/plugin-sdk/secret-input-runtime';
import { DecideError } from './errors.js';

export const SECRET_OWNER = 'plugins.entries.typesafe-ai.config.apiKey';
const { $schema: _schema, ...secretSchema } = z.toJSONSchema(buildSecretInputSchema(), { target: 'draft-7' });
export const configSchema = Type.Object({
  apiKey: Type.Optional(Type.Unsafe<SecretInput>(secretSchema)),
}, { additionalProperties: false });

export function requireCredential(value: unknown): string {
  try {
    assertPluginCapabilitySecretAvailable(SECRET_OWNER);
    if (coerceSecretRef(value)) throw new Error();
    const key = normalizeResolvedSecretInputString({ value, path: SECRET_OWNER });
    if (!key || /[\s\x00-\x1f\x7f]/u.test(key) || key.startsWith('oc-sent-') || key.startsWith('secretref-env:') || key.startsWith('__env__:')) throw new Error();
    return key;
  } catch {
    throw new DecideError('TypeSafe credential is missing, blocked or unresolved. Configure apiKey with an OpenClaw SecretRef to TYPESAFE_API_KEY and resolve it before calling this tool.');
  }
}
