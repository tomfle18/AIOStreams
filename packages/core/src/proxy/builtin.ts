import { BaseProxy, ProxyStream } from './base.js';
import {
  createLogger,
  maskSensitiveInfo,
  Env,
  makeRequest,
  encryptString,
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

export class BuiltinProxyStats {
  private activeConnections = Cache.getInstance<
    string,
    { ip: string; url: string; filename?: string; timestamp: number }[]
  >('bproxy:stats', 10000, 'sql');

  constructor() {}

  public async getAllActiveConnections(): Promise<
    Map<
      string,
      { ip: string; url: string; filename?: string; timestamp: number }[]
    >
  > {
    const users = Env.BUILTIN_PROXY_AUTH?.keys();

    // create a map of users and their active connections
    const connections = new Map<
      string,
      { ip: string; url: string; filename?: string; timestamp: number }[]
    >();
    for (const user of users ?? []) {
      connections.set(user, await this.getActiveConnections(user));
    }
    return connections;
  }

  public async getActiveConnections(
    user: string
  ): Promise<
    { ip: string; url: string; filename?: string; timestamp: number }[]
  > {
    return (await this.activeConnections.get(user)) ?? [];
  }

  public async addActiveConnection(
    user: string,
    ip: string,
    url: string,
    timestamp: number,
    filename?: string
  ) {
    logger.debug(`[${user}] Adding active connection`, {
      ip,
      url,
      filename,
      timestamp,
    });

    const existingConnections = (await this.activeConnections.get(user)) ?? [];
    const connectionKey = `${ip}:${url}`;

    // Filter out any existing connections with the same IP+filename combination
    const filteredConnections = existingConnections.filter((conn) => {
      return `${conn.ip}:${conn.url}` !== connectionKey;
    });

    // Add the new connection (which will be the most recent for this IP+filename)
    const updatedConnections = [
      ...filteredConnections,
      { ip, url, filename, timestamp },
    ];

    await this.activeConnections.set(user, updatedConnections, 1 * 60 * 60);
  }

  public async removeActiveConnection(user: string, ip: string, url: string) {
    await this.activeConnections.set(
      user,
      ((await this.activeConnections.get(user)) ?? []).filter(
        (connection) => connection.ip !== ip && connection.url !== url
      ),
      24 * 60 * 60
    );
  }
}
