import { BaseDebridAddon, BaseDebridConfigSchema } from '../base/debrid.js';
import { z } from 'zod';
import {
  createLogger,
  Env,
  getTimeTakenSincePoint,
} from '../../utils/index.js';
import ProwlarrApi, {
  ProwlarrApiIndexer,
  ProwlarrApiSearchItem,
  ProwlarrApiError,
  ProwlarrApiTagItem,
} from './api.js';
import { ParsedId } from '../../utils/id-parser.js';
import { SearchMetadata } from '../base/debrid.js';
import { Torrent, NZB, UnprocessedTorrent } from '../../debrid/index.js';
import {
  extractInfoHashFromMagnet,
  extractTrackersFromMagnet,
  validateInfoHash,
} from '../utils/debrid.js';
import { createQueryLimit, useAllTitles } from '../utils/general.js';

export const ProwlarrAddonConfigSchema = BaseDebridConfigSchema.extend({
  url: z.string(),
  apiKey: z.string(),
  indexers: z.array(z.string()),
  tags: z.array(z.string()),
});

export type ProwlarrAddonConfig = z.infer<typeof ProwlarrAddonConfigSchema>;

const logger = createLogger('prowlarr');

export class ProwlarrAddon extends BaseDebridAddon<ProwlarrAddonConfig> {
  readonly id = 'prowlarr';
  readonly name = 'Prowlarr';
  readonly version = '1.0.0';
  readonly logger = logger;
  readonly api: ProwlarrApi;

  public static preconfiguredIndexers: ProwlarrApiIndexer[] | undefined;

  private readonly preconfiguredInstance: boolean;
  private readonly indexers: string[] = [];
  private readonly tags: string[] = [];
  constructor(config: ProwlarrAddonConfig, clientIp?: string) {
    super(config, ProwlarrAddonConfigSchema, clientIp);

    this.preconfiguredInstance =
      Env.BUILTIN_PROWLARR_URL === config.url &&
      Env.BUILTIN_PROWLARR_API_KEY === config.apiKey;
    this.indexers = config.indexers.map((x) => x.toLowerCase());
    this.tags = config.tags.map((x) => x.toLowerCase());
    this.api = new ProwlarrApi({
      baseUrl: config.url,
      apiKey: config.apiKey,
      timeout: Env.BUILTIN_PROWLARR_SEARCH_TIMEOUT,
    });
  }

  public static async fetchpreconfiguredIndexers(): Promise<void> {
    if (this.preconfiguredIndexers) return;
    if (!Env.BUILTIN_PROWLARR_URL || !Env.BUILTIN_PROWLARR_API_KEY) return;
    const api = new ProwlarrApi({
      baseUrl: Env.BUILTIN_PROWLARR_URL,
      apiKey: Env.BUILTIN_PROWLARR_API_KEY,
      timeout: 5000,
    });
    const { data } = await api.indexers();
    logger.debug(`Fetched ${data.length} preconfigured indexers`);
    let filterReasons: Map<string, number> = new Map();

    this.preconfiguredIndexers = data.filter((indexer) => {
      if (!indexer.enable) {
        filterReasons.set(
          'not enabled',
          (filterReasons.get('not enabled') ?? 0) + 1
        );
        return false;
      }
      if (indexer.protocol !== 'torrent') {
        filterReasons.set(
          'not torrent protocol',
          (filterReasons.get('not torrent protocol') ?? 0) + 1
        );
        return false;
      }
      if (Env.BUILTIN_PROWLARR_INDEXERS?.length) {
        if (
          ![
            indexer.name.toLowerCase(),
            indexer.sortName.toLowerCase(),
            indexer.definitionName.toLowerCase(),
          ].some((x) =>
            Env.BUILTIN_PROWLARR_INDEXERS?.map((x) => x.toLowerCase()).includes(
              x
            )
          )
        ) {
          filterReasons.set(
            'not in preconfigured indexers',
            (filterReasons.get('not in preconfigured indexers') ?? 0) + 1
          );
          return false;
        }
      }
      return true;
    });
    logger.debug(
      `Set ${this.preconfiguredIndexers?.length} preconfigured indexers`
    );
    if (filterReasons.size > 0) {
      logger.debug(
        `Filter reasons: ${Array.from(filterReasons.entries())
          .map(([key, value]) => `${key}: ${value}`)
          .join(', ')}`
      );
    }
  }

