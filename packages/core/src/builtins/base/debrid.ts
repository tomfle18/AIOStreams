import {
  CacheAndPlaySchema,
  Manifest,
  Meta,
  Stream,
} from '../../db/schemas.js';
import { z, ZodError } from 'zod';
import { IdParser, IdType, ParsedId } from '../../utils/id-parser.js';
import {
  AnimeDatabase,
  BuiltinServiceId,
  constants,
  encryptString,
  Env,
  formatZodError,
  getSimpleTextHash,
  getTimeTakenSincePoint,
  SERVICE_DETAILS,
} from '../../utils/index.js';
import { TorrentClient } from '../../utils/torrent.js';
import {
  BuiltinDebridServices,
  PlaybackInfo,
  Torrent,
  NZB,
  TorrentWithSelectedFile,
  NZBWithSelectedFile,
  UnprocessedTorrent,
  ServiceAuth,
  DebridError,
  generatePlaybackUrl,
  TitleMetadata as DebridTitleMetadata,
  metadataStore,
  FileInfo,
} from '../../debrid/index.js';
import { processTorrents, processNZBs } from '../utils/debrid.js';
import { calculateAbsoluteEpisode } from '../utils/general.js';
import { TitleMetadata } from '../torbox-search/source-handlers.js';
import { MetadataService } from '../../metadata/service.js';
import { Logger } from 'winston';
import pLimit from 'p-limit';
import { cleanTitle } from '../../parser/utils.js';

export interface SearchMetadata extends TitleMetadata {
  primaryTitle?: string;
  year?: number;
  imdbId?: string | null;
  tmdbId?: number | null;
  tvdbId?: number | null;
  isAnime?: boolean;
}

export const BaseDebridConfigSchema = z.object({
  services: BuiltinDebridServices,
  tmdbApiKey: z.string().optional(),
  tmdbReadAccessToken: z.string().optional(),
  tvdbApiKey: z.string().optional(),
  cacheAndPlay: CacheAndPlaySchema.optional(),
});
export type BaseDebridConfig = z.infer<typeof BaseDebridConfigSchema>;

export abstract class BaseDebridAddon<T extends BaseDebridConfig> {
  abstract readonly id: string;
  abstract readonly name: string;
  abstract readonly version: string;

  get addonId(): string {
    return `com.${this.name.toLowerCase().replace(/\s/g, '')}.viren070`;
  }

  abstract readonly logger: Logger;

  protected readonly userData: T;
  protected readonly clientIp?: string;

  private static readonly supportedIdTypes: IdType[] = [
    'imdbId',
    'kitsuId',
    'malId',
    'themoviedbId',
    'thetvdbId',
  ];

  constructor(userData: T, configSchema: z.ZodType<T>, clientIp?: string) {
    try {
      this.userData = configSchema.parse(userData);
    } catch (error) {
      throw new Error(
        `Invalid user data: ${formatZodError(error as ZodError)}`
      );
    }

    this.clientIp = clientIp;
  }

  public getManifest(): Manifest {
    return {
      id: this.addonId,
      name: this.name,
      version: this.version,
      types: ['movie', 'series', 'anime'],
      catalogs: [],
      description: `${this.name} addon`,
      resources: [
        {
          name: 'stream',
          types: ['movie', 'series', 'anime'],
          idPrefixes: IdParser.getPrefixes(BaseDebridAddon.supportedIdTypes),
        },
      ],
    };
  }

