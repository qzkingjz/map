import { useState, useCallback } from 'react';
import InteractiveMap from './components/Map';
import FloatingInput from './components/FloatingInput';
import { extractCities, CityData } from './lib/gemini';
import { AnimatePresence, motion } from 'motion/react';
import { Map as MapIcon, Compass } from 'lucide-react';

export default function App() {
  const [highlightedCities, setHighlightedCities] = useState<CityData[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [errorPrompt, setErrorPrompt] = useState<string | null>(null);
  const [isVoiceEnabled, setIsVoiceEnabled] = useState(true);

  const handleSearch = useCallback(async (request: string) => {
    setIsLoading(true);
    setErrorPrompt(null);
    window.speechSynthesis?.cancel();
    
    try {
      const cities = await extractCities(request);
      if (cities.length > 0) {
        setHighlightedCities(cities);
        
        if (isVoiceEnabled && 'speechSynthesis' in window) {
          const infoTexts = cities.map(c => c.info).filter(Boolean);
          const textToSpeak = infoTexts.length > 0 
            ? infoTexts.join('。') 
            : `为您定位到 ${cities.map(c => c.name).join('、')}`;
            
          const utterance = new SpeechSynthesisUtterance(textToSpeak);
          utterance.lang = 'zh-CN';
          window.speechSynthesis.speak(utterance);
        }
      } else {
        const errorMsg = "未能在这个请求中找到有效的地理位置。请换个说法试试，例如“点亮纽约”。";
        setErrorPrompt(errorMsg);
        
        if (isVoiceEnabled && 'speechSynthesis' in window) {
          const utterance = new SpeechSynthesisUtterance("未能找到地理位置，请换个描述。");
          utterance.lang = 'zh-CN';
          window.speechSynthesis.speak(utterance);
        }
      }
    } catch (err) {
      console.error(err);
      setErrorPrompt("服务请求失败，请稍后再试。");
    } finally {
      setIsLoading(false);
    }
  }, [isVoiceEnabled]);

  const handleClear = useCallback(() => {
    setHighlightedCities([]);
    setErrorPrompt(null);
    window.speechSynthesis?.cancel();
  }, []);

  return (
    <div className="relative h-screen w-screen overflow-hidden font-sans">
      <div className="mesh-bg"></div>
      
      <InteractiveMap highlightedCities={highlightedCities} />
      
      <FloatingInput 
        onSearch={handleSearch} 
        onClear={handleClear}
        isLoading={isLoading} 
        hasResults={highlightedCities.length > 0}
        cityCount={highlightedCities.length}
        isVoiceEnabled={isVoiceEnabled}
        onToggleVoice={() => setIsVoiceEnabled(prev => !prev)}
      />

      {/* Error message Toast */}
      <AnimatePresence>
        {errorPrompt && (
          <motion.div
            initial={{ opacity: 0, y: 20, x: '-50%' }}
            animate={{ opacity: 1, y: 0, x: '-50%' }}
            exit={{ opacity: 0, y: 20, x: '-50%' }}
            className="absolute bottom-24 left-1/2 z-[1000] px-6 py-3 rounded-full glass-ui border-red-500/50 text-red-100 text-sm shadow-xl flex items-center gap-2"
          >
            {errorPrompt}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Status bar */}
      <div className="absolute bottom-10 right-10 z-[1000] px-5 py-2.5 rounded-[50px] glass-ui text-[11px] uppercase tracking-[1px] text-[#4ade80] flex items-center gap-2">
        <div className="w-[6px] h-[6px] rounded-full bg-[#4ade80] shadow-[0_0_8px_#4ade80]"></div>
        <span>Map Engine Active</span>
      </div>
    </div>
  );
}

