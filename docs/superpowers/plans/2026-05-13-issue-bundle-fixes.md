# Issue Bundle Fixes (v2.7.1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix upstream issues #116, #103, #108, #109, #113 in the `malilc/robloxstudio-mcp` fork — release as v2.7.1. Server-side only; no plugin Lua changes required.

**Architecture:** Introduce a single `PluginHealth` module (`checkPluginHealth` for role-specific tool calls; `hasAnyResponsivePlugin` for global health). All "is the plugin connected?" decisions route through it so tool calls fast-fail with actionable messages instead of waiting 30s for a generic timeout. Separately, bump the inspector's SDK dependency (one-line fix for #116) and add a `REMOVED_TOOLS` mapping for friendly errors on tools that were intentionally removed (#113).

**Tech Stack:** TypeScript (ESM), Node.js, `@modelcontextprotocol/sdk` v1.27.1, Jest 29 + supertest for tests, npm workspaces monorepo.

**Reference spec:** `docs/superpowers/specs/2026-05-13-issue-bundle-fixes-design.md`

---

## Task Order Rationale

1. **Task 1 first** — independent SDK bump (#116). Lowest risk, validates build pipeline.
2. **Tasks 2-4 sequential** — `plugin-health.ts` (Task 2) is a dependency of `studio-client.ts` refactor (Task 3) and `http-server.ts` updates (Task 4).
3. **Tasks 5-6 sequential** — `removed-tools.ts` (Task 5) is a dependency of CallTool handler wiring (Task 6).
4. **Tasks 7-9** — docs, version bump, final verification.

---

## Task 1: Fix #116 — Bump Inspector SDK

**Files:**
- Modify: `packages/robloxstudio-mcp-inspector/package.json` line 40

- [ ] **Step 1.1: Edit package.json**

Edit `packages/robloxstudio-mcp-inspector/package.json`, change the SDK version:

```diff
 "dependencies": {
-    "@modelcontextprotocol/sdk": "^0.6.0",
+    "@modelcontextprotocol/sdk": "^1.27.1",
     "cors": "^2.8.5",
```

- [ ] **Step 1.2: Refresh lockfile**

Run: `npm install`
Expected: Updates `package-lock.json` without errors. Inspector now resolves to SDK v1.x.

- [ ] **Step 1.3: Build the inspector package**

Run: `npm run build -w packages/robloxstudio-mcp-inspector`
Expected: Builds successfully. Before this fix, it would either fail to type-check against core v1.x API or build but crash at runtime.

- [ ] **Step 1.4: Smoke-test inspector starts without crash**

Run (PowerShell): `node packages/robloxstudio-mcp-inspector/dist/index.js`
Expected: Process starts; logs "MCP server listening" or similar; does NOT crash with `-32000: Connection Closed`. Press Ctrl+C to stop after a few seconds.

If it crashes, the SDK bump didn't work. Stop and re-check Step 1.1 and `npm install` output.

- [ ] **Step 1.5: Commit**

```bash
git add packages/robloxstudio-mcp-inspector/package.json package-lock.json
git commit -m "fix(inspector): bump @modelcontextprotocol/sdk to ^1.27.1 (#116)

Inspector was pinned to ^0.6.0 while @robloxstudio-mcp/core was built
against SDK v1.x API, causing startup crash with -32000: Connection
Closed. Aligns inspector with the main package and root config."
```

---

## Task 2: Create `plugin-health.ts` (TDD)

**Files:**
- Create: `packages/core/src/plugin-health.ts`
- Create test: `packages/core/src/__tests__/plugin-health.test.ts`

- [ ] **Step 2.1: Write the failing test file**

Create `packages/core/src/__tests__/plugin-health.test.ts`:

```ts
import { BridgeService } from '../bridge-service.js';
import {
  checkPluginHealth,
  hasAnyResponsivePlugin,
  PluginStatus,
  RESPONSIVE_THRESHOLD_MS,
} from '../plugin-health.js';

describe('checkPluginHealth', () => {
  let bridge: BridgeService;

  beforeEach(() => {
    bridge = new BridgeService();
  });

  test('empty bridge → NOT_CONNECTED', () => {
    const result = checkPluginHealth(bridge, 'edit');
    expect(result.status).toBe(PluginStatus.NOT_CONNECTED);
  });

  test('instance with different role → NOT_CONNECTED', () => {
    bridge.registerInstance('c1', 'client');
    const result = checkPluginHealth(bridge, 'edit');
    expect(result.status).toBe(PluginStatus.NOT_CONNECTED);
  });

  test('fresh instance (lastActivity = now) → RESPONSIVE', () => {
    bridge.registerInstance('e1', 'edit');
    const result = checkPluginHealth(bridge, 'edit');
    expect(result.status).toBe(PluginStatus.RESPONSIVE);
    expect(result.instance?.role).toBe('edit');
  });

  test('instance just under threshold (4s old) → RESPONSIVE', () => {
    bridge.registerInstance('e1', 'edit');
    const inst = bridge.getInstances().find(i => i.role === 'edit')!;
    const baseNow = Date.now();
    inst.lastActivity = baseNow - 4000;
    const result = checkPluginHealth(bridge, 'edit', { now: baseNow });
    expect(result.status).toBe(PluginStatus.RESPONSIVE);
  });

  test('instance past threshold (6s old) → STALE with msSinceLastActivity', () => {
    bridge.registerInstance('e1', 'edit');
    const inst = bridge.getInstances().find(i => i.role === 'edit')!;
    const baseNow = Date.now();
    inst.lastActivity = baseNow - 6000;
    const result = checkPluginHealth(bridge, 'edit', { now: baseNow });
    expect(result.status).toBe(PluginStatus.STALE);
    expect(result.msSinceLastActivity).toBe(6000);
  });

  test('responsiveThresholdMs override changes boundary', () => {
    bridge.registerInstance('e1', 'edit');
    const inst = bridge.getInstances().find(i => i.role === 'edit')!;
    const baseNow = Date.now();
    inst.lastActivity = baseNow - 6000;
    const result = checkPluginHealth(bridge, 'edit', {
      now: baseNow,
      responsiveThresholdMs: 10000,
    });
    expect(result.status).toBe(PluginStatus.RESPONSIVE);
  });
});

describe('hasAnyResponsivePlugin', () => {
  let bridge: BridgeService;

  beforeEach(() => {
    bridge = new BridgeService();
  });

  test('empty bridge → false', () => {
    expect(hasAnyResponsivePlugin(bridge)).toBe(false);
  });

  test('one responsive instance (any role) → true', () => {
    bridge.registerInstance('c1', 'client');
    expect(hasAnyResponsivePlugin(bridge)).toBe(true);
  });

  test('only stale instance → false', () => {
    bridge.registerInstance('e1', 'edit');
    const inst = bridge.getInstances()[0];
    const baseNow = Date.now();
    inst.lastActivity = baseNow - 10000;
    expect(hasAnyResponsivePlugin(bridge, { now: baseNow })).toBe(false);
  });

  test('mixed: responsive edit + stale client → true', () => {
    bridge.registerInstance('e1', 'edit');
    bridge.registerInstance('c1', 'client');
    const baseNow = Date.now();
    const staleInst = bridge.getInstances().find(i => i.role === 'client-1')!;
    staleInst.lastActivity = baseNow - 10000;
    expect(hasAnyResponsivePlugin(bridge, { now: baseNow })).toBe(true);
  });
});

describe('RESPONSIVE_THRESHOLD_MS', () => {
  test('is 5000', () => {
    expect(RESPONSIVE_THRESHOLD_MS).toBe(5000);
  });
});
```

- [ ] **Step 2.2: Run the test, verify it fails**

Run: `npm test -w packages/core -- plugin-health`
Expected: All tests fail with "Cannot find module '../plugin-health.js'" or similar.

- [ ] **Step 2.3: Create the implementation file**

Create `packages/core/src/plugin-health.ts`:

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
  now?: number;
}

