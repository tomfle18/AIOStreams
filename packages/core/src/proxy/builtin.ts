import { BaseProxy, ProxyStream } from './base.js';
import {
  createLogger,
  maskSensitiveInfo,
  Env,
  makeRequest,
  encryptString,
  decryptString,
  Cache,
} from '../utils/index.js';
import path from 'path';

const logger = createLogger('builtin');

const cache = Cache.getInstance<string, string>('publicIp');

export class BuiltinProxy extends BaseProxy {
  public static validateAuth(auth: string): {
    username: string;
    password: string;
    admin: boolean;
  } {
    const [username, password] = auth.split(':');
    if (!username || !password) {
      throw new Error('Invalid credentials');
    }

    if (
      Env.AIOSTREAMS_AUTH?.has(username) &&
      Env.AIOSTREAMS_AUTH?.get(username) !== password
    ) {
      throw new Error('Invalid credentials');
    }

    return {
      username,
      password,
      admin:
        Env.AIOSTREAMS_AUTH_ADMINS && Env.AIOSTREAMS_AUTH_ADMINS.length > 0
          ? Env.AIOSTREAMS_AUTH_ADMINS.includes(username)
          : true,
    };
  }

  protected override generateProxyUrl(endpoint: string): URL {
    return new URL(endpoint);
  }

  protected override getPublicIpEndpoint(): string {
    return '';
  }

  protected override getPublicIpFromResponse(data: any): string | null {
    return null;
  }

  protected override getHeaders(): Record<string, string> {
    return {};
  }

  public override async getPublicIp(): Promise<string | null> {
    BuiltinProxy.validateAuth(this.config.credentials);

    if (this.config.publicIp) {
      return this.config.publicIp;
    }

    const cacheKey = `${this.config.id}:${this.config.url}:${this.config.credentials}`;
    const cachedPublicIp = cache ? await cache.get(cacheKey) : null;
    if (cachedPublicIp) {
      logger.debug('Returning cached public IP');
      return cachedPublicIp;
    }

    const response = await makeRequest('https://checkip.amazonaws.com', {
      method: 'GET',
      timeout: 10000,
    });

    if (!response.ok) {
      throw new Error(
        `Failed to check public IP using AWS: ${response.status}: ${response.statusText}`
      );
    }

    const publicIp = await response.text();

    if (publicIp && cache) {
      await cache.set(cacheKey, publicIp, Env.PROXY_IP_CACHE_TTL);
    } else {
      logger.error(
        `Proxy did not respond with a public IP. Response: ${JSON.stringify(publicIp)}`
      );
      throw new Error('Proxy did not respond with a public IP');
    }
    return publicIp;
  }

  protected override async generateStreamUrls(
    streams: ProxyStream[]
  ): Promise<string[] | null> {
    const auth = BuiltinProxy.validateAuth(this.config.credentials);
    return streams.map((stream) => {
      const encryptedAuth = encryptString(
        JSON.stringify({
          username: auth.username,
          password: auth.password,
        })
      );
      const encryptedData = encryptString(
        JSON.stringify({
          url: stream.url,
          filename: stream.filename,
          requestHeaders: stream.headers?.request,
          responseHeaders: stream.headers?.response,
        })
      );
      return `${Env.BASE_URL}/api/v1/proxy/${encryptedAuth.data}.${encryptedData.data}/${encodeURIComponent(stream.filename ?? '')}`;
    });
  }
}

interface ConnectionRecord {
  ip: string;
  url: string;
  filename?: string;
  timestamp: number; // Initial connection time
  lastSeen: number; // Last activity time
  count: number; // Total number of requests (including seeks)
  requestIds: string[]; // List of active request IDs
}

interface UserStats {
  active: ConnectionRecord[];
  history: ConnectionRecord[];
}

export class BuiltinProxyStats {
  private activeConnections = Cache.getInstance<string, string>(
    'bproxy:active',
    10000,
    'sql'
  );
  private connectionHistory = Cache.getInstance<string, string>(
    'bproxy:history',
    10000,
    'sql'
  );

  private static ACTIVE_THRESHOLD = 6 * 60 * 60 * 1000; // 6 hours

  constructor() {}

  private encryptConnectionRecords(connections: ConnectionRecord[]): string {
    const result = encryptString(JSON.stringify(connections));
    if (!result.success || !result.data) {
      throw new Error(`Failed to encrypt connection records: ${result.error}`);
    }
    return result.data;
  }

  private decryptConnectionRecords(encryptedData: string): ConnectionRecord[] {
    const result = decryptString(encryptedData);
    if (!result.success || !result.data) {
      logger.warn('Failed to decrypt connection records', {
        error: result.error,
      });
      return [];
    }
    try {
      return JSON.parse(result.data);
    } catch (error) {
      logger.warn('Failed to parse decrypted connection records', { error });
      return [];
    }
  }

  public async getAllUserStats(): Promise<Map<string, UserStats>> {
    const users = Env.AIOSTREAMS_AUTH?.keys();
    const userStats = new Map<string, UserStats>();

    for (const user of users ?? []) {
      userStats.set(user, await this.getUserStats(user));
    }
    return userStats;
  }

