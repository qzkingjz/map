import { useCallback, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Database,
  Globe2,
  Layers3,
  Moon,
  Quote,
  Sun,
} from 'lucide-react';
import CityFollowupPopover from './CityFollowupPopover';
import FloatingInput from './FloatingInput';
import InteractiveMap from './Map';
import {
  askCityFollowup,
  CityData,
  extractQuery,
} from '../lib/gemini';
import { MAP_PROVIDER_LIST, MapMode, MapProvider } from '../lib/mapProviders';
import { FollowupTarget, UiTheme } from '../lib/ui';

interface AiMapExperienceProps {
  onBack: () => void;
}

const isSameCity = (left: CityData, right: CityData) =>
  left.name === right.name &&
  Math.abs(left.lat - right.lat) < 0.000001 &&
  Math.abs(left.lng - right.lng) < 0.000001;

export default function AiMapExperience({ onBack }: AiMapExperienceProps) {
  const [highlightedCities, setHighlightedCities] = useState<CityData[]>([]);
  const [latestAnswer, setLatestAnswer] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [errorPrompt, setErrorPrompt] = useState<string | null>(null);
  const [isVoiceEnabled, setIsVoiceEnabled] = useState(true);
  const [mapProvider, setMapProvider] = useState<MapProvider>('amap');
  const [mapMode, setMapMode] = useState<MapMode>('2d');
  const [theme, setTheme] = useState<UiTheme>('dark');
  const [isControlPanelOpen, setIsControlPanelOpen] = useState(false);
  const [showReferences, setShowReferences] = useState(false);
  const [isKnowledgeBaseEnabled, setIsKnowledgeBaseEnabled] = useState(true);
  const [followupTarget, setFollowupTarget] = useState<FollowupTarget | null>(null);
  const [isFollowupLoading, setIsFollowupLoading] = useState(false);

  const hasResponse = highlightedCities.length > 0 || Boolean(latestAnswer);

  const speakText = useCallback(
    (text: string | null | undefined) => {
      if (!isVoiceEnabled || !('speechSynthesis' in window) || !text?.trim()) {
        return;
      }

      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text.trim());
      utterance.lang = 'zh-CN';
      window.speechSynthesis.speak(utterance);
    },
    [isVoiceEnabled]
  );

  const handleSearch = useCallback(
    async (request: string) => {
      setIsLoading(true);
      setErrorPrompt(null);
      setFollowupTarget(null);
      setLatestAnswer(null);
      window.speechSynthesis?.cancel();

      try {
        const result = await extractQuery(request, {
          useKnowledgeBase: isKnowledgeBaseEnabled,
        });
        const normalizedAnswer = result.answer?.trim() || null;

        setHighlightedCities(result.locations);
        setLatestAnswer(normalizedAnswer);

        if (result.locations.length > 0 || normalizedAnswer) {
          const fallbackLocationText =
            result.locations.length > 0
              ? `已为您定位到 ${result.locations.map(city => city.name).join('、')}`
              : '已为您整理文本答案。';

          speakText(normalizedAnswer ?? fallbackLocationText);
          return;
        }

        setErrorPrompt('这次没有拿到可显示的答案，也没有提取出可落图的位置，请换个说法再试试。');
      } catch (error) {
        console.error(error);
        setErrorPrompt(error instanceof Error ? error.message : '服务请求失败，请稍后再试。');
      } finally {
        setIsLoading(false);
      }
    },
    [isKnowledgeBaseEnabled, speakText]
  );

  const handleFollowupSubmit = useCallback(
    async (question: string) => {
      if (!followupTarget) return;

      setIsFollowupLoading(true);
      setErrorPrompt(null);

      try {
        const answer = await askCityFollowup(
          followupTarget.city.name,
          question,
          followupTarget.city.info,
          { useKnowledgeBase: isKnowledgeBaseEnabled }
        );

        if (!answer) {
          setErrorPrompt('追问暂未返回结果，请换个问法再试一次。');
          return;
        }

        setHighlightedCities(previous =>
          previous.map(city =>
            isSameCity(city, followupTarget.city)
              ? {
                  ...city,
                  info: answer.info,
                  infoWithReferences: answer.infoWithReferences ?? answer.info,
                  source: answer.source ?? city.source,
                }
              : city
          )
        );
        setLatestAnswer(answer.info);
        speakText(answer.info);
      } catch (error) {
        console.error(error);
        setErrorPrompt(error instanceof Error ? error.message : '追问失败，请稍后重试。');
      } finally {
        setIsFollowupLoading(false);
        setFollowupTarget(null);
      }
    },
    [followupTarget, isKnowledgeBaseEnabled, speakText]
  );

  const handleClear = useCallback(() => {
    setHighlightedCities([]);
    setLatestAnswer(null);
    setErrorPrompt(null);
    setFollowupTarget(null);
    window.speechSynthesis?.cancel();
  }, []);

  const activeProviderLabel = useMemo(
    () => MAP_PROVIDER_LIST.find(provider => provider.id === mapProvider)?.label ?? '地图',
    [mapProvider]
  );

  const panelTitleClass = theme === 'light' ? 'text-slate-700' : 'text-white/70';
  const panelSubClass = theme === 'light' ? 'text-slate-500' : 'text-white/60';
  const buttonIdleClass =
    theme === 'light'
      ? 'border-slate-300 bg-white/55 text-slate-600 hover:border-slate-400'
      : 'border-white/15 bg-white/5 text-white/70 hover:border-white/30';
  const buttonActiveClass =
    theme === 'light'
      ? 'border-emerald-700/80 bg-emerald-600 text-white shadow-[0_6px_16px_rgba(5,150,105,0.35)]'
      : 'border-[#4ade80]/60 bg-[#4ade80]/15 text-[#4ade80]';

  return (
    <div className={`app-root theme-${theme} relative h-screen w-screen overflow-hidden font-sans`}>
      <div className="mesh-bg"></div>

      <InteractiveMap
        highlightedCities={highlightedCities}
        provider={mapProvider}
        mode={mapMode}
        theme={theme}
        showReferences={showReferences}
        onPointHover={setFollowupTarget}
      />

      <button
        type="button"
        onClick={onBack}
        className="absolute left-10 bottom-10 z-[1100] inline-flex items-center gap-2 rounded-full border border-white/15 bg-black/20 px-4 py-2 text-sm text-white/80 shadow-lg backdrop-blur transition hover:border-white/35 hover:text-white"
      >
        <ArrowLeft className="h-4 w-4" />
        返回展示站
      </button>

      <FloatingInput
        onSearch={handleSearch}
        onClear={handleClear}
        isLoading={isLoading}
        hasResults={hasResponse}
        cityCount={highlightedCities.length}
        isVoiceEnabled={isVoiceEnabled}
        onToggleVoice={() => setIsVoiceEnabled(previous => !previous)}
        isKnowledgeBaseEnabled={isKnowledgeBaseEnabled}
        theme={theme}
      />

      <CityFollowupPopover
        target={followupTarget}
        theme={theme}
        isLoading={isFollowupLoading}
        onSubmit={handleFollowupSubmit}
        onClose={() => setFollowupTarget(null)}
      />

      <motion.div
        className="absolute right-4 top-10 z-[1000] flex items-start gap-2 sm:right-10"
        initial={false}
        animate={{ x: isControlPanelOpen ? 0 : 338 }}
        transition={{ type: 'spring', stiffness: 260, damping: 28 }}
      >
        <button
          type="button"
          onClick={() => setIsControlPanelOpen(previous => !previous)}
          className="glass-ui flex min-h-[118px] w-11 flex-col items-center justify-center gap-2 rounded-2xl border px-2 py-3 text-[#4ade80] shadow-xl transition hover:border-[#4ade80]/55 hover:bg-[#4ade80]/10"
          aria-expanded={isControlPanelOpen}
          aria-label={isControlPanelOpen ? '收起地图控制' : '展开地图控制'}
          title={isControlPanelOpen ? '收起地图控制' : '展开地图控制'}
        >
          {isControlPanelOpen ? (
            <ChevronRight className="h-4 w-4" />
          ) : (
            <ChevronLeft className="h-4 w-4" />
          )}
          <Layers3 className="h-4 w-4" />
          <span className="text-[11px] leading-tight [writing-mode:vertical-rl]">控制</span>
        </button>

        <div className="w-[330px] rounded-2xl glass-ui px-4 py-3">
          <div className={`mb-3 flex items-center gap-2 text-xs uppercase tracking-[0.15em] ${panelTitleClass}`}>
            <Layers3 className="h-3.5 w-3.5 text-[#4ade80]" />
            地图控制
          </div>

          <div className="mb-3">
            <div className={`mb-2 text-[11px] ${panelSubClass}`}>视图模式</div>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setMapMode('2d')}
                className={`rounded-lg border px-3 py-2 text-xs transition ${
                  mapMode === '2d' ? buttonActiveClass : buttonIdleClass
                }`}
              >
                2D 平面
              </button>
              <button
                type="button"
                onClick={() => setMapMode('3d')}
                className={`rounded-lg border px-3 py-2 text-xs transition ${
                  mapMode === '3d' ? buttonActiveClass : buttonIdleClass
                }`}
              >
                3D 全球
              </button>
            </div>
          </div>

          <div className="mb-3">
            <div className={`mb-2 text-[11px] ${panelSubClass}`}>界面主题</div>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setTheme('dark')}
                className={`flex items-center justify-center gap-1 rounded-lg border px-3 py-2 text-xs transition ${
                  theme === 'dark' ? buttonActiveClass : buttonIdleClass
                }`}
              >
                <Moon className="h-3.5 w-3.5" />
                暗黑
              </button>
              <button
                type="button"
                onClick={() => setTheme('light')}
                className={`flex items-center justify-center gap-1 rounded-lg border px-3 py-2 text-xs transition ${
                  theme === 'light' ? buttonActiveClass : buttonIdleClass
                }`}
              >
                <Sun className="h-3.5 w-3.5" />
                明亮
              </button>
            </div>
          </div>

          <div className="mb-3">
            <div className={`mb-2 flex items-center gap-1 text-[11px] ${panelSubClass}`}>
              <Database className="h-3.5 w-3.5" />
              问答来源
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setIsKnowledgeBaseEnabled(true)}
                className={`rounded-lg border px-3 py-2 text-xs transition ${
                  isKnowledgeBaseEnabled ? buttonActiveClass : buttonIdleClass
                }`}
              >
                知识库
              </button>
              <button
                type="button"
                onClick={() => setIsKnowledgeBaseEnabled(false)}
                className={`rounded-lg border px-3 py-2 text-xs transition ${
                  !isKnowledgeBaseEnabled ? buttonActiveClass : buttonIdleClass
                }`}
              >
                大模型
              </button>
            </div>
          </div>

          <div className="mb-3">
            <div className={`mb-2 flex items-center gap-1 text-[11px] ${panelSubClass}`}>
              <Quote className="h-3.5 w-3.5" />
              引用展示
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setShowReferences(false)}
                className={`rounded-lg border px-3 py-2 text-xs transition ${
                  !showReferences ? buttonActiveClass : buttonIdleClass
                }`}
              >
                隐藏
              </button>
              <button
                type="button"
                onClick={() => setShowReferences(true)}
                className={`rounded-lg border px-3 py-2 text-xs transition ${
                  showReferences ? buttonActiveClass : buttonIdleClass
                }`}
              >
                显示
              </button>
            </div>
          </div>

          <div>
            <div className={`mb-2 text-[11px] ${panelSubClass}`}>地图源</div>
            <select
              value={mapProvider}
              onChange={event => setMapProvider(event.target.value as MapProvider)}
              disabled={mapMode === '3d'}
              className="map-source-select w-full rounded-lg border border-white/20 bg-black/25 px-3 py-2 text-sm text-white/85 outline-none transition focus:border-[#4ade80]/60 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {MAP_PROVIDER_LIST.map(provider => (
                <option key={provider.id} value={provider.id}>
                  {provider.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </motion.div>

      <AnimatePresence>
        {errorPrompt && (
          <motion.div
            initial={{ opacity: 0, y: 20, x: '-50%' }}
            animate={{ opacity: 1, y: 0, x: '-50%' }}
            exit={{ opacity: 0, y: 20, x: '-50%' }}
            className="absolute bottom-24 left-1/2 z-[1000] flex items-center gap-2 rounded-full border border-red-500/50 px-6 py-3 text-sm shadow-xl glass-ui"
          >
            <span className={theme === 'light' ? 'text-red-700' : 'text-red-100'}>
              {errorPrompt}
            </span>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="absolute bottom-10 right-10 z-[1000] flex items-center gap-2 rounded-[50px] px-5 py-2.5 text-[11px] uppercase tracking-[1px] text-[#4ade80] glass-ui">
        <div className="h-[6px] w-[6px] rounded-full bg-[#4ade80] shadow-[0_0_8px_#4ade80]"></div>
        <Globe2 className="h-3.5 w-3.5" />
        <span>
          {mapMode === '3d' ? 'World Neon 3D Active' : `${activeProviderLabel} Active`}
        </span>
        <span className="mx-1 text-white/20">|</span>
        <span>{isKnowledgeBaseEnabled ? 'KB On' : 'Model Only'}</span>
        <span className="mx-1 text-white/20">|</span>
        <span>{showReferences ? 'Refs On' : 'Refs Off'}</span>
      </div>
    </div>
  );
}