export function checkPluginHealth(
  bridge: BridgeService,
  role: string,
  opts?: HealthCheckOpts
): HealthCheckResult {
  const now = opts?.now ?? Date.now();
  const threshold = opts?.responsiveThresholdMs ?? RESPONSIVE_THRESHOLD_MS;

  const instance = bridge.getInstances().find(i => i.role === role);
  if (!instance) {
    return { status: PluginStatus.NOT_CONNECTED };
  }

  const msSinceLastActivity = now - instance.lastActivity;
  if (msSinceLastActivity >= threshold) {
    return {
      status: PluginStatus.STALE,
      instance,
      msSinceLastActivity,
    };
  }

  return {
    status: PluginStatus.RESPONSIVE,
    instance,
    msSinceLastActivity,
  };
}

export function hasAnyResponsivePlugin(
  bridge: BridgeService,
  opts?: HealthCheckOpts
): boolean {
  const now = opts?.now ?? Date.now();
  const threshold = opts?.responsiveThresholdMs ?? RESPONSIVE_THRESHOLD_MS;
  return bridge.getInstances().some(i => now - i.lastActivity < threshold);
}
```

- [ ] **Step 2.4: Run the test, verify it passes**

Run: `npm test -w packages/core -- plugin-health`
Expected: All ~11 tests pass.

If any fail, read the failure carefully — likely a boundary-condition bug (e.g., `>` vs `>=`). The spec says STALE when `msSinceLastActivity >= threshold` (i.e., 5000ms or older). The "just under" test uses 4000ms which is RESPONSIVE; the "past threshold" test uses 6000ms which is STALE.

- [ ] **Step 2.5: Commit**

```bash
git add packages/core/src/plugin-health.ts packages/core/src/__tests__/plugin-health.test.ts
git commit -m "feat(core): add PluginHealth module for connection state checks

