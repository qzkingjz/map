import { BookOpenText } from 'lucide-react';
import { AnswerSource } from '../lib/gemini';
import { UiTheme } from '../lib/ui';

interface AnswerPanelProps {
  answer: string | null;
  source: AnswerSource | null;
  prompt: string | null;
  theme: UiTheme;
  locationCount: number;
  showReferences: boolean;
  isKnowledgeBaseEnabled: boolean;
}

function getSourceLabel(source: AnswerSource | null): string {
  if (source === 'ragflow') return '知识库';
  if (source === 'model') return '大模型';
  return '未标记';
}

export default function AnswerPanel({
  answer,
  source,
  prompt,
  theme,
  locationCount,
  showReferences,
  isKnowledgeBaseEnabled,
}: AnswerPanelProps) {
  if (!answer) return null;

  const titleClass = theme === 'light' ? 'text-slate-800' : 'text-slate-100';
  const textClass = theme === 'light' ? 'text-slate-700' : 'text-slate-100/90';
  const subClass = theme === 'light' ? 'text-slate-500' : 'text-white/55';
  const badgeClass =
    source === 'ragflow'
      ? theme === 'light'
        ? 'border-sky-200 bg-sky-100 text-sky-700'
        : 'border-sky-300/30 bg-sky-400/15 text-sky-200'
      : source === 'model'
      ? theme === 'light'
        ? 'border-amber-200 bg-amber-100 text-amber-700'
        : 'border-amber-300/25 bg-amber-300/12 text-amber-100'
      : theme === 'light'
      ? 'border-slate-200 bg-slate-100 text-slate-600'
      : 'border-white/15 bg-white/10 text-white/70';

  return (
    <div className="absolute bottom-24 right-4 z-[1000] w-[min(420px,calc(100vw-2rem))] rounded-2xl glass-ui px-4 py-4 sm:right-10">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <BookOpenText className="mt-0.5 h-4 w-4 text-[#4ade80]" />
            <h3 className={`text-sm font-semibold ${titleClass}`}>本次回答</h3>
            <span className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${badgeClass}`}>
              {getSourceLabel(source)}
            </span>
          </div>
          {prompt && (
            <p className={`mt-1 truncate text-xs ${subClass}`}>问题：{prompt}</p>
          )}
        </div>
      </div>

      <div className={`max-h-[34vh] overflow-y-auto whitespace-pre-wrap pr-1 text-[13px] leading-6 ${textClass}`}>
        {answer}
      </div>

      <div
        className={`mt-3 border-t pt-3 text-xs ${subClass} ${
          theme === 'light' ? 'border-slate-200/80' : 'border-white/10'
        }`}
      >
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span>{showReferences ? '引用：显示中' : '引用：已隐藏'}</span>
          <span>{isKnowledgeBaseEnabled ? '知识库：已开启' : '知识库：已关闭'}</span>
        </div>
        <div className="mt-1.5">
          {locationCount > 0
            ? `已同步 ${locationCount} 个地图点，地图展示与文本答案会保持联动。`
            : '当前没有可落图的精确位置，已先展示文本答案。'}
        </div>
      </div>
    </div>
  );
}
