export type AnswerSource = 'model' | 'ragflow';

export interface CityData {
  name: string;
  lat: number;
  lng: number;
  info?: string;
  infoWithReferences?: string;
  source?: AnswerSource;
}

export interface ExtractQueryResult {
  answer?: string;
  answerWithReferences?: string;
  source?: AnswerSource;
  locations: CityData[];
}

export interface FollowupAnswer {
  info: string;
  infoWithReferences?: string;
  source?: AnswerSource;
}

export interface QueryOptions {
  useKnowledgeBase?: boolean;
}

interface ApiErrorPayload {
  error?: string;
  details?: string;
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

function sanitizeAnswerText(
  value?: string,
  options: { stripReferences?: boolean } = {}
): string | undefined {
  if (typeof value !== 'string') return undefined;

  const clean = normalizeAnswerText(value, options.stripReferences ?? true);
  return clean.length > 0 ? clean : undefined;
}

function sanitizeCity(city: CityData): CityData {
  const info = sanitizeAnswerText(city.info ?? city.infoWithReferences, {
    stripReferences: true,
  });
  const infoWithReferences = sanitizeAnswerText(
    city.infoWithReferences ?? city.info,
    {
      stripReferences: false,
    }
  );

  return {
    ...city,
    info,
    infoWithReferences,
  };
}

async function readErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const payload = (await response.json()) as ApiErrorPayload;
    const message = [payload.error, payload.details].filter(Boolean).join(': ');
    return message || fallback;
  } catch {
    return fallback;
  }
}

export async function extractQuery(
  prompt: string,
  options: QueryOptions = {}
): Promise<ExtractQueryResult> {
  const response = await fetch('/api/extractCities', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      prompt,
      useKnowledgeBase: options.useKnowledgeBase ?? true,
    }),
  });

  if (!response.ok) {
    throw new Error(
      await readErrorMessage(response, `Server returned ${response.status}`)
    );
  }

  const data = (await response.json()) as Partial<ExtractQueryResult> | CityData[];

  if (Array.isArray(data)) {
    return {
      locations: data.map(sanitizeCity),
      answer: undefined,
      answerWithReferences: undefined,
      source: undefined,
    };
  }

  return {
    locations: Array.isArray(data.locations) ? data.locations.map(sanitizeCity) : [],
    answer: sanitizeAnswerText(data.answer ?? data.answerWithReferences, {
      stripReferences: true,
    }),
    answerWithReferences: sanitizeAnswerText(
      data.answerWithReferences ?? data.answer,
      {
        stripReferences: false,
      }
    ),
    source: data.source === 'ragflow' || data.source === 'model' ? data.source : undefined,
  };
}

export async function extractCities(
  prompt: string,
  options: QueryOptions = {}
): Promise<CityData[]> {
  const result = await extractQuery(prompt, options);
  return result.locations;
}

export async function askCityFollowup(
  cityName: string,
  question: string,
  contextInfo?: string,
  options: QueryOptions = {}
): Promise<FollowupAnswer | null> {
  const fallbackPrompt = `请围绕“${cityName}”回答这个地理追问：${question}。如果已有背景信息，请参考：${
    contextInfo ?? '无'
  }。请返回简洁中文结论。`;

  try {
    const response = await fetch('/api/followupCity', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        cityName,
        question,
        contextInfo,
        useKnowledgeBase: options.useKnowledgeBase ?? true,
      }),
    });

    if (!response.ok) {
      throw new Error(
        await readErrorMessage(response, `/api/followupCity returned ${response.status}`)
      );
    }

    const data = (await response.json()) as Partial<FollowupAnswer>;
    const info = sanitizeAnswerText(data.info ?? data.infoWithReferences, {
      stripReferences: true,
    });
    const infoWithReferences = sanitizeAnswerText(
      data.infoWithReferences ?? data.info,
      {
        stripReferences: false,
      }
    );

    if (info) {
      return {
        info,
        infoWithReferences,
        source: data.source === 'ragflow' || data.source === 'model' ? data.source : undefined,
      };
    }
  } catch (error) {
    console.error('Error asking city follow-up:', error);

    if (error instanceof Error && error.message.includes('OPENAI_API_KEY is missing')) {
      throw error;
    }
  }

  try {
    const result = await extractQuery(fallbackPrompt, options);

    const exactCity = result.locations.find(
      city => city.name === cityName && typeof city.info === 'string' && city.info.trim().length > 0
    );
    if (exactCity?.info) {
      return {
        info: exactCity.info,
        infoWithReferences: exactCity.infoWithReferences ?? exactCity.info,
        source: exactCity.source,
      };
    }

    if (typeof result.answer === 'string' && result.answer.trim().length > 0) {
      return {
        info: result.answer,
        infoWithReferences: result.answerWithReferences ?? result.answer,
        source: result.source,
      };
    }

    const anyCityWithInfo = result.locations.find(
      city => typeof city.info === 'string' && city.info.trim().length > 0
    );
    if (anyCityWithInfo?.info) {
      return {
        info: anyCityWithInfo.info,
        infoWithReferences: anyCityWithInfo.infoWithReferences ?? anyCityWithInfo.info,
        source: anyCityWithInfo.source,
      };
    }
  } catch (error) {
    console.error('Fallback follow-up via extractQuery failed:', error);

    if (error instanceof Error) {
      throw error;
    }
  }

  return null;
}
