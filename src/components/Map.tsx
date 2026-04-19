import { useEffect, useState } from 'react';
import { MapContainer, TileLayer, Marker, useMap, Tooltip } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { CityData } from '../lib/gemini';

// Custom glowing dot icon
const createGlowingIcon = () => {
  return L.divIcon({
    className: 'bg-transparent border-none',
    html: `<div class="relative flex h-8 w-8 items-center justify-center">
            <div class="absolute inline-flex h-full w-full animate-[pulse_2s_infinite] rounded-full bg-[#4ade80] opacity-80" style="filter: blur(2px);"></div>
            <div class="relative inline-flex h-4 w-4 rounded-full bg-[#4ade80] shadow-[0_0_15px_rgba(74,222,128,1),0_0_40px_rgba(74,222,128,0.8)]"></div>
           </div>`,
    iconSize: [32, 32],
    iconAnchor: [16, 16],
  });
};

function MapEventHandler({ highlightedCities }: { highlightedCities: CityData[] }) {
  const map = useMap();

  useEffect(() => {
    // Extra safety measure to only process valid coordinates
    const validCities = highlightedCities.filter(
      c => c && typeof c.lat === 'number' && Number.isFinite(c.lat) && typeof c.lng === 'number' && Number.isFinite(c.lng)
    );

    if (validCities.length > 0) {
      if (validCities.length === 1) {
        map.flyTo([validCities[0].lat, validCities[0].lng], 8, {
          duration: 1.5,
          easeLinearity: 0.25,
        });
      } else {
        const bounds = L.latLngBounds(validCities.map(c => [c.lat, c.lng] as [number, number]));
        map.flyToBounds(bounds, { 
          padding: [100, 100],
          duration: 1.5,
          maxZoom: 10
        });
      }
    } else {
      // Return to default view of the world if cleared or no valid cities
      map.flyTo([20, 0], 2, { duration: 1.5 });
    }
  }, [highlightedCities, map]);

  return null;
}

export default function InteractiveMap({ highlightedCities }: { highlightedCities: CityData[] }) {
  // Ensure the map can re-render cleanly when mounted
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) return null;

  return (
    <MapContainer
      center={[20, 0]} // Center of the world
      zoom={2}
      minZoom={2}
      className="absolute inset-0 z-0 h-full w-full"
      style={{ background: 'transparent' }}
      zoomControl={false}
    >
      <TileLayer
        attribution='&copy; <a href="https://maps.google.com">Google Maps</a>'
        url="https://mt{s}.google.com/vt/lyrs=m&x={x}&y={y}&z={z}&hl=zh-CN"
        subdomains={["0", "1", "2", "3"]}
      />
      
      {highlightedCities
        .filter(city => city && Number.isFinite(city.lat) && Number.isFinite(city.lng))
        .map((city, index) => (
        <Marker
          key={`${city.name}-${index}`}
          position={[city.lat, city.lng]}
          icon={createGlowingIcon()}
        >
          <Tooltip 
            direction="top" 
            offset={[0, -16]} 
            opacity={1}
            permanent
            className="glass-ui !p-0 overflow-hidden"
          >
            <div className="flex flex-col max-w-[240px]">
              <div className="bg-[#4ade80]/10 border-b border-[#4ade80]/20 px-3 py-1.5">
                <span className="font-bold text-[#4ade80] text-[14px] leading-tight drop-shadow-sm">{city.name}</span>
              </div>
              {city.info && (
                <div className="px-3 py-2.5">
                  <span className="text-[#e2e8f0] text-[13px] leading-relaxed block break-words whitespace-pre-wrap">{city.info}</span>
                </div>
              )}
            </div>
          </Tooltip>
        </Marker>
      ))}
      <MapEventHandler highlightedCities={highlightedCities} />
    </MapContainer>
  );
}
