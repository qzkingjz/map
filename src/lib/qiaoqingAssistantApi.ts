export type QiaoqingAssistantSource = 'ragflow' | 'model';

export interface QiaoqingAssistantReference {
  id?: string;
  title: string;
  excerpt?: string;
  score?: number;
  documentId?: string;
  datasetId?: string;
}

export interface QiaoqingAssistantResponse {
  answer: string;
  answerWithReferences?: string;
  source: QiaoqingAssistantSource;
  references?: QiaoqingAssistantReference[];
}

export interface QiaoqingAssistantOptions {
  useKnowledgeBase?: boolean;
}

interface ApiErrorPayload {
  error?: string;
  details?: string;
  message?: string;
}

function normalizeAnswerText(text: string, stripReferences: boolean): string {
  let normalized = text.replace(/##\d+\$\$/g, '');

  if (stripReferences) {
    normalized = normalized
      .replace(/\[(?:ID:\d+|\d+(?:\s*,\s*\d+)*)\]/gi, ' ')
      .replace(/\bFig(?:ure)?\.\s*\d+\b/gi, ' ')
      .replace(/\bFigure\s*\d+\b/gi, ' ');
  }

  return normalized
    .replace(/[^\S\r\n]{2,}/g, ' ')
    .replace(/[ \t]+([,.;:!?，。；：！？])/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function readAssistantError(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as ApiErrorPayload;
    return [payload.error, payload.details, payload.message].filter(Boolean).join(': ');
  } catch {
    return '';
  }
}

export async function askQiaoqingAssistant(
  message: string,
  conversationId: string,
  options: QiaoqingAssistantOptions = {}
): Promise<QiaoqingAssistantResponse> {
  const response = await fetch('/api/qiaoqing-assistant', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message,
      conversationId,
      useKnowledgeBase: options.useKnowledgeBase ?? true,
    }),
  });

  if (!response.ok) {
    const detail = await readAssistantError(response);
    throw new Error(detail || `知识库服务返回 ${response.status}`);
  }

  const data = (await response.json()) as Partial<QiaoqingAssistantResponse>;
  const answer = normalizeAnswerText(data.answerWithReferences ?? data.answer ?? '', true);
  const answerWithReferences = normalizeAnswerText(
    data.answerWithReferences ?? data.answer ?? '',
    false
  );

  if (!answer) {
    throw new Error('知识库暂未返回可展示的答案');
  }

  return {
    answer,
    answerWithReferences: answerWithReferences || answer,
    source: data.source === 'model' ? 'model' : 'ragflow',
    references: Array.isArray(data.references)
      ? data.references.filter(
          reference =>
            reference &&
            typeof reference.title === 'string' &&
            reference.title.trim().length > 0
        )
      : [],
  };
}
