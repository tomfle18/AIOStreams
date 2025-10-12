import { Headers } from 'undici';
import { Env, Cache, makeRequest, ParsedId, IdType } from '../utils/index.js';
import { Metadata } from './utils.js';
import { z } from 'zod';

export type TMDBIdType = 'imdb_id' | 'tmdb_id' | 'tvdb_id';

// interface ExternalId {
//   type: ExternalIdType;
//   value: string;
// }

const API_BASE_URL = 'https://api.themoviedb.org/3';
const FIND_BY_ID_PATH = '/find';
const MOVIE_DETAILS_PATH = '/movie';
const MOVIE_TRANSLATIONS_PATH = (id: string) => `/movie/${id}/translations`;
const TV_DETAILS_PATH = '/tv';
const TV_TRANSLATIONS_PATH = (id: string) => `/tv/${id}/translations`;
const ALTERNATIVE_TITLES_PATH = '/alternative_titles';

// Cache TTLs in seconds
const ID_CACHE_TTL = 30 * 24 * 60 * 60; // 30 days
const TITLE_CACHE_TTL = 7 * 24 * 60 * 60; // 7 days
const AUTHORISATION_CACHE_TTL = 2 * 24 * 60 * 60; // 2 days

// Zod schemas for API responses
const MovieDetailsSchema = z.object({
  id: z.number(),
  title: z.string(),
  release_date: z.string().optional(),
  status: z.string(),
});

const TVDetailsSchema = z.object({
  id: z.number(),
  name: z.string(),
  first_air_date: z.string().optional(),
  last_air_date: z.string().optional(),
  status: z.string(),
  seasons: z.array(
    z.object({
      season_number: z.number(),
      episode_count: z.number(),
    })
  ),
});

const MovieAlternativeTitlesSchema = z.object({
  titles: z.array(
    z.object({
      title: z.string(),
    })
  ),
});

const TVAlternativeTitlesSchema = z.object({
  results: z.array(
    z.object({
      title: z.string(),
    })
  ),
});

const BaseTranslationsSchema = z.object({
  iso_3166_1: z.string(),
  iso_639_1: z.string(),
  name: z.string(),
  english_name: z.string(),
});

const TVTranslationsSchema = z.object({
  id: z.number(),
  translations: z.array(
    BaseTranslationsSchema.extend({
      data: z.object({
        title: z.string(),
      }),
    })
  ),
});

const MovieTranslationsSchema = z.object({
  id: z.number(),
  translations: z.array(
    BaseTranslationsSchema.extend({
      data: z.object({
        name: z.string(),
      }),
    })
  ),
});

const FindResultsSchema = z.object({
  movie_results: z.array(
    z.object({
      id: z.number(),
    })
  ),
  tv_results: z.array(
    z.object({
      id: z.number(),
    })
  ),
});

const IdTypeMap: Partial<Record<IdType, TMDBIdType>> = {
  imdbId: 'imdb_id',
  thetvdbId: 'tvdb_id',
  themoviedbId: 'tmdb_id',
};

export class TMDBMetadata {
  private readonly TMDB_ID_REGEX = /^(?:tmdb)[-:](\d+)(?::\d+:\d+)?$/;
  private readonly TVDB_ID_REGEX = /^(?:tvdb)[-:](\d+)(?::\d+:\d+)?$/;
  private readonly IMDB_ID_REGEX = /^(?:tt)(\d+)(?::\d+:\d+)?$/;
  private static readonly idCache: Cache<string, string> = Cache.getInstance<
    string,
    string
  >('tmdb_id_conversion');
  private static readonly metadataCache: Cache<string, Metadata> =
    Cache.getInstance<string, Metadata>('tmdb_metadata');
  private readonly accessToken: string | undefined;
  private readonly apiKey: string | undefined;
  private static readonly validationCache: Cache<string, boolean> =
    Cache.getInstance<string, boolean>('tmdb_validation');
  public constructor(auth?: { accessToken?: string; apiKey?: string }) {
    if (
      !auth?.accessToken &&
      !Env.TMDB_ACCESS_TOKEN &&
      !auth?.apiKey &&
      !Env.TMDB_API_KEY
    ) {
      throw new Error('TMDB Access Token or API Key is not set');
    }
    if (auth?.apiKey || Env.TMDB_API_KEY) {
      this.apiKey = auth?.apiKey || Env.TMDB_API_KEY;
    } else if (auth?.accessToken || Env.TMDB_ACCESS_TOKEN) {
      this.accessToken = auth?.accessToken || Env.TMDB_ACCESS_TOKEN;
    }
  }

