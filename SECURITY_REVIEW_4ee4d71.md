# CS-1 independent authentication security review

Reviewed 2026-09-15. Recommendation: **B. DO NOT PUSH — SECURITY DEFECTS REQUIRE FIXES**.

This review found credential disclosure in logs and contradictory authorization layers. It did **not** demonstrate access to privileged functionality using only an unauthenticated request, camp key, or transformer key. No production fixes were made. Failing regression tests are intentionally retained.

## A. Repository/commit verification

- Target: `C:/Users/seglu/OneDrive/Desktop/career-studio-final_1/careercamp-ai`.
- Origin, fetch and push: `https://github.com/owolat4real/careercamp-ai.git`.
- HEAD and reviewed commit: `4ee4d7186737ad5d3bdccd903f0d037234d9a10b`.
- Commit exists; its complete four-file diff was inspected. Tracked target files match HEAD.
- Initial target status contained an existing untracked `test/gatewayAuth.security.test.js`. It was preserved and assessed independently; it is not attributed to this review.
- No applicable `AGENTS.md` was found in the workspace search.

## B. Diff review

All changed lines in `server.js`, `core/gatewayAuth.js`, `test/gatewayAuth.test.js`, and `package.json` were reviewed: 585 insertions, 56 deletions.

The new outer policies implement purpose classification, fixed-size digest comparison, and a duplicate-value startup check. However:

1. `core/gatewayAuth.js:159-167` embeds the complete original URL in new failure logs, exposing query credentials.
2. `server.js:332-337` adds secret-only policies without reconciling six routers' existing `apiKeyGuard` functions. The intended ALLOW matrix is false for 15 handlers.
3. Transport priority order is retained for normal inputs, but the claim that extraction matches the old implementation exactly is false. Bearer handling is now case-insensitive and anchored; whitespace is normalized, query values are stringified, and presented/configured credentials are trimmed.
4. The new 512-character presented-key limit is not checked during configuration validation.
5. `npm test` runs only the 26 focused tests. It does not discover either independent security test file or the existing cache tests.

The parent commit already had the models-router mounting bug, Morgan query logging, and inner guards. Their interaction with the newly exclusive secret policy creates a new integration failure. Historical comments claiming the six v2 routes had no outer auth do not describe the immediate parent: it already applied `apiKeyAuth`.

## C. Independent route inventory

Order below follows `server.js` and each imported router. `S` = secret, `C` = camp, `T` = transformer. `L` = legacy inner guard. Every GET also has Express's implicit HEAD behavior. Prefix mounts apply outer auth to every method and descendant path; exact mounts apply it only to the registered method and implicit HEAD for GET.

| Method | Path(s) | Outer policy / mount | Additional middleware or result |
|---|---|---|---|
| GET | `/health` | Public, exact | Engine statuses and local video health probes |
| POST | `/api/show` | C, exact | Ollama proxy |
| GET | `/` | Public, exact | Service/version/repository link/endpoints |
| GET | `/v1` | Public, exact | Route catalogue and generic auth instructions |
| GET | `/v1/models` | S,C, exact | Engine attachment, then models router; authorized requests incorrectly return 404 |
| GET | `/v1/models/:model` | Intended S,C | Defined in child router but unreachable through exact parent GET; 404 even without a credential |
| POST | `/v1/chat/completions` | S,C, prefix | Engine attachment |
| POST | `/v1/embeddings` | S,C, prefix | Engine attachment |
| POST | `/v1/images/analyze` | C, prefix | Engine attachment; single-image upload |
| POST | `/v1/images/video-frames` | C, prefix | Engine attachment; frames upload |
| POST | `/v1/audio/transcriptions` | C,T, prefix | Engine attachment; file upload |
| POST | `/v1/audio/speech` | C,T, prefix | Engine attachment |
| POST | `/v1/audio/interview-analyze` | C,T, prefix | Engine attachment; audio upload |
| POST | `/v1/bert/:task` | C, prefix | Engine attachment |
| GET | `/v1/bert/tasks` | C, prefix | Engine attachment |
| POST | `/v1/agent/run` | S, prefix | Engine attachment |
| GET | `/v1/search` | C, exact | Local SearXNG proxy |
| POST | `/v1/infer` | S, prefix | L |
| GET, POST | `/v1/features/:featureId` | S, prefix | L |
| POST | `/v1/tools/:toolId`, `/v1/tools/:toolId/compare` | S, prefix | L |
| GET, POST, DELETE | `/v1/memory/:userId` | S, prefix | L, requireUserId |
| POST | `/v1/memory/:userId/extract` | S, prefix | L, requireUserId |
| GET | `/v1/developer/health`, `/v1/developer/status` | S, prefix | No inner auth; still protected by parent |
| GET | `/v1/developer/metrics` | S, prefix | L |
| POST | `/v1/developer/ping/:model` | S, prefix | L |
| GET | `/v1/developer/task-models` | S, prefix | L |
| GET | `/v1/developer/docs` | S, prefix | No inner auth; still protected by parent |
| GET, POST | `/v1/camp/:featureId` | S, prefix | L; camp guard permits next if both legacy classes are absent |
| GET | `/v1/camp` | S, prefix | Same camp guard |
| GET | `/v1/gpu-status`, `/v1/perf`, `/metrics` | S, exact | Diagnostics |
| POST | `/v1/vision/analyze` | C, exact | Engine attachment, rewrites `req.url` to `/analyze`, invokes vision router |