  public async getStreams(type: string, id: string): Promise<Stream[]> {
    const parsedId = IdParser.parse(id, type);
    if (
      !parsedId ||
      !BaseDebridAddon.supportedIdTypes.includes(parsedId.type)
    ) {
      throw new Error(`Unsupported ID: ${id}`);
    }

    this.logger.info(`Handling stream request for ${this.name}`, {
      requestType: type,
      requestId: id,
    });

    let searchMetadata: SearchMetadata;
    try {
      searchMetadata = await this._getSearchMetadata(parsedId, type);
      if (searchMetadata.primaryTitle) {
        searchMetadata.primaryTitle = cleanTitle(searchMetadata.primaryTitle);
        this.logger.debug(
          `Cleaned primary title for ${id}: ${searchMetadata.primaryTitle}`
        );
      }
    } catch (error) {
      this.logger.error(`Failed to get search metadata for ${id}: ${error}`);
      return [
        this._createErrorStream({
          title: `${this.name}`,
          description: 'Failed to get metadata',
        }),
      ];
    }

    const searchPromises = await Promise.allSettled([
      this._searchTorrents(parsedId, searchMetadata),
      this._searchNzbs(parsedId, searchMetadata),
    ]);

    let torrentResults =
      searchPromises[0].status === 'fulfilled' ? searchPromises[0].value : [];
    const nzbResults =
      searchPromises[1].status === 'fulfilled' ? searchPromises[1].value : [];

    const searchErrors: Stream[] = [];
    if (searchPromises[0].status === 'rejected') {
      searchErrors.push(
        this._createErrorStream({
          title: `${this.name}`,
          description: searchPromises[0].reason.message,
        })
      );
    }
    if (searchPromises[1].status === 'rejected') {
      searchErrors.push(
        this._createErrorStream({
          title: `${this.name}`,
          description: searchPromises[1].reason.message,
        })
      );
    }

    const torrentsToDownload = torrentResults.filter(
      (t) => !t.hash && t.downloadUrl
    );
    torrentResults = torrentResults.filter((t) => t.hash);
    if (torrentsToDownload.length > 0) {
      this.logger.info(
        `Fetching metadata for ${torrentsToDownload.length} torrents`
      );
      const start = Date.now();
      const metadataPromises = torrentsToDownload.map(async (torrent) => {
        try {
          const metadata = await TorrentClient.getMetadata(torrent);
          if (!metadata) {
            return torrent.hash ? (torrent as Torrent) : null;
          }
          return {
            ...torrent,
            hash: metadata.hash,
            sources: metadata.sources,
            files: metadata.files,
          } as Torrent;
        } catch (error) {
          return torrent.hash ? (torrent as Torrent) : null;
        }
      });

      const enrichedResults = (await Promise.all(metadataPromises)).filter(
        (r): r is Torrent => r !== null
      );
      this.logger.info(
        `Got info for ${enrichedResults.length} torrents in ${getTimeTakenSincePoint(start)}`
      );
      torrentResults = [...torrentResults, ...enrichedResults];
    }

    const [processedTorrents, processedNzbs] = await Promise.all([
      processTorrents(
        torrentResults as Torrent[],
        this.userData.services,
        id,
        searchMetadata,
        this.clientIp
      ),
      processNZBs(
        nzbResults,
        this.userData.services,
        id,
        searchMetadata,
        this.clientIp
      ),
    ]);

    const encryptedStoreAuths = this.userData.services.reduce(
      (acc, service) => {
        const auth = {
          id: service.id,
          credential: service.credential,
        };
        acc[service.id] = encryptString(JSON.stringify(auth)).data ?? '';
        return acc;
      },
      {} as Record<BuiltinServiceId, string>
    );
    const debridTitleMetadata: DebridTitleMetadata = {
      titles: searchMetadata.titles,
      year: searchMetadata.year,
      season: searchMetadata.season,
      episode: searchMetadata.episode,
      absoluteEpisode: searchMetadata.absoluteEpisode,
    };
    const metadataId = getSimpleTextHash(JSON.stringify(debridTitleMetadata));
    await metadataStore().set(
      metadataId,
      debridTitleMetadata,
      Env.BUILTIN_PLAYBACK_LINK_VALIDITY
    );

    const resultStreams = await Promise.all(
      [...processedTorrents.results, ...processedNzbs.results].map((result) =>
        this._createStream(result, encryptedStoreAuths, metadataId)
      )
    );

    const processingErrors = [
      ...processedTorrents.errors,
      ...processedNzbs.errors,
    ].map((error) => {
      let errMsg = error.error.message;
      if (error instanceof DebridError) {
        switch (error.code) {
          case 'UNAUTHORIZED':
            errMsg = 'Invalid Credentials';
        }
      }
      return this._createErrorStream({
        title: `${this.name}`,
        description: `[${constants.SERVICE_DETAILS[error.serviceId].shortName}] ${errMsg}`,
      });
    });

    return [...resultStreams, ...searchErrors, ...processingErrors];
  }

