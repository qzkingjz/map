import dotenv from "dotenv";
import express from "express";
import OpenAI from "openai";
import path from "path";
import { createServer as createViteServer } from "vite";

dotenv.config();

type AnswerSource = "model" | "ragflow";

interface CityResult {
  name: string;
  lat: number;
  lng: number;
  info?: string;
  infoWithReferences?: string;
  source?: AnswerSource;
}

interface ExtractQueryResponse {
  answer?: string;
  answerWithReferences?: string;
  source?: AnswerSource;
  locations: CityResult[];
}

interface AnswerText {
  clean: string;
  withReferences: string;
}

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

interface RagflowEnvelope<T> {
  code?: number;
  data?: T;
  message?: string;
}

interface RagflowSessionData {
  id?: string;
}

interface RagflowCompletionData {
  answer?: string;
}

class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

const PORT = Number(process.env.PORT ?? 3000);

const foundationConfig = {
  apiKey: process.env.OPENAI_API_KEY?.trim(),
  baseURL: normalizeUrl(process.env.OPENAI_BASE_URL),
  model: process.env.OPENAI_MODEL?.trim() || "gpt-5.4",
};

const ragflowConfig = {
  flag: process.env.RAGFLOW_ENABLED?.trim(),
  baseURL: normalizeUrl(process.env.RAGFLOW_BASE_URL),
  apiKey: process.env.RAGFLOW_API_KEY?.trim(),
  chatId: process.env.RAGFLOW_CHAT_ID?.trim(),
  model: process.env.RAGFLOW_MODEL?.trim() || "ragflow-chat",
  timeoutMs: Number(process.env.RAGFLOW_TIMEOUT_MS ?? 60_000),
};

let foundationClient: OpenAI | null = null;

function normalizeUrl(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.replace(/\/+$/, "") : undefined;
}

function isTruthy(value?: string): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function isRagflowConfigured(): boolean {
  return Boolean(
    ragflowConfig.baseURL &&
      ragflowConfig.apiKey &&
      ragflowConfig.chatId
  );
}

function isRagflowEnabled(): boolean {
  if (typeof ragflowConfig.flag === "string" && ragflowConfig.flag.length > 0) {
    return isTruthy(ragflowConfig.flag) && isRagflowConfigured();
  }

  return isRagflowConfigured();
}

function getFoundationClient(): OpenAI {
  if (foundationClient) {
    return foundationClient;
  }

  if (!foundationConfig.apiKey) {
    throw new ConfigurationError(
      "OPENAI_API_KEY is missing. This app still needs a foundation model to extract map locations and coordinates."
    );
  }

  foundationClient = new OpenAI({
    apiKey: foundationConfig.apiKey,
    baseURL: foundationConfig.baseURL,
    timeout: 30_000,
  });

  return foundationClient;
}

function readMessageText(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }

      if (
        part &&
        typeof part === "object" &&
        "text" in part &&
        typeof part.text === "string"
      ) {
        return part.text;
      }

      return "";
    })
    .join("")
    .trim();
}

