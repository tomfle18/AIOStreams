import { z } from 'zod';
import {
  constants,
  createLogger,
  BuiltinServiceId,
  Env,
  Cache,
  getSimpleTextHash,
  encryptString,
} from '../utils/index.js';
import {
  DebridFile,
  DebridDownload,
  PlaybackInfo,
  ServiceAuth,
  FileInfo,
  TitleMetadata,
} from './base.js';
import { normaliseTitle, titleMatch } from '../parser/utils.js';
import { partial_ratio } from 'fuzzball';

const logger = createLogger('debrid');

export const BuiltinDebridServices = z.array(
  z.object({
    id: z.enum(constants.BUILTIN_SUPPORTED_SERVICES),
    credential: z.string(),
  })
);

export type BuiltinDebridServices = z.infer<typeof BuiltinDebridServices>;

interface BaseFile {
  title?: string;
  size: number;
  index?: number;
  indexer?: string;
  seeders?: number;
  age?: string;
}

export interface Torrent extends BaseFile {
  type: 'torrent';
  downloadUrl?: string;
  sources: string[];
  hash: string;
  files?: DebridFile[];
  // magnet?: string;
}

export interface UnprocessedTorrent extends BaseFile {
  type: 'torrent';
  hash?: string;
  downloadUrl?: string;
  sources: string[];
}

export interface NZB extends BaseFile {
  type: 'usenet';
  hash: string;
  nzb: string;
}

export interface TorrentWithSelectedFile extends Torrent {
  file: DebridFile;
  service?: {
    id: BuiltinServiceId;
    cached: boolean;
    owned: boolean;
  };
}

export interface NZBWithSelectedFile extends NZB {
  file: DebridFile;
  service?: {
    id: BuiltinServiceId;
    cached: boolean;
    owned: boolean;
  };
}

// helpers
export const isSeasonWrong = (
  parsed: { seasons?: number[]; episodes?: number[] },
  metadata?: { season?: number; absoluteEpisode?: number }
) => {
  if (
    parsed.seasons?.length &&
    metadata?.season &&
    !parsed.seasons.includes(metadata.season)
  ) {
    // allow if season is "wrong" with value of 1 but absolute episode is correct
    if (
      parsed.seasons.length === 1 &&
      parsed.seasons[0] === 1 &&
      parsed.episodes?.length &&
      metadata.absoluteEpisode &&
      parsed.episodes.includes(metadata.absoluteEpisode)
    ) {
      return false;
    }
    return true;
  }
  return false;
};
export const isEpisodeWrong = (
  parsed: { episodes?: number[] },
  metadata?: { episode?: number; absoluteEpisode?: number }
) => {
  if (
    parsed.episodes?.length &&
    metadata?.episode &&
    !(
      parsed.episodes.includes(metadata.episode) ||
      (metadata.absoluteEpisode &&
        parsed.episodes.includes(metadata.absoluteEpisode))
    )
  ) {
    return true;
  }
  return false;
};
export const isTitleWrong = (
  parsed: { title?: string },
  metadata?: { titles?: string[] }
) => {
  if (
    parsed.title &&
    metadata?.titles &&
    !titleMatch(
      normaliseTitle(parsed.title),
      metadata.titles.map(normaliseTitle),
      { threshold: 0.8, scorer: partial_ratio }
    )
  ) {
    return true;
  }
  return false;
};

