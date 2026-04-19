import React, { useState, useEffect, useRef } from 'react';
import { Search, Loader2, Sparkles, X, Volume2, VolumeX, Mic } from 'lucide-react';
import { motion } from 'motion/react';

interface FloatingInputProps {
  onSearch: (request: string) => void;
  onClear: () => void;
  isLoading: boolean;
  hasResults: boolean;
  cityCount: number;
  isVoiceEnabled: boolean;
  onToggleVoice: () => void;
}

export default function FloatingInput({ onSearch, onClear, isLoading, hasResults, cityCount, isVoiceEnabled, onToggleVoice }: FloatingInputProps) {
  const [input, setInput] = useState('');
  const [isListening, setIsListening] = useState(false);
  const [hasSpeechSupport, setHasSpeechSupport] = useState(false);
  const recognitionRef = useRef<any>(null);

  // Keep latest refs to avoid stale closures in Speech Recognition callbacks
  const inputRef = useRef('');
  const onSearchRef = useRef(onSearch);

  useEffect(() => {
    onSearchRef.current = onSearch;
  }, [onSearch]);

  const handleSetInput = (val: string) => {
    setInput(val);
    inputRef.current = val;
  };

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
      if (SpeechRecognition) {
        setHasSpeechSupport(true);
        const recognition = new SpeechRecognition();
        recognition.continuous = false;
        recognition.interimResults = true;
        recognition.lang = 'zh-CN';

        recognition.onresult = (event: any) => {
          let transcript = '';
          for (let i = event.resultIndex; i < event.results.length; ++i) {
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
          // Automatically trigger search when speech stops naturally or manually
          if (inputRef.current.trim()) {
            onSearchRef.current(inputRef.current.trim());
          }
        };

        recognitionRef.current = recognition;
      }
    }
  }, []);

  const toggleListening = () => {
    if (isListening) {
      recognitionRef.current?.stop();
    } else {
      handleSetInput('');
      try {
        recognitionRef.current?.start();
        setIsListening(true);
      } catch (e) {
        console.error("Speech Recognition failed to start", e);
      }
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (input.trim() && !isLoading) {
      onSearch(input.trim());
    }
  };

  const handleClear = () => {
    handleSetInput('');
    onClear();
  };

  return (
    <motion.div
      initial={{ y: -50, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ type: 'spring', stiffness: 300, damping: 25, delay: 0.2 }}
      className="absolute top-10 left-10 z-[1000] w-80 max-w-[calc(100vw-80px)]"
    >
      <div className="glass-ui rounded-[20px] p-6">
        <div className="flex items-start justify-between mb-6">
          <div>
            <h2 className="mb-2 text-lg font-medium tracking-tight text-[#e2e8f0]">城市知识与定位</h2>
            <p className="text-[13px] text-white/50">向 AI 提问了解城市，或直接点亮位置</p>
          </div>
          <button
            type="button"
            onClick={onToggleVoice}
            className="p-2 rounded-full bg-white/5 hover:bg-white/10 text-white/70 transition-colors border border-white/5 shadow-sm"
            title={isVoiceEnabled ? "关闭语音播报" : "开启语音播报"}
          >
            {isVoiceEnabled ? <Volume2 className="h-4 w-4 text-[#4ade80]" /> : <VolumeX className="h-4 w-4" />}
          </button>
        </div>
        
        <form
          onSubmit={handleSubmit}
          className="search-box relative flex items-center w-full overflow-hidden rounded-xl transition-all focus-within:border-[#4ade80]/50 hover:border-white/20"
        >
          <input
            type="text"
            value={input}
            onChange={(e) => handleSetInput(e.target.value)}
            placeholder="试试问：巴黎有多少人口？"
            disabled={isLoading || isListening}
            className="flex-1 bg-transparent px-4 py-3 text-[#e2e8f0] placeholder-white/30 focus:outline-none disabled:opacity-50 text-sm"
          />
          {hasResults && !isLoading && (
            <button
              type="button"
              onClick={handleClear}
              className="p-2 text-white/50 hover:text-white transition-colors"
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
                  ? 'text-red-400 animate-pulse drop-shadow-[0_0_8px_rgba(248,113,113,0.8)]' 
                  : 'text-white/40 hover:text-[#4ade80]'
              }`}
              title={isListening ? "停止录音" : "点击说话"}
            >
              <Mic className="h-4 w-4" />
            </button>
          )}
          <button
            type="submit"
            disabled={!input.trim() || isLoading}
            className="p-3 text-[#e2e8f0]/60 hover:text-[#4ade80] focus:text-[#4ade80] transition-colors disabled:opacity-30 disabled:hover:text-[#e2e8f0]/60"
          >
            {isLoading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
            )}
          </button>
        </form>

        {hasResults && (
          <div className="mt-5 text-xs leading-[1.8] text-white/70">
            <p>当前状态：<b className="text-[#4ade80] font-normal">已定位</b></p>
            <p className="mt-1">检索到 {cityCount} 个区域</p>
          </div>
        )}
      </div>
    </motion.div>
  );
}
