export type MapProvider = 'google' | 'tencent' | 'amap';
export type MapMode = '2d' | '3d';

export interface MapProviderConfig {
  id: MapProvider;
  label: string;
  urls: string[];
  attribution: string;
  subdomains?: string[];
  maxZoom?: number;
}

export const MAP_PROVIDER_LIST: MapProviderConfig[] = [
  {
    id: 'google',
    label: '谷歌地图',
    urls: ['https://mt{s}.google.com/vt/lyrs=m&x={x}&y={y}&z={z}&hl=zh-CN'],
    attribution: '&copy; Google Maps',
    subdomains: ['0', '1', '2', '3'],
    maxZoom: 20,
  },
  {
    id: 'tencent',
    label: '腾讯地图',
    urls: ['https://rt{s}.map.gtimg.com/tile?z={z}&x={x}&y={-y}&styleid=0&scene=0'],
    attribution: '&copy; 腾讯地图',
    subdomains: ['0', '1', '2', '3'],
    maxZoom: 19,
  },
  {
    id: 'amap',
    label: '高德地图',
    urls: [
      'https://wprd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scl=1&style=7&x={x}&y={y}&z={z}',
      'https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scl=1&style=7&x={x}&y={y}&z={z}',
    ],
    attribution: '&copy; 高德地图',
    subdomains: ['1', '2', '3', '4'],
    maxZoom: 19,
  },
];

export const MAP_PROVIDERS: Record<MapProvider, MapProviderConfig> =
  MAP_PROVIDER_LIST.reduce((acc, provider) => {
    acc[provider.id] = provider;
    return acc;
  }, {} as Record<MapProvider, MapProviderConfig>);
