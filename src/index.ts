import { defineToolPlugin } from 'openclaw/plugin-sdk/tool-plugin';
import { configSchema, requireCredential } from './credentials.js';
import { decide } from './client.js';
import { inputSchema, outputSchema, CONTEXT_LIMITS } from './schema.js';

export default defineToolPlugin({
  id: 'typesafe-ai', name: 'TypeSafe AI',
  description: 'Optional typed decisions using TypeSafe AI Jev. Sends only explicit tool inputs to TypeSafe and can incur cost.',
  activation: { onStartup: false },
  configSchema,
  tools: tool => [tool({
    name: 'typesafe_decide', label: 'TypeSafe Decide', optional: true,
    description: 'Evaluate explicit text/JSON state with typed Noul, Choice (1–255 options) and Score (2–10 ordered levels) questions. Returns model ID, answers, probabilities, confidence where applicable, and usage. No image/audio/video or free-text generation. Keep arithmetic, counting and date comparison in code. Filter irrelevant state; adversarial state can influence answers. Vendor docs report strongest support for English. Aliases can move. This sends supplied data to TypeSafe AI and may incur cost. ' + CONTEXT_LIMITS,
    parameters: inputSchema, outputSchema,
    execute: (params, config, context) => decide(params, requireCredential(config.apiKey), context.signal),
  })],
});