This is 36 protected method/path definitions including the two unreachable models definitions, plus three public GET definitions. No additional router mount or unprotected functional alias was found.

Global order: Helmet → compression → CORS → JSON parser → URL-encoded parser → Morgan → rate limiter → route middleware → error handler. CORS terminates OPTIONS before authorization. Parsers run before auth. The authentication configuration check executes before listener creation, although engine/router imports precede it.

## D. Authorization matrix

The **outer middleware** passes the full matrix with each of Bearer, x-api-key, and query transports:

| Policy | secret | camp | transformer | unknown | missing |
|---|---|---|---|---|---|
| Internal | ALLOW | 403 | 403 | 401 | 401 |
| Core: models/chat/embeddings | ALLOW | ALLOW | 403 | 401 | 401 |
| Camp-only | 403 | ALLOW | 403 | 401 | 401 |
| Audio | 403 | ALLOW | ALLOW | 401 | 401 |

There is no transformer-only route. A hypothetical transformer-only middleware policy rejects camp in the original tests.

End-to-end exceptions: both models definitions return 404 after an allowed presentation; all 15 L-guarded handlers return 401 for secret-only presentations when all three credentials are distinct. Other ALLOW cases reach the test sentinel after the actual guards. A sentinel demonstrates authorized handler reachability, not successful model inference.

## E. Header-confusion results

Outer precedence is nonempty extracted Authorization → truthy query `api_key` converted to string → x-api-key. Unknown/wrong-purpose winners do not fall back. Transport does not confer a different class.

Real Node/Express observations:

- Case-insensitive Bearer, space/tab separator, header-name case variations, and bare valid Authorization values are accepted.
- `Bearer<key>` and `Basic <key>` reject. Empty/space-only header values normalize differently on the wire than in hand-built request mocks.
- Sending `Authorization: Bearer ` produces `Bearer` after Node strips trailing whitespace; it rejects even with a valid x-api-key. A whitespace-only Authorization header becomes empty and permits fallback.
- Duplicate Authorization fields select the first value in this runtime. Reversing their order reverses the result. Duplicate x-api-key fields are comma-joined and rejected with the synthetic distinct values.
- Repeated query keys produce arrays. Two different values reject; `api_key[]=<valid key>` is accepted through single-element array coercion.
- `api_key[toString]=synthetic` causes `String(fromQuery)` to throw and returns 500 through the server error handler. No authorization bypass or process crash was observed.
- A 10,000-character header credential returns 401; a 20,000-character header is rejected by the Node parser with 431.

**Conflicting layers:** L chooses x-api-key before case-sensitive Bearer and validates `CS_TRANSFORMER_API_KEY || CAREERCAMP_API_KEY`. Across all 15 L-guarded handlers, secret Bearer alone returns 401; secret Bearer plus transformer x-api-key reaches the handler; transformer alone and the reverse pairing return 403. This requires the secret credential and is not a transformer-only privilege escalation, but it disproves the single-class authorization design.

## F. Route/path-confusion results

All protected definitions were probed using trailing slashes, repeated slashes, mixed case, encoded literal characters, encoded slashes, queries, prefix-boundary changes, and encoded dot segments. Missing credentials produced 401 or 404, never a protected sentinel response.

Positive controls confirmed that uppercase audio paths, trailing slash, a repeated slash at the mounted-router boundary, and query strings still reach the same audio handler with an allowed key. Encodings that do not match do not create a bypass. The exact vision alias applies auth before rewriting. External proxies' URL normalization was not tested.

