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
        `Studio plugin became unresponsive (last poll ${health.msSinceLastActivity!}ms ago). Verify Studio is not frozen, check the plugin toolbar status, and try reactivating the plugin.`
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