  protected buildQueries(
    parsedId: ParsedId,
    metadata: SearchMetadata,
    options?: {
      addYear?: boolean;
      addSeasonEpisode?: boolean;
      useAllTitles?: boolean;
    }
  ): string[] {
    const { addYear, addSeasonEpisode, useAllTitles } = {
      addYear: true,
      addSeasonEpisode: true,
      useAllTitles: false,
      ...options,
    };
    let queries: string[] = [];
    if (!metadata.primaryTitle) {
      return [];
    }
    const titles = useAllTitles
      ? metadata.titles.slice(0, Env.BUILTIN_SCRAPE_TITLE_LIMIT).map(cleanTitle)
      : [metadata.primaryTitle];
    const titlePlaceholder = '<___title___>';
    const addQuery = (query: string) => {
      titles.forEach((title) => {
        queries.push(query.replace(titlePlaceholder, title));
      });
    };
    if (parsedId.mediaType === 'movie' || !addSeasonEpisode) {
      addQuery(
        `${titlePlaceholder}${metadata.year && addYear ? ` ${metadata.year}` : ''}`
      );
    } else {
      if (
        parsedId.season &&
        (parsedId.episode ? Number(parsedId.episode) < 100 : true)
      ) {
        addQuery(
          `${titlePlaceholder} S${parsedId.season!.toString().padStart(2, '0')}`
        );
      }
      if (metadata.absoluteEpisode) {
        addQuery(
          `${titlePlaceholder} ${metadata.absoluteEpisode!.toString().padStart(2, '0')}`
        );
      } else if (parsedId.episode && !parsedId.season) {
        addQuery(
          `${titlePlaceholder} E${parsedId.episode!.toString().padStart(2, '0')}`
        );
      }
      if (parsedId.season && parsedId.episode) {
        addQuery(
          `${titlePlaceholder} S${parsedId.season!.toString().padStart(2, '0')}E${parsedId.episode!.toString().padStart(2, '0')}`
        );
      }
    }
    return queries;
  }

  protected abstract _searchTorrents(
    parsedId: ParsedId,
    metadata: SearchMetadata
  ): Promise<UnprocessedTorrent[]>;
  protected abstract _searchNzbs(
    parsedId: ParsedId,
    metadata: SearchMetadata
  ): Promise<NZB[]>;

  protected async _getSearchMetadata(
    parsedId: ParsedId,
    type: string
  ): Promise<SearchMetadata> {
    const start = Date.now();

    const animeEntry = AnimeDatabase.getInstance().getEntryById(
      parsedId.type,
      parsedId.value
    );

    // Update season from anime entry if available
    if (animeEntry && !parsedId.season) {
      parsedId.season =
        animeEntry.imdb?.fromImdbSeason?.toString() ??
        animeEntry.trakt?.season?.number?.toString();
      if (
        animeEntry.imdb?.fromImdbEpisode &&
        animeEntry.imdb?.fromImdbEpisode !== 1 &&
        parsedId.episode &&
        ['malId', 'kitsuId'].includes(parsedId.type)
      ) {
        parsedId.episode = (
          animeEntry.imdb.fromImdbEpisode +
          Number(parsedId.episode) -
          1
        ).toString();
      }
    }

    const metadata = await new MetadataService({
      tmdbAccessToken: this.userData.tmdbReadAccessToken,
      tmdbApiKey: this.userData.tmdbApiKey,
      tvdbApiKey: this.userData.tvdbApiKey,
    }).getMetadata(parsedId, type === 'movie' ? 'movie' : 'series');

    // Calculate absolute episode if needed
    let absoluteEpisode: number | undefined;
    if (animeEntry && parsedId.season && parsedId.episode && metadata.seasons) {
      const seasons = metadata.seasons.map(
        ({ season_number, episode_count }) => ({
          number: season_number.toString(),
          episodes: episode_count,
        })
      );
      this.logger.debug(
        `Calculating absolute episode with current season and episode: ${parsedId.season}, ${parsedId.episode} and seasons: ${JSON.stringify(seasons)}`
      );
      // Calculate base absolute episode
      absoluteEpisode = Number(
        calculateAbsoluteEpisode(parsedId.season, parsedId.episode, seasons)
      );

      // Adjust for non-IMDB episodes if they exist
      if (
        animeEntry?.imdb?.nonImdbEpisodes &&
        absoluteEpisode &&
        parsedId.type === 'imdbId'
      ) {
        const nonImdbEpisodesBefore = animeEntry.imdb.nonImdbEpisodes.filter(
          (ep) => ep < absoluteEpisode!
        ).length;
        if (nonImdbEpisodesBefore > 0) {
          absoluteEpisode += nonImdbEpisodesBefore;
        }
      }
    }

    // // Map IDs
    const imdbId =
      parsedId.type === 'imdbId'
        ? parsedId.value.toString()
        : animeEntry?.mappings?.imdbId?.toString();
    // const tmdbId =
    //   parsedId.type === 'themoviedbId'
    //     ? parsedId.value.toString()
    //     : (animeEntry?.mappings?.themoviedbId?.toString() ?? null);
    // const tvdbId =
    //   parsedId.type === 'thetvdbId'
    //     ? parsedId.value.toString()
    //     : (animeEntry?.mappings?.thetvdbId?.toString() ?? null);

    const searchMetadata: SearchMetadata = {
      primaryTitle: metadata.title,
      titles: metadata.titles ?? [],
      season: parsedId.season ? Number(parsedId.season) : undefined,
      episode: parsedId.episode ? Number(parsedId.episode) : undefined,
      absoluteEpisode,
      year: metadata.year,
      imdbId,
      tmdbId: metadata.tmdbId ?? null,
      tvdbId: metadata.tvdbId ?? null,
      isAnime: animeEntry ? true : false,
    };

    this.logger.debug(
      `Got search metadata for ${parsedId.type}:${parsedId.value} in ${getTimeTakenSincePoint(start)}`,
      {
        ...searchMetadata,
        titles: searchMetadata.titles.length,
      }
    );

    return searchMetadata;
  }