## G. HTTP-method results

GET, POST, PUT, PATCH, DELETE, OPTIONS, and HEAD were tested without credentials on every protected source path. No method reached protected functionality.

- OPTIONS returns 204 globally through CORS, including on protected paths; this is a preflight response, not access to the handler.
- Prefix-auth routes reject unauthorized methods before a router can dispatch; allowed credentials with unsupported methods ultimately get 404.
- Exact GET handlers authenticate HEAD. Other unsupported methods bypass the exact handler but return 404.
- Exact POST endpoints have no GET/HEAD functional fallback.
- `/v1/models/:model` is unmounted, so its 404 is an availability defect, not unprotected model access.

## H. Constant-time comparison review

`core/gatewayAuth.js:28-35` generates a random 32-byte key once per module instance, HMAC-SHA256s both nonempty string inputs, then compares two 32-byte buffers. Instrumented execution confirmed equal digest lengths and different keys for independently initialized modules. Normal CommonJS caching reuses one key for that process/module; no persisted or deterministic key was found. `reload()` reloads credentials without regenerating this key, which is consistent with the per-boot design.

Undefined, null, non-string, and empty inputs return false before hashing. Classification rejects values over 512 characters before digesting. Direct `_safeEqual` has no length cap; the configuration duplicate check can hash arbitrarily long configured values. Digest input conversion cannot invoke attacker-controlled object methods after `_safeEqual`'s string checks.

**The entire operation is not constant-time.** HMAC work depends on input length, trimming/type/length checks branch, and classification exits at the first matching class. The construction avoids variable-length `timingSafeEqual` exceptions and direct character-prefix comparison. It does not establish secret-length-independent total timing. No timing attack recovering credential content was demonstrated; timing resistance is not asserted from a wall-clock unit test. Crypto initialization errors would abort loading; normal auth failures return generic JSON and do not log digests.

## I. Duplicate-secret guard review

Synthetic tests exercised both `checkConfiguration` and the actual server refusal branch:

| Configuration | Result |
|---|---|
| Three distinct values | Starts |
| camp = transformer | Refuses |
| camp = secret | Refuses |
| transformer = secret | Refuses |
| All equal | Refuses |
| One missing, other two distinct | Starts |
| Two missing, one nonblank | Starts |
| All missing | Refuses |
| All empty | Refuses |
| All whitespace-only | Refuses |
| Values equal after trimming | Refuses |

Diagnostic details contain environment variable names, not values. Duplicate checks fail closed. **Configuration validation is incomplete:** a sole 513-character secret passes startup but can never authenticate because classification rejects it. This is an availability/configuration defect, not permissive authorization.

## J. Partial-configuration behavior

All six nonempty proper subsets were tested. Missing classes do not classify, acquire another class's rights, or authorize empty credentials. Shared policies retain access for their still-configured permitted class. The guard intentionally requires at least one usable-looking value, not all three.

With only secret configured, the five non-camp legacy guards reject every call because neither legacy key is configured. Camp's legacy guard instead passes, but its outer secret check remains enforced. Neither behavior grants an unconfigured or low-privilege caller access.

The minimum-one startup policy is clear in code; readiness expectations for a complete CareerStudioMax deployment are not documented adequately. For the deployment under review, all three must be configured. Requiring all three universally is a product decision, not a reason to broaden route permissions.

## K. cs_fixed compatibility

Read-only source inspection and synthetic execution support these consumers:

- `services/careercamp-ext.js:22-28` chooses camp before transformer; transcriptions, speech, and interview analysis are called at lines 224, 262, and 301.
- `middleware/brain.js:4743` chooses the transformer key; lines 4926-4928 send it as x-api-key to audio transcriptions. **Both camp and transformer need audio access.** Transformer TTS/interview use was not independently found; the implemented policy grants the whole audio family.
- `config/aiEnvironment.js:100-114,188-190` selects secret first for model discovery. Synthetic execution confirmed its exact `/v1/models` request and secret Bearer selection. Authorization permits it, but the pre-existing mounting defect returns 404.
- `services/inferencePool.js:74-84` chooses camp normally, then secret as a supported fallback; backend-specific credentials can override general ones. `services/camp-client.js:109-118,262,306,354` uses that client for chat, streaming, and embeddings. Synthetic execution confirmed camp-first and secret-fallback selection. This supports secret access to chat/embeddings as a fallback, not a claim that ordinary fully configured requests use secret there.
- Vision/BERT/search camp-first consumers match the policy. Their historical transformer/secret fallbacks can now reject on camp-only routes. Use the correct configured camp key; do not restore universal access.
- `camp-client.js:419-425` also allows CSTM2_API_KEY to override the gateway client key. Its deployed relationship to the three gateway classes was not inspected. It must resolve to an intentionally permitted class for the endpoint; an unrelated key now fails.

