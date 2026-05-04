import { useEffect, useMemo, useRef, useState } from 'react';
import * as echarts from 'echarts';
import 'echarts-gl';
import { feature } from 'topojson-client';
import worldAtlas110m from 'world-atlas/countries-110m.json';
import { CityData } from '../lib/gemini';
import { FollowupTarget, UiTheme } from '../lib/ui';

const WORLD_MAP_NAME = 'world-neon-3d';

const isValidCity = (city: CityData | undefined | null): city is CityData =>
  !!city &&
  typeof city.lat === 'number' &&
  Number.isFinite(city.lat) &&
  city.lat >= -90 &&
  city.lat <= 90 &&
  typeof city.lng === 'number' &&
  Number.isFinite(city.lng) &&
  city.lng >= -180 &&
  city.lng <= 180;

const escapeHtml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

const getCityDisplayInfo = (city: CityData, showReferences: boolean) =>
  showReferences ? city.infoWithReferences ?? city.info : city.info;

let hasRegisteredWorldMap = false;

const registerWorldMap = () => {
  if (hasRegisteredWorldMap) return;

  const topo = worldAtlas110m as any;
  const countriesObject = (topo.objects as Record<string, object>).countries;
  const worldGeoJson = feature(topo, countriesObject as never) as any;

  if (Array.isArray(worldGeoJson.features)) {
    worldGeoJson.features.forEach((item: any) => {
      const props = item.properties ?? {};
      item.properties = {
        ...props,
        name: props.name ?? props.NAME ?? String(item.id ?? ''),
      };
    });
  }

  echarts.registerMap(WORLD_MAP_NAME, worldGeoJson as never);
  hasRegisteredWorldMap = true;
};

const buildOption = (cities: CityData[], theme: UiTheme, showReferences: boolean): any => {
  const isLight = theme === 'light';

  const cityPoints = cities.map(city => ({
    name: city.name,
    value: [city.lng, city.lat, isLight ? 10 : 9],
    city,
  }));

  const beamLines = cities.map(city => ({
    coords: [
      [city.lng, city.lat, 0],
      [city.lng, city.lat, isLight ? 22 : 26],
    ],
    city,
  }));

  return {
    animation: true,
    backgroundColor: 'transparent',
    tooltip: {
      backgroundColor: isLight ? 'rgba(255, 255, 255, 0.94)' : 'rgba(1, 10, 27, 0.92)',
      borderColor: isLight ? 'rgba(0, 130, 180, 0.35)' : 'rgba(100, 236, 255, 0.65)',
      borderWidth: 1,
      textStyle: {
        color: isLight ? '#0f172a' : '#ecfeff',
      },
      formatter: (params: any) => {
        if (params.seriesType === 'scatter3D' && params.data?.city) {
          const city = params.data.city as CityData;
          const displayInfo = getCityDisplayInfo(city, showReferences);
          const info = displayInfo ? `<br/>${escapeHtml(displayInfo)}` : '';
          return `<b>${escapeHtml(city.name)}</b>${info}`;
        }
        return params.name ? escapeHtml(params.name) : '';
      },
    },
    geo3D: {
      map: WORLD_MAP_NAME,
      roam: true,
      boxWidth: 220,
      boxDepth: 130,
      regionHeight: 3.2,
      shading: 'lambert',
      itemStyle: {
        color: isLight ? '#89c2ff' : '#0f3d76',
        opacity: 0.98,
        borderColor: isLight ? '#26a2ff' : '#4cf3ff',
        borderWidth: isLight ? 0.7 : 0.8,
      },
      label: {
        show: false,
      },
      emphasis: {
        itemStyle: {
          color: isLight ? '#4ca2f2' : '#26a8ff',
        },
      },
      light: {
        main: {
          intensity: isLight ? 1.6 : 1.45,
          shadow: true,
          alpha: 48,
          beta: 16,
        },
        ambient: {
          intensity: isLight ? 0.55 : 0.46,
        },
      },
      postEffect: {
        enable: true,
        bloom: {
          enable: true,
          bloomIntensity: isLight ? 0.25 : 0.42,
        },
        SSAO: {
          enable: true,
          quality: 'medium',
          radius: 2.2,
          intensity: isLight ? 0.8 : 1.15,
        },
        FXAA: {
          enable: true,
        },
      },
      temporalSuperSampling: {
        enable: true,
      },
      viewControl: {
        projection: 'perspective',
        alpha: 32,
        beta: -35,
        distance: 168,
        minDistance: 135,
        maxDistance: 240,
        center: [0, 3, 0],
        panSensitivity: 0.2,
        rotateSensitivity: 1.08,
        zoomSensitivity: 1.12,
        autoRotate: false,
      },
      groundPlane: {
        show: false,
      },
    },
    series: [
      {
        type: 'map3D',
        map: WORLD_MAP_NAME,
        regionHeight: 3.2,
        shading: 'lambert',
        itemStyle: {
          color: isLight ? '#71b4fb' : '#0b315f',
          borderColor: isLight ? '#2ca4ff' : '#55e9ff',
          borderWidth: isLight ? 0.66 : 0.78,
          opacity: 0.98,
        },
        emphasis: {
          itemStyle: {
            color: isLight ? '#4897e8' : '#1f89df',
          },
        },
        silent: true,
      },
      {
        type: 'lines3D',
        coordinateSystem: 'geo3D',
        blendMode: 'lighter',
        data: beamLines,
        effect: {
          show: true,
          trailWidth: 6,
          trailLength: 0.18,
          trailOpacity: 1,
          constantSpeed: 8,
        },
        lineStyle: {
          width: 4,
          color: isLight ? '#1e293b' : '#f8fafc',
          opacity: isLight ? 0.75 : 0.86,
        },
      },
      {
        type: 'scatter3D',
        coordinateSystem: 'geo3D',
        blendMode: 'lighter',
        data: cityPoints,
        symbol: 'circle',
        symbolSize: 12,
        itemStyle: {
          color: isLight ? '#f59e0b' : '#ffe66b',
          borderColor: isLight ? '#1f2937' : '#ffffff',
          borderWidth: 1.1,
          opacity: 1,
        },
        label: {
          show: true,
          formatter: '{b}',
          distance: 1.5,
          textStyle: {
            color: isLight ? '#0f172a' : '#f0fdff',
            fontSize: 11,
            fontWeight: 700,
            padding: [2, 6],
            backgroundColor: isLight ? 'rgba(255, 255, 255, 0.65)' : 'rgba(0, 26, 58, 0.45)',
            borderRadius: 3,
          },
        },
        emphasis: {
          itemStyle: {
            color: isLight ? '#fbbf24' : '#fff4a3',
          },
        },
      },
    ],
  };
};

