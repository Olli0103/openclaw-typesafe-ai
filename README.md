# TypeSafe AI for OpenClaw

`openclaw-typesafe-ai` exposes one optional agent tool, `typesafe_decide`, labelled **TypeSafe Decide**. The plugin ID is `typesafe-ai`. It sends explicit text or JSON state and typed questions to `POST https://api.typesafe.ai/v1/systemone`, with `jev-latest` as the default model.

Jev returns decisions over predefined answer spaces. It does not generate conversation, prose or code. This package therefore registers a tool and no model provider, model picker entry, hook or background service.

This is an independent integration. It is not an official TypeSafe AI or OpenClaw package. See the [verification report](VERIFICATION.md) for test coverage and the limits of the available evidence.

Compatibility is pinned to **OpenClaw 2026.9.4** on Node **24.20.0**, macOS arm64. Checks passed against both the installed `6f80261` build, copied into an isolated test environment, and the published npm build `3a9d69d` after a clean dependency installation. No other OpenClaw release is claimed compatible.

## Build and verify

Clone the source:

```sh
git clone https://github.com/Olli0103/openclaw-typesafe-ai.git
cd openclaw-typesafe-ai
```

Use Node 24.20.0 for the tested environment, with npm available. The `.nvmrc` pins that version. From the package directory:

```sh
npm ci --ignore-scripts
npm run typecheck
npm run plugin:build
npm test
npm run plugin:validate
npm run test:host
npm pack --dry-run
npm pack
```

`plugin:build` runs TypeScript and `openclaw plugins build --entry ./dist/index.js`. `plugin:validate` checks generated metadata for drift and runs `openclaw plugins validate --entry ./dist/index.js`. `test:host` invokes the actual host loader and CLI against disposable configuration, state and cache directories using an obvious fake credential. It does not install a plugin or start a Gateway. No lint tool is configured. `.npmrc` uses npm's legacy peer resolver because npm 10.9.8's normal resolver crashed on the OpenClaw/Vitest dependency graph.

`npm ci` installs the published OpenClaw package. To repeat proof against an exact managed installation, use a copy of that installation as the development dependency, then run the same checks. Never edit the installed OpenClaw tree.

The release tarball contains built JavaScript, declarations, the plugin manifest, this README and the MIT license. Tests and development scripts stay in the source directory. `prepack` rebuilds `dist/`, while `prepublishOnly` reruns the complete local gate before an npm release.

## Installation and explicit opt-in

Run these commands only when you intend to change your OpenClaw installation. Installation can restart a managed Gateway automatically. No live installation was performed during development.

Prefer the OpenClaw-native ClawHub listing after its release review completes:

```sh
openclaw plugins install clawhub:olli0103/openclaw-typesafe-ai
```

The same release is also available through npm:

```sh
openclaw plugins install npm:openclaw-typesafe-ai@0.1.0
```

For local artifact testing, install an explicitly reviewed tarball:

```sh
openclaw plugins install npm-pack:/absolute/path/openclaw-typesafe-ai-0.1.0.tgz
```

Review the source and capability prompt. For a deliberate noninteractive local installation, OpenClaw supports `--force`; it also permits overwriting an existing target, so do not add it casually. This plugin shares the ID `typesafe-ai` with a community implementation. Inspect existing inventory before installation and do not overwrite an unrelated plugin.

Make `TYPESAFE_API_KEY` available to the Gateway process through your protected environment or existing secret manager. Never paste the key into chat, command arguments, source files or configuration examples. A terminal environment variable is not automatically inherited by an already running launchd service.

Configure the reference with the supported CLI builder:

```sh
openclaw config set plugins.entries.typesafe-ai.config.apiKey \
  --ref-provider default --ref-source env --ref-id TYPESAFE_API_KEY
openclaw plugins enable typesafe-ai
```

This stores the reference below, not the key:

```json
{"source":"env","provider":"default","id":"TYPESAFE_API_KEY"}
```

The implicit `default` env provider works when `secrets.defaults.env` is unset. If your installation uses a different env-provider alias, use that alias and ensure its allowlist includes `TYPESAFE_API_KEY`. The shared OpenClaw secret schema also accepts `store`, `file` and `exec` references. Configure those providers with OpenClaw's supported secrets workflow.

For a dedicated agent/configuration whose intended allowlist consists only of this tool:

```sh
openclaw config set tools.allow '["typesafe_decide"]' --strict-json
openclaw config validate --json
openclaw plugins inspect typesafe-ai --runtime --json
```