export async function selectFileInTorrentOrNZB(
  torrentOrNZB: Torrent | NZB,
  debridDownload: DebridDownload,
  parsedFiles: Map<
    string,
    {
      title?: string;
      seasons?: number[];
      episodes?: number[];
      year?: string;
    }
  >,

  metadata?: {
    titles: string[];
    year?: number;
    season?: number;
    episode?: number;
    absoluteEpisode?: number;
  },
  options?: {
    chosenFilename?: string;
    chosenIndex?: number;
  }
): Promise<DebridFile | undefined> {
  if (!debridDownload.files?.length) {
    return {
      name: torrentOrNZB.title,
      size: torrentOrNZB.size,
      index: -1,
    };
  }

  const isVideo = debridDownload.files.map((file) => isVideoFile(file));

  // Create a scoring system for each file
  const fileScores = debridDownload.files.map((file, index) => {
    let score = 0;
    const parsed = parsedFiles.get(file.name ?? '');

    if (!parsed) {
      logger.warn(`Parsed file not found for ${file.name}`);
    }

    // Base score from video file status (highest priority)
    if (isVideo[index]) {
      score += 1000;
    }

    if (
      !(metadata?.season && metadata?.episode && metadata?.absoluteEpisode) &&
      metadata?.year &&
      parsed?.year
    ) {
      if (metadata.year === Number(parsed.year)) {
        score += 500;
      }
    }

    // Season/Episode matching (second highest priority)
    if (parsed && !isSeasonWrong(parsed, metadata)) {
      score += 500;
    }
    if (parsed && !isEpisodeWrong(parsed, metadata)) {
      score += 500;
    }

    // Title matching (third priority)
    if (parsed && !isTitleWrong(parsed, metadata)) {
      score += 100;
    }

    // Size based score (lowest priority but still relevant)
    // We normalize the size to be between 0 and 50 points
    const files = debridDownload.files || [];
    const maxSize =
      torrentOrNZB.size || files.reduce((max, f) => Math.max(max, f.size), 0);
    score += maxSize > 0 ? (file.size / maxSize) * 50 : 0;

    // Small boost for chosen index/filename if provided
    if (options?.chosenIndex === index) {
      score += 25;
    }
    if (
      options?.chosenFilename &&
      torrentOrNZB.title?.includes(options.chosenFilename)
    ) {
      score += 25;
    }
    return {
      file,
      score,
      index,
    };
  });

  // Sort by score descending
  fileScores.sort((a, b) => b.score - a.score);

  // Select the best matching file
  const bestMatch = fileScores[0];
  // return bestMatch.file;
  const parsedFile = parsedFiles.get(bestMatch.file.name ?? '');
  const parsedTitle = parsedFiles.get(torrentOrNZB.title ?? '');

  if (metadata && parsedFile && parsedTitle) {
    // if (
    //   !isSeasonWrong(parsed, metadata) &&
    //   !isSeasonWrong(parsedTorrentOrNZB, metadata)
    // ) {
    //   logger.debug(
    //     `Season ${metadata.season} not found in ${torrentOrNZB.title} and ${bestMatch.file.name}, skipping...`
    //   );
    //   return undefined;
    // }
    if (
      isEpisodeWrong(parsedFile, metadata) ||
      isEpisodeWrong(parsedTitle, metadata)
    ) {
      logger.debug(
        `Episode ${metadata.episode} or ${metadata.absoluteEpisode} not found in ${torrentOrNZB.title} and ${bestMatch.file.name}, skipping...`
      );
      return undefined;
    }
    // if (
    //   !titleMatchHelper(parsed, metadata) &&
    //   !titleMatchHelper(parsedTorrentOrNZB, metadata)
    // ) {
    //   logger.debug(
    //     `Title ${torrentOrNZB.title} and ${bestMatch.file.name} does not match ${metadata.titles.join(', ')}, skipping...`
    //   );
    //   return undefined;
    // }
  }
  return bestMatch.file;
}

export function isVideoFile(file: DebridFile): boolean {
  const videoExtensions = [
    '.3g2',
    '.3gp',
    '.amv',
    '.asf',
    '.avi',
    '.drc',
    '.f4a',
    '.f4b',
    '.f4p',
    '.f4v',
    '.flv',
    '.gif',
    '.gifv',
    '.m2v',
    '.m4p',
    '.m4v',
    '.mkv',
    '.mov',
    '.mp2',
    '.mp4',
    '.mpg',
    '.mpeg',
    '.mpv',
    '.mng',
    '.mpe',
    '.mxf',
    '.nsv',
    '.ogg',
    '.ogv',
    '.qt',
    '.rm',
    '.rmvb',
    '.roq',
    '.svi',
    '.webm',
    '.wmv',
    '.yuv',
    '.m3u8',
    '.m2ts',
  ];

  return (
    file.mimeType?.includes('video') ||
    videoExtensions.some((ext) => file.name?.endsWith(ext) ?? false)
  );
}

export const metadataStore = () => {
  const prefix = 'mds';
  const store: 'redis' | 'sql' | 'memory' =
    Env.BUILTIN_DEBRID_METADATA_STORE || (Env.REDIS_URI ? 'redis' : 'sql');
  return Cache.getInstance<string, TitleMetadata>(prefix, 1_000_000_000, store);
};

// export function generatePlaybackUrl(
//   storeAuth: ServiceAuth,
//   playbackInfo: MinimisedPlaybackInfo,
//   filename: string
// ) {
//   const encryptedStoreAuth = encryptString(JSON.stringify(storeAuth));
//   if (!encryptedStoreAuth.success) {
//     throw new Error('Failed to encrypt store auth');
//   }
//   const playbackId = getSimpleTextHash(JSON.stringify(playbackInfo));
//   pbiCache().set(playbackId, playbackInfo, Env.BUILTIN_PLAYBACK_LINK_VALIDITY);
//   return `${Env.BASE_URL}/api/v1/debrid/playback/${encryptedStoreAuth.data}/${playbackId}/${encodeURIComponent(filename)}`;
// }

export function generatePlaybackUrl(
  encryptedStoreAuth: string,
  metadataId: string,
  fileInfo: FileInfo,
  title?: string,
  filename?: string
): string {
  return `${Env.BASE_URL}/api/v1/debrid/playback/${encryptedStoreAuth}/${Buffer.from(JSON.stringify(fileInfo)).toString('base64')}/${metadataId}/${encodeURIComponent(filename ?? title ?? 'unknown')}`;
}
