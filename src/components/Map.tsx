import { useEffect, useMemo, useState } from 'react';
import { GeoJSON, MapContainer, Marker, TileLayer, Tooltip, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { feature } from 'topojson-client';
import worldAtlas110m from 'world-atlas/countries-110m.json';
import { CityData } from '../lib/gemini';
import { MAP_PROVIDERS, MapMode, MapProvider } from '../lib/mapProviders';
import GlobalNeonMap from './GlobalNeonMap';
import { FollowupTarget, UiTheme } from '../lib/ui';

const WORLD_CENTER: [number, number] = [20, 0];
const WORLD_ZOOM = 2;
const WORLD_BOUNDS = L.latLngBounds([-58, -180], [78, 180]);
const BROAD_LOCATION_ZOOM = 4;
const CITY_LOCATION_ZOOM = 8;
const BROAD_LOCATION_NAMES = new Set([
  '中国',
  '美国',
  '加拿大',
  '巴西',
  '阿根廷',
  '智利',
  '墨西哥',
  '澳大利亚',
  '新西兰',
  '俄罗斯',
  '印度',
  '印度尼西亚',
  '马来西亚',
  '菲律宾',
  '泰国',
  '缅甸',
  '越南',
  '新加坡',
  '日本',
  '韩国',
  '英国',
  '法国',
  '德国',
  '意大利',
  '西班牙',
  '葡萄牙',
  '荷兰',
  '南非',
  '埃及',
  '欧洲',
  '亚洲',
  '非洲',
  '北美洲',
  '南美洲',
  '大洋洲',
  '东南亚',
  '中东',
  '拉美',
  '南洋',
]);

const getWorldGeoJson = () => {
  const topo = worldAtlas110m as any;
  const countriesObject = (topo.objects as Record<string, object>).countries;
  return feature(topo, countriesObject as never) as any;
};

const isValidCity = (city: CityData | undefined | null): city is CityData =>
  !!city &&
  typeof city.lat === 'number' &&
  Number.isFinite(city.lat) &&
  typeof city.lng === 'number' &&
  Number.isFinite(city.lng);

const getCityDisplayInfo = (city: CityData, showReferences: boolean) =>
  showReferences ? city.infoWithReferences ?? city.info : city.info;

const getSingleLocationZoom = (city: CityData) =>
  BROAD_LOCATION_NAMES.has(city.name.trim()) ? BROAD_LOCATION_ZOOM : CITY_LOCATION_ZOOM;

const createGlowingIcon = () =>
  L.divIcon({
    className: 'bg-transparent border-none',
    html: `<div class="relative flex h-8 w-8 items-center justify-center">
            <div class="absolute inline-flex h-full w-full animate-[pulse_2s_infinite] rounded-full bg-[#4ade80] opacity-80" style="filter: blur(2px);"></div>
            <div class="relative inline-flex h-4 w-4 rounded-full bg-[#4ade80] shadow-[0_0_15px_rgba(74,222,128,1),0_0_40px_rgba(74,222,128,0.8)]"></div>
           </div>`,
    iconSize: [32, 32],
    iconAnchor: [16, 16],
  });

function MapEventHandler({
  highlightedCities,
  provider,
}: {
  highlightedCities: CityData[];
  provider: MapProvider;
}) {
  const map = useMap();

  useEffect(() => {
    const invalidateTimer = window.setTimeout(() => {
      map.invalidateSize();
    }, 80);

    const validCities = highlightedCities.filter(isValidCity);

    if (validCities.length > 0) {
      if (validCities.length === 1) {
        map.flyTo([validCities[0].lat, validCities[0].lng], getSingleLocationZoom(validCities[0]), {
          duration: 1.5,
          easeLinearity: 0.25,
        });
      } else {
        const bounds = L.latLngBounds(validCities.map(c => [c.lat, c.lng] as [number, number]));
        map.flyToBounds(bounds, {
          padding: [100, 100],
          duration: 1.5,
          maxZoom: 10,
        });
      }
    } else {
      map.flyToBounds(WORLD_BOUNDS, {
        padding: [56, 56],
        duration: 1.2,
        maxZoom: WORLD_ZOOM,
      });
    }

    return () => window.clearTimeout(invalidateTimer);
  }, [highlightedCities, map, provider]);

  return null;
}

function LeafletMap({
  highlightedCities,
  provider,
  theme,
  showReferences,
  onPointHover,
}: {
  highlightedCities: CityData[];
  provider: MapProvider;
  theme: UiTheme;
  showReferences: boolean;
  onPointHover?: (target: FollowupTarget) => void;
}) {
  const [mounted, setMounted] = useState(false);
  const [tileUrlIndex, setTileUrlIndex] = useState(0);
  const glowingIcon = useMemo(() => createGlowingIcon(), []);
  const worldGeoJson = useMemo(() => getWorldGeoJson(), []);
  const mapConfig = MAP_PROVIDERS[provider];
  const isLight = theme === 'light';
  const fallbackWorldStyle = useMemo(
    () => ({
      color: isLight ? '#2563eb' : '#67e8f9',
      fillColor: isLight ? '#8ec5ff' : '#164e63',
      fillOpacity: isLight ? 0.2 : 0.22,
      opacity: isLight ? 0.55 : 0.42,
      weight: isLight ? 0.65 : 0.55,
      className: 'leaflet-world-basemap',
    }),
    [isLight]
  );

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    setTileUrlIndex(0);
  }, [provider]);

  if (!mounted) return null;

  const activeTileUrl = mapConfig.urls[Math.min(tileUrlIndex, mapConfig.urls.length - 1)];
  const tooltipClassName = isLight
    ? 'map-city-tooltip-light !p-0 overflow-hidden'
    : 'glass-ui !p-0 overflow-hidden';
  const getSourceBadgeClassName = (source?: CityData['source']) => {
    if (source === 'ragflow') {
      return isLight
        ? 'bg-sky-100 text-sky-700 border border-sky-200'
        : 'bg-sky-400/15 text-sky-200 border border-sky-300/30';
    }

    if (source === 'model') {
      return isLight
        ? 'bg-amber-100 text-amber-700 border border-amber-200'
        : 'bg-amber-300/12 text-amber-100 border border-amber-300/25';
    }

    return isLight
      ? 'bg-slate-100 text-slate-600 border border-slate-200'
      : 'bg-white/10 text-white/70 border border-white/15';
  };
  const getSourceLabel = (source?: CityData['source']) => {
    if (source === 'ragflow') return '知识库';
    if (source === 'model') return '模型';
    return '未标记';
  };

  return (
    <MapContainer
      center={WORLD_CENTER}
      zoom={WORLD_ZOOM}
      minZoom={1}
      className="absolute inset-0 z-0 h-full w-full"
      style={{ background: 'transparent' }}
      zoomControl={false}
    >
      <TileLayer
        key={`${provider}-${tileUrlIndex}`}
        attribution={mapConfig.attribution}
        url={activeTileUrl}
        subdomains={mapConfig.subdomains}
        maxZoom={mapConfig.maxZoom}
        eventHandlers={{
          tileerror: () => {
            setTileUrlIndex(currentIndex => {
              if (currentIndex >= mapConfig.urls.length - 1) return currentIndex;
              return currentIndex + 1;
            });
          },
        }}
      />
      <GeoJSON
        key={`world-outline-${theme}`}
        data={worldGeoJson}
        style={fallbackWorldStyle}
        interactive={false}
      />

      {highlightedCities.filter(isValidCity).map((city, index) => {
        const displayInfo = getCityDisplayInfo(city, showReferences);

        return (
          <Marker
            key={`${city.name}-${index}`}
            position={[city.lat, city.lng]}
            icon={glowingIcon}
            eventHandlers={{
              mouseover: event => {
                const mouseEvent = event.originalEvent as MouseEvent | undefined;
                if (!mouseEvent || !onPointHover) return;
                onPointHover({
                  city,
                  clientX: mouseEvent.clientX,
                  clientY: mouseEvent.clientY,
                  source: '2d',
                });
              },
              click: event => {
                const mouseEvent = event.originalEvent as MouseEvent | undefined;
                if (!mouseEvent || !onPointHover) return;
                onPointHover({
                  city,
                  clientX: mouseEvent.clientX,
                  clientY: mouseEvent.clientY,
                  source: '2d',
                });
              },
            }}
          >
            <Tooltip
              direction="top"
              offset={[0, -16]}
              opacity={1}
              permanent
              interactive
              className={tooltipClassName}
            >
              <div
                className={`group flex max-w-[300px] cursor-default flex-col overflow-hidden transition-all duration-300 ${
                  isLight
                    ? 'rounded-lg border border-emerald-300/80 bg-white/94 shadow-[0_8px_18px_rgba(15,23,42,0.16)]'
                    : ''
                }`}
              >
                <div
                  className={`px-3 py-1.5 ${
                    isLight
                      ? 'bg-emerald-600/95'
                      : 'border-[#4ade80]/20 bg-[#4ade80]/10'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={`text-[14px] font-bold leading-tight drop-shadow-sm ${
                        isLight ? 'text-white' : 'text-[#4ade80]'
                      }`}
                    >
                      {city.name}
                    </span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-medium tracking-[0.08em] ${getSourceBadgeClassName(
                        city.source
                      )}`}
                    >
                      {getSourceLabel(city.source)}
                    </span>
                  </div>
                </div>
                {displayInfo && (
                  <div
                    className={`max-h-0 w-[280px] overflow-hidden px-3 opacity-0 transition-all duration-300 ease-out group-hover:max-h-[260px] group-hover:overflow-y-auto group-hover:py-2.5 group-hover:opacity-100 ${
                      isLight ? 'text-slate-800' : 'text-[#e2e8f0]'
                    }`}
                  >
                    <span className="block whitespace-pre-wrap break-words text-[13px] leading-relaxed">
                      {displayInfo}
                    </span>
                  </div>
                )}
              </div>
            </Tooltip>
          </Marker>
        );
      })}
      <MapEventHandler highlightedCities={highlightedCities} provider={provider} />
    </MapContainer>
  );
}

interface InteractiveMapProps {
  highlightedCities: CityData[];
  provider: MapProvider;
  mode: MapMode;
  theme: UiTheme;
  showReferences: boolean;
  onPointHover?: (target: FollowupTarget) => void;
}

export default function InteractiveMap({
  highlightedCities,
  provider,
  mode,
  theme,
  showReferences,
  onPointHover,
}: InteractiveMapProps) {
  if (mode === '3d') {
    return (
      <GlobalNeonMap
        highlightedCities={highlightedCities}
        theme={theme}
        showReferences={showReferences}
        onPointHover={onPointHover}
      />
    );
  }

  return (
    <LeafletMap
      highlightedCities={highlightedCities}
      provider={provider}
      theme={theme}
      showReferences={showReferences}
      onPointHover={onPointHover}
    />
  );
}