  protected _createStream(
    torrentOrNzb: TorrentWithSelectedFile | NZBWithSelectedFile,
    encryptedStoreAuths: Record<BuiltinServiceId, string>,
    metadataId: string
  ): Stream {
    // Handle debrid streaming
    const encryptedStoreAuth = torrentOrNzb.service
      ? encryptedStoreAuths?.[torrentOrNzb.service?.id]
      : undefined;

    const fileInfo: FileInfo | undefined = torrentOrNzb.service
      ? torrentOrNzb.type === 'torrent'
        ? {
            type: 'torrent',
            hash: torrentOrNzb.hash,
            sources: torrentOrNzb.sources,
            index: torrentOrNzb.file.index,
            cacheAndPlay:
              this.userData.cacheAndPlay?.enabled &&
              this.userData.cacheAndPlay?.streamTypes?.includes('torrent'),
          }
        : {
            type: 'usenet',
            nzb: torrentOrNzb.nzb,
            hash: torrentOrNzb.hash,
            index: torrentOrNzb.file.index,
            cacheAndPlay:
              this.userData.cacheAndPlay?.enabled &&
              this.userData.cacheAndPlay?.streamTypes?.includes('usenet'),
          }
      : undefined;

    const svcMeta = torrentOrNzb.service
      ? SERVICE_DETAILS[torrentOrNzb.service.id]
      : undefined;
    // const svcMeta = SERVICE_DETAILS[torrentOrNzb.service.id];
    const shortCode = svcMeta?.shortName || 'P2P';
    const cacheIndicator = torrentOrNzb.service
      ? torrentOrNzb.service.cached
        ? '⚡'
        : '⏳'
      : '';

    const name = `[${shortCode} ${cacheIndicator}${torrentOrNzb.service?.owned ? ' ☁️' : ''}] ${this.name}`;
    const description = `${torrentOrNzb.title}\n${torrentOrNzb.file.name}\n${
      torrentOrNzb.indexer ? `🔍 ${torrentOrNzb.indexer}` : ''
    } ${'seeders' in torrentOrNzb && torrentOrNzb.seeders ? `👤 ${torrentOrNzb.seeders}` : ''} ${
      torrentOrNzb.age && torrentOrNzb.age !== '0d'
        ? `🕒 ${torrentOrNzb.age}`
        : ''
    }`;

    return {
      url: torrentOrNzb.service
        ? generatePlaybackUrl(
            encryptedStoreAuth!,
            metadataId!,
            fileInfo!,
            torrentOrNzb.title,
            torrentOrNzb.file.name
          )
        : undefined,
      name,
      description,
      type: torrentOrNzb.type,
      infoHash: torrentOrNzb.hash,
      fileIdx: torrentOrNzb.file.index,
      behaviorHints: {
        videoSize: torrentOrNzb.file.size,
        filename: torrentOrNzb.file.name,
      },
    };
  }

  protected _createErrorStream({
    title,
    description,
  }: {
    title: string;
    description: string;
  }): Stream {
    return {
      name: `[❌] ${title}`,
      description: description,
      externalUrl: 'stremio:///',
    };
  }
}
