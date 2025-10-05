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

  private readonly indexers: string[] = [];
  private readonly tags: string[] = [];
  constructor(config: ProwlarrAddonConfig, clientIp?: string) {
    super(config, ProwlarrAddonConfigSchema, clientIp);
    this.indexers = config.indexers.map((x) => x.toLowerCase());
    this.tags = config.tags.map((x) => x.toLowerCase());
    this.api = new ProwlarrApi({
      baseUrl: config.url,
      apiKey: config.apiKey,
      timeout: Env.BUILTIN_PROWLARR_SEARCH_TIMEOUT,
    });
  }

  static async getIndexers(
    url: string,
    apiKey: string
  ): Promise<ProwlarrApiIndexer[]> {
    const api = new ProwlarrApi({
      baseUrl: url,
      apiKey: apiKey,
      timeout: Env.BUILTIN_PROWLARR_SEARCH_TIMEOUT,
    });
    const { data } = await api.indexers();
    return data;
  }

  protected async _searchTorrents(
    parsedId: ParsedId,
    metadata: SearchMetadata
  ): Promise<UnprocessedTorrent[]> {
    const queryLimit = createQueryLimit();
    let availableIndexers: ProwlarrApiIndexer[] = [];
    let chosenTags: number[] = [];
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
    // .map((indexer) => indexer.id);
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
