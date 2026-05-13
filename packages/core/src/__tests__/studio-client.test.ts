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
        /became unresponsive \(last poll \d+ms ago\)/
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

  test('non-local bridge (proxy) skips health check and delegates to sendRequest', async () => {
    // Simulate a proxy bridge by overriding isLocal to return false
    const proxyLikeBridge = new BridgeService();
    (proxyLikeBridge as any).isLocal = () => false;
    const proxyClient = new StudioHttpClient(proxyLikeBridge);

    // Empty bridge (no instances registered), but isLocal=false should skip the check
    jest.spyOn(proxyLikeBridge, 'sendRequest').mockResolvedValue({ result: 'forwarded' });

    await expect(proxyClient.request('/api/test', {})).resolves.toEqual({ result: 'forwarded' });
    expect(proxyLikeBridge.sendRequest).toHaveBeenCalledWith('/api/test', {}, 'edit');
  });

  test('Proxy request timeout error is also remapped to "handler timed out"', async () => {
    bridge.registerInstance('e1', 'edit');
    jest.spyOn(bridge, 'sendRequest').mockRejectedValue(new Error('Proxy request timeout'));

    await expect(client.request('/api/test', {})).rejects.toThrow(
      /handler timed out after 30s/
    );
  });
});