New checkPluginHealth(role) returns NOT_CONNECTED/STALE/RESPONSIVE so
callers can fast-fail with actionable errors instead of waiting 30s for
a generic timeout. hasAnyResponsivePlugin(bridge) provides the
role-agnostic 'is anything alive?' check for /health and /status."
```

---

## Task 3: Refactor `studio-client.ts` (TDD)

**Files:**
- Create test: `packages/core/src/__tests__/studio-client.test.ts`
- Modify: `packages/core/src/tools/studio-client.ts`

- [ ] **Step 3.1: Write the failing tests**

Create `packages/core/src/__tests__/studio-client.test.ts`:

```ts
import { BridgeService } from '../bridge-service.js';
import { StudioHttpClient } from '../tools/studio-client.js';

describe('StudioHttpClient.request', () => {
  let bridge: BridgeService;
  let client: StudioHttpClient;

  beforeEach(() => {
    bridge = new BridgeService();
    client = new StudioHttpClient(bridge);
  });

  test('no plugin → throws "not connected" without queuing a request', async () => {
    await expect(client.request('/api/test', {})).rejects.toThrow(
      /Studio plugin not connected/
    );
    expect(bridge.getPendingRequestCount()).toBe(0);
  });

  test('stale plugin → throws "became unresponsive" without queuing', async () => {
    bridge.registerInstance('e1', 'edit');
    const inst = bridge.getInstances()[0];
    const realNow = Date.now();
    inst.lastActivity = realNow - 10000;

    const originalDateNow = Date.now;
    Date.now = jest.fn(() => realNow);

    try {
      await expect(client.request('/api/test', {})).rejects.toThrow(
        /became unresponsive/
      );
      expect(bridge.getPendingRequestCount()).toBe(0);
    } finally {
      Date.now = originalDateNow;
    }
  });

  test('responsive plugin + resolved request → returns response', async () => {
    bridge.registerInstance('e1', 'edit');

    const promise = client.request('/api/test', { foo: 'bar' });
    const pending = bridge.getPendingRequest('edit');
    expect(pending).not.toBeNull();
    bridge.resolveRequest(pending!.requestId, { result: 42 });

    await expect(promise).resolves.toEqual({ result: 42 });
  });

  test('responsive plugin + Request timeout → throws "handler timed out"', async () => {
    bridge.registerInstance('e1', 'edit');
    jest.spyOn(bridge, 'sendRequest').mockRejectedValue(new Error('Request timeout'));

    await expect(client.request('/api/test', {})).rejects.toThrow(
      /handler timed out after 30s/
    );
  });

  test('responsive plugin + other error → re-throws unchanged', async () => {
    bridge.registerInstance('e1', 'edit');
    jest.spyOn(bridge, 'sendRequest').mockRejectedValue(new Error('some other error'));

    await expect(client.request('/api/test', {})).rejects.toThrow('some other error');
  });
});
```

- [ ] **Step 3.2: Run the tests, verify they fail**

Run: `npm test -w packages/core -- studio-client`
Expected: Test "no plugin" times out after 30s (because current `studio-client.ts` queues the request and waits) — this is the old behavior we're fixing. Test "stale" same. Tests 3-5 may pass partially but the error messages will differ.

To avoid waiting 30s per failing test, you can pass `--testTimeout=2000` for this step:
`npm test -w packages/core -- studio-client --testTimeout=2000`
Expected: Tests fail with "Exceeded timeout" or wrong error messages.

- [ ] **Step 3.3: Modify `studio-client.ts`**

Replace the contents of `packages/core/src/tools/studio-client.ts`:

```ts
import { BridgeService } from '../bridge-service.js';
import { checkPluginHealth, PluginStatus } from '../plugin-health.js';

