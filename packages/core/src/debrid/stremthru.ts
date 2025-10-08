import { StremThru, StremThruError } from 'stremthru';
import {
  Env,
  ServiceId,
  createLogger,
  getSimpleTextHash,
  Cache,
  DistributedLock,
} from '../utils/index.js';
import { selectFileInTorrentOrNZB, Torrent } from './utils.js';
import {
  DebridService,
  DebridServiceConfig,
  DebridDownload,
  PlaybackInfo,
  DebridError,
} from './base.js';
import { StremThruServiceId } from '../presets/stremthru.js';
import { PTT } from '../parser/index.js';
import { ParseResult } from 'go-ptt';
import assert from 'assert';

const logger = createLogger('debrid:stremthru');

function convertStremThruError(error: StremThruError): DebridError {
  return new DebridError(error.message, {
    statusCode: error.statusCode,
    statusText: error.statusText,
    code: error.code,
    headers: error.headers,
    body: error.body,
    cause: 'cause' in error ? error.cause : undefined,
  });
}

export class StremThruInterface implements DebridService {
  private readonly stremthru: StremThru;
  private static playbackLinkCache = Cache.getInstance<string, string | null>(
    'st:link'
  );
  private static checkCache = Cache.getInstance<string, DebridDownload>(
    'st:instant-check'
  );

  readonly supportsUsenet = false;
  readonly serviceName: ServiceId;

  constructor(
    private readonly config: DebridServiceConfig & {
      serviceName: StremThruServiceId;
    }
  ) {
    this.serviceName = config.serviceName;
    this.stremthru = new StremThru({
      baseUrl: Env.BUILTIN_STREMTHRU_URL,
      userAgent: Env.DEFAULT_USER_AGENT,
      auth: {
        store: config.serviceName,
        token: config.token,
      },
      clientIp: config.clientIp,
      timeout: 10000,
    });
  }

  public async listMagnets(): Promise<DebridDownload[]> {
    const result = await this.stremthru.store.listMagnets({});
    return result.data.items;
  }

  public async checkMagnets(
    magnets: string[],
    sid?: string
  ): Promise<DebridDownload[]> {
    const cachedResults: DebridDownload[] = [];
    const magnetsToCheck: string[] = [];
    for (const magnet of magnets) {
      const cacheKey = `${this.serviceName}:${getSimpleTextHash(magnet)}`;
      const cached = await StremThruInterface.checkCache.get(cacheKey);
      if (cached) {
        cachedResults.push(cached);
      } else {
        magnetsToCheck.push(magnet);
      }
    }

    if (magnetsToCheck.length > 0) {
      let newResults: DebridDownload[] = [];
      const BATCH_SIZE = 500;
      // Split magnetsToCheck into batches of 500
      const batches: string[][] = [];
      for (let i = 0; i < magnetsToCheck.length; i += BATCH_SIZE) {
        batches.push(magnetsToCheck.slice(i, i + BATCH_SIZE));
      }

      try {
        // Perform all batch requests in parallel
        const batchResults = await Promise.all(
          batches.map(async (batch) => {
            const result = await this.stremthru.store.checkMagnet({
              magnet: batch,
              sid,
            });

            assert.ok(
              result?.data,
              `StremThru checkMagnets returned no data: ${JSON.stringify(result)}`
            );

            return result.data.items;
          })
        );

        const allItems = batchResults.flat();

        newResults = allItems.map((item) => ({
          id: -1,
          hash: item.hash,
          status: item.status,
          size: item.files.reduce((acc, file) => acc + file.size, 0),
          files: item.files.map((file) => ({
            name: file.name,
            size: file.size,
            index: file.index,
          })),
        }));

        newResults.forEach((item) => {
          StremThruInterface.checkCache
            .set(
              `${this.serviceName}:${getSimpleTextHash(item.hash!)}`,
              item,
              Env.BUILTIN_DEBRID_INSTANT_AVAILABILITY_CACHE_TTL
            )
            .catch((err) => {
              logger.error(
                `Failed to cache item ${item.hash} in the background:`,
                err
              );
            });
        });
      } catch (error) {
        if (error instanceof StremThruError) {
          throw convertStremThruError(error);
        }
        throw error;
      }
      return [...cachedResults, ...newResults];
    }
    return cachedResults;
  }

  public async addMagnet(magnet: string): Promise<DebridDownload> {
    try {
      const result = await this.stremthru.store.addMagnet({
        magnet,
      });
      assert.ok(
        result?.data,
        `Missing data from StremThru addMagnet: ${JSON.stringify(result)}`
      );

      return {
        id: result.data.id,
        status: result.data.status,
        hash: result.data.hash,
        size: result.data.files.reduce((acc, file) => acc + file.size, 0),
        files: result.data.files.map((file) => ({
          name: file.name,
          size: file.size,
          link: file.link,
          path: file.path,
          index: file.index,
        })),
      };
    } catch (error) {
      throw error instanceof StremThruError
        ? convertStremThruError(error)
        : error;
    }
  }

  public async generateTorrentLink(
    link: string,
    clientIp?: string
  ): Promise<string> {
    try {
      const result = await this.stremthru.store.generateLink({
        link,
        clientIp,
      });
      assert.ok(
        result?.data,
        `Missing data from StremThru generateTorrentLink: ${JSON.stringify(result)}`
      );
      return result.data.link;
    } catch (error) {
      throw error instanceof StremThruError
        ? convertStremThruError(error)
        : error;
    }
  }