For an existing setup, first read its policy with `openclaw config get tools --json`. Preserve existing allowlist entries when setting the complete `tools.allow` array. OpenClaw rejects `allow` and `alsoAllow` in the same scope. Agent, provider and sandbox restrictions still apply. If `plugins.allow` is configured, preserve its entries and include `typesafe-ai` too.

The tool is optional in both runtime registration and manifest metadata. Enabling the plugin does not itself opt the tool into model exposure. No profile adds it automatically. The optional-tool gate controls exposure; this package does not add a separate approval prompt for every call. An allowed agent can transmit inputs and incur cost.

If an unmanaged Gateway does not reload after installation, perform your normal approved restart before checking the live tool. This development task neither restarted nor changed the live Gateway.

## Request contract

Only these fields enter the HTTP body:

- `state`: a string, JSON object or JSON array. A string is ordinary text and need not itself contain encoded JSON. Nested JSON numbers, booleans and nulls are supported. Media bytes are not decoded and URLs are not fetched.
- `questions`: a non-empty map under caller-chosen IDs. Each question must contain `type` and `instructions`.
- `model`: optional non-empty string. Defaults to `jev-latest`.

Question objects form a closed discriminated union:

| Type | Criteria |
| --- | --- |
| `noul` | Optional object with only optional `true` and `false` descriptions |
| `choice` | Required map of 1–255 option names to descriptions |
| `score` | Required ordered array of 2–10 descriptions, indexed from zero |