export class StudioHttpClient {
  private bridge: BridgeService;

  constructor(bridge: BridgeService) {
    this.bridge = bridge;
  }

  async request(endpoint: string, data: any, target = 'edit'): Promise<any> {
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
}
```

- [ ] **Step 3.4: Run the tests, verify they pass**

Run: `npm test -w packages/core -- studio-client`
Expected: All 5 tests pass quickly (no 30s waits anymore).

- [ ] **Step 3.5: Commit**

```bash
git add packages/core/src/tools/studio-client.ts packages/core/src/__tests__/studio-client.test.ts
git commit -m "fix(core): fast-fail tool calls when plugin is not responsive (#103 #108 #109)

StudioHttpClient.request now consults checkPluginHealth before queuing,
returning specific errors for NOT_CONNECTED, STALE, and handler timeouts
instead of a generic 30s 'Studio plugin connection timeout'."
```

---

## Task 4: Update `http-server.ts` Health Checks

**Files:**
- Modify: `packages/core/src/http-server.ts:136-138`
- Modify: `packages/core/src/__tests__/http-server.test.ts` (add 2 new test cases)

- [ ] **Step 4.1: Add failing test for stale-instance behavior**

Add this `test` inside the existing `describe('Plugin Connection Management', ...)` block in `packages/core/src/__tests__/http-server.test.ts` (insert after the existing "should detect stale instances" test):

```ts
test('should report pluginConnected=false when instance is stale (lastActivity old)', () => {
  bridge.registerInstance('stale-1', 'edit');
  expect(app.isPluginConnected()).toBe(true);

  // Make the instance look stale by stubbing Date.now
  const originalDateNow = Date.now;
  try {
    Date.now = jest.fn(() => originalDateNow() + 10000);
    expect(app.isPluginConnected()).toBe(false);
  } finally {
    Date.now = originalDateNow;
  }
});

test('/health should reflect stale state', async () => {
  await request(app).post('/ready').send({ instanceId: 'test-1', role: 'edit' }).expect(200);

  const originalDateNow = Date.now;
  try {
    Date.now = jest.fn(() => originalDateNow() + 10000);
    const response = await request(app).get('/health').expect(200);
    expect(response.body.pluginConnected).toBe(false);
  } finally {
    Date.now = originalDateNow;
  }
});
```

- [ ] **Step 4.2: Run the failing tests**

Run: `npm test -w packages/core -- http-server`
Expected: The two new tests fail. The "stale-instance" test fails because the current `isPluginConnected` returns true as long as the instance is in the map, regardless of activity. The "/health stale" test fails for the same reason.

- [ ] **Step 4.3: Replace `isPluginConnected` in `http-server.ts`**

In `packages/core/src/http-server.ts`, find this block (lines 136-138):

```ts
  const isPluginConnected = () => {
    return bridge.getInstances().length > 0;
  };
```

Replace with:

```ts
  const isPluginConnected = () => hasAnyResponsivePlugin(bridge);
```

Then add this import near the top (next to the existing `BridgeService` import, around line 13):

```ts
import { hasAnyResponsivePlugin } from './plugin-health.js';
```

- [ ] **Step 4.4: Run all http-server tests, verify they pass**

Run: `npm test -w packages/core -- http-server`
Expected: All tests pass, including the two new ones AND the existing "should handle plugin ready notification", "should detect stale instances" tests (those still work because `registerInstance` sets `lastActivity = Date.now()` and the assertions run immediately, so the instance is responsive).

- [ ] **Step 4.5: Commit**

```bash
git add packages/core/src/http-server.ts packages/core/src/__tests__/http-server.test.ts
git commit -m "fix(core): /health pluginConnected uses responsiveness, not just presence

isPluginConnected and /health/status endpoints now route through
hasAnyResponsivePlugin, so the green 'connected' state turns false
within 5s of the plugin going silent — was waiting up to 30s for
stale-instance cleanup. Fixes #109's false-positive 'connected' display."
```

---

## Task 5: Create `removed-tools.ts` (TDD)

**Files:**
- Create: `packages/core/src/removed-tools.ts`
- Create test: `packages/core/src/__tests__/removed-tools.test.ts`

- [ ] **Step 5.1: Write failing tests**

Create `packages/core/src/__tests__/removed-tools.test.ts`:

```ts
import { REMOVED_TOOLS } from '../removed-tools.js';

describe('REMOVED_TOOLS', () => {
  test('contains all tools removed in v2.7.0', () => {
    expect(Object.keys(REMOVED_TOOLS).sort()).toEqual(
      [
        'get_attribute',
        'get_script_analysis',
        'move_object',
        'rename_object',
        'upload_decal',
      ].sort()
    );
  });

  test('get_script_analysis explanation mentions Luau and grep_scripts', () => {
    const msg = REMOVED_TOOLS.get_script_analysis;
    expect(msg).toMatch(/v2\.7\.0/);
    expect(msg).toMatch(/Luau/);
    expect(msg).toMatch(/grep_scripts/);
  });

  test('upload_decal explanation points to upload_asset', () => {
    expect(REMOVED_TOOLS.upload_decal).toMatch(/upload_asset/);
  });

  test('move_object and rename_object explanations point to set_property', () => {
    expect(REMOVED_TOOLS.move_object).toMatch(/set_property/);
    expect(REMOVED_TOOLS.rename_object).toMatch(/set_property/);
  });

  test('get_attribute explanation points to get_attributes', () => {
    expect(REMOVED_TOOLS.get_attribute).toMatch(/get_attributes/);
  });

  test('unknown name returns undefined', () => {
    expect((REMOVED_TOOLS as Record<string, string | undefined>).never_existed).toBeUndefined();
  });
});
```

- [ ] **Step 5.2: Run the tests, verify they fail**

Run: `npm test -w packages/core -- removed-tools`
Expected: All tests fail with "Cannot find module '../removed-tools.js'".

- [ ] **Step 5.3: Create the implementation**

Create `packages/core/src/removed-tools.ts`:

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

- [ ] **Step 5.4: Run the tests, verify they pass**

Run: `npm test -w packages/core -- removed-tools`
Expected: All 6 tests pass.

- [ ] **Step 5.5: Commit**

```bash
git add packages/core/src/removed-tools.ts packages/core/src/__tests__/removed-tools.test.ts
git commit -m "feat(core): add REMOVED_TOOLS map with migration guidance

Maps tools removed in v2.7.0 (get_script_analysis, upload_decal,
move_object, rename_object, get_attribute) to explanation strings that
point at the replacement. Wired into the CallTool handler in a
follow-up commit (#113)."
```

---

## Task 6: Wire `REMOVED_TOOLS` Into Both CallTool Handlers

There are **two** CallTool dispatch paths that must both consult `REMOVED_TOOLS`:
1. `packages/core/src/http-server.ts:312-322` — Streamable HTTP `/mcp` endpoint (used by Claude Desktop, Cursor)
2. `packages/core/src/server.ts:61-71` — Stdio transport (used by `claude mcp add`, Codex CLI, Gemini CLI)

To avoid duplication, extract a shared `resolveToolHandler` helper that both call. Following the same spirit as commit `d319ba6` (which deduped via `TOOL_HANDLERS`).

**Files:**
- Modify: `packages/core/src/http-server.ts` (export helper + use it; add `REMOVED_TOOLS` import)
- Modify: `packages/core/src/server.ts:61-71` (use helper)
- Modify: `packages/core/src/__tests__/http-server.test.ts` (add helper tests)

- [ ] **Step 6.1: Write failing tests for the shared helper**

Add this `describe` block at the end of `packages/core/src/__tests__/http-server.test.ts`, just before the final closing `});` of the outer `describe('HTTP Server', ...)`:

```ts
  describe('resolveToolHandler', () => {
    test('returns handler for a known tool', () => {
      const handler = resolveToolHandler('get_place_info');
      expect(handler).toBeDefined();
      expect(typeof handler).toBe('function');
    });

    test('throws McpError with migration message for a removed tool', () => {
      let caught: McpError | undefined;
      try {
        resolveToolHandler('get_script_analysis');
      } catch (e) {
        caught = e as McpError;
      }
      expect(caught).toBeDefined();
      expect(caught!.code).toBe(ErrorCode.MethodNotFound);
      expect(caught!.message).toMatch(/removed in v2\.7\.0/);
      expect(caught!.message).toMatch(/grep_scripts/);
    });

    test('throws "Unknown tool" McpError for a genuinely unknown name', () => {
      let caught: McpError | undefined;
      try {
        resolveToolHandler('totally_fake_xyz');
      } catch (e) {
        caught = e as McpError;
      }
      expect(caught).toBeDefined();
      expect(caught!.code).toBe(ErrorCode.MethodNotFound);
      expect(caught!.message).toBe('Unknown tool: totally_fake_xyz');
    });

    test('respects allowedTools restriction (treats out-of-allowlist as unknown)', () => {
      const allowed = new Set(['get_place_info']);
      let caught: McpError | undefined;
      try {
        resolveToolHandler('get_services', allowed);
      } catch (e) {
        caught = e as McpError;
      }
      expect(caught).toBeDefined();
      expect(caught!.message).toBe('Unknown tool: get_services');
    });

    test('allowedTools restriction also surfaces removed-tool message', () => {
      const allowed = new Set(['get_place_info']);
      let caught: McpError | undefined;
      try {
        resolveToolHandler('get_script_analysis', allowed);
      } catch (e) {
        caught = e as McpError;
      }
      expect(caught).toBeDefined();
      expect(caught!.message).toMatch(/removed in v2\.7\.0/);
    });
  });