interface GlobalNeonMapProps {
  highlightedCities: CityData[];
  theme: UiTheme;
  showReferences: boolean;
  onPointHover?: (target: FollowupTarget) => void;
}

export default function GlobalNeonMap({
  highlightedCities,
  theme,
  showReferences,
  onPointHover,
}: GlobalNeonMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);
  const [activeCity, setActiveCity] = useState<CityData | null>(null);

  const cities = useMemo(() => highlightedCities.filter(isValidCity), [highlightedCities]);

  useEffect(() => {
    if (cities.length > 0) {
      setActiveCity(cities[0]);
    } else {
      setActiveCity(null);
    }
  }, [cities]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    registerWorldMap();
    const chart = echarts.init(container, undefined, { renderer: 'canvas' });
    chartRef.current = chart;
    chart.setOption(buildOption(cities, theme, showReferences), true);

    const resizeObserver = new ResizeObserver(() => {
      chart.resize();
    });
    resizeObserver.observe(container);

    const emitPointHover = (params: any) => {
      if (params.seriesType !== 'scatter3D') return;
      const city = params.data?.city as CityData | undefined;
      if (!city) return;

      setActiveCity(city);
      if (!onPointHover) return;

      const event = params.event?.event;
      const rect = container.getBoundingClientRect();
      const clientX =
        typeof event?.clientX === 'number'
          ? event.clientX
          : rect.left + (typeof event?.zrX === 'number' ? event.zrX : rect.width / 2);
      const clientY =
        typeof event?.clientY === 'number'
          ? event.clientY
          : rect.top + (typeof event?.zrY === 'number' ? event.zrY : rect.height / 2);

      onPointHover({
        city,
        clientX,
        clientY,
        source: '3d',
      });
    };

    chart.on('mouseover', emitPointHover);
    chart.on('click', emitPointHover);

    return () => {
      resizeObserver.disconnect();
      chart.off('mouseover', emitPointHover);
      chart.off('click', emitPointHover);
      chart.dispose();
      chartRef.current = null;
    };
  }, [cities, onPointHover, showReferences, theme]);

  useEffect(() => {
    if (!chartRef.current) return;
    chartRef.current.setOption(buildOption(cities, theme, showReferences), true);
  }, [cities, theme, showReferences]);

  const activeCityInfo = activeCity ? getCityDisplayInfo(activeCity, showReferences) : null;

  return (
    <div className="absolute inset-0 z-0 h-full w-full">
      <div ref={containerRef} className="global-neon-map h-full w-full" />

      <div
        className={`pointer-events-none absolute bottom-8 left-8 z-[30] max-w-[380px] rounded-2xl border px-4 py-3 shadow-2xl backdrop-blur-md ${
          theme === 'light'
            ? 'border-sky-300/50 bg-white/70 text-slate-700'
            : 'border-cyan-300/25 bg-slate-950/60 text-white/80'
        }`}
      >
        <div
          className={`mb-2 text-xs uppercase tracking-[0.2em] ${
            theme === 'light' ? 'text-sky-700' : 'text-cyan-300/90'
          }`}
        >
          Neon World 3D
        </div>
        {activeCity ? (
          <div>
            <div
              className={`text-base font-semibold ${
                theme === 'light' ? 'text-slate-900' : 'text-cyan-100'
              }`}
            >
              {activeCity.name}
            </div>
            {activeCityInfo && (
              <p
                className={`mt-1 text-xs leading-relaxed ${
                  theme === 'light' ? 'text-slate-600' : 'text-white/75'
                }`}
              >
                {activeCityInfo}
              </p>
            )}
          </div>
        ) : (
          <p
            className={`text-xs leading-relaxed ${
              theme === 'light' ? 'text-slate-600' : 'text-white/70'
            }`}
          >
            全球 3D 地图已开启。输入城市后，会在世界地图上显示发光点与垂直光柱。
          </p>
        )}
      </div>
    </div>
  );
}