  public async getUserStats(user: string): Promise<UserStats> {
    const [active, history] = await Promise.all([
      this.getActiveConnections(user),
      this.getConnectionHistory(user),
    ]);

    return { active, history };
  }

  public async getActiveConnections(user: string): Promise<ConnectionRecord[]> {
    const encryptedData = await this.activeConnections.get(user);
    if (!encryptedData) {
      return [];
    }

    const connections = this.decryptConnectionRecords(encryptedData);
    const now = Date.now();

    const stillActive: ConnectionRecord[] = [];
    const stale: ConnectionRecord[] = [];

    for (const conn of connections) {
      if (now - conn.lastSeen > BuiltinProxyStats.ACTIVE_THRESHOLD) {
        stale.push(conn);
      } else {
        stillActive.push(conn);
      }
    }

    if (stale.length > 0) {
      await this.moveToHistory(user, stale);
      await this.activeConnections.set(
        user,
        this.encryptConnectionRecords(stillActive),
        24 * 60 * 60,
        true
      );
    }

    return stillActive;
  }

  public async getConnectionHistory(user: string): Promise<ConnectionRecord[]> {
    const encryptedData = await this.connectionHistory.get(user);
    return encryptedData ? this.decryptConnectionRecords(encryptedData) : [];
  }

  public async addConnection(
    user: string,
    ip: string,
    url: string,
    timestamp: number,
    requestId: string,
    filename?: string
  ) {
    const connectionKey = `${ip}:${url}`;
    const now = Date.now();

    const activeConnections = await this.getActiveConnections(user);
    const existingIndex = activeConnections.findIndex(
      (conn) => `${conn.ip}:${conn.url}` === connectionKey
    );

    if (existingIndex >= 0) {
      // Merge with existing active connection
      const existing = activeConnections[existingIndex];
      existing.lastSeen = now;
      existing.count += 1;
      existing.requestIds = existing.requestIds ?? [];
      if (!existing.requestIds.includes(requestId)) {
        existing.requestIds.push(requestId);
      }
    } else {
      // Check history for a potential merge
      const historyConnections = await this.getConnectionHistory(user);
      const historyIndex = historyConnections.findIndex(
        (conn) =>
          `${conn.ip}:${conn.url}` === connectionKey &&
          now - conn.lastSeen <= BuiltinProxyStats.ACTIVE_THRESHOLD
      );

      if (historyIndex >= 0) {
        // Reactivate from history
        const record = historyConnections.splice(historyIndex, 1)[0];
        record.lastSeen = now;
        record.count += 1;
        record.requestIds = [requestId];
        activeConnections.push(record);

        // Update history cache
        await this.connectionHistory.set(
          user,
          this.encryptConnectionRecords(historyConnections),
          7 * 24 * 60 * 60,
          true
        );
      } else {
        // Add a completely new connection
        activeConnections.push({
          ip,
          url,
          filename,
          timestamp: timestamp,
          lastSeen: now,
          count: 1,
          requestIds: [requestId],
        });
      }
    }

    activeConnections.sort((a, b) => b.lastSeen - a.lastSeen);
    await this.activeConnections.set(
      user,
      this.encryptConnectionRecords(activeConnections),
      24 * 60 * 60,
      true
    );
  }

  public async endConnection(
    user: string,
    ip: string,
    url: string,
    requestId: string
  ) {
    const activeConnections = await this.getActiveConnections(user);
    const connectionKey = `${ip}:${url}`;
    const now = Date.now();

    const connectionIndex = activeConnections.findIndex(
      (conn) => `${conn.ip}:${conn.url}` === connectionKey
    );

    if (connectionIndex >= 0) {
      const connection = activeConnections[connectionIndex];
      connection.requestIds =
        connection.requestIds?.filter((id) => id !== requestId) ?? [];
      connection.lastSeen = now;

      if (connection.requestIds.length === 0) {
        // No active requests, move to history immediately
        const [recordToMove] = activeConnections.splice(connectionIndex, 1);
        await this.moveToHistory(user, [recordToMove]);
      }

      await this.activeConnections.set(
        user,
        this.encryptConnectionRecords(activeConnections),
        24 * 60 * 60,
        true
      );
    }
  }

  private async moveToHistory(user: string, connections: ConnectionRecord[]) {
    if (connections.length === 0) return;

    const existingHistory = await this.getConnectionHistory(user);
    const historyMap = new Map<string, ConnectionRecord>();

    for (const conn of existingHistory) {
      historyMap.set(`${conn.ip}:${conn.url}`, conn);
    }

    for (const conn of connections) {
      const key = `${conn.ip}:${conn.url}`;
      conn.requestIds = []; // Ensure requestIds is empty in history
      const existing = historyMap.get(key);

      if (!existing || conn.lastSeen > existing.lastSeen) {
        historyMap.set(key, conn);
      } else {
        // This case should be rare, but if merging, combine counts
        existing.count += conn.count;
        historyMap.set(key, existing);
      }
    }

    const updatedHistory = Array.from(historyMap.values()).sort(
      (a, b) => b.lastSeen - a.lastSeen
    );

    await this.connectionHistory.set(
      user,
      this.encryptConnectionRecords(updatedHistory),
      7 * 24 * 60 * 60,
      true
    );
  }
}
