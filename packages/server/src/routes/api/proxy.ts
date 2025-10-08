import { NextFunction, Request, Response, Router } from 'express';
import {
  APIError,
  constants,
  createLogger,
  decryptString,
  Env,
  getProxyAgent,
  getTimeTakenSincePoint,
  shouldProxy,
} from '@aiostreams/core';
import { z } from 'zod';
import { request, Dispatcher } from 'undici';
import { pipeline } from 'stream/promises';
import { createProxy, BuiltinProxyStats, BuiltinProxy } from '@aiostreams/core';

const logger = createLogger('server');
const router: Router = Router();

// Create a singleton instance of BuiltinProxyStats
const proxyStats = new BuiltinProxyStats();

export default router;

const ProxyAuthSchema = z.object({
  username: z.string(),
  password: z.string(),
});

const ProxyDataSchema = z.object({
  url: z.url(),
  // These are optional, as we'll be forwarding client headers
  requestHeaders: z.record(z.string(), z.string()).optional(),
  responseHeaders: z.record(z.string(), z.string()).optional(),
});

// GET /stats endpoint to display proxy statistics
router.get(
  '/stats',
  async (req: Request, res: Response, next: NextFunction) => {
    // only show stats to admin users
    try {
      const { auth: authQuery } = z
        .object({ auth: z.string() })
        .parse(req.query);
      const auth = BuiltinProxy.validateAuth(authQuery);
      if (!auth.admin) {
        throw new APIError(
          constants.ErrorCode.UNAUTHORIZED,
          undefined,
          'Invalid auth'
        );
      }
    } catch (error) {
      if (error instanceof APIError) {
        next(error);
      } else {
        next(
          new APIError(
            constants.ErrorCode.UNAUTHORIZED,
            undefined,
            'Invalid auth'
          )
        );
      }
    }

    try {
      const allConnections = await proxyStats.getAllActiveConnections();

      // Convert Map to a more JSON-friendly format
      const stats = {
        timestamp: new Date().toISOString(),
        totalUsers: allConnections.size,
        activeConnections: Object.fromEntries(
          Array.from(allConnections.entries()).map(([user, connections]) => [
            user,
            connections.map((conn) => ({
              ...conn,
              timestamp: new Date(conn.timestamp).toISOString(),
              relativeTimestamp: `${getTimeTakenSincePoint(conn.timestamp)} ago`,
            })),
          ])
        ),
        summary: {
          totalActiveConnections: Array.from(allConnections.values()).reduce(
            (total, connections) => total + connections.length,
            0
          ),
          usersWithActiveConnections: Array.from(
            allConnections.entries()
          ).filter(([_, connections]) => connections.length > 0).length,
        },
      };

      res.json(stats);
    } catch (error) {
      logger.error('Failed to get proxy stats', {
        error: error instanceof Error ? error.message : String(error),
      });
      next(error);
    }
  }
);