No confirmed network consumer of the secret-only privileged families was found in the searched cs_fixed JavaScript/TypeScript/JSON source. Matches for `/v1/camp` included an activity-parser comment; `/v1/features` included a test comment, not gateway calls. This is source evidence, not production traffic telemetry or proof against dynamically constructed URLs.

## L. Privileged-route review

Agent, infer, features, tools, memory, developer, camp, gpu-status, perf, and metrics all have outer secret-only middleware. The policy is fail-safe against camp/transformer-only access. Developer health/status/docs remain protected despite stale child-router comments saying public.

Six router files retain contradictory L guards: inference, features, tools, memory, developer, camp. Their 15 affected handlers are listed in C and fail ALLOW regressions. No reason to widen their privileges was established.

Protected handlers call engine methods, storage abstractions, and configured upstream providers. No self-call to an unprotected gateway alias was found. Audio interview analysis invokes BERT operations within its authorized audio handler; it does not traverse an unprotected BERT route. Engine/storage execution and upstream network services were deliberately not invoked by the tests.

## M. Logging/exposure review

**New exposure:** failure warnings use `req.originalUrl || req.url` and therefore record complete query credentials for 401, valid-but-wrong-purpose 403, and ignored query credentials when a conflicting Authorization header wins. All three non-disclosure regressions fail.

**Existing exposure:** `server.js:66` uses Morgan combined logging, recording query credentials even on successful authentication. Its non-disclosure regression fails too. Header-only failure controls did not expose the presented value, tested prefix/suffix, or SHA256 hash in access logs, auth/error logs, or response bodies. Structured-query conversion errors contain a generic conversion message, not the synthetic credential; the access logger still includes their URL.

Public `/` and `/v1` disclose service/version/route information, including a repository link and misleading blanket camp-auth guidance. Public `/health` exposes model identifiers/lists, provider configuration flags, external-AI policy, component availability, device CPU/CUDA, and video pipeline readiness through engine status functions and forwarded local-service health data. These fields were traced in `engine/careerbert.js:327`, `engine/llm.js:733-740`, `engine/vlm.js:273`, `engine/voice.js:377-379`, `engine/internet.js:187-190`, `_svd_src/svd_server.py:218-225`, and `talkinghead/talkinghead_server.py:201-202`.

No raw environment secret appears in those reviewed health return expressions. The unfiltered local-health data spread could expose future added fields. This is existing operational disclosure, not introduced by this commit. Public auth is intentional, but the amount of public health information needs an explicit decision.

No real `.env`, service logs, credential stores, or production error dumps were read.

## N. Claude-test quality assessment

The 26 focused tests pass but test the module with hand-built requests/responses, not actual route registration or imported router guards. They do not establish the complete real-route matrix, startup process behavior, logging safety, Node duplicate-header semantics, path matching, or alternate HTTP methods.

- The transformer-denied test labelled “chat/search/vision policy” uses a camp-only policy, whereas chat really allows secret and camp.
- The transformer-only test explicitly tests a hypothetical policy; it provides no real endpoint evidence.
- The original duplicate tests cover one equality pair, all missing, and distinct values, not the full configuration space.
- The original header tests check Authorization vs x-api-key but omit query conflict precedence and malformed/duplicate wire representations.
- Diagnostic and privileged tests instantiate a policy rather than loading the routes, so they cannot catch the contradictory inner guards.
- The original synchronous withEnv helper is adequate for its existing synchronous callbacks; it would restore environment state too early if reused for asynchronous integration tests.

The pre-existing 18-test independent file improves unit coverage but its “full” matrix omits actual secret+camp and includes hypothetical transformer-only. Its duplicate/empty-header tests largely simulate parsing. The Morgan PoC deliberately asserts that the key IS in the log: passing demonstrates a vulnerability, not safe logging. It claims to establish successful authentication without asserting the HTTP response status. Its control labelled Authorization/x-api-key only sends x-api-key.

## O. Additional Codex tests