Instructions and descriptions accept strings, JSON objects, arrays or null, matching the [advanced guide](https://docs.typesafe.ai/primitives/advanced) and JavaScript SDK 0.6.0 `EntryType`. The `instructions` field remains required by this tool's contract. Noul's whole `criteria` must be omitted or an object, not null. Unknown envelope/question fields, incorrect unions and invalid criteria fail before HTTP access. Nested state and rubric JSON remain open data structures.

## Examples

The outputs below are illustrative fixtures, not live API observations.

Noul input:

```json
{"state":"Please help today.","questions":{"urgent":{"type":"noul","instructions":"Is this urgent?","criteria":{"true":"Time-sensitive","false":"No urgency expressed"}}}}
```

Noul output:

```json
{"model":"jev-1.13.0","answers":{"urgent":{"type":"noul","noul":0.92}},"usage":{"input_tokens":32,"output_tokens":4}}
```

Choice input:

```json
{"state":{"message":"Please fix billing."},"questions":{"team":{"type":"choice","instructions":"Which team?","criteria":{"billing":"Payments","support":null}}}}
```

Choice output:

```json
{"model":"jev-1.13.0","answers":{"team":{"type":"choice","choice":"billing","probabilities":{"billing":0.8,"support":0.2},"confidence":0.65}},"usage":{"input_tokens":45,"output_tokens":8}}
```

Score input:

```json
{"state":["The export fails."],"model":"jev-1.13.0","questions":{"severity":{"type":"score","instructions":"How severe?","criteria":["Cosmetic","Workaround exists","Blocking"]}}}
```

Score output:

```json
{"model":"jev-1.13.0","answers":{"severity":{"type":"score","score":1.6,"legend":{"0":"Cosmetic","1":"Workaround exists","2":"Blocking"},"probabilities":{"0":0.1,"1":0.2,"2":0.7},"confidence":0.6}},"usage":{"input_tokens":70,"output_tokens":12}}
```

Combine these question entries in one call when they evaluate the same state. All answer IDs, model ID, probabilities, confidence, legends and usage are preserved in OpenClaw's structured `details` and JSON text result. Noul has no separate confidence field. Results are schema-checked and matched to the submitted question types and option/index sets. Probabilities must lie in `[0,1]` and sum to one within a `0.0001` floating-point tolerance. Malformed JSON, missing answers and unknown response fields fail closed. No answer is repaired or replaced with a guess.

## HTTP and credentials

The plugin uses a small direct HTTP client. SDK 0.6.0 supports explicit credentials, abort signals and retries, but always adds SDK/runtime/retry metadata headers. Its body parsing is permissive, it permits ambient endpoint/logging defaults, and its timeout is per attempt without a total deadline. The direct client keeps the endpoint fixed, sends no SDK telemetry headers, rejects redirects and enforces the requested validation and privacy boundaries. Vendor SDK types are checked during development.

OpenClaw resolves credentials at activation. The manifest declares `configContracts.secretInputs.paths` for `apiKey`, with `expected: "string"` and `ownerKind: "capability"`. The full owner path is `plugins.entries.typesafe-ai.config.apiKey`. The tool calls the exported `assertPluginCapabilitySecretAvailable`, rejects unresolved references, and accepts only a resolved string. It never reads an ambient API key or tries a fallback credential. Capability-owner failure is cold; a stale key cannot bypass the runtime guard. Secret metadata and `uiHints.sensitive` make Settings and CLI config diagnostics redact the credential.

- Each attempt has a 10-second timeout, including response reading. The complete call has a 30-second deadline, including retry waits.
- Only HTTP `429` and `529` retry, at most twice after the first attempt. Backoff is 500 ms then 1,000 ms.
- `Retry-After` seconds or HTTP-date and `retry-after-ms` are honored as minimum waits. A delay beyond the remaining deadline returns the HTTP status and asks the caller to retry later. It is never shortened to fit.
- Authentication, validation, other HTTP errors, transport failures, aborts, timeouts and malformed responses are not retried.
- OpenClaw's execution signal aborts HTTP and backoff. Redirects are rejected so the bearer key cannot follow an endpoint change.
- Errors keep the HTTP status and allowlisted validation field/type information. They omit arbitrary upstream messages, question IDs, inputs, response bodies and error causes.
- Local defensive limits are 4 MiB for request and response bodies and 128 levels of JSON nesting. These are implementation limits, not claimed vendor token limits.

The client uses global `fetch`, so OpenClaw's configured managed HTTP proxy hooks remain in effect. It does not create a custom dispatcher or proxy bypass.

## Jev limitations and data handling

The [current model page](https://docs.typesafe.ai/models) and [Jev 1.13 limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13) document:

- Text input only, with Choice, Score and Noul outputs. No image/audio/video understanding or free-text generation.
- 64k tokens for state plus all questions together; 32k for state plus the longest question. TypeSafe enforces these limits. No published tokenizer is integrated here, so character counts are not presented as token counts.
- English is the primary training language and currently has the best reported accuracy. Validate other languages on your own data.
- Arithmetic, counting, date comparison and deterministic computation belong in code.
- Irrelevant state can lower accuracy. Adversarial state can influence the answer. Typed output and high confidence do not prove correctness or grant permission to act.
- Aliases can move. The returned model ID identifies the version that answered. Pin a version when results must be evaluated against a fixed model.

The plugin sends only the supplied state, questions and selected model. It does not collect conversation history, prompts, memory, workspace files, caller identity or runtime metadata. It does not log bodies, cache decisions or emit telemetry. Request data goes to TypeSafe and calls may cost money, including retries. Returned results enter the normal OpenClaw tool transcript, so supplied criterion descriptions can reappear in Score legends.

Review [TypeSafe's legal policies](https://docs.typesafe.ai/legal) before sending sensitive data. The vendor describes its data handling and offers enterprise zero data retention; this plugin does not establish your account's retention terms or entitlement.

## Optional live smoke

Normal checks use fake credentials and mocked HTTP. A live check requires explicit operator approval and an API key already supplied through an authorized protected environment. Do not put the key into shell arguments or ask for it in chat.

From the source directory, after mock checks pass and approval is granted:

```sh
TYPESAFE_LIVE_SMOKE_APPROVED=1 npm run smoke:live
```

The script uses OpenClaw's exported read-only env SecretRef resolver with an explicit reference to `TYPESAFE_API_KEY`, then invokes the registered tool once with fixed nonsensitive sample text. It prints only pass/fail. The approval flag authorizes this script invocation only; it does not configure the Gateway.

Live API proof for this implementation: **not run because no authorized API key/live-call approval was available**.

## Source decisions

Documentation was checked on 2026-09-18. The full indexes/bundles, all pages named in the task and official JavaScript SDK source were inspected. The TypeSafe skill was development guidance only. OpenClaw's bundled 2026.9.4 documentation controls host behavior.

Two documentation contradictions matter. The HTTP overview shows string-only criteria while the advanced guide and SDK support structured descriptions; this plugin follows the latter. The primitives overview describes an approximate 32k shared budget, while the live models page and version-specific limitations specify the 64k/32k split; this plugin documents the specific model limits. The fetched full bundle also omitted the live model page's language-support section.

Preflight searched ClawHub, npm, GitHub and the installed inventory. ClawHub exposed the vendor development skill. The [community TypeSafe plugin](https://github.com/jason-allen-oneal/openclaw-plugin-typesafe-ai) implements conversation hooks, triage, guardrails and routing, so it does not satisfy this tool-only, explicit-input contract. No suitable official maintained plugin was identified. Nothing from preflight was installed into the Gateway.
