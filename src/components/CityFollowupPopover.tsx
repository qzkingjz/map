import { FormEvent, useEffect, useState } from 'react';
import { Loader2, Send, X } from 'lucide-react';
import { FollowupTarget, UiTheme } from '../lib/ui';

interface CityFollowupPopoverProps {
  target: FollowupTarget | null;
  theme: UiTheme;
  isLoading: boolean;
  onSubmit: (question: string) => void;
  onClose: () => void;
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

export default function CityFollowupPopover({
  target,
  theme,
  isLoading,
  onSubmit,
  onClose,
}: CityFollowupPopoverProps) {
  const [question, setQuestion] = useState('');

  useEffect(() => {
    setQuestion('');
  }, [target?.city.name, target?.city.lat, target?.city.lng]);

  if (!target) return null;

  const panelWidth = 320;
  const panelHeight = 164;
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const edgePadding = 12;
  const labelClearanceX = target.source === '2d' ? 340 : 24;
  const labelClearanceY = target.source === '2d' ? 76 : 24;
  const hasRoomOnRight =
    target.clientX + labelClearanceX + panelWidth + edgePadding <= viewportWidth;
  const rawX = hasRoomOnRight
    ? target.clientX + labelClearanceX
    : target.clientX - panelWidth - 28;
  const rawY = target.source === '2d'
    ? target.clientY + labelClearanceY
    : target.clientY + 18;
  const safeX = clamp(rawX, edgePadding, viewportWidth - panelWidth - edgePadding);
  const safeY = clamp(rawY, edgePadding, viewportHeight - panelHeight - edgePadding);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = question.trim();
    if (!trimmed || isLoading) return;
    onSubmit(trimmed);
  };

  const titleTextClass = theme === 'light' ? 'text-slate-800' : 'text-slate-100';
  const subTextClass = theme === 'light' ? 'text-slate-600' : 'text-white/70';
  const inputClass =
    theme === 'light'
      ? 'border-slate-300 bg-white text-slate-800 placeholder:text-slate-400'
      : 'border-white/20 bg-slate-950/40 text-slate-100 placeholder:text-white/35';
  const closeButtonClass =
    theme === 'light'
      ? 'text-slate-500 hover:bg-slate-200/70 hover:text-slate-800'
      : 'text-white/55 hover:bg-white/10 hover:text-white';
  const submitButtonClass =
    theme === 'light'
      ? 'border-emerald-700/60 bg-emerald-600 text-white hover:bg-emerald-700'
      : 'border-cyan-300/55 bg-cyan-400/18 text-cyan-100 hover:bg-cyan-400/28';

  return (
    <div
      className={`followup-popover fixed z-[1200] w-[320px] rounded-2xl border px-3.5 py-3 shadow-2xl glass-ui ${
        theme === 'light' ? 'border-slate-300/70' : 'border-cyan-300/30'
      }`}
      style={{ left: `${safeX}px`, top: `${safeY}px` }}
    >
      <div className="mb-2 flex items-start justify-between gap-2">
        <div>
          <div className={`text-sm font-semibold ${titleTextClass}`}>追问：{target.city.name}</div>
          <div className={`mt-0.5 text-xs ${subTextClass}`}>
            针对该位置继续提问，结果会回写到地图信息卡。
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className={`rounded-md p-1 transition ${closeButtonClass}`}
          aria-label="关闭追问框"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <form onSubmit={handleSubmit} className="flex items-center gap-2">
        <input
          type="text"
          value={question}
          onChange={event => setQuestion(event.target.value)}
          placeholder="比如：这里为什么华人比较集中？"
          className={`h-10 flex-1 rounded-lg border px-3 text-sm outline-none transition focus:border-cyan-300 ${inputClass}`}
          disabled={isLoading}
        />
        <button
          type="submit"
          disabled={isLoading || !question.trim()}
          className={`inline-flex h-10 w-10 items-center justify-center rounded-lg border transition disabled:cursor-not-allowed disabled:opacity-45 ${submitButtonClass}`}
          aria-label="提交追问"
        >
          {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
        </button>
      </form>
    </div>
  );
}