- `test/gatewayAuth.codex-harness.cjs`: isolated VM environment; actual server registrations, installed Express/CORS/Morgan/parsers and real router guards; no dotenv or boot. Resource-consuming final handlers become sentinels; constructors/upstreams are inert stubs.
- `test/gatewayAuth.codex.test.js`: 55 tests, including 36 per-route ALLOW regressions, complete DENY transports, methods, path variants, conflicting/repeated real headers, partial/duplicate startup, comparison instrumentation, logging regressions, and cs_fixed key-resolution execution.
- `test/gatewayAuth.codex-results.tap`: complete final output, including 23 intentional failing security/availability regression checks.

The harness tests local HTTP parsing and actual middleware composition. It is not a GPU inference, storage integration, reverse-proxy, or live-cloud test. All writes/deletes in route-method probes terminate at authentication or in-memory sentinels.

## P. Complete test results

Runtime: Node **v24.14.1**, installed Express **4.22.2**, Morgan **1.11.0**. These are local installed versions, not verified cloud versions.

| File / test group | Tests | Passed | Failed |
|---|---:|---:|---:|
| Original `test/gatewayAuth.test.js` | 26 | 26 | 0 |
| Pre-existing `test/gatewayAuth.security.test.js` | 18 | 18 | 0 |
| New `test/gatewayAuth.codex.test.js` | 55 | 32 | 23 |
| Existing `core/responseCache.test.js` | 6 | 6 | 0 |
| **Total** | **105** | **82** | **23** |

Four test files/groups. The three Node test-runner files report **0 named suites**, 99 tests, 76 passes, 23 failures; cache uses a custom six-test runner. No skipped/cancelled/todo tests were reported by Node.

The 23 failures break down into 15 contradictory inner-guard ALLOW checks, 2 models-routing ALLOW checks, 4 log non-disclosure checks, 1 oversized-config startup check, and 1 malformed-query authentication-status check. These are assertions of desired behavior, not expected-failure annotations. All must be reviewed before calling the suite green.

Commands used (from careercamp-ai):

```powershell
node --test test/gatewayAuth.test.js test/gatewayAuth.security.test.js
node --test --test-reporter=tap --test-reporter-destination=test/gatewayAuth.codex-results.tap test/gatewayAuth.codex.test.js
node core/responseCache.test.js
git diff --check
```

## Q. Security findings by severity

### Critical

None demonstrated.

### High

**H1 — Credentials disclosed to logs.** New auth warning URL logging leaks even a valid privileged key submitted to a wrong-purpose route. Existing Morgan logging leaks successful query credentials. Anyone able to read those logs may replay the exposed credential with its full class permissions. This is not a finding that an unauthenticated HTTP caller can read the logs. References: `core/gatewayAuth.js:159-167`, `server.js:66`. Four failing regressions.

### Medium

**M1 — Contradictory authorization layers break 15 privileged handlers and allow conflicting headers to influence acceptance.** The exclusively permitted secret fails the surviving legacy checks; adding a second credential changes the result. References: `server.js:332-337`; `routes/inference.js:10`, `features.js:11`, `tools.js:10`, `memory.js:12`, `developer.js:11`, `camp.js:256`. This is an authorization integration/availability defect, not proven low-privilege escalation. Fifteen failing regressions plus an all-affected-routes conflict proof.

### Low

- **L1 — Unusable configuration passes startup.** Sole 513-character secret starts while no request can authenticate with it. `core/gatewayAuth.js:81-102,111-113`. One failing regression.
- **L2 — Structured query causes an authentication-path 500.** `String(fromQuery)` can throw for Express-parsed objects; generic request-level error handling catches it. No process crash/bypass demonstrated. `core/gatewayAuth.js:140`. One failing regression.
- **L3 — Public operational disclosure, pre-existing.** `/health` includes model inventories/provider flags/device/readiness. No raw secret established; narrow or explicitly accept this public contract.

### Informational

- **I1 — Pre-existing model-route availability defect.** Exact `app.get('/v1/models', ..., modelsRoute)` does not strip the mount prefix for the child router. Both model handlers return 404 in the current composition; model listing is a confirmed cs_fixed consumer. `server.js:260-263`, `api/models.js:17-25`. Two failing regressions.
- **I2 — Timing claim needs qualification.** Fixed-size digest comparison is sounder than raw variable-length comparison, but total classification time is not constant.
- **I3 — Public/child-route documentation and test names do not accurately describe effective auth.** No transformer-only route exists; developer child comments and `/v1` generic guidance are misleading.
- **I4 — Some historical cs_fixed fallback keys are incompatible with narrower policies.** Correct credential provisioning and source-confirmed consumer checks are required, not widened authorization.

