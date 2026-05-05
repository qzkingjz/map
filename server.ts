import dotenv from "dotenv";
import express from "express";
import crypto from "node:crypto";
import mysql, { type Pool, type ResultSetHeader, type RowDataPacket } from "mysql2/promise";
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
type CollectionSourceType = "crawler" | "tavily" | "bing" | "gdelt" | "rss";
type CollectionSourceMode = "auto" | "crawler" | "tavily";

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

interface GdeltArticle {
  title?: string;
  url?: string;
  domain?: string;
  seendate?: string;
  language?: string;
  sourcecountry?: string;
  socialimage?: string;
  content?: string;
  raw_content?: string | null;
}

interface CrawlerSource {
  name: string;
  listUrls: string[];
  articleUrlPattern?: RegExp;
}

interface BingNewsItem {
  name?: string;
  url?: string;
  description?: string;
  datePublished?: string;
  provider?: Array<{ name?: string }>;
  image?: {
    thumbnail?: {
      contentUrl?: string;
    };
  };
}

interface TavilySearchResult {
  title?: string;
  url?: string;
  content?: string;
  raw_content?: string | null;
  published_date?: string;
  score?: number;
  images?: Array<{ url?: string } | string>;
}

interface NewsArticleSummary {
  display_title: string;
  source_name: string;
  summary: string;
  qiaoqing_points: string[];
  regions: string[];
  people: string[];
  organizations: string[];
  tags: string[];
  importance: number;
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

const adminDbConfig = {
  host: process.env.APP_DB_HOST?.trim(),
  port: Number(process.env.APP_DB_PORT ?? 3306),
  database: process.env.APP_DB_NAME?.trim(),
  user: process.env.APP_DB_USER?.trim(),
  password: process.env.APP_DB_PASSWORD ?? "",
};

const adminBootstrapConfig = {
  username: process.env.APP_ADMIN_USERNAME?.trim() || "admin",
  password: process.env.APP_ADMIN_PASSWORD ?? "fjma1234",
  displayName: process.env.APP_ADMIN_DISPLAY_NAME?.trim() || "系统管理员",
};

const adminSessionCookieName = "qiaoqing_admin_session";
const adminSessionTtlMs = Number(process.env.APP_SESSION_TTL_HOURS ?? 12) * 60 * 60 * 1000;
const adminCookieSecure = isTruthy(process.env.APP_COOKIE_SECURE);
const captchaTtlMs = Number(process.env.APP_CAPTCHA_TTL_SECONDS ?? 300) * 1000;

interface CaptchaChallenge {
  answerHash: string;
  expiresAt: number;
  attempts: number;
}

const captchaStore = new Map<string, CaptchaChallenge>();

const newsSearchConfig = {
  tavilyApiKey: process.env.TAVILY_API_KEY?.trim(),
  tavilyEndpoint:
    process.env.TAVILY_SEARCH_ENDPOINT?.trim() ||
    "https://api.tavily.com/search",
  tavilyTopic: process.env.TAVILY_TOPIC?.trim() || "general",
  tavilySearchDepth: process.env.TAVILY_SEARCH_DEPTH?.trim() || "basic",
  tavilyIncludeRawContent: process.env.TAVILY_INCLUDE_RAW_CONTENT?.trim() || "false",
  tavilyIncludeDomains: process.env.TAVILY_INCLUDE_DOMAINS?.trim(),
  bingApiKey: process.env.BING_NEWS_SEARCH_KEY?.trim(),
  bingEndpoint:
    process.env.BING_NEWS_SEARCH_ENDPOINT?.trim() ||
    "https://api.bing.microsoft.com/v7.0/news/search",
  market: process.env.BING_NEWS_SEARCH_MARKET?.trim() || "zh-CN",
};

const defaultChineseNewsDomains = [
  "chinaqw.com",
  "chinanews.com.cn",
  "fj.chinanews.com.cn",
  "people.com.cn",
  "xinhuanet.com",
  "cctv.com",
  "cnr.cn",
  "cri.cn",
  "gmw.cn",
  "china.com.cn",
  "ce.cn",
  "fjsen.com",
  "qz.fjsen.com",
  "qzwb.com",
  "qztv.cn",
  "hqu.edu.cn",
];

const sourceNameByDomain: Record<string, string> = {
  "chinaqw.com": "中国侨网",
  "chinanews.com.cn": "中国新闻网",
  "fj.chinanews.com.cn": "中新网福建",
  "people.com.cn": "人民网",
  "xinhuanet.com": "新华网",
  "cctv.com": "央视网",
  "cnr.cn": "央广网",
  "cri.cn": "国际在线",
  "gmw.cn": "光明网",
  "china.com.cn": "中国网",
  "ce.cn": "中国经济网",
  "fjsen.com": "东南网",
  "qz.fjsen.com": "东南网泉州",
  "qzwb.com": "泉州网",
  "qztv.cn": "泉州广播电视台",
  "hqu.edu.cn": "华侨大学",
};

const crawlerSources: CrawlerSource[] = [
  {
    name: "中国侨网",
    listUrls: [
      "http://www.chinaqw.com/qx/",
      "http://www.chinaqw.com/ydylpc/",
      "http://www.chinaqw.com/hqhr/",
    ],
    articleUrlPattern: /chinaqw\.com\/.+\/\d{4}\/\d{2}-\d{2}\/\d+\.shtml/i,
  },
  {
    name: "中新网福建",
    listUrls: [
      "http://www.fj.chinanews.com.cn/news/",
      "http://www.fj.chinanews.com.cn/news/fj_qw.html",
    ],
    articleUrlPattern: /fj\.chinanews\.com\.cn\/news\/\d{4}\/\d{4}-\d{2}-\d{2}\/\d+\.html/i,
  },
  {
    name: "华侨大学新闻网",
    listUrls: [
      "https://news.hqu.edu.cn/mthd.htm",
      "https://news.hqu.edu.cn/zhxw.htm",
      "https://www.hqu.edu.cn/index/mtkd.htm",
    ],
    articleUrlPattern: /hqu\.edu\.cn\/info\/\d+\/\d+\.htm/i,
  },
  {
    name: "东南网泉州",
    listUrls: ["https://qz.fjsen.com/"],
    articleUrlPattern: /fjsen\.com\/\d{4}-\d{2}\/\d{2}\/content_\d+\.htm/i,
  },
  {
    name: "泉州网",
    listUrls: ["https://www.qzwb.com/"],
    articleUrlPattern: /qzwb\.com\/gb\/content\/\d{4}-\d{2}\/\d{2}\/content_\d+\.htm/i,
  },
];

let foundationClient: OpenAI | null = null;
let adminDbPool: Pool | null = null;

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
  if (!(error instanceof Error)) {
    return "Unknown server error";
  }

  const cause = error.cause as { code?: string; message?: string } | undefined;
  if (cause?.code) {
    return `${error.message}: ${cause.code}`;
  }

  if (cause?.message) {
    return `${error.message}: ${cause.message}`;
  }

  return error.message;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function fetchWithRetry(
  input: Parameters<typeof fetch>[0],
  init: RequestInit,
  timeoutMs: number,
  label: string,
  attempts = 3
): Promise<Response> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetch(input, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      lastError = error;
      if (attempt >= attempts) break;

      console.warn(
        `[collection] ${label} fetch attempt ${attempt} failed:`,
        getErrorMessage(error)
      );
      await wait(700 * attempt);
    }
  }

  throw lastError;
}

