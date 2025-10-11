import { Addon, Option, Stream, UserData } from '../db/index.js';
import { Preset, baseOptions } from './preset.js';
import { Env, RESOURCES, ServiceId, constants } from '../utils/index.js';
import { BuiltinAddonPreset } from './builtin.js';

export class NewznabPreset extends BuiltinAddonPreset {
  static override get METADATA() {
    const supportedResources = [constants.STREAM_RESOURCE];
    const options: Option[] = [
      {
        id: 'name',
        name: 'Name',
        description: 'What to call this addon',
        type: 'string',
        required: true,
        default: 'Newznab',
      },
      {
        id: 'newznabUrl',
        name: 'Newznab URL',
        description: 'Provide the URL to the Newznab endpoint ',
        type: 'url',
        required: true,
      },
      {
        id: 'apiKey',
        name: 'API Key',
        description:
          'The password for the Newznab API. This is used to authenticate with the Newznab endpoint.',
        type: 'password',
        required: false,
      },
      {
        id: 'apiPath',
        name: 'API Path',
        description: 'The path to the Newznab API. Usually /api.',
        type: 'string',
        required: false,
        default: '/api',
      },
      {
        id: 'proxyAuth',
        name: 'AIOStreams Proxy Auth',
        description:
          'If you want to proxy the NZBs through AIOStreams, provide a username:password pair from the `BUILTIN_PROXY_AUTH` environment variable.',
        type: 'password',
        required: false,
      },
      {
        id: 'timeout',
        name: 'Timeout',
        description: 'The timeout for this addon',
        type: 'number',
        default: Env.DEFAULT_TIMEOUT,
        constraints: {
          min: Env.MIN_TIMEOUT,
          max: Env.MAX_TIMEOUT,
          forceInUi: false,
        },
      },
      {
        id: 'mediaTypes',
        name: 'Media Types',
        description:
          'Limits this addon to the selected media types for streams. For example, selecting "Movie" means this addon will only be used for movie streams (if the addon supports them). Leave empty to allow all.',
        type: 'multi-select',
        required: false,
        showInNoobMode: false,
        default: [],
        options: [
          {
            label: 'Movie',
            value: 'movie',
          },
          {
            label: 'Series',
            value: 'series',
          },
          {
            label: 'Anime',
            value: 'anime',
          },
        ],
      },
      {
        id: 'forceQuerySearch',
        name: 'Force Query Search',
        description: 'Force the addon to use the query search parameter',
        type: 'boolean',
        required: false,
        default: false,
      },
    ];

    return {
      ID: 'newznab',
      NAME: 'Newznab',
      LOGO: '',
      URL: `${Env.INTERNAL_URL}/builtins/newznab`,
      TIMEOUT: Env.DEFAULT_TIMEOUT,
      USER_AGENT: Env.DEFAULT_USER_AGENT,
      SUPPORTED_SERVICES: [constants.TORBOX_SERVICE],
      DESCRIPTION: 'An addon to get usenet results from a Newznab endpoint.',
      OPTIONS: options,
      SUPPORTED_STREAM_TYPES: [constants.USENET_STREAM_TYPE],
      SUPPORTED_RESOURCES: supportedResources,
      BUILTIN: true,
    };
  }

  static async generateAddons(
    userData: UserData,
    options: Record<string, any>
  ): Promise<Addon[]> {
    const usableServices = this.getUsableServices(userData, options.services);
    if (!usableServices || usableServices.length === 0) {
      throw new Error(
        `${this.METADATA.NAME} requires at least one usable service, but none were found. Please enable at least one of the following services: ${this.METADATA.SUPPORTED_SERVICES.join(
          ', '
        )}`
      );
    }
    return [
      this.generateAddon(
        userData,
        options,
        usableServices.map((service) => service.id)
      ),
    ];
  }

  private static generateAddon(
    userData: UserData,
    options: Record<string, any>,
    services: ServiceId[]
  ): Addon {
    return {
      name: options.name || this.METADATA.NAME,
      manifestUrl: this.generateManifestUrl(userData, services, options),
      enabled: true,
      library: options.libraryAddon ?? false,
      resources: options.resources || undefined,
      mediaTypes: options.mediaTypes || [],
      timeout: options.timeout || this.METADATA.TIMEOUT,
      preset: {
        id: '',
        type: this.METADATA.ID,
        options: options,
      },
      formatPassthrough:
        options.formatPassthrough ?? options.streamPassthrough ?? false,
      resultPassthrough: options.resultPassthrough ?? false,
      forceToTop: options.forceToTop ?? false,
      headers: {
        'User-Agent': this.METADATA.USER_AGENT,
      },
    };
  }

  protected static generateManifestUrl(
    userData: UserData,
    services: ServiceId[],
    options: Record<string, any>
  ) {
    const config = {
      ...this.getBaseConfig(userData, services),
      url: options.newznabUrl,
      apiPath: options.apiPath,
      apiKey: options.apiKey,
      proxyAuth: options.proxyAuth,
      forceQuerySearch: options.forceQuerySearch ?? false,
    };

    const configString = this.base64EncodeJSON(config, 'urlSafe');
    return `${this.METADATA.URL}/${configString}/manifest.json`;
  }
}
