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

function sanitiseHeaderValue(value: string): string {
  return value.replace(/[^\t\x20-\x7e]/g, '');
}

// A helper to iterate over the headers object
function sanitiseHeaders(
  headers: Record<string, string | string[] | number | undefined>
): Record<string, string | string[]> {
  const sanitised: Record<string, string | string[]> = {};

  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }

    if (Array.isArray(value)) {
      sanitised[key] = value.map((v) => sanitiseHeaderValue(v));
    } else if (typeof value === 'number') {
      sanitised[key] = String(value);
    } else {
      sanitised[key] = sanitiseHeaderValue(value);
    }
  }

  return sanitised;
}

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
      const allUserStats = await proxyStats.getAllUserStats();

      // Convert Map to a more JSON-friendly format
      const stats = {
        timestamp: new Date().toISOString(),
        totalUsers: allUserStats.size,
        users: Object.fromEntries(
          Array.from(allUserStats.entries()).map(([user, userStats]) => [
            user,
            {
              active: userStats.active.map((conn) => ({
                ...conn,
                timestamp: new Date(conn.timestamp).toISOString(),
                lastSeen: new Date(conn.lastSeen).toISOString(),
                relativeTimestamp: `${getTimeTakenSincePoint(conn.timestamp)} ago`,
                relativeLastSeen: `${getTimeTakenSincePoint(conn.lastSeen)} ago`,
              })),
              history: userStats.history.map((conn) => ({
                ...conn,
                timestamp: new Date(conn.timestamp).toISOString(),
                lastSeen: new Date(conn.lastSeen).toISOString(),
                relativeTimestamp: `${getTimeTakenSincePoint(conn.timestamp)} ago`,
                relativeLastSeen: `${getTimeTakenSincePoint(conn.lastSeen)} ago`,
              })),
            },
          ])
        ),
        summary: {
          totalActiveConnections: Array.from(allUserStats.values()).reduce(
            (total, userStats) => total + userStats.active.length,
            0
          ),
          totalHistoryConnections: Array.from(allUserStats.values()).reduce(
            (total, userStats) => total + userStats.history.length,
            0
          ),
          usersWithActiveConnections: Array.from(allUserStats.entries()).filter(
            ([_, userStats]) => userStats.active.length > 0
          ).length,
          usersWithHistory: Array.from(allUserStats.entries()).filter(
            ([_, userStats]) => userStats.history.length > 0
          ).length,
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

      // Track the connection
      clientIp =
        req.requestIp || req.ip || req.socket.remoteAddress || 'unknown';
      const timestamp = Date.now();
      proxyStats
        .addConnection(auth.username, clientIp, data.url, timestamp, filename)
        .catch((error) =>
          logger.warn(`[${requestId}] Failed to add connection to stats`, {
            error: error instanceof Error ? error.message : String(error),
          })
        );

      // prepare and execute upstream request
      const { host, ...clientHeaders } = req.headers;

      const isBodyRequest =
        req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH';

      const upstreamStartTime = Date.now();
      let currentUrl = data.url;
      const maxRedirects = 10;
      let redirectCount = 0;
      let method = req.method as Dispatcher.HttpMethod;

      while (redirectCount < maxRedirects) {
        const urlObj = new URL(currentUrl);
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
        const headers = { ...clientHeaders, ...data.requestHeaders };
        logger.debug(`[${requestId}] Making upstream request`, {
          username: auth.username,
          method: method,
          proxied: useProxy
            ? `true${proxyIndex > 1 ? ` (${proxyIndex + 1})` : ''}`
            : 'false',
          range: headers['range'],
          url: currentUrl,
        });
        upstreamResponse = await request(currentUrl, {
          method: method,
          headers: headers,
          dispatcher: proxyAgent,
          body: isBodyRequest ? req : undefined,
          bodyTimeout: 0,
          headersTimeout: 0,
        });

        if ([301, 302, 303, 307, 308].includes(upstreamResponse.statusCode)) {
          redirectCount++;
          const location = upstreamResponse.headers['location'];
          if (!location || typeof location !== 'string') {
            break; // No location header, stop redirecting
          }
          currentUrl = new URL(location, currentUrl).href;

          if ([301, 302, 303].includes(upstreamResponse.statusCode)) {
            method = 'GET';
          }
          // For 307, 308, method remains the same
          continue;
        }

        break; // Not a redirect, exit loop
      }

      if (!upstreamResponse) {
        throw new Error('Upstream response not found');
      }
      const upstreamDuration = getTimeTakenSincePoint(upstreamStartTime);

      // forward upstream response to client
      res.set(sanitiseHeaders(upstreamResponse.headers));
      if (data.responseHeaders) {
        res.set(data.responseHeaders);
      }
      res.status(upstreamResponse.statusCode);

      logger.debug(`[${requestId}] Serving upstream response`, {
        username: auth.username,
        statusCode: upstreamResponse.statusCode,
        upstreamDuration,
        contentType: upstreamResponse.headers['content-type'],
        contentLength: upstreamResponse.headers['content-length'],
        range: upstreamResponse.headers['range'],
        targetUrl: currentUrl,
      });

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

      // Remove the connection tracking on error
      if (auth && clientIp && data) {
        proxyStats
          .removeConnection(auth.username, clientIp, data.url)
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
