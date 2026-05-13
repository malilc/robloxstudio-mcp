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