## R. Required fixes

1. Remove credential-bearing URLs from auth warnings and sanitize request-target/query logging in Morgan. Review referrer/error paths while retaining generic auth diagnostics. Make all four non-disclosure regressions pass.
2. Reconcile legacy router guards with the centralized secret policy, preserving intended class restrictions and using one consistent presentation/classification result. Do not fix this by distributing multiple credentials or broadening internal permissions.
3. Validate configured credential lengths consistently with classification; reject malformed structured query credentials without throwing.
4. Resolve the model router mounting defect to substantiate legitimate model-discovery compatibility. It predates this commit but prevents the requested ALLOW verification.
5. Make an explicit decision on public health disclosure and document partial deployment readiness and real credential-class requirements.
6. Re-run the complete route/method/header/logging regressions after fixes; do not rely solely on `npm test`.

Per the review request, production fixes were **not implemented**. Only test/evidence/report artifacts were added.

## S. Exact SaladCloud pre-deployment checks

Code-only checklist for a human operator; SaladCloud was not accessed:

1. Confirm `CAREERCAMP_SECRET_KEY`, `CAREERCAMP_API_KEY`, and `CS_TRANSFORMER_API_KEY` are all configured in the gateway workload.
2. Confirm all are nonempty after trimming and mutually distinct **after trimming**, not merely visually different. Do not copy values to logs, tickets, shell history, or this report.
3. Confirm each effective credential is at most 512 JavaScript string characters and matches its intended consumer. Prefer provisioned high-entropy transport-safe values; the implementation does not enforce entropy.
4. Confirm backend-specific consumer overrides do not select a wrong-class or unrelated CSTM2/CS_MODEL credential. Camp consumers need camp on vision/BERT/search/show; audio needs the appropriate camp/transformer credential; model discovery needs the explicitly permitted secret/camp class.
5. Confirm a restart/replacement loads the new values: credentials are snapshotted at module initialization. No live hot-swap is implemented.
6. Confirm the artifact includes `core/gatewayAuth.js` and the intended reviewed/fixed commit, dependencies are installed, the existing Node >=20 requirement is met, and startup reaches readiness without a configuration FATAL. Record actual deployed runtime/parser versions for retesting.
7. Treat duplicate configuration as a startup failure and prepare rollback operationally. Changing only deployment configuration cannot fix the contradictory guards or logging defects in this commit.

New startup requirements from this commit: no duplicate trimmed nonblank gateway credential values; blank-after-trim values are ignored; the new module must load and Node crypto must generate a random key. It adds no new external service, package dependency, persistent key, or environment variable. Requiring all three for this deployment is stricter than its minimum-one code guard. The existing local duplicate condition was neither rediscovered nor inspected.

## T. Push/deployment recommendation

**B. DO NOT PUSH — SECURITY DEFECTS REQUIRE FIXES**.

Passing the original tests or checking cloud environment variables alone cannot clear H1/M1. No push or deployment was performed.

## U. Git safety

Production files and package metadata were not edited. No `.env` was read/changed, no secret was rotated, and no SaladCloud/Render operations occurred. No commits, pushes, resets, cleans, or dependency installations occurred.

Added only this report, the Codex harness/test file, and its TAP evidence. Preserved the initially untracked security test and the existing parent-workspace cs_fixed changes (autoqa reports/training-run data). `cs_fixed` was read only. Final tracked diff remains empty in the target repository; `git diff --check` passed.

## V. Warnings/errors and limits

- Initial shell tool startup was delayed; subsequent commands completed.
- Git warned it could not read the user's global ignore file; parent-workspace status also warned about a pytest-cache directory. Repository identity, HEAD, tracked diff, and target test execution were available; these warnings did not invalidate the review.
- Early discovery commands referenced nonexistent `tests`, root-level video-server files, and guessed camp-client paths. Correct source locations were subsequently found and inspected.
- Failing Codex regressions are expected evidence of unresolved defects. An initial control assertion accidentally included the known-leaking access-log sink; it was corrected to inspect only auth/error sinks. Final counts above use the completed 55-test run.
- The audit did not run the GPU-backed server, contact real upstreams, inspect real environment values, or test the cloud edge. Source-confirmed consumer compatibility is not a live deployment verification.

**CS-1 AUTH HARDENING REVIEW FOUND DEFECTS — FIX BEFORE PUSH**