  private getHeaders(): Headers {
    const headers = new Headers();
    if (this.accessToken) {
      headers.set('Authorization', `Bearer ${this.accessToken}`);
    }
    headers.set('Content-Type', 'application/json');
    return headers;
  }

  private async convertToTmdbId(parsedId: ParsedId): Promise<string> {
    if (parsedId.type === 'themoviedbId') {
      return parsedId.value.toString();
    }

    // Check cache first
    const cacheKey = `${parsedId.type}:${parsedId.value}:${parsedId.mediaType}`;
    const cachedId = await TMDBMetadata.idCache.get(cacheKey);
    if (cachedId) {
      return cachedId;
    }

    const url = new URL(API_BASE_URL + FIND_BY_ID_PATH + `/${parsedId.value}`);
    url.searchParams.set('external_source', `${IdTypeMap[parsedId.type]}`);
    this.addSearchParams(url);
    const response = await makeRequest(url.toString(), {
      timeout: 5000,
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      throw new Error(`${response.status} - ${response.statusText}`);
    }

    const data = FindResultsSchema.parse(await response.json());
    const results =
      parsedId.mediaType === 'movie' ? data.movie_results : data.tv_results;
    const meta = results[0];

    if (!meta) {
      throw new Error(
        `No ${parsedId.mediaType} metadata found for ID: ${parsedId.type}:${parsedId.value}`
      );
    }

    const tmdbId = meta.id.toString();
    // Cache the result
    TMDBMetadata.idCache.set(cacheKey, tmdbId, ID_CACHE_TTL);
    return tmdbId;
  }

  private parseReleaseDate(releaseDate: string | undefined): string {
    if (!releaseDate) return '0';
    const date = new Date(releaseDate);
    return date.getFullYear().toString();
  }

  public async getMetadata(parsedId: ParsedId): Promise<Metadata> {
    if (!['movie', 'series', 'anime'].includes(parsedId.mediaType)) {
      throw new Error(`Invalid media type: ${parsedId.mediaType}`);
    }
    if (!['imdbId', 'thetvdbId', 'themoviedbId'].includes(parsedId.type)) {
      throw new Error(`Invalid ID type: ${parsedId.type}`);
    }

    const tmdbId = await this.convertToTmdbId(parsedId);

    // Check cache first
    const cacheKey = `${tmdbId}:${parsedId.mediaType}`;
    const cachedMetadata = await TMDBMetadata.metadataCache.get(cacheKey);
    if (cachedMetadata) {
      return { ...cachedMetadata, tmdbId: Number(tmdbId) };
    }

    // Fetch primary title from details endpoint
    const detailsUrl = new URL(
      API_BASE_URL +
        (parsedId.mediaType === 'movie'
          ? MOVIE_DETAILS_PATH
          : TV_DETAILS_PATH) +
        `/${tmdbId}`
    );
    this.addSearchParams(detailsUrl);
    const detailsResponse = await makeRequest(detailsUrl.toString(), {
      timeout: 5000,
      headers: this.getHeaders(),
    });

    if (!detailsResponse.ok) {
      throw new Error(`Failed to fetch details: ${detailsResponse.statusText}`);
    }

    const detailsJson = await detailsResponse.json();
    const detailsData =
      parsedId.mediaType === 'movie'
        ? MovieDetailsSchema.parse(detailsJson)
        : TVDetailsSchema.parse(detailsJson);

    const primaryTitle =
      parsedId.mediaType === 'movie'
        ? (detailsData as z.infer<typeof MovieDetailsSchema>).title
        : (detailsData as z.infer<typeof TVDetailsSchema>).name;
    const year = this.parseReleaseDate(
      parsedId.mediaType === 'movie'
        ? (detailsData as z.infer<typeof MovieDetailsSchema>).release_date
        : (detailsData as z.infer<typeof TVDetailsSchema>).first_air_date
    );
    const yearEnd =
      parsedId.mediaType !== 'movie'
        ? (detailsData as z.infer<typeof TVDetailsSchema>).last_air_date
          ? this.parseReleaseDate(
              (detailsData as z.infer<typeof TVDetailsSchema>).last_air_date
            )
          : undefined
        : undefined;
    const seasons =
      parsedId.mediaType !== 'movie'
        ? (detailsData as z.infer<typeof TVDetailsSchema>).seasons
        : undefined;

    // Fetch alternative titles and translations in parallel
    const altTitlesUrl = new URL(
      API_BASE_URL +
        (parsedId.mediaType === 'movie'
          ? MOVIE_DETAILS_PATH
          : TV_DETAILS_PATH) +
        `/${tmdbId}` +
        ALTERNATIVE_TITLES_PATH
    );
    const translatedTitlesUrl = new URL(
      API_BASE_URL +
        (parsedId.mediaType === 'movie'
          ? MOVIE_TRANSLATIONS_PATH(tmdbId)
          : TV_TRANSLATIONS_PATH(tmdbId))
    );
    this.addSearchParams(altTitlesUrl);
    this.addSearchParams(translatedTitlesUrl);

    const [altTitlesResult, translationsResult] = await Promise.allSettled([
      makeRequest(altTitlesUrl.toString(), {
        timeout: 5000,
        headers: this.getHeaders(),
      }).then(async (response) => {
        if (!response.ok) {
          throw new Error(
            `Failed to fetch alternative titles: ${response.statusText}`
          );
        }
        const json = await response.json();
        const data =
          parsedId.mediaType === 'movie'
            ? MovieAlternativeTitlesSchema.parse(json)
            : TVAlternativeTitlesSchema.parse(json);
        return parsedId.mediaType === 'movie'
          ? (data as z.infer<typeof MovieAlternativeTitlesSchema>).titles.map(
              (title) => title.title
            )
          : (data as z.infer<typeof TVAlternativeTitlesSchema>).results.map(
              (title) => title.title
            );
      }),
      makeRequest(translatedTitlesUrl.toString(), {
        timeout: 5000,
        headers: this.getHeaders(),
      }).then(async (response) => {
        if (!response.ok) {
          throw new Error(
            `Failed to fetch translations: ${response.statusText}`
          );
        }
        const json = await response.json();
        const data =
          parsedId.mediaType === 'movie'
            ? MovieTranslationsSchema.parse(json)
            : TVTranslationsSchema.parse(json);
        return data.translations
          .map((translation) => {
            if (parsedId.mediaType === 'movie') {
              return (translation.data as { name: string }).name;
            } else {
              return (translation.data as { title: string }).title;
            }
          })
          .filter(Boolean);
      }),
    ]);

    // Collect all successful titles
    const allTitles = [primaryTitle];

    if (altTitlesResult.status === 'fulfilled') {
      allTitles.push(...altTitlesResult.value);
    }

    if (translationsResult.status === 'fulfilled') {
      allTitles.push(...translationsResult.value);
    }

    // If both requests failed, we should throw an error
    if (
      altTitlesResult.status === 'rejected' &&
      translationsResult.status === 'rejected'
    ) {
      throw new Error(
        `Failed to fetch both alternative titles and translations: ${altTitlesResult.reason}, ${translationsResult.reason}`
      );
    }

    const uniqueTitles = [...new Set(allTitles)];
    const metadata: Metadata = {
      title: primaryTitle,
      titles: uniqueTitles,
      year: Number(year),
      yearEnd: yearEnd ? Number(yearEnd) : undefined,
      seasons,
      tmdbId: Number(tmdbId),
      tvdbId: null,
    };
    // Cache the result
    TMDBMetadata.metadataCache.set(cacheKey, metadata, TITLE_CACHE_TTL);
    return { ...metadata, tmdbId: Number(tmdbId) };
  }

  private addSearchParams(url: URL) {
    if (this.apiKey) {
      url.searchParams.set('api_key', this.apiKey);
    }
  }

  public async validateAuthorisation() {
    const cacheKey = this.accessToken || this.apiKey;
    if (!cacheKey) {
      throw new Error('TMDB Access Token or API Key is not set');
    }
    const cachedResult = await TMDBMetadata.validationCache.get(cacheKey);
    if (cachedResult) {
      return cachedResult;
    }
    const url = new URL(API_BASE_URL + '/authentication');
    this.addSearchParams(url);
    const validationResponse = await makeRequest(url.toString(), {
      timeout: 2000,
      headers: this.getHeaders(),
    });
    if (!validationResponse.ok) {
      throw new Error(
        `Failed to validate TMDB authorisation, ensure you have set a valid access token or API key: ${validationResponse.statusText}`
      );
    }
    const validationData: any = await validationResponse.json();
    const isValid = validationData.success;
    TMDBMetadata.validationCache.set(
      cacheKey,
      isValid,
      AUTHORISATION_CACHE_TTL
    );
    return isValid;
  }
}