router.all(
  '/:encryptedAuthAndData{/:filename}',
  async (req: Request, res: Response, next: NextFunction) => {
    const startTime = Date.now();
    const requestId = Math.random().toString(36).substring(7);
    let upstreamResponse: Dispatcher.ResponseData | undefined;
    let auth: { username: string; password: string } | undefined;
    let data: z.infer<typeof ProxyDataSchema> | undefined;
    let clientIp: string | undefined;

    try {
      // decrypt and authenticate the request
      const { encryptedAuthAndData } = req.params;
      const [encryptedAuth, encryptedData] = encryptedAuthAndData.split('.');
      const filename = req.params.filename as string | undefined;

      const { data: rawData } = decryptString(encryptedData);
      const { data: rawAuth } = decryptString(encryptedAuth);

      if (!rawData || !rawAuth) {
        logger.error(`[${requestId}] Decryption failed`);
        throw new APIError(
          constants.ErrorCode.ENCRYPTION_ERROR,
          undefined,
          'Could not decrypt data or auth'
        );
      }

      data = ProxyDataSchema.parse(JSON.parse(rawData));
      auth = ProxyAuthSchema.parse(JSON.parse(rawAuth));

      if (
        !Env.BUILTIN_PROXY_AUTH?.has(auth.username) ||
        Env.BUILTIN_PROXY_AUTH?.get(auth.username) !== auth.password
      ) {
        logger.warn(`[${requestId}] Authentication failed`, {
          username: auth.username,
        });
        throw new APIError(
          constants.ErrorCode.UNAUTHORIZED,
          undefined,
          'Invalid auth'
        );
      }

      // Track the active connection
      clientIp = req.ip || req.connection.remoteAddress || 'unknown';
      const timestamp = Date.now();
      proxyStats.addActiveConnection(
        auth.username,
        clientIp,
        data.url,
        timestamp,
        filename
      );

      // prepare and execute upstream request
      const { host, ...clientHeaders } = req.headers;

      const isBodyRequest =
        req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH';

      const upstreamStartTime = Date.now();
      const urlObj = new URL(data.url);
      if (Env.BASE_URL && urlObj.origin === Env.BASE_URL) {
        const internalUrl = new URL(Env.INTERNAL_URL);
        urlObj.protocol = internalUrl.protocol;
        urlObj.host = internalUrl.host;
        urlObj.port = internalUrl.port;
      }

      if (Env.REQUEST_URL_MAPPINGS) {
        for (const [key, value] of Object.entries(Env.REQUEST_URL_MAPPINGS)) {
          if (urlObj.origin === key) {
            const mappedUrl = new URL(value);
            urlObj.protocol = mappedUrl.protocol;
            urlObj.host = mappedUrl.host;
            urlObj.port = mappedUrl.port;
            break;
          }
        }
      }
      const { useProxy, proxyIndex } = shouldProxy(urlObj);
      const proxyAgent = useProxy
        ? getProxyAgent(Env.ADDON_PROXY![proxyIndex])
        : undefined;
      upstreamResponse = await request(data.url, {
        method: req.method as Dispatcher.HttpMethod,
        headers: { ...clientHeaders, ...data.requestHeaders },
        dispatcher: proxyAgent,
        body: isBodyRequest ? req : undefined,
        bodyTimeout: 0,
        headersTimeout: 0,
      });
      const upstreamDuration = getTimeTakenSincePoint(upstreamStartTime);

      logger.debug(`[${requestId}] Serving upstream response`, {
        username: auth.username,
        targetUrl: data.url,
        statusCode: upstreamResponse.statusCode,
        upstreamDuration,
      });

      // forward upstream response to client
      res.set(upstreamResponse.headers);
      if (data.responseHeaders) {
        res.set(data.responseHeaders);
      }
      res.status(upstreamResponse.statusCode);

      if (req.method === 'HEAD') {
        res.end();
      } else {
        await pipeline(upstreamResponse.body, res);
      }
      logger.debug(`[${requestId}] Proxy connection closed`, {
        username: auth.username,
      });
    } catch (error) {
      const totalDuration = Date.now() - startTime;

      // Remove the active connection tracking on error
      if (auth && clientIp && data) {
        proxyStats
          .removeActiveConnection(auth.username, clientIp, data.url)
          .catch((statsError) =>
            logger.warn(
              `[${requestId}] Failed to remove connection from stats on error`,
              { error: statsError }
            )
          );
      }

      if (upstreamResponse) {
        upstreamResponse.body.destroy();
      }

      if (
        (error as NodeJS.ErrnoException)?.code !== 'ERR_STREAM_PREMATURE_CLOSE'
      ) {
        logger.error(`[${requestId}] Proxy request failed`, {
          error: error instanceof Error ? error.message : String(error),
          durationMs: totalDuration,
          upstreamStatusCode: upstreamResponse?.statusCode,
        });
        next(error);
      } else {
        logger.debug(`[${requestId}] Client disconnected (premature close)`, {
          durationMs: totalDuration,
        });
      }
    }
  }
);
