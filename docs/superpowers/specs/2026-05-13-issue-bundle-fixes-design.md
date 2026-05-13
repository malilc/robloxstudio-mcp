# Issue Bundle Fixes — Design Spec

**Date:** 2026-05-13
**Target version:** v2.7.1
**Scope:** 4 GitHub issues from upstream `boshyxd/robloxstudio-mcp` (currently unmaintained), fixed in the `malilc/robloxstudio-mcp` fork.

## Issues Addressed

| # | Title | Type |
|---|---|---|
| 116 | `robloxstudio-mcp-inspector` fails with -32000: Connection Closed — SDK version mismatch | Real bug, verified in code |
| 103 | MCP error -32603 ("Studio plugin connection timeout") on `get_place_info`, `get_services` | Recurring user pain |
| 108 | MCP not usable in Codex — same `-32603` connection timeout on `get_project_structure` | Same root cause as #103 |
| 109 | Codex usage very buggy — fails 80% of the time but shows "Connected" in green | False-positive health check, same root cause |
| 113 | `get_script_analysis` endpoint missing in plugin routeMap | Outdated — tool intentionally removed; needs better UX |

Out of scope (deferred): #114 (Windows npx ENOENT, insufficient info), #115 (insufficient info), #105 (insufficient info), #110/#100/#101 (feature requests).

## Goals

- Inspector package starts without crashing.
- Tool calls fast-fail with actionable error messages when the Studio plugin is not connected or has become unresponsive, instead of waiting 30s for a generic timeout.
- The `pluginConnected` signal in `/health`, `/status`, and internal checks reflects actual responsiveness, not just registry presence.
- Calls to known-removed tools return an explanation with the migration path instead of a generic "Unknown tool" error.

## Non-Goals

- No changes to the Roblox Studio plugin (Lua) code or the HTTP protocol between server and plugin. The fix is server-side only; plugin redeployment is not required.
- No retry logic inside `StudioHttpClient` — let the caller / LLM decide.
- No active probe of plugin health — keep the passive model (plugin updates `lastActivity` when it polls).
- No general refactor of `BridgeService` beyond what these issues require.

## Architecture Overview

A single new concept — `PluginHealth` — sits between `BridgeService` (raw state) and all consumers that ask "is the plugin connected?".

```
┌─────────────────┐    poll/ready      ┌──────────────┐
│ Roblox Plugin   │  ─────────────────▶│  /poll route │
│  (Studio Lua)   │  ◀──────responses──│  /response   │
└─────────────────┘                    └──────┬───────┘
                                              │ updates
                                              ▼
                                       ┌──────────────────┐
                                       │  BridgeService   │
                                       │  - instances     │
                                       │  - lastActivity  │
                                       └──────┬───────────┘
                                              │ queried by
                            ┌─────────────────┼─────────────────┐
                            ▼                 ▼                 ▼
                      ┌──────────┐    ┌─────────────┐    ┌──────────┐
                      │ /health  │    │StudioClient │    │ /status  │
                      │          │    │  .request() │    │          │
                      └──────────┘    └─────────────┘    └──────────┘
                              │              │                │
                              └──────────────┴────────────────┘
                                       all use
                                  ┌──────────────────────┐
                                  │  checkPluginHealth   │  ← NEW
                                  │  (bridge, role,opts) │
                                  │  → HealthCheckResult │
                                  └──────────────────────┘
```

`checkPluginHealth` returns one of three statuses:

- `NOT_CONNECTED` — no instance matches the requested role.
- `STALE` — instance exists, but `Date.now() - lastActivity > RESPONSIVE_THRESHOLD_MS` (5s default).
- `RESPONSIVE` — instance exists and polled recently.

Every "is the plugin connected?" check across the codebase routes through this function. Two existing thresholds remain separate:

- `STALE_INSTANCE_MS = 30000` (in `BridgeService`) — housekeeping; cleans up instances eventually so the map doesn't leak.
- `RESPONSIVE_THRESHOLD_MS = 5000` (new, in `plugin-health.ts`) — UX; declares an instance unresponsive for tool-call purposes much sooner than cleanup.

