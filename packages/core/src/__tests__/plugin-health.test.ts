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

  test('instance at exactly threshold (5s old) → STALE', () => {
    bridge.registerInstance('e1', 'edit');
    const inst = bridge.getInstances().find(i => i.role === 'edit')!;
    const baseNow = Date.now();
    inst.lastActivity = baseNow - RESPONSIVE_THRESHOLD_MS;
    const result = checkPluginHealth(bridge, 'edit', { now: baseNow });
    expect(result.status).toBe(PluginStatus.STALE);
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
    const clientRole = bridge.registerInstance('c1', 'client');
    const baseNow = Date.now();
    const staleInst = bridge.getInstances().find(i => i.role === clientRole)!;
    staleInst.lastActivity = baseNow - 10000;
    expect(hasAnyResponsivePlugin(bridge, { now: baseNow })).toBe(true);
  });
});

describe('RESPONSIVE_THRESHOLD_MS', () => {
  test('is 5000', () => {
    expect(RESPONSIVE_THRESHOLD_MS).toBe(5000);
  });
});