```

Then at the top of `packages/core/src/__tests__/http-server.test.ts`, add to the existing imports:

```ts
import { createHttpServer, resolveToolHandler } from '../http-server.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
```

(If `createHttpServer` is already imported alone, update the import line; if `McpError`/`ErrorCode` are not imported, add them.)

- [ ] **Step 6.2: Run the tests, verify they fail**

Run: `npm test -w packages/core -- http-server`
Expected: Tests fail with "resolveToolHandler is not exported" or "Cannot find name 'resolveToolHandler'".

- [ ] **Step 6.3: Add the shared helper to `http-server.ts`**

Open `packages/core/src/http-server.ts`. Add this import near the existing imports (around line 13-14):

```ts
import { REMOVED_TOOLS } from './removed-tools.js';
```

Then add this exported function right after the existing `TOOL_HANDLERS` constant declaration (around line 105, before `export function createHttpServer`):

```ts
export function resolveToolHandler(name: string, allowedTools?: Set<string>): ToolHandler {
  if (allowedTools && !allowedTools.has(name)) {
    const removed = REMOVED_TOOLS[name];
    if (removed) throw new McpError(ErrorCode.MethodNotFound, removed);
    throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
  }
  const handler = TOOL_HANDLERS[name];
  if (!handler) {
    const removed = REMOVED_TOOLS[name];
    if (removed) throw new McpError(ErrorCode.MethodNotFound, removed);
    throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
  }
  return handler;
}
```

- [ ] **Step 6.4: Replace the inline CallTool dispatch in `http-server.ts`**

In `packages/core/src/http-server.ts`, find the `CallToolRequestSchema` handler (around lines 312-322):

```ts
        server.setRequestHandler(CallToolRequestSchema, async (request) => {
          const { name, arguments: args } = request.params;

          if (allowedTools && !allowedTools.has(name)) {
            throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
          }
          const handler = TOOL_HANDLERS[name];
          if (!handler) {
            throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
          }
```

Replace with:

```ts
        server.setRequestHandler(CallToolRequestSchema, async (request) => {
          const { name, arguments: args } = request.params;
          const handler = resolveToolHandler(name, allowedTools);
```

- [ ] **Step 6.5: Replace the inline CallTool dispatch in `server.ts`**

In `packages/core/src/server.ts`, find the `CallToolRequestSchema` handler (around lines 61-71):

```ts
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      if (!this.allowedToolNames.has(name)) {
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
      }

      const handler = TOOL_HANDLERS[name];
      if (!handler) {
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
      }
```

Replace with:

```ts
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const handler = resolveToolHandler(name, this.allowedToolNames);
```

Then update the import at the top of `server.ts` (line 10) from:

```ts
import { createHttpServer, listenWithRetry, TOOL_HANDLERS } from './http-server.js';
```

to:

```ts
import { createHttpServer, listenWithRetry, resolveToolHandler, TOOL_HANDLERS } from './http-server.js';
```

(Keep `TOOL_HANDLERS` in the import — it's still used elsewhere in `server.ts` even if not in the CallTool handler.)

- [ ] **Step 6.6: Run the full core test suite, verify it passes**

Run: `npm test -w packages/core`
Expected: All tests pass, including the new `resolveToolHandler` cases. Existing tests should be unaffected.

- [ ] **Step 6.7: Commit**

```bash
git add packages/core/src/http-server.ts packages/core/src/server.ts packages/core/src/__tests__/http-server.test.ts
git commit -m "fix(core): return migration guidance for removed tools (#113)

Extract shared resolveToolHandler that consults REMOVED_TOOLS before
falling back to 'Unknown tool: X'. Used by both the streamable HTTP
/mcp CallTool handler and the stdio CallTool handler in
RobloxStudioMCPServer, so LLMs see explanations like 'get_script_analysis
was removed in v2.7.0... use grep_scripts' regardless of transport."
```

---

## Task 7: Update README Error Semantics Note

**Files:**
- Modify: `README.md` (append a short note near the "Setup" section or after the troubleshooting block)

- [ ] **Step 7.1: Read current README troubleshooting context**

Run: `Read README.md` and locate a sensible place to add a short note. The current README is concise — a short "Connection states" subsection under Setup makes sense.

- [ ] **Step 7.2: Append a short error-semantics note**

Edit `README.md` — find the section right after "Plugin shows 'Connected' when ready." (around line 34) and insert this paragraph:

```markdown
**If tool calls fail:** the server returns specific errors so you can act on them — `Studio plugin not connected` (open Studio & enable HTTP), `Studio plugin became unresponsive` (Studio may be frozen — reactivate the plugin), or `Studio plugin handler timed out` (operation too large — try a narrower scope).
```

- [ ] **Step 7.3: Commit**

```bash
git add README.md
git commit -m "docs(readme): document new tool-call error semantics for v2.7.1"
```

---

## Task 8: Bump Version to v2.7.1

**Files:**
- Modify: `package.json` (root) version
- Modify: `packages/core/package.json` version
- Modify: `packages/robloxstudio-mcp/package.json` version
- Modify: `packages/robloxstudio-mcp-inspector/package.json` version
- Modify: `README.md` version line (around line 126 — `<!-- VERSION_LINE -->`)

- [ ] **Step 8.1: Update all four package.json files**

In each of:
- `package.json` (line 3)
- `packages/core/package.json` (line 3)
- `packages/robloxstudio-mcp/package.json` (line 3)
- `packages/robloxstudio-mcp-inspector/package.json` (line 3)

Change `"version": "2.7.0"` to `"version": "2.7.1"`.

- [ ] **Step 8.2: Update README version line**

In `README.md`, find:

```markdown
<!-- VERSION_LINE -->**v2.7.0-next.6** - 43 tools, inspector edition, monorepo architecture
```

Change to:

```markdown
<!-- VERSION_LINE -->**v2.7.1** - 43 tools, inspector edition, monorepo architecture
```

- [ ] **Step 8.3: Refresh lockfile**

Run: `npm install`
Expected: Updates `package-lock.json` with the new versions, no errors.

- [ ] **Step 8.4: Commit**

```bash
git add package.json packages/core/package.json packages/robloxstudio-mcp/package.json packages/robloxstudio-mcp-inspector/package.json README.md package-lock.json
git commit -m "chore: bump version to 2.7.1

- fix #116: inspector startup crash from SDK version mismatch
- fix #103, #108: 'connection timeout' no longer hangs 30s when plugin
  is not running — fails immediately with clear message
- fix #109: false-positive 'connected' status when plugin becomes
  unresponsive — fast-fails after 5s of no activity
- fix #113: removed tools return migration guidance instead of generic
  'Unknown tool' error"
```

---

## Task 9: Final Verification

No file changes — just running gates. If any step fails, stop and investigate root cause (do NOT skip).

- [ ] **Step 9.1: Build all packages**

Run: `npm run build`
Expected: Builds `@robloxstudio-mcp/core`, then `robloxstudio-mcp`, then `robloxstudio-mcp-inspector` without errors.

- [ ] **Step 9.2: Typecheck**

Run: `npm run typecheck`
Expected: No TypeScript errors.

- [ ] **Step 9.3: Lint**

Run: `npm run lint`
Expected: No ESLint errors.

- [ ] **Step 9.4: Full test suite**

Run: `npm test`
Expected: All tests pass. New count: existing tests + ~11 (plugin-health) + 5 (studio-client) + 6 (removed-tools) + 7 (http-server additions: 2 stale-instance + 5 resolveToolHandler).

- [ ] **Step 9.5: Inspector smoke test**

Run (PowerShell): `node packages/robloxstudio-mcp-inspector/dist/index.js`
Expected: Starts; does not crash with `-32000`. Stop with Ctrl+C after confirming.

- [ ] **Step 9.6: Main server smoke test**

Run (PowerShell, in one terminal): `npm run dev`
Expected: Server starts on port 3000 (or whichever default), logs listening message.

Run (in another terminal): `curl http://localhost:3000/health`
Expected: JSON response with `"status":"ok"`, `"pluginConnected":false`, `"version":"2.7.1"`.

Stop the server with Ctrl+C.

- [ ] **Step 9.7: Manual Studio smoke (optional — recommend before PR/release)**

This step requires Roblox Studio installed with the plugin loaded. It is the final gate before merging/releasing, but is out of scope if you don't have Studio available now — note that the PR description should call this out for the reviewer.

Steps if you do have Studio:
1. Start `npm run dev`
2. Open Roblox Studio with the MCP plugin installed
3. Verify plugin shows "Connected"
4. From an MCP client, call `get_place_info` — expect success
5. Disable the plugin (or close Studio); within 5s, call `get_place_info` again — expect the new `Studio plugin became unresponsive` error (NOT the old 30s timeout)
6. Re-enable plugin → tool calls work again

---

## Spec Coverage Self-Review Checklist (after completing all tasks)

- [ ] #116 SDK bump verified — inspector starts without crash (Steps 1.4, 9.5)
- [ ] #103/#108 — NOT_CONNECTED fast-fail covered by studio-client.test.ts (Step 3.1)
- [ ] #109 — STALE detection + /health responsiveness covered (Steps 3.1, 4.1)
- [ ] Handler timeout (slow operations) covered (Step 3.1)
- [ ] #113 — REMOVED_TOOLS friendly errors covered for **both** transports (HTTP `/mcp` and stdio) via shared `resolveToolHandler` (Steps 5.1, 6.1, 6.5)
- [ ] All five removed tools listed in REMOVED_TOOLS (Step 5.3)
- [ ] Backwards-compatibility: HTTP protocol and plugin Lua unchanged (no Task touches them)
- [ ] Version bumped (Task 8)
- [ ] README documents new error semantics (Task 7)
- [ ] Lint + typecheck + test pass (Task 9)

---

## Files Touched Summary

**Created:**
- `packages/core/src/plugin-health.ts`
- `packages/core/src/removed-tools.ts`
- `packages/core/src/__tests__/plugin-health.test.ts`
- `packages/core/src/__tests__/studio-client.test.ts`
- `packages/core/src/__tests__/removed-tools.test.ts`

**Modified:**
- `packages/core/src/tools/studio-client.ts`
- `packages/core/src/http-server.ts`
- `packages/core/src/server.ts`
- `packages/core/src/__tests__/http-server.test.ts`
- `packages/robloxstudio-mcp-inspector/package.json`
- `package.json` (root)
- `packages/core/package.json`
- `packages/robloxstudio-mcp/package.json`
- `README.md`
- `package-lock.json`

**Not touched (verifies non-goal):**
- `studio-plugin/**` (no plugin Lua changes)
- HTTP protocol surface (`/poll`, `/ready`, `/response`, `/proxy`)
- `BridgeService` public methods