Why split: an instance can stay in the map for up to 30s after a network blip (so it can resume cleanly if the plugin comes back), while tool calls during the blip fail immediately with a clear message.

## Components

| File | Action | Responsibility |
|---|---|---|
| `packages/core/src/plugin-health.ts` | new | Exports `PluginStatus` enum, `RESPONSIVE_THRESHOLD_MS`, `HealthCheckResult` interface, `checkPluginHealth(bridge, role, opts?)` |
| `packages/core/src/tools/studio-client.ts` | edit | Calls `checkPluginHealth` before `bridge.sendRequest`; maps each status to a specific error message |
| `packages/core/src/http-server.ts` | edit | `/health`, `/status`, internal `isPluginConnected()` use `checkPluginHealth`; CallTool handler consults `REMOVED_TOOLS` for `MethodNotFound` cases |
| `packages/core/src/removed-tools.ts` | new | `Record<string, string>` mapping removed tool name → explanation + alternative |
| `packages/core/src/bridge-service.ts` | minor edit | Keep `STALE_INSTANCE_MS` (no semantic change). No changes to public methods. |
| `packages/robloxstudio-mcp-inspector/package.json` | edit | Bump `@modelcontextprotocol/sdk` from `^0.6.0` to `^1.27.1` (fixes #116) |
| `packages/core/src/__tests__/plugin-health.test.ts` | new | Unit tests for all three statuses + threshold boundary |
| `packages/core/src/__tests__/studio-client.test.ts` | new | Unit tests for fast-fail behavior and error mapping |
| `packages/core/src/__tests__/removed-tools.test.ts` | new | Unit tests for mapping lookup |
| `packages/core/src/__tests__/http-server.test.ts` | edit | Update existing health-related tests; add CallTool removed-tool case |

### Contracts

**`plugin-health.ts`**

```ts
import type { BridgeService, PluginInstance } from './bridge-service.js';

export enum PluginStatus {
  NOT_CONNECTED = 'NOT_CONNECTED',
  STALE = 'STALE',
  RESPONSIVE = 'RESPONSIVE',
}

export const RESPONSIVE_THRESHOLD_MS = 5000;

export interface HealthCheckResult {
  status: PluginStatus;
  instance?: PluginInstance;
  msSinceLastActivity?: number;
}

export interface HealthCheckOpts {
  responsiveThresholdMs?: number;
  now?: number;  // for tests; defaults to Date.now()
}

export function checkPluginHealth(
  bridge: BridgeService,
  role: string,
  opts?: HealthCheckOpts
): HealthCheckResult;

// Helper for "any plugin responsive?" checks (used by /health, /status,
// isPluginConnected) — role-agnostic so it covers edit/server/client roles
// the same way the original `getInstances().length > 0` check did.
export function hasAnyResponsivePlugin(
  bridge: BridgeService,
  opts?: HealthCheckOpts
): boolean;
```

**`studio-client.ts`** (after edit)

```ts
async request(endpoint: string, data: any, target = 'edit') {
  const health = checkPluginHealth(this.bridge, target);

  if (health.status === PluginStatus.NOT_CONNECTED) {
    throw new Error(
      'Studio plugin not connected. Open Roblox Studio and ensure the MCP plugin shows "Connected" in the toolbar (enable HTTP requests in Game Settings > Security if needed).'
    );
  }
  if (health.status === PluginStatus.STALE) {
    throw new Error(
      `Studio plugin became unresponsive (last poll ${health.msSinceLastActivity}ms ago). Verify Studio is not frozen, check the plugin toolbar status, and try reactivating the plugin.`
    );
  }

  try {
    return await this.bridge.sendRequest(endpoint, data, target);
  } catch (error) {
    if (error instanceof Error && error.message === 'Request timeout') {
      throw new Error(
        `Studio plugin handler timed out after 30s on endpoint "${endpoint}". The operation may be too large or Studio is processing. Try a narrower scope (e.g., specific path instead of full tree).`
      );
    }
    throw error;
  }
}
```

**`removed-tools.ts`**

```ts
export const REMOVED_TOOLS: Record<string, string> = {
  get_script_analysis:
    'get_script_analysis was removed in v2.7.0. It used loadstring which parses Lua 5.1 and reported Luau-only syntax (type annotations, continue, etc.) as compile errors. Use grep_scripts to find syntactic patterns instead, or rely on Studio\'s built-in Script Analysis pane.',
  upload_decal:
    'upload_decal was removed in v2.7.0. Use upload_asset with assetType: "Decal" which supports both cookie and Open Cloud auth.',
  move_object:
    'move_object was removed in v2.7.0. Use set_property with propertyName: "Parent" instead.',
  rename_object:
    'rename_object was removed in v2.7.0. Use set_property with propertyName: "Name" instead.',
  get_attribute:
    'get_attribute (single) was removed in v2.7.0. Use get_attributes which returns the full attribute map.',
};
```

**`http-server.ts` CallTool handler** (`/mcp` route):

```ts
const handler = TOOL_HANDLERS[name];
if (!handler) {
  const removed = REMOVED_TOOLS[name];
  if (removed) throw new McpError(ErrorCode.MethodNotFound, removed);
  throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
}
```

**`http-server.ts` `isPluginConnected`** (replace existing one-liner):

```ts
const isPluginConnected = () => hasAnyResponsivePlugin(bridge);
```

`/health` and `/status` endpoints continue to populate the same JSON fields; only the semantic of `pluginConnected` changes — it now returns false once *all* plugin instances have been silent for `RESPONSIVE_THRESHOLD_MS`, instead of waiting up to 30s for the instance to be cleaned out of the map. This preserves the role-agnostic behavior of the original check (`getInstances().length > 0`) while reflecting actual responsiveness.

`checkPluginHealth(bridge, role)` is used by `StudioHttpClient.request()` for role-specific tool-call decisions (e.g., dispatch to `edit` vs `server` vs `client-N`); `hasAnyResponsivePlugin(bridge)` is used by the global health/status checks that don't care about a specific role.

## Data Flow / Key Sequences

### Sequence 1: Plugin never connected
```
StudioHttpClient.request → checkPluginHealth → NOT_CONNECTED → throw immediately
```
**Before fix:** wait 30s for bridge timeout, get "Studio plugin connection timeout".
**After fix:** fail in <10ms, clear actionable message. (Covers #103/#108 when plugin not running.)

### Sequence 2: Plugin was connected, became unresponsive
```
T=0-10s  plugin polls regularly; lastActivity is updated on each poll
T=10s    last successful poll. Studio then freezes; no further polls happen.
         lastActivity is frozen at 10000.
T=16s    tool call → checkPluginHealth(now=16000)
         msSinceLastActivity = 6000 > RESPONSIVE_THRESHOLD_MS (5000) → STALE
         → throw "Studio plugin became unresponsive (last poll 6000ms ago)..."
```
**Before fix:** 30s bridge timeout, generic "connection timeout" message, UI still shows green "connected" for the whole 30s window.
**After fix:** Tool call fast-fails roughly 5s after the plugin stops polling, with an accurate "became unresponsive" message. (Covers #109.)

### Sequence 3: Happy path
```
T=0     plugin polls → lastActivity = T0
T=1s    plugin polls → lastActivity = T1
T=2s    tool call → checkPluginHealth → RESPONSIVE
        → bridge.sendRequest → plugin processes → response
```
No change in behavior.

### Sequence 4: Plugin healthy but handler is slow (Studio busy, large query)
```
T=0     checkPluginHealth → RESPONSIVE
        bridge.sendRequest queued
T=0-30s plugin keeps polling (lastActivity updates), but the operation it picked up takes >30s
T=30s   bridge timeout → reject Promise with 'Request timeout'
        → StudioHttpClient throws "Studio plugin handler timed out after 30s on endpoint ..."
```
**Before fix:** "Studio plugin connection timeout" — misleads user into thinking plugin disconnected.
**After fix:** "handler timed out" + suggestion to narrow scope — user understands plugin is fine, operation was too big.

### Sequence 5: Removed tool called
```
LLM tries get_script_analysis (from stale context or user prompt)
  /mcp CallTool → TOOL_HANDLERS.get_script_analysis is undefined
  → REMOVED_TOOLS['get_script_analysis'] exists
  → throw McpError(MethodNotFound, '<removed in v2.7.0... use grep_scripts>')
```
LLM reads the message and pivots to the suggested alternative.

## Error Matrix

| Situation | Status | Error message | MCP code |
|---|---|---|---|
| Plugin never connected | `NOT_CONNECTED` | `Studio plugin not connected. Open Roblox Studio and ensure the MCP plugin shows "Connected" in the toolbar (enable HTTP requests in Game Settings > Security if needed).` | `InternalError` |
| Plugin stale > 5s | `STALE` | `Studio plugin became unresponsive (last poll {N}ms ago). Verify Studio is not frozen, check the plugin toolbar status, and try reactivating the plugin.` | `InternalError` |
| Plugin healthy, handler > 30s | (healthy + bridge timeout) | `Studio plugin handler timed out after 30s on endpoint "{endpoint}". The operation may be too large or Studio is processing. Try a narrower scope (e.g., specific path instead of full tree).` | `InternalError` |
| Removed tool called | (REMOVED_TOOLS hit) | Message from `REMOVED_TOOLS` with alternative | `MethodNotFound` |
| Genuinely unknown tool | (no handler, no REMOVED_TOOLS) | `Unknown tool: {name}` | `MethodNotFound` |
| Inspector SDK crash (#116) | n/a | Fixed at root (SDK bump). No new error. | — |

## Testing Strategy

### Test inventory

| File | Action | Approx count | Purpose |
|---|---|---|---|
| `plugin-health.test.ts` | new | ~10 | `checkPluginHealth` (6 cases) + `hasAnyResponsivePlugin` (4 cases) |
| `studio-client.test.ts` | new | ~5 | fast-fail behavior, error message mapping |
| `removed-tools.test.ts` | new | ~2 | mapping lookup correctness |
| `http-server.test.ts` | edit | ~3 cases | `/health`, `/status` semantic; CallTool removed-tool path |
| `bridge-service` smoke | unchanged | — | passes unmodified |
| Integration tests | unchanged | — | pass unmodified |

### Key test scenarios

**`plugin-health.test.ts`:**

`checkPluginHealth`:
- Empty bridge → `NOT_CONNECTED`
- Instance role mismatch (e.g., only `client-1` exists, query for `edit`) → `NOT_CONNECTED`
- Instance present, lastActivity = `now` → `RESPONSIVE`
- Instance present, lastActivity = `now - 4000` → `RESPONSIVE` (boundary)
- Instance present, lastActivity = `now - 6000` → `STALE`, `msSinceLastActivity ≈ 6000`
- `responsiveThresholdMs` override works

`hasAnyResponsivePlugin`:
- Empty bridge → `false`
- One responsive instance (any role) → `true`
- One stale instance only → `false`
- Mixed: one responsive `edit` + one stale `client-1` → `true`

**`studio-client.test.ts`** (mock bridge):
- Empty bridge → throws "not connected" error, never calls `sendRequest`
- Stale bridge → throws "became unresponsive", never calls `sendRequest`
- Responsive bridge + `sendRequest` resolves → returns result
- Responsive bridge + `sendRequest` rejects 'Request timeout' → throws "handler timed out"
- Responsive bridge + `sendRequest` rejects other error → re-throws as-is

**`http-server.test.ts` (additions):**
- `/health`: instance present with stale `lastActivity` → `pluginConnected: false` (new behavior)
- `/status`: same as above
- POST `/mcp` CallTool `get_script_analysis` → error contains "removed in v2.7.0" and "grep_scripts"
- POST `/mcp` CallTool `totally_fake` → still returns `Unknown tool: totally_fake`

### Time injection

`checkPluginHealth` accepts `opts.now` to simulate elapsed time without sleeping:
```ts
checkPluginHealth(bridge, role, { now: Date.now() + 10000 });
```
Production callers never pass `now` — it defaults to `Date.now()`. This avoids refactoring `BridgeService` to inject a clock interface (over-engineering for this scope).

### Manual verification before marking complete

1. `npm run build` (all packages) — pass
2. `npm run typecheck` — pass
3. `npm run lint` — pass
4. `npm test` — pass
5. Inspector smoke: `node packages/robloxstudio-mcp-inspector/dist/index.js` starts without `-32000 Connection Closed` crash (validates #116)
6. Main server smoke: `npm run dev` starts; `GET /health` returns valid JSON

Out of scope for this work: live testing against Roblox Studio with plugin loaded. That's a separate manual gate before merging the PR — to be noted in the PR description.

### Known coverage gaps

- Plugin Lua behavior is unchanged but if the assumption about poll cadence is wrong, `RESPONSIVE_THRESHOLD_MS = 5000` could be too tight. Mitigation: it's an exported constant, easy to tune if real-world telemetry shows otherwise.
- Race window between `cleanupStaleInstances` (30s) and `checkPluginHealth` STALE detection (5s): a 25s window where the instance is in the map but flagged unresponsive. This is intended — tool calls fail fast, but the instance is still recoverable if the plugin resumes polling.

## Backward Compatibility

| Surface | Type | Impact | Notes |
|---|---|---|---|
| `BridgeService` class API | internal | none | additive only |
| `StudioHttpClient.request()` signature | internal | none | same signature, error path differs |
| HTTP protocol (`/poll`, `/ready`, `/response`, `/proxy`, `/mcp`) | public | none | unchanged |
| `/health` JSON shape | external | semantic change | `pluginConnected: false` now fires after 5s of staleness instead of 30s — strictly better |
| `/status` JSON shape | external | semantic change | same as above |
| MCP tool error messages | public (visible to LLM clients) | message strings differ | error messages aren't a contract; new ones are more actionable |
| Plugin (Lua) protocol | public | none | zero plugin redeployment |
| npm package names / versions | public | bump | v2.7.0 → v2.7.1 |

**Verdict:** Backwards-compatible at the protocol level. Existing plugins and MCP clients continue to work; behavior strictly improves.

## Rollout

### Commit sequence

1. Bump inspector SDK to `^1.27.1` (fixes #116) — isolated 1-line change
2. Add `plugin-health.ts` + tests
3. Refactor `studio-client.ts` + tests
4. Update `http-server.ts` `/health`, `/status`, `isPluginConnected`
5. Add `removed-tools.ts` + tests + wire into CallTool handler
6. Update README error-semantics note
7. Bump root + package versions to v2.7.1

### Versioning

v2.7.0 → **v2.7.1** (patch). No breaking API change; behavioral improvements only.

### Release notes draft

```
v2.7.1

Bug fixes:
- Fix #116: inspector startup crash from SDK version mismatch
  (bumped @modelcontextprotocol/sdk from ^0.6.0 to ^1.27.1)
- Fix #103, #108: "Studio plugin connection timeout" no longer hangs
  for 30s when plugin is not running — fails immediately with clear message
- Fix #109: false-positive "connected" status when plugin becomes
  unresponsive — tool calls now fast-fail after 5s of no plugin activity
- Fix #113: removed tools (get_script_analysis, upload_decal, move_object,
  rename_object, get_attribute) now return explanatory errors with
  suggested alternatives instead of generic "Unknown tool"
```

### Upstream issue communication

Out of scope for this design. Maintainer of `boshyxd/robloxstudio-mcp` is inactive; deciding whether to PR upstream, comment on issues from the fork, or just publish under the fork name is left to the user post-implementation.

### Rollback strategy

- Each commit is independent and revertable.
- `studio-client.ts` refactor (commit 3) contains the fast-fail behavior — revert that single commit to undo the runtime behavior change without losing #116 / #113 fixes.
- Inspector SDK bump (#116) is a single-line change, revertable on its own.
- `removed-tools.ts` (#113) doesn't touch the runtime hot path — revert-free.