async function createChatText(
  client: OpenAI,
  model: string,
  messages: ChatMessage[]
): Promise<string> {
  const completion = await client.chat.completions.create({
    model,
    messages,
  });

  return readMessageText(completion.choices[0]?.message?.content);
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

function cleanJsonText(value: string): string {
  return value
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
}

function parseCityResults(rawText: string): CityResult[] {
  if (!rawText.trim()) {
    return [];
  }

  const cleanText = cleanJsonText(rawText);
  let parsedData: unknown;

  try {
    parsedData = JSON.parse(cleanText);
  } catch (error) {
    console.error("Failed to parse city JSON:", cleanText, error);
    return [];
  }

  const records = Array.isArray(parsedData)
    ? parsedData
    : parsedData &&
        typeof parsedData === "object" &&
        "cities" in parsedData &&
        Array.isArray(parsedData.cities)
      ? parsedData.cities
      : [parsedData];

  return records
    .map<CityResult | null>((record) => {
      if (!record || typeof record !== "object") {
        return null;
      }

      const name = typeof record.name === "string" ? record.name.trim() : "";
      const lat = toFiniteNumber(
        "lat" in record ? record.lat : "latitude" in record ? record.latitude : null
      );
      const lng = toFiniteNumber(
        "lng" in record
          ? record.lng
          : "lon" in record
            ? record.lon
            : "longitude" in record
              ? record.longitude
              : null
      );
      const info =
        typeof record.info === "string" && record.info.trim().length > 0
          ? record.info.trim()
          : undefined;

      if (!name || lat === null || lng === null) {
        return null;
      }

      return info ? { name, lat, lng, info } : { name, lat, lng };
    })
    .filter((record): record is CityResult => record !== null);
}

function buildCityExtractionMessages(prompt: string): ChatMessage[] {
  return [
    {
      role: "system",
      content: [
        "You extract global locations for a map application.",
        "Return only a JSON array.",
        "Each item must include name, lat, lng, info.",
        "Use the standard Chinese name in the name field.",
        "lat and lng must be finite decimal numbers.",
        "Only extract locations explicitly mentioned in the user's original question.",
        "Do not infer or add related neighborhoods, streets, districts, countries, or nearby places that are not named in the question.",
        "Only return real mappable geographic entities or named landmarks.",
        "Do not return abstract concepts, housing types, product names, or document titles.",
        "Examples to exclude: 四合院, 洋房, 别墅, 白皮书, 方案, 设备清单.",
        "If the user asks a factual question, write a concise Chinese answer in info.",
        "If the user is only highlighting a place, info can be empty or a one-sentence Chinese description.",
        "Do not wrap the JSON in markdown.",
      ].join(" "),
    },
    {
      role: "user",
      content: prompt,
    },
  ];
}

const LOCATION_HINT_SUFFIXES = [
  "市",
  "省",
  "区",
  "县",
  "州",
  "镇",
  "乡",
  "村",
  "岛",
  "湾",
  "山",
  "湖",
  "河",
  "江",
  "海",
  "洲",
  "路",
  "街",
  "桥",
  "港",
  "机场",
  "车站",
  "高铁站",
  "火车站",
  "地铁站",
  "大学",
  "医院",
  "校区",
  "公园",
  "广场",
  "景区",
  "大厦",
  "中心",
  "寺",
  "馆",
  "宫",
  "门",
];

const GENERIC_NON_LOCATION_TERMS = [
  "四合院",
  "洋房",
  "别墅",
  "公寓",
  "住宅",
  "户型",
  "楼盘",
  "白皮书",
  "设备清单",
  "文档",
  "方案",
  "资产",
  "清单",
];

function looksLikeSpecificLocationName(name: string): boolean {
  if (LOCATION_HINT_SUFFIXES.some((suffix) => name.endsWith(suffix))) {
    return true;
  }

  return /[\s,，]/.test(name);
}

function isSuspiciousExtractedLocation(name: string): boolean {
  const normalized = name.trim();
  if (!normalized) return true;

  if (GENERIC_NON_LOCATION_TERMS.some((term) => normalized.includes(term))) {
    return true;
  }

  if (normalized.length <= 4 && !looksLikeSpecificLocationName(normalized)) {
    return true;
  }

  return false;
}

function buildRagflowQuestion(
  cityName: string,
  userPrompt: string,
  contextInfo?: string
): string {
  const safeCityName = cityName.trim();
  const safePrompt = userPrompt.trim();
  const safeContext =
    typeof contextInfo === "string" ? contextInfo.trim() : "";

  if (!safePrompt) {
    return safeCityName;
  }

  if (safePrompt.includes(safeCityName)) {
    return safePrompt;
  }

  return [safeCityName, safePrompt, safeContext].filter(Boolean).join("\n");
}

function cleanRagflowAnswer(answer: string): string {
  return stripReferenceNoise(answer);
}

function stripReferenceNoise(value: string): string {
  return normalizeAnswerText(
    value
      .replace(/\[(?:ID:\d+|\d+(?:\s*,\s*\d+)*)\]/gi, " ")
      .replace(/\bFig(?:ure)?\.\s*\d+\b/gi, " ")
      .replace(/\bFigure\s*\d+\b/gi, " ")
  );
}

function normalizeAnswerText(value: string): string {
  return value
    .replace(/##\d+\$\$/g, "")
    .replace(/[^\S\r\n]{2,}/g, " ")
    .replace(/[ \t]+([,.;:!???????????])/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function buildAnswerText(value: string): AnswerText {
  const withReferences = normalizeAnswerText(value);

  return {
    clean: cleanRagflowAnswer(withReferences),
    withReferences,
  };
}

function readKnowledgeBasePreference(value: unknown): boolean {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    return !["0", "false", "off", "no"].includes(value.trim().toLowerCase());
  }

  return true;
}

function isRagflowKnowledgeMiss(answer: string): boolean {
  const normalized = answer.replace(/\s+/g, "");

  return [
    "知识库中未找到您要的答案",
    "知识库中未找到相关答案",
    "知识库中暂无明确信息",
    "未在知识库中找到相关答案",
  ].some((marker) => normalized.includes(marker));
}

async function requestRagflow<T>(
  path: string,
  init: RequestInit
): Promise<T> {
  if (
    !isRagflowEnabled() ||
    !ragflowConfig.baseURL ||
    !ragflowConfig.apiKey ||
    !ragflowConfig.chatId
  ) {
    throw new ConfigurationError(
      "RAGFlow is not fully configured. Please check RAGFLOW_BASE_URL, RAGFLOW_API_KEY, and RAGFLOW_CHAT_ID."
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ragflowConfig.timeoutMs);

  try {
    const response = await fetch(`${ragflowConfig.baseURL}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${ragflowConfig.apiKey}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
      signal: controller.signal,
    });

    const text = await response.text();
    let payload: RagflowEnvelope<T>;

    try {
      payload = JSON.parse(text) as RagflowEnvelope<T>;
    } catch {
      throw new Error(`Invalid RAGFlow response: ${text.slice(0, 200)}`);
    }

    if (!response.ok || payload.code !== 0) {
      throw new Error(
        `RAGFlow request failed (${response.status}): ${payload.message ?? text.slice(0, 200)}`
      );
    }

    return payload.data as T;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(
        `RAGFlow request timed out after ${ragflowConfig.timeoutMs}ms`
      );
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function createRagflowSession(sessionName: string): Promise<string> {
  const data = await requestRagflow<RagflowSessionData>(
    `/api/v1/chats/${ragflowConfig.chatId}/sessions`,
    {
      method: "POST",
      body: JSON.stringify({ name: sessionName }),
    }
  );

  const sessionId = typeof data.id === "string" ? data.id.trim() : "";
  if (!sessionId) {
    throw new Error("RAGFlow did not return a session id.");
  }

  return sessionId;
}

function buildGeneralRagflowQuestion(prompt: string): string {
  return prompt.trim();
}

function buildGeneralFoundationAnswerMessages(prompt: string): ChatMessage[] {
  return [
    {
      role: "system",
      content: [
        "你是一名全球地理知识助手。",
        "请直接回答用户的完整问题，不要先拆词。",
        "如果问题涉及分布、人口、迁移、热点区域，请明确写出国家、地区或城市名称，方便地图定位。",
        "回答使用简洁中文，控制在 3-6 句。",
        "只返回纯文本，不要 Markdown。",
      ].join(" "),
    },
    {
      role: "user",
      content: prompt,
    },
  ];
}

function buildLocationExtractionFromAnswerMessages(answer: string): ChatMessage[] {
  return [
    {
      role: "system",
      content: [
        "You extract real-world mappable locations from answer text.",
        "Return only a JSON array.",
        "Each item must include name, lat, lng, info.",
        "Use standard Chinese names for locations.",
        "Ignore citation markers like [ID:2], [1], Fig. 3, and markdown artifacts.",
        "If an exact street address or school name is mentioned but exact coordinates are uncertain, fall back to the nearest city, district, or province explicitly mentioned in the text.",
        "It is better to return a coarse city-level location with approximate center coordinates than an empty array.",
        "Only keep concrete places that can be placed on a map.",
        "If there is truly no place name at all, return an empty array.",
      ].join(" "),
    },
    {
      role: "user",
      content: answer,
    },
  ];
}

function buildCoarseLocationFallbackMessages(answer: string): ChatMessage[] {
  return [
    {
      role: "system",
      content: [
        "You extract fallback map locations from answer text.",
        "Return only a JSON array.",
        "Each item must include name, lat, lng, info.",
        "Use standard Chinese names.",
        "If the answer contains a detailed address, school, neighborhood, or project but you cannot locate the exact point, return the nearest explicit city, district, or province mentioned in the text.",
        "Use approximate center coordinates for that city, district, or province.",
        "Prefer 1 to 3 high-confidence locations.",
        "Ignore citations such as [ID:2], [1], Fig. 3.",
      ].join(" "),
    },
    {
      role: "user",
      content: answer,
    },
  ];
}

function normalizeKnowledgeAnswer(answer: string): string {
  return stripReferenceNoise(answer)
    .replace(/\s+/g, " ")
    .trim();
}

function dedupeCityResults(cities: CityResult[]): CityResult[] {
  const seen = new Set<string>();

  return cities.filter((city) => {
    const key = `${city.name}|${city.lat.toFixed(4)}|${city.lng.toFixed(4)}`;
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function attachAnswerToCities(
  cities: CityResult[],
  answer: AnswerText,
  source: AnswerSource
): CityResult[] {
  return cities.map((city) => ({
    ...city,
    info: answer.clean,
    infoWithReferences: answer.withReferences,
    source,
  }));
}

function getPrimarySource(cities: CityResult[]): AnswerSource | undefined {
  if (cities.some((city) => city.source === "ragflow")) {
    return "ragflow";
  }

  if (cities.some((city) => city.source === "model")) {
    return "model";
  }

  return undefined;
}

function getCityAnswerText(
  city: CityResult,
  field: "info" | "infoWithReferences"
): string | undefined {
  const value =
    field === "infoWithReferences"
      ? city.infoWithReferences?.trim() || city.info?.trim()
      : city.info?.trim();

  return value && value.length > 0 ? value : undefined;
}

function buildAnswerFromCities(
  cities: CityResult[],
  field: "info" | "infoWithReferences" = "info"
): string | undefined {
  const informativeCities = cities.filter((city) => getCityAnswerText(city, field));

  if (informativeCities.length === 0) {
    return undefined;
  }

  if (informativeCities.length === 1) {
    return getCityAnswerText(informativeCities[0], field);
  }

  return informativeCities
    .slice(0, 6)
    .map((city) => `${city.name}: ${getCityAnswerText(city, field)}`)
    .join("\n\n");
}

function buildQueryResponse(
  locations: CityResult[],
  answer?: AnswerText | null,
  source?: AnswerSource
): ExtractQueryResponse {
  const normalizedLocations = locations.map((city) => ({
    ...city,
    infoWithReferences: city.infoWithReferences ?? city.info,
  }));
  const cleanAnswer = answer?.clean || buildAnswerFromCities(normalizedLocations, "info");
  const answerWithReferences =
    answer?.withReferences ||
    buildAnswerFromCities(normalizedLocations, "infoWithReferences") ||
    cleanAnswer;

  return {
    answer: cleanAnswer,
    answerWithReferences,
    source: source ?? getPrimarySource(normalizedLocations),
    locations: normalizedLocations,
  };
}

async function answerGeneralWithRagflow(prompt: string): Promise<AnswerText | null> {
  if (!isRagflowEnabled()) {
    return null;
  }

  const sessionId = await createRagflowSession(`map-general-${Date.now()}`);
  const data = await requestRagflow<RagflowCompletionData>(
    `/api/v1/chats/${ragflowConfig.chatId}/completions`,
    {
      method: "POST",
      body: JSON.stringify({
        question: buildGeneralRagflowQuestion(prompt),
        session_id: sessionId,
        stream: false,
      }),
    }
  );

  const answer =
    typeof data.answer === "string" ? buildAnswerText(data.answer) : null;

  if (!answer || isRagflowKnowledgeMiss(answer.withReferences)) {
    return null;
  }

  return answer;
}

async function answerGeneralWithFoundation(
  prompt: string
): Promise<AnswerText | null> {
  const answer = await createChatText(
    getFoundationClient(),
    foundationConfig.model,
    buildGeneralFoundationAnswerMessages(prompt)
  );

  if (!answer.trim()) {
    return null;
  }

  return buildAnswerText(answer);
}
async function extractLocationsFromKnowledgeAnswer(
  answer: string
): Promise<CityResult[]> {
  const normalizedAnswer = normalizeKnowledgeAnswer(answer);
  const rawText = await createChatText(
    getFoundationClient(),
    foundationConfig.model,
    buildLocationExtractionFromAnswerMessages(normalizedAnswer)
  );

  const primaryLocations = dedupeCityResults(parseCityResults(rawText));
  if (primaryLocations.length > 0) {
    return primaryLocations;
  }

  const fallbackText = await createChatText(
    getFoundationClient(),
    foundationConfig.model,
    buildCoarseLocationFallbackMessages(normalizedAnswer)
  );

  return dedupeCityResults(parseCityResults(fallbackText));
}

async function extractLocationsFromPrompt(prompt: string): Promise<CityResult[]> {
  const rawText = await createChatText(
    getFoundationClient(),
    foundationConfig.model,
    buildCityExtractionMessages(prompt)
  );

  return dedupeCityResults(parseCityResults(rawText));
}

async function resolvePromptThroughRagflow(
  prompt: string
): Promise<ExtractQueryResponse | null> {
  const answer = await answerGeneralWithRagflow(prompt);
  if (!answer) {
    return null;
  }

  const answerLocations = await extractLocationsFromPrompt(prompt);
  return buildQueryResponse(
    attachAnswerToCities(answerLocations, answer, "ragflow"),
    answer,
    "ragflow"
  );
}

async function resolvePromptThroughFoundation(
  prompt: string
): Promise<ExtractQueryResponse | null> {
  const answer = await answerGeneralWithFoundation(prompt);
  if (!answer) {
    return null;
  }

  const answerLocations = await extractLocationsFromPrompt(prompt);
  return buildQueryResponse(
    attachAnswerToCities(answerLocations, answer, "model"),
    answer,
    "model"
  );
}

async function tryResolvePromptThroughRagflow(
  prompt: string,
  useKnowledgeBase = true
): Promise<ExtractQueryResponse | null> {
  if (!useKnowledgeBase || !isRagflowEnabled()) {
    return null;
  }

  try {
    return await resolvePromptThroughRagflow(prompt);
  } catch (error) {
    console.warn("RAGFlow general lookup failed:", error);
    return null;
  }
}

function buildFoundationFollowupMessages(
  cityName: string,
  question: string,
  contextInfo?: string
): ChatMessage[] {
  return [
    {
      role: "system",
      content: [
        "你是一名地理知识助手。",
        "请根据地点和问题返回简洁、准确的中文回答。",
        "只返回纯文本，不要 Markdown。",
        "回答控制在 2-4 句。",
      ].join(" "),
    },
    {
      role: "user",
      content: [
        `地点：${cityName}`,
        `问题：${question}`,
        `已有背景：${typeof contextInfo === "string" ? contextInfo : ""}`,
      ].join("\n"),
    },
  ];
}

async function answerWithRagflow(
  cityName: string,
  userPrompt: string,
  contextInfo?: string
): Promise<AnswerText | null> {
  if (!isRagflowEnabled()) {
    return null;
  }

  const sessionId = await createRagflowSession(
    `map-${cityName}-${Date.now()}`
  );
  const data = await requestRagflow<RagflowCompletionData>(
    `/api/v1/chats/${ragflowConfig.chatId}/completions`,
    {
      method: "POST",
      body: JSON.stringify({
        question: buildRagflowQuestion(cityName, userPrompt, contextInfo),
        session_id: sessionId,
        stream: false,
      }),
    }
  );

  const answer =
    typeof data.answer === "string" ? buildAnswerText(data.answer) : null;

  if (!answer || isRagflowKnowledgeMiss(answer.withReferences)) {
    return null;
  }

  return answer;
}

async function enrichCityWithKnowledge(
  city: CityResult,
  originalPrompt: string,
  useKnowledgeBase = true
): Promise<CityResult> {
  if (useKnowledgeBase) {
    try {
      const ragflowInfo = await answerWithRagflow(city.name, originalPrompt, city.info);
      if (ragflowInfo) {
        return {
          ...city,
          info: ragflowInfo.clean,
          infoWithReferences: ragflowInfo.withReferences,
          source: "ragflow",
        };
      }
    } catch (error) {
      console.warn(`RAGFlow enrichment failed for ${city.name}:`, error);
    }
  }

  if (city.info?.trim()) {
    return {
      ...city,
      info: city.info.trim(),
      infoWithReferences: city.infoWithReferences?.trim() || city.info.trim(),
      source: "model",
    };
  }

  return city;
}

async function answerFollowupQuestion(
  cityName: string,
  question: string,
  contextInfo?: string,
  useKnowledgeBase = true
): Promise<{
  info: string;
  infoWithReferences: string;
  source: AnswerSource;
} | null> {
  if (useKnowledgeBase) {
    try {
      const ragflowInfo = await answerWithRagflow(cityName, question, contextInfo);
      if (ragflowInfo) {
        return {
          info: ragflowInfo.clean,
          infoWithReferences: ragflowInfo.withReferences,
          source: "ragflow",
        };
      }
    } catch (error) {
      console.warn(`RAGFlow follow-up failed for ${cityName}:`, error);
    }
  }

  const info = await createChatText(
    getFoundationClient(),
    foundationConfig.model,
    buildFoundationFollowupMessages(cityName, question, contextInfo)
  );

  if (!info.trim()) {
    return null;
  }

  const answer = buildAnswerText(info);

  return {
    info: answer.clean,
    infoWithReferences: answer.withReferences,
    source: "model",
  };
}

function getStatusCode(error: unknown): number {
  return error instanceof ConfigurationError ? 503 : 500;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown server error";
}

async function startServer() {
  const app = express();

  app.use(express.json());

  app.get("/healthz", (_req, res) => {
    res.json({
      ok: true,
      service: "qiaoqing-map",
      timestamp: new Date().toISOString(),
    });
  });

  if (ragflowConfig.flag && isTruthy(ragflowConfig.flag) && !isRagflowConfigured()) {
    console.warn(
      "[ragflow] RAGFLOW_ENABLED is true, but RAGFLOW_BASE_URL / RAGFLOW_API_KEY / RAGFLOW_CHAT_ID are incomplete."
    );
  }

  app.post("/api/followupCity", async (req, res) => {
    try {
      const { cityName, question, contextInfo } = req.body ?? {};
      const useKnowledgeBase = readKnowledgeBasePreference(
        req.body?.useKnowledgeBase
      );

      if (typeof cityName !== "string" || typeof question !== "string") {
        return res.status(400).json({ error: "Invalid request payload" });
      }

      const safeCityName = cityName.trim();
      const safeQuestion = question.trim();
      if (!safeCityName || !safeQuestion) {
        return res.status(400).json({ error: "City or question is empty" });
      }

      const answer = await answerFollowupQuestion(
        safeCityName,
        safeQuestion,
        typeof contextInfo === "string" ? contextInfo : undefined,
        useKnowledgeBase
      );

      if (!answer) {
        return res.json({
          info: "知识库暂未返回相关结果，请换个问法再试一次。",
          infoWithReferences: "知识库暂未返回相关结果，请换个问法再试一次。",
          source: useKnowledgeBase && isRagflowEnabled() ? "ragflow" : "model",
        });
      }

      return res.json(answer);
    } catch (error) {
      console.error("Follow-up API error:", error);
      return res.status(getStatusCode(error)).json({
        error: "Failed to answer follow-up question",
        details: getErrorMessage(error),
      });
    }
  });

  app.post("/api/extractCities", async (req, res) => {
    try {
      const prompt = typeof req.body?.prompt === "string" ? req.body.prompt.trim() : "";
      const useKnowledgeBase = readKnowledgeBasePreference(
        req.body?.useKnowledgeBase
      );

      if (!prompt) {
        return res.status(400).json({ error: "Prompt is required" });
      }

      const ragflowResolvedCities = await tryResolvePromptThroughRagflow(
        prompt,
        useKnowledgeBase
      );
      if (ragflowResolvedCities) {
        return res.json(ragflowResolvedCities);
      }

      const rawText = await createChatText(
        getFoundationClient(),
        foundationConfig.model,
        buildCityExtractionMessages(prompt)
      );

      const cities = parseCityResults(rawText);
      const shouldUseGeneralKnowledgeFirst =
        cities.length === 0 ||
        cities.every((city) => isSuspiciousExtractedLocation(city.name));

      if (shouldUseGeneralKnowledgeFirst) {
        const foundationResolvedCities = await resolvePromptThroughFoundation(prompt);
        if (foundationResolvedCities) {
          return res.json(foundationResolvedCities);
        }
      }

      if (cities.length === 0) {
        return res.json(buildQueryResponse([]));
      }

      const enrichedCities = await Promise.all(
        cities.map((city) =>
          enrichCityWithKnowledge(city, prompt, useKnowledgeBase)
        )
      );

      const hasKnowledgeHit = enrichedCities.some((city) => city.source === "ragflow");
      const allExtractedCitiesAreSuspicious = enrichedCities.every((city) =>
        isSuspiciousExtractedLocation(city.name)
      );

      if (!hasKnowledgeHit && allExtractedCitiesAreSuspicious) {
        const foundationResolvedCities = await resolvePromptThroughFoundation(prompt);
        if (foundationResolvedCities) {
          return res.json(foundationResolvedCities);
        }
      }

      return res.json(buildQueryResponse(enrichedCities));
    } catch (error) {
      console.error("Extract cities API error:", error);
      return res.status(getStatusCode(error)).json({
        error: "Failed to extract cities",
        details: getErrorMessage(error),
      });
    }
  });

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`[ai] Foundation model: ${foundationConfig.model}`);
    console.log(`[ragflow] Knowledge mode: ${isRagflowEnabled() ? "enabled" : "disabled"}`);
    console.log("[ragflow] Transport: native chat API");
  });
}

startServer();