function detectHtmlCharset(contentType: string | null, bytes: Uint8Array): string {
  const typeMatch = contentType?.match(/charset=([^;\s]+)/i);
  if (typeMatch?.[1]) return typeMatch[1].trim().toLowerCase();

  const head = new TextDecoder("utf-8", { fatal: false })
    .decode(bytes.slice(0, 4096))
    .toLowerCase();
  const metaMatch = head.match(/charset=["']?\s*([a-z0-9_-]+)/i);
  return metaMatch?.[1]?.trim().toLowerCase() || "utf-8";
}

function normalizeCharset(charset: string): string {
  if (["gb2312", "gbk", "gb18030"].includes(charset)) return "gb18030";
  return charset || "utf-8";
}

async function fetchHtml(url: string): Promise<string> {
  const response = await fetchWithRetry(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) qiaoqing-map-collector/1.0",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "zh-CN,zh;q=0.9",
    },
  }, 15_000, `Crawler ${url}`, 2);

  if (!response.ok) {
    throw new Error(`Crawler returned ${response.status} for ${url}`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  const charset = normalizeCharset(detectHtmlCharset(response.headers.get("content-type"), bytes));

  try {
    return new TextDecoder(charset, { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }
}

function stripHtml(value: string): string {
  return decodeXmlText(
    value
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
  );
}

function resolveArticleUrl(href: string, baseUrl: string): string | null {
  if (!href || href.startsWith("#") || href.toLowerCase().startsWith("javascript:")) {
    return null;
  }

  try {
    return new URL(decodeXmlText(href), baseUrl).toString();
  } catch {
    return null;
  }
}

function keywordTerms(keyword: string): string[] {
  return keyword
    .split(/[\s,，、;；]+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2);
}

function matchesKeyword(value: string, keyword: string): boolean {
  const terms = keywordTerms(keyword);
  if (terms.length === 0) return true;
  return terms.some((term) => value.includes(term));
}

function extractCrawlerLinks(html: string, baseUrl: string, source: CrawlerSource, keyword: string): GdeltArticle[] {
  const links: GdeltArticle[] = [];
  const seen = new Set<string>();
  const anchorPattern = /<a\b[^>]*href=["']?([^"'\s>]+)["']?[^>]*>([\s\S]*?)<\/a>/gi;

  for (const match of html.matchAll(anchorPattern)) {
    const url = resolveArticleUrl(match[1], baseUrl);
    if (!url || seen.has(url)) continue;
    if (source.articleUrlPattern && !source.articleUrlPattern.test(url)) continue;

    const title = stripHtml(match[2]);
    const searchable = `${title} ${url}`;
    if (!hasChineseText(title) || !matchesKeyword(searchable, keyword)) continue;

    seen.add(url);
    links.push({
      title,
      url,
      domain: source.name,
      language: "zh-CN",
      sourcecountry: "China",
    });
  }

  return links;
}

function readMetaContent(html: string, property: string): string | undefined {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`,
    "i"
  );
  const match = html.match(pattern);
  return match ? decodeXmlText(match[1]) : undefined;
}

function extractArticleTitle(html: string, fallback?: string): string | undefined {
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1) {
    const text = stripHtml(h1[1]);
    if (text) return text;
  }

  const metaTitle = readMetaContent(html, "og:title");
  if (metaTitle) return metaTitle;

  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (title) {
    return stripHtml(title[1]).replace(/[-_].{0,20}$/, "").trim();
  }

  return fallback;
}

function extractArticlePublishedAt(html: string): string | undefined {
  const metaDate =
    readMetaContent(html, "article:published_time") ||
    readMetaContent(html, "pubdate") ||
    readMetaContent(html, "publishdate");
  if (metaDate) return metaDate;

  const dateMatch = html.match(/(\d{4})[年\-\/.](\d{1,2})[月\-\/.](\d{1,2})[日\sT]*(\d{1,2}:\d{2}(?::\d{2})?)?/);
  if (!dateMatch) return undefined;

  const [, year, month, day, time] = dateMatch;
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")} ${time ?? "00:00:00"}`;
}

function extractArticleImage(html: string, baseUrl: string): string | undefined {
  const image = readMetaContent(html, "og:image");
  if (!image) return undefined;
  return resolveArticleUrl(image, baseUrl) ?? image;
}

function extractArticleContent(html: string): string {
  const articleMatch =
    html.match(/<article[\s\S]*?>([\s\S]*?)<\/article>/i) ||
    html.match(/<div[^>]+(?:id|class)=["'][^"']*(?:content|article|text|main|TRS_Editor)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);

  const block = articleMatch?.[1] ?? html;
  const paragraphs = [...block.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((match) => stripHtml(match[1]))
    .filter((item) => item.length >= 8);

  const text = (paragraphs.length > 0 ? paragraphs.join("\n") : stripHtml(block))
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return text.slice(0, 6000);
}

async function enrichCrawlerArticle(article: GdeltArticle, source: CrawlerSource): Promise<GdeltArticle | null> {
  if (!article.url) return null;

  try {
    const html = await fetchHtml(article.url);
    const title = extractArticleTitle(html, article.title);
    const content = extractArticleContent(html);
    if (!title || !hasChineseText(title) || !content || !hasChineseText(content)) {
      return null;
    }

    return {
      ...article,
      title,
      domain: source.name,
      seendate: extractArticlePublishedAt(html),
      socialimage: extractArticleImage(html, article.url),
      content,
      raw_content: content,
    };
  } catch (error) {
    console.warn("[collection] Crawler article failed:", article.url, getErrorMessage(error));
    return null;
  }
}

async function fetchCrawlerArticles(
  keyword: string,
  _timeRangeDays: number,
  maxRecords: number
): Promise<GdeltArticle[]> {
  const candidates: GdeltArticle[] = [];
  const seen = new Set<string>();

  for (const source of crawlerSources) {
    for (const listUrl of source.listUrls) {
      try {
        const html = await fetchHtml(listUrl);
        for (const article of extractCrawlerLinks(html, listUrl, source, keyword)) {
          if (!article.url || seen.has(article.url)) continue;
          seen.add(article.url);
          candidates.push(article);
        }
      } catch (error) {
        console.warn("[collection] Crawler list failed:", listUrl, getErrorMessage(error));
      }
    }
  }

  const enriched: GdeltArticle[] = [];
  for (const candidate of candidates.slice(0, Math.max(maxRecords * 4, 12))) {
    const source = crawlerSources.find((item) =>
      item.articleUrlPattern?.test(candidate.url ?? "")
    );
    if (!source) continue;

    const article = await enrichCrawlerArticle(candidate, source);
    if (!article) continue;

    const searchable = `${article.title ?? ""}\n${article.content ?? ""}`;
    if (!matchesKeyword(searchable, keyword)) continue;
    enriched.push(article);
    if (enriched.length >= maxRecords) break;
  }

  return filterChineseDomesticArticles(enriched);
}

function parseGdeltDate(value?: string): Date | null {
  if (!value) return null;

  const compact = value.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if (compact) {
    const [, year, month, day, hour, minute, second] = compact;
    return new Date(
      `${year}-${month}-${day}T${hour}:${minute}:${second}Z`
    );
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function toMysqlDate(value: Date | null): string | null {
  if (!value || Number.isNaN(value.getTime())) return null;

  return value.toISOString().slice(0, 19).replace("T", " ");
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function compactStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 12);
}

function splitCsv(value?: string): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function chineseSearchDomains(): string[] {
  const configured = splitCsv(newsSearchConfig.tavilyIncludeDomains);
  return configured.length > 0 ? configured : defaultChineseNewsDomains;
}

function normalizeNewsDomain(value?: string): string | undefined {
  if (!value) return undefined;

  try {
    return new URL(value).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return value.replace(/^www\./, "").toLowerCase();
  }
}

function sourceDisplayName(domainOrUrl?: string): string {
  const domain = normalizeNewsDomain(domainOrUrl);
  if (!domain) return "国内资讯";

  const directName = sourceNameByDomain[domain];
  if (directName) return directName;

  const matchedDomain = Object.keys(sourceNameByDomain).find((item) =>
    domain === item || domain.endsWith(`.${item}`)
  );

  return matchedDomain ? sourceNameByDomain[matchedDomain] : "国内资讯";
}

function hasChineseText(value?: string | null): boolean {
  return Boolean(value && /[\u3400-\u9fff]/.test(value));
}

function hasLongLatinText(value?: string | null): boolean {
  return Boolean(value && /[A-Za-z][A-Za-z\s.'’&-]{2,}/.test(value));
}

function isEnglishChannelUrl(value?: string): boolean {
  if (!value) return false;
  return /\/(english|en|eng)\//i.test(value) || /[?&](lang|language)=en\b/i.test(value);
}

function isLikelyNewsArticleUrl(value?: string): boolean {
  if (!value) return false;

  try {
    const pathName = new URL(value).pathname.toLowerCase();
    if (/\/(mthd|spxw|mt|list|node|channel)(\/|\.htm?$)/i.test(pathName)) {
      return false;
    }

    return /\.(shtml|html|htm)$/i.test(pathName);
  } catch {
    return false;
  }
}

function keepChineseDomesticArticle(article: GdeltArticle): boolean {
  const sourceName = sourceDisplayName(article.url ?? article.domain);
  if (sourceName === "国内资讯") return false;
  if (isEnglishChannelUrl(article.url)) return false;
  if (!isLikelyNewsArticleUrl(article.url)) return false;
  return hasChineseText(article.title) || hasChineseText(article.content);
}

function filterChineseDomesticArticles(articles: GdeltArticle[]): GdeltArticle[] {
  return articles.filter(keepChineseDomesticArticle);
}

function cleanChineseDisplayText(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  if (!trimmed || !hasChineseText(trimmed) || hasLongLatinText(trimmed)) {
    return fallback;
  }

  return trimmed;
}

function cleanChineseList(value: string[], fallback: string[]): string[] {
  const cleaned = value
    .map((item) => item.trim())
    .filter((item) => hasChineseText(item) && !hasLongLatinText(item));

  return cleaned.length > 0 ? cleaned : fallback;
}

function parseSummaryJson(text: string): NewsArticleSummary | null {
  const clean = cleanJsonText(text);

  try {
    const parsed = JSON.parse(clean) as Partial<NewsArticleSummary>;
    const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
    if (!summary) return null;

    return {
      display_title:
        typeof parsed.display_title === "string" && parsed.display_title.trim()
          ? parsed.display_title.trim()
          : "侨情相关资讯",
      source_name:
        typeof parsed.source_name === "string" && parsed.source_name.trim()
          ? parsed.source_name.trim()
          : "国内资讯",
      summary,
      qiaoqing_points: compactStringArray(parsed.qiaoqing_points),
      regions: compactStringArray(parsed.regions),
      people: compactStringArray(parsed.people),
      organizations: compactStringArray(parsed.organizations),
      tags: compactStringArray(parsed.tags),
      importance: clampInteger(parsed.importance, 3, 1, 5),
    };
  } catch {
    return null;
  }
}

function buildNewsSummaryMessages(article: GdeltArticle, keyword: string): ChatMessage[] {
  return [
    {
      role: "system",
      content:
        "你是侨情新闻分析员。请根据新闻标题、来源、发布时间和关键词，输出严格 JSON，不要 Markdown。",
    },
    {
      role: "user",
      content: JSON.stringify({
        instruction:
          "整理为侨情资讯结构。summary 80到150字；qiaoqing_points 2到4条；regions、people、organizations、tags 用数组；importance 为1到5。",
        keyword,
        title: article.title,
        source: article.domain,
        url: article.url,
        publishedAt: article.seendate,
        language: article.language,
        sourceCountry: article.sourcecountry,
        output_schema: {
          summary: "string",
          qiaoqing_points: ["string"],
          regions: ["string"],
          people: ["string"],
          organizations: ["string"],
          tags: ["string"],
          importance: 3,
        },
      }),
    },
  ];
}

function buildChineseNewsSummaryMessages(article: GdeltArticle, keyword: string): ChatMessage[] {
  return [
    {
      role: "system",
      content:
        "你是侨情新闻编辑和舆情分析员。只输出严格 JSON，不要 Markdown。所有面向用户展示的字段必须使用简体中文；如果原始标题、媒体名、机构名或摘要包含英文，要翻译成自然中文。",
    },
    {
      role: "user",
      content: JSON.stringify({
        instruction:
          "整理为国内中文侨情资讯。display_title 用中文新闻标题，不超过 42 个汉字；source_name 用中文媒体名或中文来源名；summary 80 到 150 字；qiaoqing_points 2 到 4 条；regions、people、organizations、tags 都用中文数组；importance 为 1 到 5。不要在展示字段里保留英文，确需保留的专有名词也要加中文译名。",
        keyword,
        original_title: article.title,
        source: article.domain,
        url: article.url,
        publishedAt: article.seendate,
        language: article.language,
        sourceCountry: article.sourcecountry,
        excerpt: article.content,
        output_schema: {
          display_title: "string",
          source_name: "string",
          summary: "string",
          qiaoqing_points: ["string"],
          regions: ["string"],
          people: ["string"],
          organizations: ["string"],
          tags: ["string"],
          importance: 3,
        },
      }),
    },
  ];
}

async function summarizeNewsArticle(
  article: GdeltArticle,
  keyword: string
): Promise<NewsArticleSummary> {
  try {
    const raw = await createChatText(
      getFoundationClient(),
      foundationConfig.model,
      buildChineseNewsSummaryMessages(article, keyword)
    );
    const parsed = parseSummaryJson(raw);
    if (parsed) return parsed;
  } catch (error) {
    console.warn("[collection] Failed to summarize article:", getErrorMessage(error));
  }

  return {
    display_title: `${keyword}相关资讯`,
    source_name: sourceDisplayName(article.url ?? article.domain),
    summary: `${article.title ?? "相关资讯"}。来源：${article.domain ?? "未知"}。该信息与“${keyword}”相关，建议人工复核后发布。`,
    qiaoqing_points: [article.title ?? keyword],
    regions: compactStringArray([article.sourcecountry]),
    people: [],
    organizations: compactStringArray([article.domain]),
    tags: [keyword],
    importance: 3,
  };
}

async function fetchGdeltArticles(
  keyword: string,
  timeRangeDays: number,
  maxRecords: number
): Promise<GdeltArticle[]> {
  const query = encodeURIComponent(keyword);
  const url =
    `https://api.gdeltproject.org/api/v2/doc/doc?query=${query}` +
    `&mode=ArtList&format=json&sort=DateDesc&timespan=${timeRangeDays}d` +
    `&maxrecords=${maxRecords}`;

  const response = await fetchWithRetry(url, {
    headers: {
      "User-Agent": "qiaoqing-map-collector/1.0",
    },
  }, 20_000, "GDELT");

  if (!response.ok) {
    throw new Error(`GDELT returned ${response.status}`);
  }

  const payload = (await response.json()) as { articles?: GdeltArticle[] };
  return Array.isArray(payload.articles)
    ? filterChineseDomesticArticles(payload.articles)
    : [];
}

async function fetchBingNewsArticles(
  keyword: string,
  timeRangeDays: number,
  maxRecords: number
): Promise<GdeltArticle[]> {
  if (!newsSearchConfig.bingApiKey) {
    return [];
  }

  const freshness = timeRangeDays <= 1 ? "Day" : timeRangeDays <= 7 ? "Week" : "Month";
  const url = new URL(newsSearchConfig.bingEndpoint);
  url.searchParams.set("q", keyword);
  url.searchParams.set("mkt", newsSearchConfig.market);
  url.searchParams.set("freshness", freshness);
  url.searchParams.set("count", String(maxRecords));
  url.searchParams.set("sortBy", "Date");

  const response = await fetchWithRetry(url, {
    headers: {
      "Ocp-Apim-Subscription-Key": newsSearchConfig.bingApiKey,
      "User-Agent": "qiaoqing-map-collector/1.0",
    },
  }, 20_000, "Bing News");

  if (!response.ok) {
    throw new Error(`Bing News returned ${response.status}`);
  }

  const payload = (await response.json()) as { value?: BingNewsItem[] };
  const articles = Array.isArray(payload.value)
    ? payload.value.map((item) => ({
        title: item.name,
        url: item.url,
        domain: item.provider?.[0]?.name,
        seendate: item.datePublished,
        language: newsSearchConfig.market,
        socialimage: item.image?.thumbnail?.contentUrl,
      }))
    : [];

  return filterChineseDomesticArticles(articles);
}

function tavilyTimeRange(timeRangeDays: number): "day" | "week" | "month" | "year" {
  if (timeRangeDays <= 1) return "day";
  if (timeRangeDays <= 7) return "week";
  if (timeRangeDays <= 30) return "month";
  return "year";
}

function tavilyRawContentOption(): boolean | "markdown" | "text" {
  const value = newsSearchConfig.tavilyIncludeRawContent.toLowerCase();
  if (value === "markdown" || value === "text") return value;
  return isTruthy(value);
}

function imageUrlFromTavilyResult(result: TavilySearchResult): string | undefined {
  const firstImage = result.images?.[0];
  if (typeof firstImage === "string") return firstImage;
  return firstImage?.url;
}

async function fetchTavilyNewsArticles(
  keyword: string,
  timeRangeDays: number,
  maxRecords: number
): Promise<GdeltArticle[]> {
  if (!newsSearchConfig.tavilyApiKey) {
    return [];
  }

  const response = await fetchWithRetry(newsSearchConfig.tavilyEndpoint, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${newsSearchConfig.tavilyApiKey}`,
      "Content-Type": "application/json",
      "User-Agent": "qiaoqing-map-collector/1.0",
    },
    body: JSON.stringify({
      query: `${keyword} 国内 中文 新闻 侨务 侨联 华侨 华人`,
      topic: newsSearchConfig.tavilyTopic,
      search_depth: newsSearchConfig.tavilySearchDepth,
      max_results: Math.min(Math.max(maxRecords, 1), 20),
      time_range: tavilyTimeRange(timeRangeDays),
      include_domains: chineseSearchDomains(),
      include_answer: false,
      include_raw_content: tavilyRawContentOption(),
      include_images: true,
    }),
  }, 30_000, "Tavily");

  if (!response.ok) {
    throw new Error(`Tavily Search returned ${response.status}`);
  }

  const payload = (await response.json()) as { results?: TavilySearchResult[] };
  const articles = Array.isArray(payload.results)
    ? payload.results.map((item) => {
        const domain = (() => {
          try {
            return item.url ? new URL(item.url).hostname.replace(/^www\./, "") : undefined;
          } catch {
            return undefined;
          }
        })();

        return {
          title: item.title,
          url: item.url,
          domain,
          seendate: item.published_date,
          language: "zh-CN",
          socialimage: imageUrlFromTavilyResult(item),
          content: item.content,
          raw_content: item.raw_content,
        };
      })
    : [];

  return filterChineseDomesticArticles(articles);
}

function decodeXmlText(value: string): string {
  return value
    .replace(/^<!\[CDATA\[/, "")
    .replace(/\]\]>$/, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function readXmlTag(block: string, tag: string): string | undefined {
  const match = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match ? decodeXmlText(match[1]) : undefined;
}

async function fetchGoogleNewsRssArticles(
  keyword: string,
  timeRangeDays: number,
  maxRecords: number
): Promise<GdeltArticle[]> {
  const query = encodeURIComponent(`${keyword} when:${timeRangeDays}d`);
  const url = `https://news.google.com/rss/search?q=${query}&hl=zh-CN&gl=CN&ceid=CN:zh-Hans`;
  const response = await fetchWithRetry(url, {
    headers: {
      "User-Agent": "qiaoqing-map-collector/1.0",
    },
  }, 20_000, "Google News RSS");

  if (!response.ok) {
    throw new Error(`Google News RSS returned ${response.status}`);
  }

  const xml = await response.text();
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)]
    .slice(0, maxRecords)
    .map<GdeltArticle>((match) => {
      const block = match[1];
      const sourceMatch = block.match(/<source[^>]*>([\s\S]*?)<\/source>/i);
      return {
        title: readXmlTag(block, "title"),
        url: readXmlTag(block, "link"),
        domain: sourceMatch ? decodeXmlText(sourceMatch[1]) : "Google News",
        seendate: readXmlTag(block, "pubDate"),
        language: "zh-CN",
      };
    });

  return filterChineseDomesticArticles(items);
}

async function fetchCollectionArticles(
  keyword: string,
  timeRangeDays: number,
  maxRecords: number,
  sourceMode: CollectionSourceMode
): Promise<{ sourceType: CollectionSourceType; articles: GdeltArticle[] }> {
  if (sourceMode === "auto" || sourceMode === "crawler") {
    try {
      const crawlerArticles = await fetchCrawlerArticles(keyword, timeRangeDays, maxRecords);
      if (crawlerArticles.length > 0) {
        return { sourceType: "crawler", articles: crawlerArticles };
      }
    } catch (error) {
      console.warn("[collection] Crawler failed:", getErrorMessage(error));
    }

    if (sourceMode === "crawler") {
      return { sourceType: "crawler", articles: [] };
    }
  }

  if ((sourceMode === "auto" || sourceMode === "tavily") && newsSearchConfig.tavilyApiKey) {
    try {
      const tavilyArticles = await fetchTavilyNewsArticles(keyword, timeRangeDays, maxRecords);
      if (tavilyArticles.length > 0) {
        return { sourceType: "tavily", articles: tavilyArticles };
      }
    } catch (error) {
      console.warn("[collection] Tavily failed, falling back to Bing/public sources:", getErrorMessage(error));
    }
  }

  if (sourceMode === "tavily") {
    return { sourceType: "tavily", articles: [] };
  }

  if (newsSearchConfig.bingApiKey) {
    try {
      const bingArticles = await fetchBingNewsArticles(keyword, timeRangeDays, maxRecords);
      if (bingArticles.length > 0) {
        return { sourceType: "bing", articles: bingArticles };
      }
    } catch (error) {
      console.warn("[collection] Bing News failed, falling back to public sources:", getErrorMessage(error));
    }
  }

  try {
    return {
      sourceType: "gdelt",
      articles: await fetchGdeltArticles(keyword, timeRangeDays, maxRecords),
    };
  } catch (error) {
    console.warn("[collection] GDELT failed, falling back to Google News RSS:", getErrorMessage(error));
    return {
      sourceType: "rss",
      articles: await fetchGoogleNewsRssArticles(keyword, timeRangeDays, maxRecords),
    };
  }
}

function preferredCollectionSourceType(): CollectionSourceType {
  return "crawler";
}

function normalizeCollectionSourceMode(value: unknown): CollectionSourceMode {
  if (value === "crawler" || value === "tavily") return value;
  return "auto";
}

function preferredCollectionSourceTypeForMode(sourceMode: CollectionSourceMode): CollectionSourceType {
  if (sourceMode === "crawler") return "crawler";
  if (sourceMode === "tavily") return "tavily";
  if (newsSearchConfig.tavilyApiKey) return "tavily";
  return "crawler";
}

async function runCollectionTask(
  taskId: number,
  keyword: string,
  timeRangeDays: number,
  maxRecords: number,
  sourceMode: CollectionSourceMode
): Promise<{ found: number; saved: number; summarized: number }> {
  const pool = getAdminDbPool();
  await pool.execute(
    `UPDATE collection_tasks
     SET status = 'running', started_at = NOW(), error_message = NULL
     WHERE id = ?`,
    [taskId]
  );

  try {
    const { sourceType, articles } = await fetchCollectionArticles(
      keyword,
      timeRangeDays,
      maxRecords,
      sourceMode
    );
    let saved = 0;
    let summarized = 0;

    await pool.execute(
      `UPDATE collection_tasks SET source_type = ?, total_found = ? WHERE id = ?`,
      [sourceType, articles.length, taskId]
    );

    for (const article of articles) {
      const title = article.title?.trim();
      const sourceUrl = article.url?.trim();
      if (!title || !sourceUrl) continue;

      const contentHash = hashToken(`${title}\n${sourceUrl}`);
      const summary = await summarizeNewsArticle(article, keyword);
      summarized += 1;
      const mappedSourceName = sourceDisplayName(sourceUrl || article.domain);
      const displaySourceName =
        mappedSourceName !== "国内资讯"
          ? mappedSourceName
          : summary.source_name.trim() || mappedSourceName;
      const fallbackTitle = `${keyword}相关资讯`;
      const fallbackSummary = `该信息来自${displaySourceName}，与“${keyword}”相关。系统已按国内中文资讯规则采集，建议管理员复核原文后发布。`;
      const displayTitle = cleanChineseDisplayText(summary.display_title, fallbackTitle);
      const displaySummary = cleanChineseDisplayText(summary.summary, fallbackSummary);
      const displayPoints = cleanChineseList(summary.qiaoqing_points, [
        `与“${keyword}”相关`,
        "建议复核原文后发布",
      ]);
      const displayRegions = cleanChineseList(summary.regions, []);
      const displayPeople = cleanChineseList(summary.people, []);
      const displayOrganizations = cleanChineseList(summary.organizations, [displaySourceName]);
      const displayTags = cleanChineseList(summary.tags, [keyword]);

      const [result] = await pool.execute<ResultSetHeader>(
        `INSERT INTO news_articles
          (task_id, title, source_name, source_url, published_at, image_url,
           raw_excerpt, raw_content, ai_summary, qiaoqing_points, regions, people,
           organizations, tags, language, status, importance, content_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON), CAST(? AS JSON),
           CAST(? AS JSON), CAST(? AS JSON), CAST(? AS JSON), ?, 'published', ?, ?)
         ON DUPLICATE KEY UPDATE
           task_id = VALUES(task_id),
           title = VALUES(title),
           source_name = VALUES(source_name),
           published_at = VALUES(published_at),
           image_url = VALUES(image_url),
           raw_excerpt = VALUES(raw_excerpt),
           raw_content = VALUES(raw_content),
           ai_summary = VALUES(ai_summary),
           qiaoqing_points = VALUES(qiaoqing_points),
           regions = VALUES(regions),
           people = VALUES(people),
           organizations = VALUES(organizations),
           tags = VALUES(tags),
           language = VALUES(language),
           importance = VALUES(importance),
           updated_at = NOW()`,
        [
          taskId,
          displayTitle,
          displaySourceName,
          sourceUrl,
          toMysqlDate(parseGdeltDate(article.seendate)),
          article.socialimage ?? null,
          article.content ?? title,
          article.raw_content ?? null,
          displaySummary,
          JSON.stringify(displayPoints),
          JSON.stringify(displayRegions),
          JSON.stringify(displayPeople),
          JSON.stringify(displayOrganizations),
          JSON.stringify(displayTags),
          article.language ?? null,
          summary.importance,
          contentHash,
        ]
      );

      if (result.affectedRows > 0) saved += 1;

      await pool.execute(
        `UPDATE collection_tasks
         SET total_saved = ?, total_summarized = ?, updated_at = NOW()
         WHERE id = ?`,
        [saved, summarized, taskId]
      );
    }

    await pool.execute(
      `UPDATE collection_tasks
       SET status = 'completed', total_found = ?, total_saved = ?,
           total_summarized = ?, finished_at = NOW()
       WHERE id = ?`,
      [articles.length, saved, summarized, taskId]
    );

    return { found: articles.length, saved, summarized };
  } catch (error) {
    await pool.execute(
      `UPDATE collection_tasks
       SET status = 'failed', error_message = ?, finished_at = NOW()
       WHERE id = ?`,
      [getErrorMessage(error).slice(0, 500), taskId]
    );
    throw error;
  }
}

type AdminRole = "super_admin" | "admin" | "viewer";

interface AdminUser {
  id: number;
  username: string;
  displayName: string;
  role: AdminRole;
  status: "active" | "disabled";
}

interface AdminRequest extends express.Request {
  adminUser?: AdminUser;
}

function isAdminDbConfigured(): boolean {
  return Boolean(
    adminDbConfig.host &&
      adminDbConfig.database &&
      adminDbConfig.user &&
      Number.isFinite(adminDbConfig.port)
  );
}

function getAdminDbPool(): Pool {
  if (adminDbPool) {
    return adminDbPool;
  }

  if (!isAdminDbConfigured()) {
    throw new ConfigurationError(
      "APP_DB_HOST / APP_DB_NAME / APP_DB_USER are required for admin features."
    );
  }

  adminDbPool = mysql.createPool({
    host: adminDbConfig.host,
    port: adminDbConfig.port,
    database: adminDbConfig.database,
    user: adminDbConfig.user,
    password: adminDbConfig.password,
    waitForConnections: true,
    connectionLimit: 8,
    namedPlaceholders: true,
  });

  return adminDbPool;
}

function hashToken(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = await new Promise<Buffer>((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });

  return `scrypt$${salt}$${hash.toString("hex")}`;
}

async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const [algorithm, salt, hashHex] = storedHash.split("$");
  if (algorithm !== "scrypt" || !salt || !hashHex) {
    return false;
  }

  const expected = Buffer.from(hashHex, "hex");
  const actual = await new Promise<Buffer>((resolve, reject) => {
    crypto.scrypt(password, salt, expected.length, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });

  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function getCookie(req: express.Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;

  return header
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

function normalizeAdminUser(row: RowDataPacket): AdminUser {
  return {
    id: Number(row.id),
    username: String(row.username),
    displayName: String(row.display_name ?? row.username),
    role: row.role === "super_admin" || row.role === "viewer" ? row.role : "admin",
    status: row.status === "disabled" ? "disabled" : "active",
  };
}

async function writeAuditLog(
  action: string,
  req: express.Request,
  options: {
    actorUserId?: number | null;
    targetType?: string | null;
    targetId?: string | null;
    detail?: unknown;
  } = {}
): Promise<void> {
  try {
    const pool = getAdminDbPool();
    await pool.execute(
      `INSERT INTO audit_logs
        (actor_user_id, action, target_type, target_id, detail, ip_address, user_agent)
       VALUES (?, ?, ?, ?, CAST(? AS JSON), ?, ?)`,
      [
        options.actorUserId ?? null,
        action,
        options.targetType ?? null,
        options.targetId ?? null,
        JSON.stringify(options.detail ?? {}),
        req.ip,
        req.headers["user-agent"] ?? null,
      ]
    );
  } catch (error) {
    console.warn("[admin] Failed to write audit log:", getErrorMessage(error));
  }
}

async function ensureAdminBootstrap(): Promise<void> {
  if (!isAdminDbConfigured()) {
    console.warn("[admin] Database is not configured; admin features are disabled.");
    return;
  }

  const pool = getAdminDbPool();
  const [rows] = await pool.query<RowDataPacket[]>("SELECT COUNT(*) AS count FROM users");
  const count = Number(rows[0]?.count ?? 0);

  if (count > 0) {
    return;
  }

  const passwordHash = await hashPassword(adminBootstrapConfig.password);
  await pool.execute(
    `INSERT INTO users (username, display_name, password_hash, role, status)
     VALUES (?, ?, ?, 'super_admin', 'active')`,
    [
      adminBootstrapConfig.username,
      adminBootstrapConfig.displayName,
      passwordHash,
    ]
  );

  console.log(
    `[admin] Bootstrapped super admin user "${adminBootstrapConfig.username}".`
  );
}

async function requireAdminSession(
  req: AdminRequest,
  res: express.Response,
  next: express.NextFunction
) {
  try {
    const user = await readSessionAdminUser(req);

    if (!user) {
      res.clearCookie(adminSessionCookieName);
      return res.status(401).json({ error: "Not authenticated" });
    }

    req.adminUser = user;
    return next();
  } catch (error) {
    console.error("[admin] Session check failed:", error);
    return res.status(getStatusCode(error)).json({
      error: "Failed to check admin session",
      details: getErrorMessage(error),
    });
  }
}

async function readSessionAdminUser(req: express.Request): Promise<AdminUser | null> {
  const token = getCookie(req, adminSessionCookieName);
  if (!token) {
    return null;
  }

  const pool = getAdminDbPool();
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT u.id, u.username, u.display_name, u.role, u.status
     FROM auth_sessions s
     INNER JOIN users u ON u.id = s.user_id
     WHERE s.session_token_hash = ?
       AND s.revoked_at IS NULL
       AND s.expires_at > NOW()
       AND u.status = 'active'
     LIMIT 1`,
    [hashToken(token)]
  );

  return rows[0] ? normalizeAdminUser(rows[0]) : null;
}

function requireSuperAdmin(
  req: AdminRequest,
  res: express.Response,
  next: express.NextFunction
) {
  if (req.adminUser?.role !== "super_admin") {
    return res.status(403).json({ error: "Super administrator access is required" });
  }

  return next();
}

function publicAdminUser(user: AdminUser) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    status: user.status,
  };
}

function readOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readAdminRole(value: unknown): AdminRole | null {
  return value === "super_admin" || value === "admin" || value === "viewer"
    ? value
    : null;
}

function readAdminStatus(value: unknown): "active" | "disabled" | null {
  return value === "active" || value === "disabled" ? value : null;
}

async function countActiveSuperAdmins(excludeUserId?: number): Promise<number> {
  const params: Array<number> = [];
  let sql = `SELECT COUNT(*) AS count FROM users WHERE role = 'super_admin' AND status = 'active'`;

  if (typeof excludeUserId === "number") {
    sql += " AND id <> ?";
    params.push(excludeUserId);
  }

  const [rows] = await getAdminDbPool().execute<RowDataPacket[]>(sql, params);
  return Number(rows[0]?.count ?? 0);
}

function cleanupExpiredCaptchas(): void {
  const now = Date.now();
  for (const [id, challenge] of captchaStore.entries()) {
    if (challenge.expiresAt <= now) {
      captchaStore.delete(id);
    }
  }
}

function hashCaptchaAnswer(id: string, answer: string): string {
  return crypto
    .createHash("sha256")
    .update(`${id}:${answer.trim().toUpperCase()}:${adminSessionCookieName}`)
    .digest("hex");
}

function createCaptchaText(): string {
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  let value = "";
  for (let index = 0; index < 4; index += 1) {
    value += alphabet[crypto.randomInt(0, alphabet.length)];
  }
  return value;
}

function createCaptchaSvg(text: string): string {
  const chars = text.split("");
  const lines = Array.from({ length: 5 }, () => {
    const x1 = crypto.randomInt(4, 112);
    const y1 = crypto.randomInt(6, 38);
    const x2 = crypto.randomInt(8, 118);
    const y2 = crypto.randomInt(8, 40);
    const opacity = (crypto.randomInt(22, 42) / 100).toFixed(2);
    return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#b33a2d" stroke-width="1.2" opacity="${opacity}" />`;
  }).join("");

  const dots = Array.from({ length: 18 }, () => {
    const cx = crypto.randomInt(4, 120);
    const cy = crypto.randomInt(4, 42);
    const opacity = (crypto.randomInt(24, 48) / 100).toFixed(2);
    return `<circle cx="${cx}" cy="${cy}" r="1" fill="#166a68" opacity="${opacity}" />`;
  }).join("");

  const letters = chars
    .map((char, index) => {
      const x = 18 + index * 25 + crypto.randomInt(-2, 3);
      const y = 30 + crypto.randomInt(-3, 4);
      const rotate = crypto.randomInt(-12, 13);
      return `<text x="${x}" y="${y}" transform="rotate(${rotate} ${x} ${y})">${char}</text>`;
    })
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="44" viewBox="0 0 128 44" role="img" aria-label="captcha">
    <rect width="128" height="44" rx="4" fill="#fffaf2" />
    ${lines}
    ${dots}
    <g fill="#74251f" font-family="Georgia, 'Times New Roman', serif" font-size="24" font-weight="700" letter-spacing="3">${letters}</g>
  </svg>`;
}

function issueCaptcha() {
  cleanupExpiredCaptchas();
  const id = crypto.randomBytes(16).toString("base64url");
  const answer = createCaptchaText();
  captchaStore.set(id, {
    answerHash: hashCaptchaAnswer(id, answer),
    expiresAt: Date.now() + captchaTtlMs,
    attempts: 0,
  });

  return {
    id,
    svg: createCaptchaSvg(answer),
    expiresInSeconds: Math.max(1, Math.floor(captchaTtlMs / 1000)),
  };
}

function verifyCaptcha(captchaId: unknown, captchaAnswer: unknown): boolean {
  const id = typeof captchaId === "string" ? captchaId.trim() : "";
  const answer = typeof captchaAnswer === "string" ? captchaAnswer.trim() : "";
  if (!id || !answer) return false;

  const challenge = captchaStore.get(id);
  if (!challenge || challenge.expiresAt <= Date.now()) {
    captchaStore.delete(id);
    return false;
  }

  challenge.attempts += 1;
  const expected = Buffer.from(challenge.answerHash, "hex");
  const actual = Buffer.from(hashCaptchaAnswer(id, answer), "hex");
  const isValid =
    expected.length === actual.length && crypto.timingSafeEqual(expected, actual);

  if (isValid || challenge.attempts >= 3) {
    captchaStore.delete(id);
  }

  return isValid;
}

function registerAdminRoutes(app: express.Express) {
  app.get("/api/auth/captcha", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    return res.json(issueCaptcha());
  });

  app.post("/api/auth/login", async (req, res) => {
    try {
      const username = typeof req.body?.username === "string" ? req.body.username.trim() : "";
      const password = typeof req.body?.password === "string" ? req.body.password : "";
      const captchaId = req.body?.captchaId;
      const captchaAnswer = req.body?.captchaAnswer;

      if (!username || !password) {
        return res.status(400).json({ error: "Username and password are required" });
      }

      if (!verifyCaptcha(captchaId, captchaAnswer)) {
        await writeAuditLog("auth.captcha_failed", req, {
          detail: { username },
        });
        return res.status(400).json({ error: "验证码错误或已过期，请刷新后重试" });
      }

      const pool = getAdminDbPool();
      const [rows] = await pool.execute<RowDataPacket[]>(
        `SELECT id, username, display_name, password_hash, role, status
         FROM users
         WHERE username = ?
         LIMIT 1`,
        [username]
      );

      const row = rows[0];
      const isValid =
        row &&
        row.status === "active" &&
        (await verifyPassword(password, String(row.password_hash)));

      if (!isValid) {
        await writeAuditLog("auth.login_failed", req, {
          detail: { username },
        });
        return res.status(401).json({ error: "Invalid username or password" });
      }

      const token = crypto.randomBytes(32).toString("base64url");
      const expiresAt = new Date(Date.now() + adminSessionTtlMs);
      const user = normalizeAdminUser(row);

      await pool.execute(
        `INSERT INTO auth_sessions
          (user_id, session_token_hash, ip_address, user_agent, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
        [
          user.id,
          hashToken(token),
          req.ip,
          req.headers["user-agent"] ?? null,
          expiresAt,
        ]
      );

      await pool.execute(
        `UPDATE users
         SET last_login_at = NOW(), last_login_ip = ?
         WHERE id = ?`,
        [req.ip, user.id]
      );

      await writeAuditLog("auth.login", req, {
        actorUserId: user.id,
        targetType: "user",
        targetId: String(user.id),
      });

      res.cookie(adminSessionCookieName, token, {
        httpOnly: true,
        sameSite: "lax",
        secure: adminCookieSecure,
        maxAge: adminSessionTtlMs,
        path: "/",
      });

      return res.json({ user: publicAdminUser(user) });
    } catch (error) {
      console.error("[admin] Login failed:", error);
      return res.status(getStatusCode(error)).json({
        error: "Failed to login",
        details: getErrorMessage(error),
      });
    }
  });

  app.post("/api/auth/logout", requireAdminSession, async (req: AdminRequest, res) => {
    try {
      const token = getCookie(req, adminSessionCookieName);
      if (token) {
        await getAdminDbPool().execute(
          `UPDATE auth_sessions
           SET revoked_at = NOW()
           WHERE session_token_hash = ?`,
          [hashToken(token)]
        );
      }

      await writeAuditLog("auth.logout", req, {
        actorUserId: req.adminUser?.id ?? null,
      });
      res.clearCookie(adminSessionCookieName, { path: "/" });
      return res.json({ ok: true });
    } catch (error) {
      return res.status(getStatusCode(error)).json({
        error: "Failed to logout",
        details: getErrorMessage(error),
      });
    }
  });

  app.get("/api/auth/me", requireAdminSession, (req: AdminRequest, res) => {
    return res.json({ user: req.adminUser ? publicAdminUser(req.adminUser) : null });
  });

  app.post("/api/audit/page-view", requireAdminSession, async (req: AdminRequest, res) => {
    const page = readOptionalString(req.body?.page);
    const pathName = readOptionalString(req.body?.path);

    if (!page) {
      return res.status(400).json({ error: "Page is required" });
    }

    await writeAuditLog("page.view", req, {
      actorUserId: req.adminUser?.id ?? null,
      targetType: "page",
      targetId: pathName ?? page,
      detail: {
        page,
        path: pathName,
      },
    });

    return res.json({ ok: true });
  });

  app.get("/api/latest-news", requireAdminSession, async (req, res) => {
    try {
      const limit = clampInteger(req.query.limit, 30, 1, 100);
      const [rows] = await getAdminDbPool().query<RowDataPacket[]>(
        `SELECT
          id, title, source_name AS sourceName, source_url AS sourceUrl,
          published_at AS publishedAt, image_url AS imageUrl,
          ai_summary AS aiSummary, qiaoqing_points AS qiaoqingPoints,
          regions, people, organizations, tags, importance,
          created_at AS createdAt
         FROM news_articles
         WHERE status = 'published'
           AND source_url NOT LIKE '%/english/%'
           AND title NOT REGEXP '[A-Za-z]{3,}'
         ORDER BY COALESCE(published_at, created_at) DESC, id DESC
         LIMIT ${limit}`
      );

      return res.json({ articles: rows });
    } catch (error) {
      return res.status(getStatusCode(error)).json({
        error: "Failed to load latest news",
        details: getErrorMessage(error),
      });
    }
  });

  app.get("/api/latest-news/:id", requireAdminSession, async (req, res) => {
    try {
      const articleId = Number(req.params.id);
      if (!Number.isInteger(articleId) || articleId <= 0) {
        return res.status(400).json({ error: "Invalid article id" });
      }

      const [rows] = await getAdminDbPool().execute<RowDataPacket[]>(
        `SELECT
          id, title, source_name AS sourceName, source_url AS sourceUrl,
          published_at AS publishedAt, image_url AS imageUrl,
          raw_excerpt AS rawExcerpt, raw_content AS rawContent,
          ai_summary AS aiSummary, qiaoqing_points AS qiaoqingPoints,
          regions, people, organizations, tags, language, importance,
          ragflow_dataset_id AS ragflowDatasetId,
          ragflow_document_id AS ragflowDocumentId,
          synced_to_ragflow_at AS syncedToRagflowAt,
          created_at AS createdAt
         FROM news_articles
         WHERE id = ?
           AND status = 'published'
           AND source_url NOT LIKE '%/english/%'
           AND title NOT REGEXP '[A-Za-z]{3,}'
         LIMIT 1`,
        [articleId]
      );

      if (!rows[0]) {
        return res.status(404).json({ error: "Article not found" });
      }

      return res.json({ article: rows[0] });
    } catch (error) {
      return res.status(getStatusCode(error)).json({
        error: "Failed to load latest news detail",
        details: getErrorMessage(error),
      });
    }
  });

  app.use("/api/admin", requireAdminSession, requireSuperAdmin);

  app.get("/api/admin/summary", async (_req, res) => {
    try {
      const pool = getAdminDbPool();
      const [[userCounts], [sessionCounts], [auditCounts], [settings]] =
        await Promise.all([
          pool.query<RowDataPacket[]>(
            `SELECT
              COUNT(*) AS totalUsers,
              SUM(status = 'active') AS activeUsers,
              SUM(role = 'super_admin') AS superAdmins
             FROM users`
          ),
          pool.query<RowDataPacket[]>(
            `SELECT
              COUNT(*) AS activeSessions
             FROM auth_sessions
             WHERE revoked_at IS NULL AND expires_at > NOW()`
          ),
          pool.query<RowDataPacket[]>(
            `SELECT COUNT(*) AS todayAuditLogs
             FROM audit_logs
             WHERE created_at >= CURDATE()`
          ),
          pool.query<RowDataPacket[]>(
            `SELECT setting_key FROM system_settings ORDER BY setting_key`
          ),
        ]);

      return res.json({
        users: userCounts[0] ?? {},
        sessions: sessionCounts[0] ?? {},
        audit: auditCounts[0] ?? {},
        settings: settings,
        ragflow: {
          enabled: isRagflowEnabled(),
          baseURL: ragflowConfig.baseURL,
          chatId: ragflowConfig.chatId,
          model: ragflowConfig.model,
        },
      });
    } catch (error) {
      return res.status(getStatusCode(error)).json({
        error: "Failed to load admin summary",
        details: getErrorMessage(error),
      });
    }
  });

  app.get("/api/admin/users", async (_req, res) => {
    try {
      const [rows] = await getAdminDbPool().query<RowDataPacket[]>(
        `SELECT
          id, username, display_name AS displayName, role, status,
          email, phone, last_login_at AS lastLoginAt, last_login_ip AS lastLoginIp,
          created_at AS createdAt
         FROM users
         ORDER BY id ASC`
      );

      return res.json({ users: rows });
    } catch (error) {
      return res.status(getStatusCode(error)).json({
        error: "Failed to load users",
        details: getErrorMessage(error),
      });
    }
  });

  app.post("/api/admin/collection/run", async (req: AdminRequest, res) => {
    const keyword = readOptionalString(req.body?.keyword);
    const timeRangeDays = clampInteger(req.body?.timeRangeDays, 7, 1, 30);
    const maxRecords = clampInteger(req.body?.maxRecords, 20, 1, 50);
    const sourceMode = normalizeCollectionSourceMode(req.body?.sourceMode);

    if (!keyword) {
      return res.status(400).json({ error: "Keyword is required" });
    }

    try {
      const [result] = await getAdminDbPool().execute<ResultSetHeader>(
        `INSERT INTO collection_tasks
          (keyword, source_type, time_range_days, max_records, status, created_by)
         VALUES (?, ?, ?, ?, 'pending', ?)`,
        [
          keyword,
          preferredCollectionSourceTypeForMode(sourceMode),
          timeRangeDays,
          maxRecords,
          req.adminUser?.id ?? null,
        ]
      );

      await writeAuditLog("collection.run", req, {
        actorUserId: req.adminUser?.id ?? null,
        targetType: "collection_task",
        targetId: String(result.insertId),
        detail: { keyword, timeRangeDays, maxRecords, sourceMode },
      });

      void runCollectionTask(
        result.insertId,
        keyword,
        timeRangeDays,
        maxRecords,
        sourceMode
      ).catch((error) => {
        console.error("[collection] Background task failed:", getErrorMessage(error));
      });

      return res.status(202).json({
        taskId: result.insertId,
        status: "pending",
        message: "Collection task started",
      });
    } catch (error) {
      return res.status(getStatusCode(error)).json({
        error: "Failed to run collection task",
        details: getErrorMessage(error),
      });
    }
  });

  app.get("/api/admin/collection/tasks", async (_req, res) => {
    try {
      await getAdminDbPool().execute(
        `UPDATE collection_tasks
         SET status = 'failed',
             error_message = '采集任务长时间无进度，已自动标记为超时',
             finished_at = NOW()
         WHERE status IN ('pending', 'running')
           AND updated_at < DATE_SUB(NOW(), INTERVAL 15 MINUTE)`
      );

      const [rows] = await getAdminDbPool().query<RowDataPacket[]>(
        `SELECT
          t.id, t.keyword, t.source_type AS sourceType,
          t.time_range_days AS timeRangeDays, t.max_records AS maxRecords,
          t.status, t.total_found AS totalFound, t.total_saved AS totalSaved,
          t.total_summarized AS totalSummarized, t.error_message AS errorMessage,
          t.started_at AS startedAt, t.finished_at AS finishedAt,
          t.created_at AS createdAt, u.username AS createdByUsername
         FROM collection_tasks t
         LEFT JOIN users u ON u.id = t.created_by
         ORDER BY t.id DESC
         LIMIT 50`
      );

      return res.json({ tasks: rows });
    } catch (error) {
      return res.status(getStatusCode(error)).json({
        error: "Failed to load collection tasks",
        details: getErrorMessage(error),
      });
    }
  });

  app.get("/api/admin/collection/articles", async (_req, res) => {
    try {
      const [rows] = await getAdminDbPool().query<RowDataPacket[]>(
        `SELECT
          id, title, source_name AS sourceName, source_url AS sourceUrl,
          published_at AS publishedAt, ai_summary AS aiSummary,
          qiaoqing_points AS qiaoqingPoints, regions, tags,
          status, importance, synced_to_ragflow_at AS syncedToRagflowAt,
          created_at AS createdAt
         FROM news_articles
         WHERE status <> 'hidden'
           AND source_url NOT LIKE '%/english/%'
           AND title NOT REGEXP '[A-Za-z]{3,}'
         ORDER BY COALESCE(published_at, created_at) DESC, id DESC
         LIMIT 100`
      );

      return res.json({ articles: rows });
    } catch (error) {
      return res.status(getStatusCode(error)).json({
        error: "Failed to load collection articles",
        details: getErrorMessage(error),
      });
    }
  });

  app.patch("/api/admin/collection/articles/:id", async (req: AdminRequest, res) => {
    try {
      const articleId = Number(req.params.id);
      const status = req.body?.status;
      if (!Number.isInteger(articleId) || articleId <= 0) {
        return res.status(400).json({ error: "Invalid article id" });
      }

      if (status !== "published" && status !== "hidden" && status !== "draft") {
        return res.status(400).json({ error: "Invalid article status" });
      }

      await getAdminDbPool().execute(
        `UPDATE news_articles SET status = ? WHERE id = ?`,
        [status, articleId]
      );

      await writeAuditLog("collection.article_status", req, {
        actorUserId: req.adminUser?.id ?? null,
        targetType: "news_article",
        targetId: String(articleId),
        detail: { status },
      });

      return res.json({ ok: true });
    } catch (error) {
      return res.status(getStatusCode(error)).json({
        error: "Failed to update article",
        details: getErrorMessage(error),
      });
    }
  });

  app.post("/api/admin/users", async (req: AdminRequest, res) => {
    try {
      const username = readOptionalString(req.body?.username);
      const displayName = readOptionalString(req.body?.displayName);
      const password = typeof req.body?.password === "string" ? req.body.password : "";
      const role = readAdminRole(req.body?.role) ?? "viewer";
      const status = readAdminStatus(req.body?.status) ?? "active";
      const email = readOptionalString(req.body?.email);
      const phone = readOptionalString(req.body?.phone);

      if (!username || !displayName || password.length < 6) {
        return res.status(400).json({
          error: "Username, display name and a password of at least 6 characters are required",
        });
      }

      const passwordHash = await hashPassword(password);
      const [result] = await getAdminDbPool().execute<ResultSetHeader>(
        `INSERT INTO users
          (username, display_name, password_hash, role, status, email, phone)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [username, displayName, passwordHash, role, status, email, phone]
      );

      await writeAuditLog("user.create", req, {
        actorUserId: req.adminUser?.id ?? null,
        targetType: "user",
        targetId: String(result.insertId),
        detail: { username, role, status },
      });

      return res.status(201).json({ id: result.insertId });
    } catch (error) {
      const message = getErrorMessage(error);
      const statusCode = message.includes("Duplicate entry") ? 409 : getStatusCode(error);
      return res.status(statusCode).json({
        error: statusCode === 409 ? "Username or email already exists" : "Failed to create user",
        details: message,
      });
    }
  });

  app.patch("/api/admin/users/:id", async (req: AdminRequest, res) => {
    try {
      const userId = Number(req.params.id);
      if (!Number.isInteger(userId) || userId <= 0) {
        return res.status(400).json({ error: "Invalid user id" });
      }

      const [existingRows] = await getAdminDbPool().execute<RowDataPacket[]>(
        `SELECT id, role, status FROM users WHERE id = ? LIMIT 1`,
        [userId]
      );

      if (!existingRows[0]) {
        return res.status(404).json({ error: "User not found" });
      }

      const username = readOptionalString(req.body?.username);
      const displayName = readOptionalString(req.body?.displayName);
      const role = readAdminRole(req.body?.role);
      const status = readAdminStatus(req.body?.status);
      const email = readOptionalString(req.body?.email);
      const phone = readOptionalString(req.body?.phone);
      const password = typeof req.body?.password === "string" ? req.body.password : "";
      const nextRole = role ?? (existingRows[0].role as AdminRole);
      const nextStatus = status ?? (existingRows[0].status as "active" | "disabled");

      if (!username || !displayName || !role || !status) {
        return res.status(400).json({
          error: "Username, display name, role and status are required",
        });
      }

      if (
        existingRows[0].role === "super_admin" &&
        existingRows[0].status === "active" &&
        (nextRole !== "super_admin" || nextStatus !== "active") &&
        (await countActiveSuperAdmins(userId)) === 0
      ) {
        return res.status(400).json({ error: "At least one active super administrator is required" });
      }

      if (password.trim()) {
        if (password.length < 6) {
          return res.status(400).json({ error: "Password must be at least 6 characters" });
        }

        await getAdminDbPool().execute(
          `UPDATE users
           SET username = ?, display_name = ?, password_hash = ?, role = ?, status = ?,
               email = ?, phone = ?
           WHERE id = ?`,
          [username, displayName, await hashPassword(password), role, status, email, phone, userId]
        );
      } else {
        await getAdminDbPool().execute(
          `UPDATE users
           SET username = ?, display_name = ?, role = ?, status = ?, email = ?, phone = ?
           WHERE id = ?`,
          [username, displayName, role, status, email, phone, userId]
        );
      }

      if (status === "disabled") {
        await getAdminDbPool().execute(
          `UPDATE auth_sessions SET revoked_at = NOW()
           WHERE user_id = ? AND revoked_at IS NULL`,
          [userId]
        );
      }

      await writeAuditLog("user.update", req, {
        actorUserId: req.adminUser?.id ?? null,
        targetType: "user",
        targetId: String(userId),
        detail: { username, role, status },
      });

      return res.json({ ok: true });
    } catch (error) {
      const message = getErrorMessage(error);
      const statusCode = message.includes("Duplicate entry") ? 409 : getStatusCode(error);
      return res.status(statusCode).json({
        error: statusCode === 409 ? "Username or email already exists" : "Failed to update user",
        details: message,
      });
    }
  });

  app.delete("/api/admin/users/:id", async (req: AdminRequest, res) => {
    try {
      const userId = Number(req.params.id);
      if (!Number.isInteger(userId) || userId <= 0) {
        return res.status(400).json({ error: "Invalid user id" });
      }

      if (req.adminUser?.id === userId) {
        return res.status(400).json({ error: "You cannot delete your own account" });
      }

      const [existingRows] = await getAdminDbPool().execute<RowDataPacket[]>(
        `SELECT id, username, role, status FROM users WHERE id = ? LIMIT 1`,
        [userId]
      );

      if (!existingRows[0]) {
        return res.status(404).json({ error: "User not found" });
      }

      if (
        existingRows[0].role === "super_admin" &&
        existingRows[0].status === "active" &&
        (await countActiveSuperAdmins(userId)) === 0
      ) {
        return res.status(400).json({ error: "At least one active super administrator is required" });
      }

      await getAdminDbPool().execute(`DELETE FROM users WHERE id = ?`, [userId]);
      await writeAuditLog("user.delete", req, {
        actorUserId: req.adminUser?.id ?? null,
        targetType: "user",
        targetId: String(userId),
        detail: { username: existingRows[0].username },
      });

      return res.json({ ok: true });
    } catch (error) {
      return res.status(getStatusCode(error)).json({
        error: "Failed to delete user",
        details: getErrorMessage(error),
      });
    }
  });

  app.get("/api/admin/audit-logs", async (_req, res) => {
    try {
      const [rows] = await getAdminDbPool().query<RowDataPacket[]>(
        `SELECT
          a.id,
          a.action,
          a.target_type AS targetType,
          a.target_id AS targetId,
          a.detail,
          a.ip_address AS ipAddress,
          a.created_at AS createdAt,
          u.username AS actorUsername
         FROM audit_logs a
         LEFT JOIN users u ON u.id = a.actor_user_id
         ORDER BY a.id DESC
         LIMIT 50`
      );

      return res.json({ logs: rows });
    } catch (error) {
      return res.status(getStatusCode(error)).json({
        error: "Failed to load audit logs",
        details: getErrorMessage(error),
      });
    }
  });

  app.get("/api/admin/ragflow/status", async (_req, res) => {
    const startedAt = Date.now();

    if (!ragflowConfig.baseURL) {
      return res.status(503).json({
        ok: false,
        status: "missing_config",
        message: "RAGFLOW_BASE_URL is not configured.",
      });
    }

    try {
      const response = await fetch(`${ragflowConfig.baseURL}/`, {
        method: "GET",
        signal: AbortSignal.timeout(5000),
      });

      return res.json({
        ok: response.ok,
        status: response.status,
        latencyMs: Date.now() - startedAt,
        baseURL: ragflowConfig.baseURL,
        chatId: ragflowConfig.chatId,
        model: ragflowConfig.model,
      });
    } catch (error) {
      return res.status(502).json({
        ok: false,
        status: "failed",
        message: getErrorMessage(error),
        baseURL: ragflowConfig.baseURL,
      });
    }
  });
}

async function startServer() {
  const app = express();

  app.use(express.json());
  try {
    await ensureAdminBootstrap();
  } catch (error) {
    console.warn(
      "[admin] Database bootstrap failed; admin login will be unavailable until the database is reachable:",
      getErrorMessage(error)
    );
  }
  registerAdminRoutes(app);

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

      const auditUser = await readSessionAdminUser(req);
      await writeAuditLog("qiaoqing.followup", req, {
        actorUserId: auditUser?.id ?? null,
        targetType: "city",
        targetId: safeCityName,
        detail: {
          cityName: safeCityName,
          question: safeQuestion,
          useKnowledgeBase,
        },
      });

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

      const auditUser = await readSessionAdminUser(req);
      await writeAuditLog("qiaoqing.ask", req, {
        actorUserId: auditUser?.id ?? null,
        targetType: "question",
        targetId: "侨情监测",
        detail: {
          prompt,
          useKnowledgeBase,
        },
      });

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
