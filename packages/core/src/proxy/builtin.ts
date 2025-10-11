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
      Env.BUILTIN_PROXY_AUTH?.has(username) &&
      Env.BUILTIN_PROXY_AUTH?.get(username) !== password
    ) {
      throw new Error('Invalid credentials');
    }

    return {
      username,
      password,
      admin:
        Env.BUILTIN_PROXY_ADMINS && Env.BUILTIN_PROXY_ADMINS.length > 0
          ? Env.BUILTIN_PROXY_ADMINS.includes(username)
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

    const response = await makeRequest('https://checkip.amazonaws.com', {
      method: 'GET',
      timeout: 5000,
    });

    return response.text();
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
  timestamp: number;
  lastSeen: number;
  count: number;
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

  private readonly ACTIVE_THRESHOLD = 60 * 60 * 1000; // 1 hour in milliseconds

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
    const users = Env.BUILTIN_PROXY_AUTH?.keys();
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
    const connections = encryptedData
      ? this.decryptConnectionRecords(encryptedData)
      : [];
    const now = Date.now();

    // Filter out connections older than 1 hour and move them to history
    const activeConnections: ConnectionRecord[] = [];
    const expiredConnections: ConnectionRecord[] = [];

    for (const conn of connections) {
      if (now - conn.lastSeen <= this.ACTIVE_THRESHOLD) {
        activeConnections.push(conn);
      } else {
        expiredConnections.push(conn);
      }
    }

    // Move expired connections to history
    if (expiredConnections.length > 0) {
      await this.moveToHistory(user, expiredConnections);
      await this.activeConnections.set(
        user,
        this.encryptConnectionRecords(activeConnections),
        24 * 60 * 60
      );
    }

    return activeConnections;
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
    filename?: string
  ) {
    logger.debug(`[${user}] Adding connection`, {
      ip,
      url,
      filename,
      timestamp,
    });

    const connectionKey = `${ip}:${url}`;
    const now = Date.now();

    // Get current active connections
    const activeConnections = await this.getActiveConnections(user);

    // Check if this connection already exists in active connections
    const existingIndex = activeConnections.findIndex(
      (conn) => `${conn.ip}:${conn.url}` === connectionKey
    );

    if (existingIndex >= 0) {
      const existing = activeConnections[existingIndex];
      activeConnections[existingIndex] = {
        ...existing,
        lastSeen: now,
        count: existing.count + 1,
      };
    } else {
      // Add new connection
      activeConnections.push({
        ip,
        url,
        filename,
        timestamp,
        lastSeen: now,
        count: 1,
      });
    }

    // Sort by lastSeen (most recent first)
    activeConnections.sort((a, b) => b.lastSeen - a.lastSeen);

    await this.activeConnections.set(
      user,
      this.encryptConnectionRecords(activeConnections),
      24 * 60 * 60
    );
  }

  public async removeConnection(user: string, ip: string, url: string) {
    const activeConnections = await this.getActiveConnections(user);
    const connectionKey = `${ip}:${url}`;

    const filteredConnections = activeConnections.filter(
      (conn) => `${conn.ip}:${conn.url}` !== connectionKey
    );

    await this.activeConnections.set(
      user,
      this.encryptConnectionRecords(filteredConnections),
      24 * 60 * 60
    );
  }

  private async moveToHistory(user: string, connections: ConnectionRecord[]) {
    const existingHistory = await this.getConnectionHistory(user);

    // Merge with existing history, keeping the most recent record for each connection
    const historyMap = new Map<string, ConnectionRecord>();

    // Add existing history
    for (const conn of existingHistory) {
      const key = `${conn.ip}:${conn.url}`;
      historyMap.set(key, conn);
    }

    // Add/update with new connections
    for (const conn of connections) {
      const key = `${conn.ip}:${conn.url}`;
      const existing = historyMap.get(key);

      if (!existing || conn.lastSeen > existing.lastSeen) {
        historyMap.set(key, conn);
      } else if (existing) {
        // Merge counts if the existing record is more recent
        existing.count += conn.count;
      }
    }

    const updatedHistory = Array.from(historyMap.values()).sort(
      (a, b) => b.lastSeen - a.lastSeen
    );

    await this.connectionHistory.set(
      user,
      this.encryptConnectionRecords(updatedHistory),
      7 * 24 * 60 * 60
    ); // Keep history for 7 days
  }

  // Legacy methods for backward compatibility
  public async getAllActiveConnections(): Promise<
    Map<
      string,
      { ip: string; url: string; filename?: string; timestamp: number }[]
    >
  > {
    const userStats = await this.getAllUserStats();
    const result = new Map();

    for (const [user, stats] of userStats) {
      result.set(
        user,
        stats.active.map((conn) => ({
          ip: conn.ip,
          url: conn.url,
          filename: conn.filename,
          timestamp: conn.timestamp,
        }))
      );
    }

    return result;
  }

  public async addActiveConnection(
    user: string,
    ip: string,
    url: string,
    timestamp: number,
    filename?: string
  ) {
    return this.addConnection(user, ip, url, timestamp, filename);
  }

  public async removeActiveConnection(user: string, ip: string, url: string) {
    return this.removeConnection(user, ip, url);
  }
}