  protected async _searchTorrents(
    parsedId: ParsedId,
    metadata: SearchMetadata
  ): Promise<UnprocessedTorrent[]> {
    const queryLimit = createQueryLimit();
    let availableIndexers: ProwlarrApiIndexer[] = [];
    let chosenTags: number[] = [];
    if (this.preconfiguredInstance && ProwlarrAddon.preconfiguredIndexers) {
      availableIndexers = ProwlarrAddon.preconfiguredIndexers;
    } else {
      try {
        const { data } = await this.api.indexers();
        availableIndexers = data;
      } catch (error) {
        if (error instanceof ProwlarrApiError) {
          throw new Error(
            `Failed to get Prowlarr indexers: ${error.message}: ${error.status} - ${error.statusText}`
          );
        }
        throw new Error(`Failed to get Prowlarr indexers: ${error}`);
      }
    }

    try {
      const { data } = await this.api.tags();
      chosenTags = data
        .filter((tag) => this.tags.includes(tag.label.toLowerCase()))
        .map((tag) => tag.id);
    } catch (error) {
      logger.warn(`Failed to get Prowlarr tags: ${error}`);
    }

    const chosenIndexers = availableIndexers.filter(
      (indexer) =>
        indexer.enable &&
        indexer.protocol === 'torrent' &&
        ((!this.indexers.length && !chosenTags.length) ||
          (chosenTags.length &&
            indexer.tags.some((tag) => chosenTags.includes(tag))) ||
          (this.indexers.length &&
            (this.indexers.includes(indexer.name.toLowerCase()) ||
              this.indexers.includes(indexer.definitionName.toLowerCase()) ||
              this.indexers.includes(indexer.sortName.toLowerCase()))))
    );

    this.logger.info(
      `Chosen indexers: ${chosenIndexers.map((indexer) => indexer.name).join(', ')}`
    );

    const queries = this.buildQueries(parsedId, metadata, {
      useAllTitles: useAllTitles(this.userData.url),
    });
    if (queries.length === 0) {
      return [];
    }

    const searchPromises = queries.map((q) =>
      queryLimit(async () => {
        const start = Date.now();
        const { data } = await this.api.search({
          query: q,
          indexerIds: chosenIndexers.map((indexer) => indexer.id),
          type: 'search',
        });
        this.logger.info(
          `Prowlarr search for ${q} took ${getTimeTakenSincePoint(start)}`,
          {
            results: data.length,
          }
        );
        return data;
      })
    );
    const allResults = await Promise.all(searchPromises);
    const results = allResults.flat();

    const seenTorrents = new Set<string>();
    const torrents: UnprocessedTorrent[] = [];

    for (const result of results) {
      const magnetUrl = result.guid.includes('magnet:')
        ? result.guid
        : undefined;
      const downloadUrl = result.magnetUrl?.startsWith('http')
        ? result.magnetUrl
        : result.downloadUrl;
      const infoHash = validateInfoHash(
        result.infoHash ||
          (magnetUrl ? extractInfoHashFromMagnet(magnetUrl) : undefined)
      );
      if (!infoHash && !downloadUrl) continue;
      if (seenTorrents.has(infoHash ?? downloadUrl!)) continue;
      seenTorrents.add(infoHash ?? downloadUrl!);

      torrents.push({
        hash: infoHash,
        downloadUrl: downloadUrl,
        sources: magnetUrl ? extractTrackersFromMagnet(magnetUrl) : [],
        seeders: result.seeders,
        title: result.title,
        size: result.size,
        indexer: result.indexer,
        type: 'torrent',
      });
    }
    return torrents;
  }

  protected async _searchNzbs(
    parsedId: ParsedId,
    metadata: SearchMetadata
  ): Promise<NZB[]> {
    return [];
  }
}