  public async resolve(
    playbackInfo: PlaybackInfo,
    filename: string,
    cacheAndPlay: boolean
  ): Promise<string | undefined> {
    const { result } = await DistributedLock.getInstance().withLock(
      `stremthru:resolve:${playbackInfo.hash}:${playbackInfo.metadata?.season}:${playbackInfo.metadata?.episode}:${playbackInfo.metadata?.absoluteEpisode}:${filename}:${cacheAndPlay}:${this.config.clientIp}:${this.config.serviceName}:${this.config.token}`,
      () => this._resolve(playbackInfo, filename, cacheAndPlay),
      {
        timeout: playbackInfo.cacheAndPlay ? 120000 : 30000,
        ttl: 10000,
      }
    );
    return result;
  }

  private async _resolve(
    playbackInfo: PlaybackInfo,
    filename: string,
    cacheAndPlay: boolean
  ): Promise<string | undefined> {
    if (playbackInfo.type === 'usenet') {
      throw new DebridError('StremThru does not support usenet operations', {
        statusCode: 400,
        statusText: 'StremThru does not support usenet operations',
        code: 'NOT_IMPLEMENTED',
        headers: {},
        body: playbackInfo,
      });
    }

    const { hash, metadata } = playbackInfo;
    const cacheKey = `${this.serviceName}:${this.config.token}:${this.config.clientIp}:${playbackInfo.hash}:${playbackInfo.metadata?.season}:${playbackInfo.metadata?.episode}:${playbackInfo.metadata?.absoluteEpisode}`;
    const cachedLink = await StremThruInterface.playbackLinkCache.get(cacheKey);

    let magnet = `magnet:?xt=urn:btih:${hash}`;
    if (playbackInfo.sources.length > 0) {
      magnet += `&tr=${playbackInfo.sources.join('&tr=')}`;
    }

    if (cachedLink !== undefined) {
      logger.debug(`Using cached link for ${hash}`);
      if (cachedLink === null) {
        if (!cacheAndPlay) {
          return undefined;
        }
      } else {
        return cachedLink;
      }
    }

    logger.debug(`Adding magnet to ${this.serviceName} for ${magnet}`);

    let magnetDownload = await this.addMagnet(magnet);

    logger.debug(`Magnet download added for ${magnet}`, {
      status: magnetDownload.status,
      id: magnetDownload.id,
    });

    if (magnetDownload.status !== 'downloaded') {
      // temporarily cache the null value for 1m
      StremThruInterface.playbackLinkCache.set(cacheKey, null, 60);
      if (!cacheAndPlay) {
        return undefined;
      }
      // poll status when cacheAndPlay is true, max wait time is 110s
      for (let i = 0; i < 10; i++) {
        await new Promise((resolve) => setTimeout(resolve, 11000));
        const list = await this.listMagnets();
        const magnetDownloadInList = list.find(
          (magnet) => magnet.hash === hash
        );
        if (!magnetDownloadInList) {
          logger.warn(`Failed to find ${hash} in list`);
        } else {
          logger.debug(`Polled status for ${hash}`, {
            attempt: i + 1,
            status: magnetDownloadInList.status,
          });
          if (magnetDownloadInList.status === 'downloaded') {
            magnetDownload = magnetDownloadInList;
            break;
          }
        }
      }
      if (magnetDownload.status !== 'downloaded') {
        return undefined;
      }
    }

    if (!magnetDownload.files?.length) {
      throw new DebridError('No files found for magnet download', {
        statusCode: 400,
        statusText: 'No files found for magnet download',
        code: 'NO_MATCHING_FILE',
        headers: {},
        body: magnetDownload,
      });
    }

    const torrent: Torrent = {
      title: magnetDownload.name || '',
      hash: hash,
      size: magnetDownload.size || 0,
      type: 'torrent',
      sources: playbackInfo.sources,
    };

    const allStrings: string[] = [];
    allStrings.push(magnetDownload.name ?? '');
    allStrings.push(...magnetDownload.files.map((file) => file.name ?? ''));
    const parseResults = await PTT.parse(allStrings);
    const parsedFiles = new Map<string, ParseResult>();
    for (const [index, result] of parseResults.entries()) {
      if (result) {
        parsedFiles.set(allStrings[index], result);
      }
    }

    const file = await selectFileInTorrentOrNZB(
      torrent,
      magnetDownload,
      parsedFiles,
      metadata,
      {
        chosenFilename: playbackInfo.filename,
        chosenIndex: playbackInfo.index,
      }
    );

    if (!file?.link) {
      throw new DebridError('No matching file found', {
        statusCode: 400,
        statusText: 'No matching file found',
        code: 'NO_MATCHING_FILE',
        headers: {},
        body: file,
      });
    }

    logger.debug(`Found matching file`, {
      season: metadata?.season,
      episode: metadata?.episode,
      absoluteEpisode: metadata?.absoluteEpisode,
      chosenFile: file.name,
      availableFiles: `[${magnetDownload.files.map((file) => file.name).join(', ')}]`,
    });

    const playbackLink = await this.generateTorrentLink(
      file.link,
      this.config.clientIp
    );
    await StremThruInterface.playbackLinkCache.set(
      cacheKey,
      playbackLink,
      Env.BUILTIN_DEBRID_PLAYBACK_LINK_CACHE_TTL
    );

    return playbackLink;
  }
}
