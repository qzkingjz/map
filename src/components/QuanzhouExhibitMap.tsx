import { useEffect, useMemo, useRef } from 'react';
import * as echarts from 'echarts';
import { feature } from 'topojson-client';
import worldAtlas110m from 'world-atlas/countries-110m.json';

const WORLD_MAP_NAME = 'qz-overseas-world';
const QUANZHOU_COORD: [number, number] = [118.6757, 24.8741];

export interface MigrationPoint {
  name: string;
  coord: [number, number];
  value: number;
  label: string;
  note: string;
}

interface QuanzhouExhibitMapProps {
  points: MigrationPoint[];
  activePoint: MigrationPoint;
  onSelect: (point: MigrationPoint) => void;
}

let hasRegisteredWorldMap = false;

function registerWorldMap() {
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
}

export default function QuanzhouExhibitMap({
  points,
  activePoint,
  onSelect,
}: QuanzhouExhibitMapProps) {
  const chartRef = useRef<HTMLDivElement | null>(null);
  const instanceRef = useRef<echarts.ECharts | null>(null);

  const option = useMemo(() => {
    const scatterData = points.map(point => ({
      name: point.name,
      value: [...point.coord, point.value],
      point,
      itemStyle: {
        color: point.name === activePoint.name ? '#f4b44d' : '#bd4d3c',
      },
    }));

    const routeData = points.map(point => ({
      coords: [QUANZHOU_COORD, point.coord],
      lineStyle: {
        opacity: point.name === activePoint.name ? 0.82 : 0.2,
        width: point.name === activePoint.name ? 2.6 : 1,
      },
    }));

    return {
      backgroundColor: 'transparent',
      tooltip: {
        trigger: 'item',
        borderWidth: 0,
        backgroundColor: 'rgba(38, 28, 24, 0.92)',
        textStyle: {
          color: '#fff8ef',
          fontSize: 12,
        },
        formatter: (params: any) => {
          const point = params.data?.point as MigrationPoint | undefined;
          if (!point) return params.name ?? '';
          return `<strong>${point.name}</strong><br/>${point.label}<br/>${point.note}`;
        },
      },
      geo: {
        map: WORLD_MAP_NAME,
        roam: true,
        zoom: 1.08,
        center: [95, 18],
        itemStyle: {
          areaColor: '#ead6bd',
          borderColor: '#caa889',
          borderWidth: 0.65,
        },
        emphasis: {
          itemStyle: {
            areaColor: '#d7b590',
          },
          label: {
            show: false,
          },
        },
        label: {
          show: false,
        },
      },
      series: [
        {
          type: 'lines',
          coordinateSystem: 'geo',
          zlevel: 2,
          effect: {
            show: true,
            period: 5,
            trailLength: 0.18,
            symbol: 'circle',
            symbolSize: 4,
          },
          lineStyle: {
            color: '#bd4d3c',
            curveness: 0.22,
          },
          data: routeData,
        },
        {
          type: 'effectScatter',
          coordinateSystem: 'geo',
          zlevel: 3,
          symbolSize: (value: number[]) => Math.max(10, Math.sqrt(value[2]) * 4.2),
          rippleEffect: {
            scale: 3.6,
            brushType: 'stroke',
          },
          label: {
            show: true,
            formatter: '{b}',
            position: 'right',
            color: '#3d2720',
            fontWeight: 700,
            fontSize: 11,
          },
          data: scatterData,
        },
      ],
    };
  }, [activePoint.name, points]);

  useEffect(() => {
    const container = chartRef.current;
    if (!container) return;

    registerWorldMap();
    let chart: echarts.ECharts | null = null;
    let isDisposed = false;

    const handleClick = (params: any) => {
      const point = params.data?.point as MigrationPoint | undefined;
      if (point) onSelect(point);
    };

    const ensureChart = () => {
      if (isDisposed) return;

      const { width, height } = container.getBoundingClientRect();
      if (width <= 0 || height <= 0) {
        return;
      }

      if (!chart) {
        chart = echarts.init(container);
        instanceRef.current = chart;
        chart.setOption(option);
        chart.on('click', handleClick);
        return;
      }

      chart.resize();
    };

    const resizeObserver = new ResizeObserver(() => {
      window.requestAnimationFrame(ensureChart);
    });
    resizeObserver.observe(container);
    window.requestAnimationFrame(ensureChart);

    return () => {
      isDisposed = true;
      resizeObserver.disconnect();
      chart?.off('click', handleClick);
      chart?.dispose();
      instanceRef.current = null;
    };
  }, [onSelect]);

  useEffect(() => {
    instanceRef.current?.setOption(option, true);
  }, [option]);

  return <div ref={chartRef} className="qz-map-canvas" aria-label="泉籍华侨全球分布图" />;
}
