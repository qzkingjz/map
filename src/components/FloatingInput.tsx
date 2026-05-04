import React, { useEffect, useRef, useState } from 'react';
import { Loader2, Mic, Volume2, VolumeX, X } from 'lucide-react';
import { motion } from 'motion/react';
import { UiTheme } from '../lib/ui';

interface FloatingInputProps {
  onSearch: (request: string) => void;
  onClear: () => void;
  isLoading: boolean;
  hasResults: boolean;
  cityCount: number;
  isVoiceEnabled: boolean;
  onToggleVoice: () => void;
  theme: UiTheme;
}

export default function FloatingInput({
  onSearch,
  onClear,
  isLoading,
  hasResults,
  cityCount,
  isVoiceEnabled,
  onToggleVoice,
  theme,
}: FloatingInputProps) {
  const [input, setInput] = useState('');
  const [isListening, setIsListening] = useState(false);
  const [hasSpeechSupport, setHasSpeechSupport] = useState(false);
  const recognitionRef = useRef<any>(null);
  const inputRef = useRef('');
  const onSearchRef = useRef(onSearch);

  useEffect(() => {
    onSearchRef.current = onSearch;
  }, [onSearch]);

  const handleSetInput = (value: string) => {
    setInput(value);
    inputRef.current = value;
  };

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const SpeechRecognition =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) return;

    setHasSpeechSupport(true);
    const recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = 'zh-CN';

    recognition.onresult = (event: any) => {
      let transcript = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        transcript += event.results[i][0].transcript;
      }
      handleSetInput(transcript);
    };

    recognition.onerror = (event: any) => {
      console.error('Speech recognition error', event.error);
      setIsListening(false);
    };

    recognition.onend = () => {
      setIsListening(false);
      if (inputRef.current.trim()) {
        onSearchRef.current(inputRef.current.trim());
      }
    };

    recognitionRef.current = recognition;
  }, []);

  const toggleListening = () => {
    if (isListening) {
      recognitionRef.current?.stop();
      return;
    }

    handleSetInput('');
    try {
      recognitionRef.current?.start();
      setIsListening(true);
    } catch (error) {
      console.error('Speech recognition failed to start', error);
    }
  };

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (input.trim() && !isLoading) {
      onSearch(input.trim());
    }
  };

  const handleClear = () => {
    handleSetInput('');
    onClear();
  };

  const titleClass = theme === 'light' ? 'text-slate-800' : 'text-[#e2e8f0]';
  const descClass = theme === 'light' ? 'text-slate-600' : 'text-white/50';
  const searchInputClass =
    theme === 'light'
      ? 'text-slate-800 placeholder:text-slate-400'
      : 'text-[#e2e8f0] placeholder:text-white/30';
  const rightIconClass =
    theme === 'light' ? 'text-slate-500 hover:text-slate-700' : 'text-white/50 hover:text-white';

  return (
    <motion.div
      initial={{ y: -50, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ type: 'spring', stiffness: 300, damping: 25, delay: 0.2 }}
      className="absolute left-10 top-10 z-[1000] w-80 max-w-[calc(100vw-80px)]"
    >
      <div className="glass-ui rounded-[20px] p-6">
        <div className="mb-6 flex items-start justify-between">
          <div>
            <h2 className={`mb-2 text-lg font-medium tracking-tight ${titleClass}`}>城市知识与定位</h2>
            <p className={`text-[13px] ${descClass}`}>向 AI 提问了解城市，或直接点亮位置</p>
          </div>
          <button
            type="button"
            onClick={onToggleVoice}
            className="rounded-full border border-white/10 bg-white/8 p-2 text-white/70 shadow-sm transition-colors hover:bg-white/12"
            title={isVoiceEnabled ? '关闭语音播报' : '开启语音播报'}
          >
            {isVoiceEnabled ? <Volume2 className="h-4 w-4 text-[#4ade80]" /> : <VolumeX className="h-4 w-4" />}
          </button>
        </div>

        <form
          onSubmit={handleSubmit}
          className="search-box relative flex w-full items-center overflow-hidden rounded-xl transition-all focus-within:border-[#4ade80]/50 hover:border-white/20"
        >
          <input
            type="text"
            value={input}
            onChange={event => handleSetInput(event.target.value)}
            placeholder="试试问：巴黎有多少人口？"
            disabled={isLoading || isListening}
            className={`flex-1 bg-transparent px-4 py-3 text-sm focus:outline-none disabled:opacity-50 ${searchInputClass}`}
          />
          {hasResults && !isLoading && (
            <button
              type="button"
              onClick={handleClear}
              className={`p-2 transition-colors ${rightIconClass}`}
            >
              <X className="h-4 w-4" />
            </button>
          )}
          {hasSpeechSupport && !isLoading && (
            <button
              type="button"
              onClick={toggleListening}
              className={`p-2 transition-colors ${
                isListening
                  ? 'animate-pulse text-red-400 drop-shadow-[0_0_8px_rgba(248,113,113,0.8)]'
                  : theme === 'light'
                  ? 'text-slate-500 hover:text-[#16a34a]'
                  : 'text-white/40 hover:text-[#4ade80]'
              }`}
              title={isListening ? '停止录音' : '点击说话'}
            >
              <Mic className="h-4 w-4" />
            </button>
          )}
          <button
            type="submit"
            disabled={!input.trim() || isLoading}
            className="p-3 text-[#e2e8f0]/60 transition-colors hover:text-[#4ade80] focus:text-[#4ade80] disabled:opacity-30 disabled:hover:text-[#e2e8f0]/60"
          >
            {isLoading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="11" cy="11" r="8"></circle>
                <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
              </svg>
            )}
          </button>
        </form>

        {hasResults && (
          <div className={`mt-5 text-xs leading-[1.8] ${theme === 'light' ? 'text-slate-700' : 'text-white/70'}`}>
            {cityCount > 0 ? (
              <>
                <p>
                  当前状态：<b className="font-normal text-[#4ade80]">已定位</b>
                </p>
                <p className="mt-1">检索到 {cityCount} 个区域</p>
              </>
            ) : (
              <>
                <p>
                  当前状态：<b className="font-normal text-[#4ade80]">已回答</b>
                </p>
                <p className="mt-1">已返回文本答案，暂未定位到具体地图点</p>
              </>
            )}
          </div>
        )}
      </div>
    </motion.div>
  );
}
