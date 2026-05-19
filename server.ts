import dotenv from "dotenv";
import express from "express";
import crypto from "node:crypto";
import fs from "node:fs/promises";
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

interface KnownLocation {
  name: string;
  lat: number;
  lng: number;
  aliases: string[];
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
  references?: SourceReference[];
}

interface SourceReference {
  id?: string;
  title: string;
  excerpt?: string;
  score?: number;
  documentId?: string;
  datasetId?: string;
}

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type CollectionSourceType = "aggregate" | "crawler" | "tavily" | "bing" | "gdelt" | "rss";
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
  reference?: RagflowReferenceData;
  references?: RagflowReferenceData;
}

interface RagflowReferenceData {
  chunks?: RagflowReferenceChunk[];
  doc_aggs?: RagflowDocumentAggregate[];
}

interface RagflowReferenceChunk {
  id?: string | number;
  content?: string;
  document_name?: string;
  doc_name?: string;
  document_title?: string;
  document_id?: string;
  doc_id?: string;
  dataset_id?: string;
  similarity?: number;
  vector_similarity?: number;
  term_similarity?: number;
}

interface RagflowDocumentAggregate {
  doc_name?: string;
  document_name?: string;
  doc_id?: string;
  document_id?: string;
  count?: number;
}

interface QueryCacheEntry {
  expiresAt: number;
  value: ExtractQueryResponse;
}

interface RagflowSessionCacheEntry {
  expiresAt: number;
  promise: Promise<string>;
}

interface RequestTimer {
  id: string;
  mark: (label: string, detail?: Record<string, unknown>) => void;
  end: (label?: string) => void;
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

interface CollectionSourceResult {
  sourceType: CollectionSourceType;
  articles: GdeltArticle[];
  elapsedMs: number;
  error?: string;
  timedOut?: boolean;
  skipped?: boolean;
}

interface CollectionSourceHealth {
  failures: number;
  disabledUntil: number;
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

interface TextCleaningStats {
  originalLength: number;
  cleanedLength: number;
  removedCharacters: number;
  removedLines: number;
  dedupedLines: number;
}

interface TextCleaningResult {
  text: string;
  stats: TextCleaningStats;
}

type CleaningUploadMode = "cleaned" | "ragflow_parse_required" | "unsupported";

interface UploadedCleaningFile {
  filename: string;
  mimeType: string;
  buffer: Buffer;
}

interface SavedCleaningFile {
  kind: "original" | "cleaned";
  filename: string;
  path: string;
  bytes: number;
}

interface CleaningUploadDecision {
  mode: CleaningUploadMode;
  documentType: string;
  message: string;
  suggestedSteps: string[];
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
  timeoutMs: Number(process.env.OPENAI_TIMEOUT_MS ?? 30_000),
  answerTimeoutMs: Number(process.env.OPENAI_ANSWER_TIMEOUT_MS ?? 60_000),
  maxRetries: Number(process.env.OPENAI_MAX_RETRIES ?? 0),
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
  crawlerTimeoutMs: Number(process.env.COLLECTION_CRAWLER_TIMEOUT_MS ?? 10_000),
  tavilyTimeoutMs: Number(process.env.COLLECTION_TAVILY_TIMEOUT_MS ?? 8_000),
  bingTimeoutMs: Number(process.env.COLLECTION_BING_TIMEOUT_MS ?? 8_000),
  gdeltTimeoutMs: Number(process.env.COLLECTION_GDELT_TIMEOUT_MS ?? 7_000),
  rssTimeoutMs: Number(process.env.COLLECTION_RSS_TIMEOUT_MS ?? 7_000),
  sourceFailureThreshold: Number(process.env.COLLECTION_SOURCE_FAILURE_THRESHOLD ?? 3),
  sourceCooldownMs: Number(process.env.COLLECTION_SOURCE_COOLDOWN_MS ?? 10 * 60 * 1000),
};

const dataCleaningConfig = {
  enabled: process.env.DATA_CLEANING_ENABLED?.trim().toLowerCase() !== "false",
  maxChars: Number(process.env.DATA_CLEANING_MAX_CHARS ?? 12_000),
  uploadMaxBytes: Number(process.env.DATA_CLEANING_UPLOAD_MAX_BYTES ?? 5 * 1024 * 1024),
  storageDir: path.resolve(process.env.DATA_CLEANING_STORAGE_DIR?.trim() || "data/cleaning-uploads"),
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

const knownPromptLocations: KnownLocation[] = [
  { name: "中国", lat: 35.8617, lng: 104.1954, aliases: ["中国", "国内", "我国"] },
  { name: "泉州", lat: 24.8741, lng: 118.6757, aliases: ["泉州", "泉州市", "刺桐城", "世界泉州"] },
  { name: "厦门", lat: 24.4798, lng: 118.0894, aliases: ["厦门", "厦门市"] },
  { name: "福州", lat: 26.0745, lng: 119.2965, aliases: ["福州", "福州市"] },
  { name: "福建", lat: 26.1008, lng: 117.295, aliases: ["福建", "福建省"] },
  { name: "北京", lat: 39.9042, lng: 116.4074, aliases: ["北京", "北京市"] },
  { name: "上海", lat: 31.2304, lng: 121.4737, aliases: ["上海", "上海市"] },
  { name: "广州", lat: 23.1291, lng: 113.2644, aliases: ["广州", "广州市"] },
  { name: "深圳", lat: 22.5431, lng: 114.0579, aliases: ["深圳", "深圳市"] },
  { name: "香港", lat: 22.3193, lng: 114.1694, aliases: ["香港"] },
  { name: "澳门", lat: 22.1987, lng: 113.5439, aliases: ["澳门"] },
  { name: "台北", lat: 25.033, lng: 121.5654, aliases: ["台北", "台北市"] },
  { name: "俄罗斯", lat: 61.524, lng: 105.3188, aliases: ["俄罗斯", "俄国", "俄"] },
  { name: "美国", lat: 37.0902, lng: -95.7129, aliases: ["美国", "美利坚", "全美"] },
  { name: "加拿大", lat: 56.1304, lng: -106.3468, aliases: ["加拿大"] },
  { name: "巴西", lat: -14.235, lng: -51.9253, aliases: ["巴西"] },
  { name: "阿根廷", lat: -38.4161, lng: -63.6167, aliases: ["阿根廷"] },
  { name: "墨西哥", lat: 23.6345, lng: -102.5528, aliases: ["墨西哥"] },
  { name: "澳大利亚", lat: -25.2744, lng: 133.7751, aliases: ["澳大利亚", "澳洲"] },
  { name: "新西兰", lat: -40.9006, lng: 174.886, aliases: ["新西兰"] },
  { name: "日本", lat: 36.2048, lng: 138.2529, aliases: ["日本"] },
  { name: "韩国", lat: 35.9078, lng: 127.7669, aliases: ["韩国", "南韩"] },
  { name: "印度", lat: 20.5937, lng: 78.9629, aliases: ["印度"] },
  { name: "印度尼西亚", lat: -0.7893, lng: 113.9213, aliases: ["印度尼西亚", "印尼"] },
  { name: "马来西亚", lat: 4.2105, lng: 101.9758, aliases: ["马来西亚", "大马"] },
  { name: "菲律宾", lat: 12.8797, lng: 121.774, aliases: ["菲律宾"] },
  { name: "泰国", lat: 15.87, lng: 100.9925, aliases: ["泰国"] },
  { name: "缅甸", lat: 21.9162, lng: 95.956, aliases: ["缅甸"] },
  { name: "越南", lat: 14.0583, lng: 108.2772, aliases: ["越南"] },
  { name: "新加坡", lat: 1.3521, lng: 103.8198, aliases: ["新加坡"] },
  { name: "英国", lat: 55.3781, lng: -3.436, aliases: ["英国", "英格兰"] },
  { name: "法国", lat: 46.2276, lng: 2.2137, aliases: ["法国"] },
  { name: "德国", lat: 51.1657, lng: 10.4515, aliases: ["德国"] },
  { name: "意大利", lat: 41.8719, lng: 12.5674, aliases: ["意大利"] },
  { name: "西班牙", lat: 40.4637, lng: -3.7492, aliases: ["西班牙"] },
  { name: "葡萄牙", lat: 39.3999, lng: -8.2245, aliases: ["葡萄牙"] },
  { name: "荷兰", lat: 52.1326, lng: 5.2913, aliases: ["荷兰", "尼德兰"] },
  { name: "南非", lat: -30.5595, lng: 22.9375, aliases: ["南非"] },
  { name: "欧洲", lat: 54.526, lng: 15.2551, aliases: ["欧洲"] },
  { name: "东南亚", lat: 8.0, lng: 115.0, aliases: ["东南亚", "南洋"] },
  { name: "中东", lat: 29.2985, lng: 42.551, aliases: ["中东"] },
  { name: "拉美", lat: -14.235, lng: -51.9253, aliases: ["拉美", "拉丁美洲"] },
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
const queryCacheTtlMs = Number(process.env.QUERY_CACHE_TTL_MS ?? 10 * 60 * 1000);
const queryCacheMaxEntries = Number(process.env.QUERY_CACHE_MAX_ENTRIES ?? 120);
const knowledgeFallbackDelayMs = Number(process.env.KNOWLEDGE_FALLBACK_DELAY_MS ?? 2500);
const locationExtractionSoftTimeoutMs = Number(
  process.env.LOCATION_EXTRACTION_SOFT_TIMEOUT_MS ?? 8000
);
const ragflowSessionReuseEnabled =
  process.env.RAGFLOW_SESSION_REUSE_ENABLED?.trim().toLowerCase() !== "false";
const ragflowSessionTtlMs = Number(process.env.RAGFLOW_SESSION_TTL_MS ?? 30 * 60 * 1000);
const queryResponseCache = new Map<string, QueryCacheEntry>();
const ragflowSessionCache = new Map<string, RagflowSessionCacheEntry>();
const collectionSourceHealth = new Map<CollectionSourceType, CollectionSourceHealth>();

function cloneQueryResponse(value: ExtractQueryResponse): ExtractQueryResponse {
  return JSON.parse(JSON.stringify(value)) as ExtractQueryResponse;
}

function getQueryCacheKey(prompt: string, useKnowledgeBase: boolean): string {
  return crypto
    .createHash("sha1")
    .update(JSON.stringify({
      prompt: prompt.trim(),
      useKnowledgeBase,
      model: foundationConfig.model,
      ragflowChatId: ragflowConfig.chatId ?? "",
    }))
    .digest("hex");
}

function readCachedQueryResponse(cacheKey: string): ExtractQueryResponse | null {
  const cached = queryResponseCache.get(cacheKey);
  if (!cached) return null;

  if (cached.expiresAt <= Date.now()) {
    queryResponseCache.delete(cacheKey);
    return null;
  }

  return cloneQueryResponse(cached.value);
}

function writeCachedQueryResponse(cacheKey: string, value: ExtractQueryResponse) {
  if (queryCacheTtlMs <= 0) return;

  queryResponseCache.set(cacheKey, {
    expiresAt: Date.now() + queryCacheTtlMs,
    value: cloneQueryResponse(value),
  });

  while (queryResponseCache.size > queryCacheMaxEntries) {
    const oldestKey = queryResponseCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    queryResponseCache.delete(oldestKey);
  }
}

function createRequestTimer(scope: string): RequestTimer {
  const id = crypto.randomUUID().slice(0, 8);
  const startedAt = Date.now();
  let lastMarkAt = startedAt;

  const log = (label: string, detail?: Record<string, unknown>) => {
    const now = Date.now();
    const sinceLast = now - lastMarkAt;
    const total = now - startedAt;
    lastMarkAt = now;
    const detailText = detail ? ` ${JSON.stringify(detail)}` : "";
    console.info(`[${scope}:${id}] ${label} +${sinceLast}ms total=${total}ms${detailText}`);
  };

  log("start");

  return {
    id,
    mark: log,
    end: (label = "done") => log(label),
  };
}

function createDeferredFoundationFallback(
  prompt: string,
  timer: RequestTimer
): {
  start: (reason: string) => Promise<AnswerText | null>;
  cancel: () => void;
} {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let startedPromise: Promise<AnswerText | null> | null = null;

  const start = (reason: string) => {
    if (!startedPromise) {
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }

      timer.mark("foundation fallback start", { reason });
      startedPromise = timed(timer, "foundation answer fallback", () =>
        answerGeneralWithFoundation(prompt)
      ).catch((error) => {
        console.warn("[qiaoqing] Foundation fallback failed:", getErrorMessage(error));
        return null;
      });
    }

    return startedPromise;
  };

  if (knowledgeFallbackDelayMs >= 0) {
    timeout = setTimeout(() => {
      void start("hedged-delay");
    }, knowledgeFallbackDelayMs);
  }

  return {
    start,
    cancel: () => {
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
    },
  };
}

async function timed<T>(
  timer: RequestTimer,
  label: string,
  task: () => Promise<T>
): Promise<T> {
  const startedAt = Date.now();
  try {
    const result = await task();
    timer.mark(label, { ms: Date.now() - startedAt, ok: true });
    return result;
  } catch (error) {
    timer.mark(label, {
      ms: Date.now() - startedAt,
      ok: false,
      error: getErrorMessage(error),
    });
    throw error;
  }
}

function withSoftTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  fallback: T,
  onTimeout: () => void
): Promise<T> {
  if (timeoutMs <= 0) {
    return promise;
  }

  return new Promise((resolve) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      onTimeout();
      resolve(fallback);
    }, timeoutMs);

    promise
      .then((value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(value);
      })
      .catch(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(fallback);
      });
  });
}

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
    timeout: foundationConfig.timeoutMs,
    maxRetries: foundationConfig.maxRetries,
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
  messages: ChatMessage[],
  options: { timeoutMs?: number } = {}
): Promise<string> {
  const completion = await client.chat.completions.create({
    model,
    messages,
  }, {
    timeout: options.timeoutMs,
    maxRetries: foundationConfig.maxRetries,
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

function normalizeReferenceExcerpt(value: string): string {
  return stripReferenceNoise(value)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 220);
}

function getReferenceTitle(
  chunk: RagflowReferenceChunk,
  docAggs: RagflowDocumentAggregate[]
): string {
  const directTitle =
    chunk.document_name?.trim() ||
    chunk.doc_name?.trim() ||
    chunk.document_title?.trim();

  if (directTitle) {
    return directTitle;
  }

  const chunkDocumentId = chunk.document_id ?? chunk.doc_id;
  const matchedAgg = docAggs.find((item) => {
    const aggregateDocumentId = item.document_id ?? item.doc_id;
    return aggregateDocumentId && aggregateDocumentId === chunkDocumentId;
  });

  return (
    matchedAgg?.document_name?.trim() ||
    matchedAgg?.doc_name?.trim() ||
    "知识库文档"
  );
}

function buildRagflowReferences(
  reference?: RagflowReferenceData
): SourceReference[] {
  const chunks = Array.isArray(reference?.chunks) ? reference.chunks : [];
  const docAggs = Array.isArray(reference?.doc_aggs) ? reference.doc_aggs : [];
  const seen = new Set<string>();

  return chunks
    .map((chunk, index): SourceReference | null => {
      const title = getReferenceTitle(chunk, docAggs);
      const excerpt =
        typeof chunk.content === "string"
          ? normalizeReferenceExcerpt(chunk.content)
          : undefined;
      const referenceId =
        chunk.id !== undefined && chunk.id !== null
          ? String(chunk.id)
          : String(index + 1);
      const key = `${title}|${excerpt ?? ""}|${chunk.document_id ?? chunk.doc_id ?? ""}`;

      if (seen.has(key)) {
        return null;
      }

      seen.add(key);

      return {
        id: referenceId,
        title,
        excerpt,
        score:
          typeof chunk.similarity === "number"
            ? chunk.similarity
            : typeof chunk.vector_similarity === "number"
              ? chunk.vector_similarity
              : typeof chunk.term_similarity === "number"
                ? chunk.term_similarity
                : undefined,
        documentId: chunk.document_id ?? chunk.doc_id,
        datasetId: chunk.dataset_id,
      };
    })
    .filter((reference): reference is SourceReference => Boolean(reference))
    .slice(0, 6);
}

function buildAnswerText(
  value: string,
  reference?: RagflowReferenceData
): AnswerText {
  const withReferences = normalizeAnswerText(value);

  return {
    clean: cleanRagflowAnswer(withReferences),
    withReferences,
    references: buildRagflowReferences(reference),
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

function invalidateRagflowSession(cacheKey: string) {
  ragflowSessionCache.delete(cacheKey);
}

async function getRagflowSession(
  cacheKey: string,
  sessionNamePrefix: string
): Promise<string> {
  if (!ragflowSessionReuseEnabled) {
    return createRagflowSession(`${sessionNamePrefix}-${Date.now()}`);
  }

  const cached = ragflowSessionCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.promise;
  }

  const promise = createRagflowSession(`${sessionNamePrefix}-${Date.now()}`).catch((error) => {
    invalidateRagflowSession(cacheKey);
    throw error;
  });

  ragflowSessionCache.set(cacheKey, {
    expiresAt: Date.now() + ragflowSessionTtlMs,
    promise,
  });

  return promise;
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

function buildAssistantFoundationAnswerMessages(prompt: string): ChatMessage[] {
  return [
    {
      role: "system",
      content: [
        "你是海丝侨情与侨务治理垂直大模型门户网的侨情助手。",
        "请围绕华侨华人、侨批档案、侨务治理、海外社团、泉州侨乡文化、海丝迁徙和侨商产业等主题回答。",
        "如果问题超出侨情领域，也可以给出通用回答，但要提醒用户可补充侨情背景。",
        "回答使用简体中文，结构清楚，控制在 3-6 句。",
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

function extractKnownLocationsFromPrompt(prompt: string): CityResult[] {
  const normalizedPrompt = prompt.trim().toLowerCase();
  const matched: CityResult[] = [];
  const seen = new Set<string>();

  knownPromptLocations.forEach((location) => {
    const hasMatch = location.aliases.some((alias) =>
      normalizedPrompt.includes(alias.toLowerCase())
    );

    if (!hasMatch || seen.has(location.name)) {
      return;
    }

    seen.add(location.name);
    matched.push({
      name: location.name,
      lat: location.lat,
      lng: location.lng,
    });
  });

  return matched;
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

function buildFoundationUnavailableAnswer(useKnowledgeBase: boolean): AnswerText {
  const message = useKnowledgeBase
    ? "知识库暂未检索到匹配答案，大模型兜底回答超时。请稍后重试，或把问题范围缩小后再查询。"
    : "大模型回答超时。请稍后重试，或把问题范围缩小后再查询。";

  return {
    clean: message,
    withReferences: message,
  };
}

async function answerGeneralWithRagflow(prompt: string): Promise<AnswerText | null> {
  if (!isRagflowEnabled()) {
    return null;
  }

  const cacheKey = "general";
  const sessionId = await getRagflowSession(cacheKey, "map-general");
  let data: RagflowCompletionData;

  try {
    data = await requestRagflow<RagflowCompletionData>(
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
  } catch (error) {
    invalidateRagflowSession(cacheKey);
    throw error;
  }

  const answer =
    typeof data.answer === "string"
      ? buildAnswerText(data.answer, data.reference ?? data.references)
      : null;

  if (!answer || isRagflowKnowledgeMiss(answer.withReferences)) {
    return null;
  }

  return answer;
}

async function answerAssistantWithRagflow(
  message: string,
  conversationId: string
): Promise<AnswerText | null> {
  if (!isRagflowEnabled()) {
    return null;
  }

  const safeConversationId =
    conversationId.replace(/[^\w-]/g, "").slice(0, 72) || "default";
  const cacheKey = `assistant:${safeConversationId}`;
  const sessionId = await getRagflowSession(cacheKey, "qiaoqing-assistant");
  let data: RagflowCompletionData;

  try {
    data = await requestRagflow<RagflowCompletionData>(
      `/api/v1/chats/${ragflowConfig.chatId}/completions`,
      {
        method: "POST",
        body: JSON.stringify({
          question: message.trim(),
          session_id: sessionId,
          stream: false,
        }),
      }
    );
  } catch (error) {
    invalidateRagflowSession(cacheKey);
    throw error;
  }

  const answer =
    typeof data.answer === "string"
      ? buildAnswerText(data.answer, data.reference ?? data.references)
      : null;

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
    buildGeneralFoundationAnswerMessages(prompt),
    { timeoutMs: foundationConfig.answerTimeoutMs }
  );

  if (!answer.trim()) {
    return null;
  }

  return buildAnswerText(answer);
}

async function answerAssistantWithFoundation(
  prompt: string
): Promise<AnswerText | null> {
  const answer = await createChatText(
    getFoundationClient(),
    foundationConfig.model,
    buildAssistantFoundationAnswerMessages(prompt),
    { timeoutMs: foundationConfig.answerTimeoutMs }
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
  const knownLocations = extractKnownLocationsFromPrompt(prompt);
  if (knownLocations.length > 0) {
    return knownLocations;
  }

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

async function resolvePromptOptimized(
  prompt: string,
  useKnowledgeBase: boolean,
  timer: RequestTimer
): Promise<ExtractQueryResponse> {
  const rawLocationsPromise = timed(timer, "location extraction", () =>
    extractLocationsFromPrompt(prompt)
  ).catch((error) => {
    console.warn("[qiaoqing] Location extraction failed:", getErrorMessage(error));
    return [] as CityResult[];
  });
  const locationsPromise = withSoftTimeout(
    rawLocationsPromise,
    locationExtractionSoftTimeoutMs,
    [] as CityResult[],
    () => {
      timer.mark("location extraction soft timeout", {
        ms: locationExtractionSoftTimeoutMs,
      });
    }
  );

  if (useKnowledgeBase && isRagflowEnabled()) {
    const foundationFallback = createDeferredFoundationFallback(prompt, timer);
    const answerPromise = timed(timer, "ragflow answer", () =>
      answerGeneralWithRagflow(prompt)
    ).catch((error) => {
      console.warn("[qiaoqing] RAGFlow answer failed:", getErrorMessage(error));
      return null;
    });

    const [locations, ragflowAnswer] = await Promise.all([
      locationsPromise,
      answerPromise,
    ]);

    if (ragflowAnswer) {
      foundationFallback.cancel();
      timer.mark("compose ragflow response", {
        locations: locations.length,
      });
      return buildQueryResponse(
        attachAnswerToCities(locations, ragflowAnswer, "ragflow"),
        ragflowAnswer,
        "ragflow"
      );
    }

    timer.mark("fallback to foundation answer", {
      locations: locations.length,
    });
    const foundationAnswer = await foundationFallback.start("ragflow-miss");

    if (foundationAnswer) {
      return buildQueryResponse(
        attachAnswerToCities(locations, foundationAnswer, "model"),
        foundationAnswer,
        "model"
      );
    }

    const timeoutAnswer = buildFoundationUnavailableAnswer(true);
    return buildQueryResponse(
      attachAnswerToCities(locations, timeoutAnswer, "model"),
      timeoutAnswer,
      "model"
    );
  }

  const answerPromise = timed(timer, "foundation answer", () =>
    answerGeneralWithFoundation(prompt)
  );
  const [locations, foundationAnswer] = await Promise.all([
    locationsPromise,
    answerPromise,
  ]);

  if (foundationAnswer) {
    timer.mark("compose foundation response", {
      locations: locations.length,
    });
    return buildQueryResponse(
      attachAnswerToCities(locations, foundationAnswer, "model"),
      foundationAnswer,
      "model"
    );
  }

  return buildQueryResponse(locations);
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

  const cacheKey = `city:${cityName}`;
  const sessionId = await getRagflowSession(cacheKey, `map-${cityName}`);
  let data: RagflowCompletionData;

  try {
    data = await requestRagflow<RagflowCompletionData>(
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
  } catch (error) {
    invalidateRagflowSession(cacheKey);
    throw error;
  }

  const answer =
    typeof data.answer === "string"
      ? buildAnswerText(data.answer, data.reference ?? data.references)
      : null;

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

function shouldDropKnowledgeLine(line: string): boolean {
  const compact = line.replace(/\s+/g, "");
  if (!compact) return true;
  if (/^https?:\/\/\S+$/i.test(compact)) return true;
  if (
    /^(\u4E0A\u4E00\u7BC7|\u4E0B\u4E00\u7BC7|\u76F8\u5173\u9605\u8BFB|\u8FD4\u56DE\u9996\u9875|\u6253\u5370|\u5173\u95ED|\u6536\u85CF|\u5206\u4EAB\u5230|\u5FAE\u4FE1|\u5FAE\u535A)$/u.test(compact)
  ) {
    return true;
  }
  if (/^(All rights reserved|Copyright)\b/i.test(line)) return true;
  if (/^(\u8D23\u4EFB\u7F16\u8F91|\u7F16\u8F91|\u4F5C\u8005)[:\uFF1A]/u.test(compact) && compact.length <= 28) return true;
  if (/^(\u6765\u6E90|\u53D1\u5E03\u65F6\u95F4|\u53D1\u8868\u65F6\u95F4|\u53D1\u5E03\u65E5\u671F)[:\uFF1A]/u.test(compact) && compact.length <= 36) return true;
  if (/^[\-_=*#~\u00B7.\u3002]{3,}$/.test(compact)) return true;
  return false;
}

function cleanKnowledgeText(value?: string | null): TextCleaningResult {
  const original = typeof value === "string" ? value : "";
  const stats: TextCleaningStats = {
    originalLength: original.length,
    cleanedLength: 0,
    removedCharacters: 0,
    removedLines: 0,
    dedupedLines: 0,
  };

  if (!original.trim()) {
    return { text: "", stats };
  }

  let text = original
    .replace(/^\uFEFF/, "")
    .replace(/[\u200B-\u200D\u2060]/g, "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ");

  text = decodeXmlText(text)
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[ \t\u00A0]+/g, " ")
    .replace(/\r\n?/g, "\n")
    .replace(/\n[ \t]+/g, "\n");

  const seenLines = new Set<string>();
  const lines = text.split("\n");
  const cleanedLines: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine
      .replace(/[ \t]{2,}/g, " ")
      .replace(/\s+([\uFF0C\u3002\uFF01\uFF1F\uFF1B\uFF1A\u3001,.!?;:])/g, "$1")
      .trim();
    const compact = line.replace(/\s+/g, "");

    if (shouldDropKnowledgeLine(line)) {
      stats.removedLines += 1;
      continue;
    }

    if (compact.length >= 8 && seenLines.has(compact)) {
      stats.dedupedLines += 1;
      continue;
    }

    if (compact.length >= 8) {
      seenLines.add(compact);
    }

    cleanedLines.push(line);
  }

  text = cleanedLines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const maxChars = Number.isFinite(dataCleaningConfig.maxChars)
    ? Math.max(1_000, dataCleaningConfig.maxChars)
    : 12_000;
  if (text.length > maxChars) {
    text = text.slice(0, maxChars).trim();
  }

  stats.cleanedLength = text.length;
  stats.removedCharacters = Math.max(0, stats.originalLength - stats.cleanedLength);
  return { text, stats };
}

function maybeCleanKnowledgeText(value?: string | null): TextCleaningResult {
  if (dataCleaningConfig.enabled) {
    return cleanKnowledgeText(value);
  }

  const text = typeof value === "string" ? value.trim() : "";
  return {
    text,
    stats: {
      originalLength: typeof value === "string" ? value.length : 0,
      cleanedLength: text.length,
      removedCharacters: Math.max(0, (typeof value === "string" ? value.length : 0) - text.length),
      removedLines: 0,
      dedupedLines: 0,
    },
  };
}

function emptyCleaningStats(originalLength = 0): TextCleaningStats {
  return {
    originalLength,
    cleanedLength: 0,
    removedCharacters: originalLength,
    removedLines: 0,
    dedupedLines: 0,
  };
}

function sanitizeStorageFilename(filename: string): string {
  const fallback = "uploaded-file";
  const normalized = path.basename(filename || fallback).replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");
  const compact = normalized.replace(/\s+/g, " ").trim();
  return (compact || fallback).slice(0, 160);
}

function cleanedStorageFilename(filename: string): string {
  const safeName = sanitizeStorageFilename(filename);
  const extension = path.extname(safeName);
  const baseName = extension ? safeName.slice(0, -extension.length) : safeName;
  return extension ? `${baseName}.cleaned${extension}` : `${baseName}.cleaned.txt`;
}

function uploadStorageSubdir(): string {
  return new Date().toISOString().slice(0, 10);
}

async function saveCleaningBuffer(
  filename: string,
  buffer: Buffer,
  kind: SavedCleaningFile["kind"]
): Promise<SavedCleaningFile> {
  const directory = path.join(dataCleaningConfig.storageDir, uploadStorageSubdir());
  await fs.mkdir(directory, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const nonce = crypto.randomBytes(4).toString("hex");
  const safeFilename = sanitizeStorageFilename(filename);
  const storedFilename = `${stamp}-${nonce}-${safeFilename}`;
  const fullPath = path.join(directory, storedFilename);
  await fs.writeFile(fullPath, buffer);

  return {
    kind,
    filename: storedFilename,
    path: fullPath,
    bytes: buffer.length,
  };
}

function decodeHeaderValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseContentDispositionFilename(value?: string): string | null {
  if (!value) return null;

  const encoded = value.match(/filename\*=UTF-8''([^;\r\n]+)/i);
  if (encoded) {
    return path.basename(decodeHeaderValue(encoded[1].replace(/^"|"$/g, "")));
  }

  const plain = value.match(/filename="([^"]+)"|filename=([^;\r\n]+)/i);
  const filename = plain?.[1] ?? plain?.[2];
  return filename ? path.basename(filename.trim()) : null;
}

function parseMultipartCleaningFile(contentType: string, body: Buffer): UploadedCleaningFile | null {
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2];
  if (!boundary) return null;

  const delimiter = Buffer.from(`--${boundary}`);
  let cursor = body.indexOf(delimiter);

  while (cursor >= 0) {
    cursor += delimiter.length;
    if (body[cursor] === 45 && body[cursor + 1] === 45) break;
    if (body[cursor] === 13 && body[cursor + 1] === 10) cursor += 2;

    const headerEnd = body.indexOf(Buffer.from("\r\n\r\n"), cursor);
    if (headerEnd < 0) break;

    const headersText = body.slice(cursor, headerEnd).toString("utf8");
    const headers = new Map<string, string>();
    for (const line of headersText.split("\r\n")) {
      const separator = line.indexOf(":");
      if (separator <= 0) continue;
      headers.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim());
    }

    const contentStart = headerEnd + 4;
    const nextBoundary = body.indexOf(Buffer.from(`\r\n--${boundary}`), contentStart);
    if (nextBoundary < 0) break;

    const disposition = headers.get("content-disposition");
    const filename = parseContentDispositionFilename(disposition);
    const fieldName = disposition?.match(/name="([^"]+)"/i)?.[1];
    if (filename || fieldName === "file" || fieldName === "text") {
      const fallbackName = fieldName === "text" ? "uploaded.txt" : "uploaded-file";
      return {
        filename: filename || fallbackName,
        mimeType: headers.get("content-type") || "text/plain",
        buffer: body.slice(contentStart, nextBoundary),
      };
    }

    cursor = body.indexOf(delimiter, nextBoundary);
  }

  return null;
}

function readHeaderString(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function readQueryString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readUploadedCleaningFile(req: express.Request): UploadedCleaningFile | null {
  const body = Buffer.isBuffer(req.body) ? req.body : null;
  if (!body || body.length === 0) return null;

  const contentType = readHeaderString(req.headers["content-type"]) ?? "";
  if (contentType.toLowerCase().includes("multipart/form-data")) {
    return parseMultipartCleaningFile(contentType, body);
  }

  return {
    filename:
      path.basename(
        readQueryString(req.query.filename) ||
          decodeHeaderValue(readHeaderString(req.headers["x-filename"]) ?? "")
      ) || "uploaded.txt",
    mimeType: contentType.split(";")[0]?.trim() || "application/octet-stream",
    buffer: body,
  };
}

function isSupportedTextUpload(file: UploadedCleaningFile): boolean {
  const extension = path.extname(file.filename).toLowerCase();
  const mimeType = file.mimeType.toLowerCase();
  const supportedExtensions = new Set([
    ".txt",
    ".md",
    ".markdown",
    ".csv",
    ".tsv",
    ".json",
    ".jsonl",
    ".html",
    ".htm",
    ".xml",
    ".yaml",
    ".yml",
    ".log",
    ".sql",
  ]);

  if (supportedExtensions.has(extension)) return true;
  if (mimeType.startsWith("text/")) return true;
  return /(json|xml|yaml|javascript|x-www-form-urlencoded)/i.test(mimeType);
}

function cleaningUploadDecision(file: UploadedCleaningFile): CleaningUploadDecision {
  const extension = path.extname(file.filename).toLowerCase();
  const mimeType = file.mimeType.toLowerCase();
  const signature = file.buffer.subarray(0, 8).toString("latin1");

  if (signature.startsWith("%PDF") || extension === ".pdf" || mimeType.includes("pdf")) {
    return {
      mode: "ragflow_parse_required",
      documentType: "pdf",
      message: "PDF 需要先解析成文本，再做轻量清洗。",
      suggestedSteps: [
        "先把原始 PDF 上传到 RAGFlow 知识库，让 RAGFlow 完成解析。",
        "如果是扫描件或图片型 PDF，需要先做 OCR，或使用 RAGFlow 的 OCR/解析能力。",
        "解析后重点检查页眉页脚、页码、水印、断行错乱和 OCR 错字。",
        "如果能导出解析后的文本或 Markdown，再上传到这里做轻量清洗。",
      ],
    };
  }

  if (
    [".xlsx", ".xls", ".xlsm"].includes(extension) ||
    mimeType.includes("spreadsheet") ||
    mimeType.includes("excel")
  ) {
    return {
      mode: "ragflow_parse_required",
      documentType: "spreadsheet",
      message: "表格文件需要先做表格结构解析，再做轻量清洗。",
      suggestedSteps: [
        "先把 XLSX/XLS 上传到 RAGFlow，或把重要 sheet 导出为 CSV/Markdown。",
        "检查 sheet 名、表头、合并单元格、空行空列是否被正确保留。",
        "重要表格建议一个 sheet 或一个 Markdown 段落只放一张表。",
        "如需二次清洗，可把导出的 CSV/Markdown 上传到这里。",
      ],
    };
  }

  if (
    [".doc", ".docx"].includes(extension) ||
    mimeType.includes("wordprocessingml") ||
    mimeType.includes("msword")
  ) {
    return {
      mode: "ragflow_parse_required",
      documentType: "word",
      message: "Word 文档需要先解析标题、段落和表格结构。",
      suggestedSteps: [
        "先把 DOC/DOCX 上传到 RAGFlow，让它解析标题、正文、表格和脚注。",
        "检查标题层级、表格、脚注、页眉页脚是否抽取正确。",
        "如需二次清洗，可导出解析后的文本或 Markdown 再上传到这里。",
      ],
    };
  }

  if (
    [".ppt", ".pptx"].includes(extension) ||
    mimeType.includes("presentationml") ||
    mimeType.includes("powerpoint")
  ) {
    return {
      mode: "ragflow_parse_required",
      documentType: "presentation",
      message: "演示文稿需要先按幻灯片结构解析。",
      suggestedSteps: [
        "先把 PPT/PPTX 上传到 RAGFlow，让它解析幻灯片文字和备注。",
        "检查标题、项目符号顺序、备注和页码是否保留正确。",
        "如需二次清洗，可导出解析后的文本或 Markdown 再上传到这里。",
      ],
    };
  }

  if (mimeType.startsWith("image/") || [".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"].includes(extension)) {
    return {
      mode: "ragflow_parse_required",
      documentType: "image",
      message: "图片需要先 OCR 成文本，再做轻量清洗。",
      suggestedSteps: [
        "先使用 RAGFlow OCR/解析能力，或其他 OCR 工具提取图片文字。",
        "检查 OCR 结果中的识别错误、漏列、阅读顺序错误。",
        "如需二次清洗，可把 OCR 文本上传到这里。",
      ],
    };
  }

  if (
    [".zip", ".rar", ".7z", ".tar", ".gz", ".tgz", ".bz2"].includes(extension) ||
    mimeType.includes("zip") ||
    mimeType.includes("rar") ||
    mimeType.includes("7z") ||
    mimeType.includes("x-tar") ||
    mimeType.includes("gzip")
  ) {
    return {
      mode: "ragflow_parse_required",
      documentType: "archive",
      message: "这是一份压缩文件，无法直接做轻量清洗。",
      suggestedSteps: [
        "原始压缩文件已保存到服务器。",
        "请先解压压缩包，再按文件类型分别上传 PDF、Word、Excel、图片或文本文件。",
        "如果压缩包内文件较多，建议先筛选出需要进入知识库的文件，避免无关附件进入 RAGFlow。",
        "解压后的文本、CSV、Markdown、HTML 可以在这里直接清洗；PDF、Office、图片需要先解析或 OCR。",
      ],
    };
  }

  if (isSupportedTextUpload(file)) {
    return {
      mode: "cleaned",
      documentType: "text",
      message: "文本类文件已直接完成轻量清洗。",
      suggestedSteps: [],
    };
  }

  if (looksLikeBinary(file.buffer)) {
    return {
      mode: "unsupported",
      documentType: extension ? extension.slice(1) : "binary",
      message: "该二进制文件类型不能直接做轻量清洗。",
      suggestedSteps: [
        "如果 RAGFlow 支持该格式，请先上传到 RAGFlow 解析。",
        "否则请先转换或导出为文本、Markdown、CSV 或 HTML，再使用这里的清洗功能。",
      ],
    };
  }

  return {
    mode: "cleaned",
    documentType: "plain-text",
    message: "文件内容看起来是纯文本，已直接完成轻量清洗。",
    suggestedSteps: [],
  };
}

function looksLikeBinary(buffer: Buffer): boolean {
  if (buffer.length === 0) return false;
  if (buffer.includes(0)) return true;

  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  let controlCount = 0;
  for (const byte of sample) {
    const allowedControl = byte === 9 || byte === 10 || byte === 13;
    if (byte < 32 && !allowedControl) {
      controlCount += 1;
    }
  }

  return controlCount / sample.length > 0.02;
}

function extractTextFromCleaningUpload(file: UploadedCleaningFile): string {
  if (looksLikeBinary(file.buffer)) {
    throw new Error("Unsupported binary file type for lightweight cleaning.");
  }

  return new TextDecoder("utf-8", { fatal: false }).decode(file.buffer);
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

function collectionRelatedTerms(keyword: string): string[] {
  const normalized = keyword.replace(/\s+/g, "");
  const terms = ["侨情", "华侨", "侨胞", "侨联", "侨务", "华侨华人"];

  if (/泉州|刺桐|海丝/.test(normalized)) {
    terms.push("泉州侨乡", "海丝侨务");
  }

  if (/菲律宾|马来西亚|新加坡|印尼|印度尼西亚|泰国|缅甸|越南|东南亚|南洋/.test(normalized)) {
    terms.push("同乡会", "侨团", "闽南");
  }

  return [...new Set(terms.filter((term) => !normalized.includes(term)))];
}

function buildCollectionSearchQuery(keyword: string): string {
  const relatedTerms = collectionRelatedTerms(keyword).slice(0, 8);
  if (relatedTerms.length === 0) return keyword;
  return `${keyword} (${relatedTerms.join(" OR ")})`;
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
  const query = encodeURIComponent(buildCollectionSearchQuery(keyword));
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
  url.searchParams.set("q", buildCollectionSearchQuery(keyword));
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
      query: `${buildCollectionSearchQuery(keyword)} 国内 中文 新闻`,
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
  const query = encodeURIComponent(`${buildCollectionSearchQuery(keyword)} when:${timeRangeDays}d`);
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

function collectionSourceWeight(sourceType: CollectionSourceType): number {
  if (sourceType === "crawler") return 50;
  if (sourceType === "bing") return 34;
  if (sourceType === "tavily") return 30;
  if (sourceType === "gdelt") return 24;
  if (sourceType === "rss") return 22;
  return 20;
}

function trustedDomainWeight(article: GdeltArticle): number {
  const domain = normalizeNewsDomain(article.url ?? article.domain);
  if (!domain) return 0;

  const matchedDomain = Object.keys(sourceNameByDomain).find((item) =>
    domain === item || domain.endsWith(`.${item}`)
  );

  if (!matchedDomain) return 0;
  if (
    ["chinaqw.com", "qz.fjsen.com", "qzwb.com", "qztv.cn", "hqu.edu.cn"].includes(
      matchedDomain
    )
  ) {
    return 24;
  }
  return 16;
}

function normalizeCollectionUrl(value?: string): string | undefined {
  if (!value) return undefined;

  try {
    const url = new URL(value);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|spm|from|source|share|scene|wd|eqid)/i.test(key)) {
        url.searchParams.delete(key);
      }
    }
    return url.toString().replace(/\/$/, "");
  } catch {
    return value.trim().replace(/\/$/, "");
  }
}

function normalizeCollectionTitle(value?: string): string {
  return (value ?? "")
    .replace(/[^\u3400-\u9fffA-Za-z0-9]/g, "")
    .toLowerCase();
}

function titleSimilarity(left?: string, right?: string): number {
  const a = normalizeCollectionTitle(left);
  const b = normalizeCollectionTitle(right);
  if (!a || !b) return 0;
  if (a === b) return 1;

  const shorter = a.length <= b.length ? a : b;
  const longer = a.length > b.length ? a : b;
  if (shorter.length >= 8 && longer.includes(shorter)) return 0.92;

  const aTerms = new Set(keywordTerms(a));
  const bTerms = new Set(keywordTerms(b));
  if (aTerms.size === 0 || bTerms.size === 0) return 0;

  let overlap = 0;
  for (const term of aTerms) {
    if (bTerms.has(term)) overlap += 1;
  }
  return overlap / Math.max(aTerms.size, bTerms.size);
}

function collectionArticleScore(
  article: GdeltArticle,
  keyword: string,
  sourceType: CollectionSourceType
): number {
  const searchable = `${article.title ?? ""}\n${article.content ?? ""}`;
  const terms = keywordTerms(keyword);
  const matchedTerms = terms.filter((term) => searchable.includes(term)).length;
  const keywordScore = terms.length > 0 ? (matchedTerms / terms.length) * 26 : 12;
  const freshnessDate = parseGdeltDate(article.seendate);
  const ageDays = freshnessDate
    ? Math.max(0, (Date.now() - freshnessDate.getTime()) / 86_400_000)
    : 30;
  const freshnessScore = Math.max(0, 18 - Math.min(ageDays, 30) * 0.6);
  const contentScore = article.raw_content || article.content ? 8 : 0;

  return (
    collectionSourceWeight(sourceType) +
    trustedDomainWeight(article) +
    keywordScore +
    freshnessScore +
    contentScore
  );
}

function disabledCollectionSourceMessage(sourceType: CollectionSourceType): string | null {
  const health = collectionSourceHealth.get(sourceType);
  if (!health || health.disabledUntil <= Date.now()) return null;

  const seconds = Math.ceil((health.disabledUntil - Date.now()) / 1000);
  return `${sourceType} temporarily disabled for ${seconds}s`;
}

function recordCollectionSourceHealth(result: CollectionSourceResult): void {
  if (result.skipped) return;

  if (!result.error && !result.timedOut) {
    collectionSourceHealth.delete(result.sourceType);
    return;
  }

  const current = collectionSourceHealth.get(result.sourceType) ?? {
    failures: 0,
    disabledUntil: 0,
  };
  const failures = current.failures + 1;
  const disabledUntil =
    failures >= newsSearchConfig.sourceFailureThreshold
      ? Date.now() + newsSearchConfig.sourceCooldownMs
      : current.disabledUntil;

  collectionSourceHealth.set(result.sourceType, {
    failures,
    disabledUntil,
  });
}

async function runCollectionSource(
  sourceType: CollectionSourceType,
  label: string,
  timeoutMs: number,
  run: () => Promise<GdeltArticle[]>
): Promise<CollectionSourceResult> {
  const disabledMessage = disabledCollectionSourceMessage(sourceType);
  if (disabledMessage) {
    return {
      sourceType,
      articles: [],
      elapsedMs: 0,
      error: disabledMessage,
      skipped: true,
    };
  }

  const startedAt = Date.now();
  const timeoutResult = new Promise<CollectionSourceResult>((resolve) => {
    setTimeout(() => {
      resolve({
        sourceType,
        articles: [],
        elapsedMs: Date.now() - startedAt,
        error: `${label} timed out after ${timeoutMs}ms`,
        timedOut: true,
      });
    }, timeoutMs);
  });

  const runResult = run()
    .then((articles): CollectionSourceResult => ({
      sourceType,
      articles,
      elapsedMs: Date.now() - startedAt,
    }))
    .catch((error): CollectionSourceResult => ({
      sourceType,
      articles: [],
      elapsedMs: Date.now() - startedAt,
      error: getErrorMessage(error),
    }));

  return Promise.race([runResult, timeoutResult]);
}

function mergeCollectionResults(
  results: CollectionSourceResult[],
  keyword: string,
  maxRecords: number
): GdeltArticle[] {
  type Candidate = GdeltArticle & { collectionSourceType: CollectionSourceType; score: number };

  const byUrl = new Map<string, Candidate>();
  const candidates: Candidate[] = [];

  for (const result of results) {
    for (const article of result.articles) {
      const title = article.title?.trim();
      const url = normalizeCollectionUrl(article.url);
      if (!title || !url) continue;

      const candidate: Candidate = {
        ...article,
        url,
        collectionSourceType: result.sourceType,
        score: collectionArticleScore(article, keyword, result.sourceType),
      };
      const existing = byUrl.get(url);
      if (!existing || candidate.score > existing.score) {
        byUrl.set(url, candidate);
      }
    }
  }

  const urlDeduped = [...byUrl.values()].sort((a, b) => b.score - a.score);
  for (const article of urlDeduped) {
    const duplicateByTitle = candidates.some(
      (existing) => titleSimilarity(existing.title, article.title) >= 0.9
    );
    if (duplicateByTitle) continue;

    candidates.push(article);
    if (candidates.length >= maxRecords) break;
  }

  return candidates.map(({ collectionSourceType: _sourceType, score: _score, ...article }) => article);
}

async function fetchCollectionArticles(
  keyword: string,
  timeRangeDays: number,
  maxRecords: number,
  sourceMode: CollectionSourceMode
): Promise<{ sourceType: CollectionSourceType; articles: GdeltArticle[] }> {
  if (sourceMode === "auto") {
    const sourceRuns: Array<Promise<CollectionSourceResult>> = [
      runCollectionSource("crawler", "Crawler", newsSearchConfig.crawlerTimeoutMs, () =>
        fetchCrawlerArticles(keyword, timeRangeDays, maxRecords)
      ),
      runCollectionSource("gdelt", "GDELT", newsSearchConfig.gdeltTimeoutMs, () =>
        fetchGdeltArticles(keyword, timeRangeDays, maxRecords)
      ),
      runCollectionSource("rss", "Google News RSS", newsSearchConfig.rssTimeoutMs, () =>
        fetchGoogleNewsRssArticles(keyword, timeRangeDays, maxRecords)
      ),
    ];

    if (newsSearchConfig.tavilyApiKey) {
      sourceRuns.push(
        runCollectionSource("tavily", "Tavily", newsSearchConfig.tavilyTimeoutMs, () =>
          fetchTavilyNewsArticles(keyword, timeRangeDays, maxRecords)
        )
      );
    }

    if (newsSearchConfig.bingApiKey) {
      sourceRuns.push(
        runCollectionSource("bing", "Bing News", newsSearchConfig.bingTimeoutMs, () =>
          fetchBingNewsArticles(keyword, timeRangeDays, maxRecords)
        )
      );
    }

    const results = await Promise.all(sourceRuns);
    for (const result of results) {
      recordCollectionSourceHealth(result);
      const status = result.skipped
        ? "skipped"
        : result.timedOut
          ? "timeout"
          : result.error
            ? "failed"
            : "ok";
      console.log(
        `[collection] ${result.sourceType} ${status}: ${result.articles.length} articles in ${result.elapsedMs}ms` +
          (result.error ? ` (${result.error})` : "")
      );
    }

    return {
      sourceType: "aggregate",
      articles: mergeCollectionResults(results, keyword, maxRecords),
    };
  }

  if (sourceMode === "crawler") {
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

  if (sourceMode === "tavily" && newsSearchConfig.tavilyApiKey) {
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
  return "aggregate";
}

function normalizeCollectionSourceMode(value: unknown): CollectionSourceMode {
  if (value === "crawler" || value === "tavily") return value;
  return "auto";
}

function preferredCollectionSourceTypeForMode(sourceMode: CollectionSourceMode): CollectionSourceType {
  if (sourceMode === "crawler") return "crawler";
  if (sourceMode === "tavily") return "tavily";
  return "aggregate";
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

      const excerptCleaning = maybeCleanKnowledgeText(article.content ?? title);
      const rawContentCleaning = maybeCleanKnowledgeText(
        article.raw_content ?? article.content ?? title
      );
      const cleanedArticle: GdeltArticle = {
        ...article,
        content: excerptCleaning.text || title,
        raw_content: rawContentCleaning.text || null,
      };

      const contentHash = hashToken(`${title}\n${sourceUrl}`);
      const summary = await summarizeNewsArticle(cleanedArticle, keyword);
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
          toMysqlDate(parseGdeltDate(cleanedArticle.seendate)),
          cleanedArticle.socialimage ?? null,
          cleanedArticle.content ?? title,
          cleanedArticle.raw_content ?? null,
          displaySummary,
          JSON.stringify(displayPoints),
          JSON.stringify(displayRegions),
          JSON.stringify(displayPeople),
          JSON.stringify(displayOrganizations),
          JSON.stringify(displayTags),
          cleanedArticle.language ?? null,
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
type AdminPermission = "overview" | "users" | "collection" | "audit" | "ragflow";

const adminPermissions: AdminPermission[] = [
  "overview",
  "users",
  "collection",
  "audit",
  "ragflow",
];

interface AdminUser {
  id: number;
  username: string;
  displayName: string;
  role: AdminRole;
  status: "active" | "disabled";
  menuPermissions: AdminPermission[];
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

function normalizeAdminPermissionArray(value: unknown, role: AdminRole): AdminPermission[] {
  if (role === "super_admin") return [...adminPermissions];
  if (role === "viewer") return [];

  const rawItems = (() => {
    if (Array.isArray(value)) return value;
    if (typeof value === "string" && value.trim()) {
      try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return value.split(",");
      }
    }
    return [];
  })();

  const allowed = new Set<AdminPermission>(adminPermissions);
  const normalized = rawItems.filter((item): item is AdminPermission =>
    typeof item === "string" && allowed.has(item as AdminPermission)
  );

  return [...new Set(normalized)];
}

function normalizeAdminUser(row: RowDataPacket): AdminUser {
  const role: AdminRole =
    row.role === "super_admin" || row.role === "viewer" ? row.role : "admin";
  return {
    id: Number(row.id),
    username: String(row.username),
    displayName: String(row.display_name ?? row.username),
    role,
    status: row.status === "disabled" ? "disabled" : "active",
    menuPermissions: normalizeAdminPermissionArray(row.menu_permissions, role),
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
  const [permissionColumns] = await pool.execute<RowDataPacket[]>(
    `SELECT COLUMN_NAME
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'users'
       AND COLUMN_NAME = 'menu_permissions'
     LIMIT 1`
  );
  if (!permissionColumns[0]) {
    await pool.execute(
      `ALTER TABLE users
       ADD COLUMN menu_permissions JSON NULL AFTER phone`
    );
  }

  const [collectionSourceColumns] = await pool.execute<RowDataPacket[]>(
    `SELECT COLUMN_TYPE AS columnType
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'collection_tasks'
       AND COLUMN_NAME = 'source_type'
     LIMIT 1`
  );
  const sourceColumnType = String(collectionSourceColumns[0]?.columnType ?? "");
  if (sourceColumnType && !sourceColumnType.includes("'aggregate'")) {
    await pool.execute(
      `ALTER TABLE collection_tasks
       MODIFY source_type ENUM('aggregate', 'crawler', 'tavily', 'bing', 'gdelt', 'rss', 'manual')
       NOT NULL DEFAULT 'aggregate'`
    );
  }

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
    `SELECT u.id, u.username, u.display_name, u.role, u.status, u.menu_permissions
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

function requireAdminPageAccess(
  req: AdminRequest,
  res: express.Response,
  next: express.NextFunction
) {
  if (req.adminUser?.role !== "super_admin" && req.adminUser?.role !== "admin") {
    return res.status(403).json({ error: "Administrator access is required" });
  }

  return next();
}

function hasAdminPermission(user: AdminUser | undefined, permission: AdminPermission): boolean {
  if (!user) return false;
  if (user.role === "super_admin") return true;
  if (user.role !== "admin") return false;
  return user.menuPermissions.includes(permission);
}

function requireAdminPermission(permission: AdminPermission) {
  return (
    req: AdminRequest,
    res: express.Response,
    next: express.NextFunction
  ) => {
    if (!hasAdminPermission(req.adminUser, permission)) {
      return res.status(403).json({ error: "Permission denied" });
    }

    return next();
  };
}

function publicAdminUser(user: AdminUser) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    status: user.status,
    menuPermissions: user.menuPermissions,
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

function readMenuPermissions(value: unknown, role: AdminRole): AdminPermission[] {
  const permissions = normalizeAdminPermissionArray(value, role);
  if (role === "admin" && permissions.length === 0) {
    return ["collection"];
  }
  return permissions;
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
        `SELECT id, username, display_name, password_hash, role, status, menu_permissions
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

  app.use("/api/admin", requireAdminSession, requireAdminPageAccess);

  app.get("/api/admin/summary", requireAdminPermission("overview"), async (_req, res) => {
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

  app.get("/api/admin/users", requireSuperAdmin, async (_req, res) => {
    try {
      const [rows] = await getAdminDbPool().query<RowDataPacket[]>(
        `SELECT
          id, username, display_name AS displayName, role, status,
          menu_permissions AS menuPermissions,
          email, phone, last_login_at AS lastLoginAt, last_login_ip AS lastLoginIp,
          created_at AS createdAt
         FROM users
         ORDER BY id ASC`
      );

      return res.json({
        users: rows.map((row) => {
          const role: AdminRole =
            row.role === "super_admin" || row.role === "viewer" ? row.role : "admin";
          return {
            ...row,
            menuPermissions: normalizeAdminPermissionArray(row.menuPermissions, role),
          };
        }),
      });
    } catch (error) {
      return res.status(getStatusCode(error)).json({
        error: "Failed to load users",
        details: getErrorMessage(error),
      });
    }
  });

  app.post("/api/admin/collection/run", requireAdminPermission("collection"), async (req: AdminRequest, res) => {
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

  app.get("/api/admin/collection/tasks", requireAdminPermission("collection"), async (_req, res) => {
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

  app.get("/api/admin/collection/articles", requireAdminPermission("collection"), async (_req, res) => {
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

  app.patch("/api/admin/collection/articles/:id", requireAdminPermission("collection"), async (req: AdminRequest, res) => {
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

  app.post("/api/admin/users", requireSuperAdmin, async (req: AdminRequest, res) => {
    try {
      const username = readOptionalString(req.body?.username);
      const displayName = readOptionalString(req.body?.displayName);
      const password = typeof req.body?.password === "string" ? req.body.password : "";
      const role = readAdminRole(req.body?.role) ?? "viewer";
      const status = readAdminStatus(req.body?.status) ?? "active";
      const menuPermissions = readMenuPermissions(req.body?.menuPermissions, role);
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
          (username, display_name, password_hash, role, status, menu_permissions, email, phone)
         VALUES (?, ?, ?, ?, ?, CAST(? AS JSON), ?, ?)`,
        [
          username,
          displayName,
          passwordHash,
          role,
          status,
          JSON.stringify(menuPermissions),
          email,
          phone,
        ]
      );

      await writeAuditLog("user.create", req, {
        actorUserId: req.adminUser?.id ?? null,
        targetType: "user",
        targetId: String(result.insertId),
        detail: { username, role, status, menuPermissions },
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

  app.patch("/api/admin/users/:id", requireSuperAdmin, async (req: AdminRequest, res) => {
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
      const menuPermissions = readMenuPermissions(req.body?.menuPermissions, nextRole);

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
               menu_permissions = CAST(? AS JSON), email = ?, phone = ?
           WHERE id = ?`,
          [
            username,
            displayName,
            await hashPassword(password),
            role,
            status,
            JSON.stringify(menuPermissions),
            email,
            phone,
            userId,
          ]
        );
      } else {
        await getAdminDbPool().execute(
          `UPDATE users
           SET username = ?, display_name = ?, role = ?, status = ?,
               menu_permissions = CAST(? AS JSON), email = ?, phone = ?
           WHERE id = ?`,
          [
            username,
            displayName,
            role,
            status,
            JSON.stringify(menuPermissions),
            email,
            phone,
            userId,
          ]
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
        detail: { username, role, status, menuPermissions },
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

  app.delete("/api/admin/users/:id", requireSuperAdmin, async (req: AdminRequest, res) => {
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

  app.get("/api/admin/audit-logs", requireAdminPermission("audit"), async (_req, res) => {
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

  app.get("/api/admin/ragflow/status", requireAdminPermission("ragflow"), async (_req, res) => {
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

  app.post("/api/admin/cleaning/preview", requireAdminPermission("collection"), async (req: AdminRequest, res) => {
    const text = readOptionalString(req.body?.text);
    if (!text) {
      return res.status(400).json({ error: "Text is required" });
    }

    const result = maybeCleanKnowledgeText(text);

    await writeAuditLog("cleaning.preview", req, {
      actorUserId: req.adminUser?.id ?? null,
      targetType: "knowledge_text",
      detail: {
        originalLength: result.stats.originalLength,
        cleanedLength: result.stats.cleanedLength,
        removedLines: result.stats.removedLines,
        dedupedLines: result.stats.dedupedLines,
      },
    });

    return res.json({
      enabled: dataCleaningConfig.enabled,
      text: result.text,
      stats: result.stats,
    });
  });

  app.post(
    "/api/admin/cleaning/upload",
    requireAdminPermission("collection"),
    express.raw({
      type: () => true,
      limit: Number.isFinite(dataCleaningConfig.uploadMaxBytes)
        ? dataCleaningConfig.uploadMaxBytes
        : 5 * 1024 * 1024,
    }),
    async (req: AdminRequest, res) => {
      try {
        const file = readUploadedCleaningFile(req);
        if (!file) {
          return res.status(400).json({ error: "File is required" });
        }

        const savedFiles: SavedCleaningFile[] = [
          await saveCleaningBuffer(file.filename, file.buffer, "original"),
        ];
        const decision = cleaningUploadDecision(file);
        if (decision.mode !== "cleaned") {
          const stats = emptyCleaningStats(file.buffer.length);
          await writeAuditLog("cleaning.upload", req, {
            actorUserId: req.adminUser?.id ?? null,
            targetType: "knowledge_file",
            targetId: file.filename,
            detail: {
              filename: file.filename,
              mimeType: file.mimeType,
              bytes: file.buffer.length,
              mode: decision.mode,
              documentType: decision.documentType,
              savedFiles,
            },
          });

          return res.json({
            enabled: dataCleaningConfig.enabled,
            filename: file.filename,
            mimeType: file.mimeType,
            bytes: file.buffer.length,
            mode: decision.mode,
            documentType: decision.documentType,
            message: decision.message,
            suggestedSteps: decision.suggestedSteps,
            savedFiles,
            text: "",
            stats,
          });
        }

        const sourceText = extractTextFromCleaningUpload(file);
        const result = maybeCleanKnowledgeText(sourceText);
        const cleanedBuffer = Buffer.from(result.text, "utf8");
        savedFiles.push(
          await saveCleaningBuffer(
            cleanedStorageFilename(file.filename),
            cleanedBuffer,
            "cleaned"
          )
        );

        await writeAuditLog("cleaning.upload", req, {
          actorUserId: req.adminUser?.id ?? null,
          targetType: "knowledge_file",
          targetId: file.filename,
          detail: {
            filename: file.filename,
            mimeType: file.mimeType,
            bytes: file.buffer.length,
            mode: decision.mode,
            documentType: decision.documentType,
            originalLength: result.stats.originalLength,
            cleanedLength: result.stats.cleanedLength,
            removedLines: result.stats.removedLines,
            dedupedLines: result.stats.dedupedLines,
            savedFiles,
          },
        });

        return res.json({
          enabled: dataCleaningConfig.enabled,
          filename: file.filename,
          mimeType: file.mimeType,
          bytes: file.buffer.length,
          mode: decision.mode,
          documentType: decision.documentType,
          message: decision.message,
          suggestedSteps: decision.suggestedSteps,
          savedFiles,
          text: result.text,
          stats: result.stats,
        });
      } catch (error) {
        return res.status(400).json({
          error: "Failed to clean uploaded file",
          details: getErrorMessage(error),
        });
      }
    }
  );
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

  app.post("/api/qiaoqing-assistant", async (req, res) => {
    const timer = createRequestTimer("qiaoqing.assistant");

    try {
      const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
      const conversationId =
        typeof req.body?.conversationId === "string"
          ? req.body.conversationId.trim()
          : "";
      const useKnowledgeBase = readKnowledgeBasePreference(
        req.body?.useKnowledgeBase
      );

      if (!message) {
        return res.status(400).json({ error: "Message is required" });
      }

      if (useKnowledgeBase && !isRagflowEnabled()) {
        return res.status(503).json({
          error: "知识库服务暂未启用",
          details: "请确认 RAGFLOW_ENABLED、RAGFLOW_BASE_URL、RAGFLOW_API_KEY 和 RAGFLOW_CHAT_ID 配置。",
        });
      }

      const auditUser = await readSessionAdminUser(req);
      await writeAuditLog("qiaoqing.assistant", req, {
        actorUserId: auditUser?.id ?? null,
        targetType: "question",
        targetId: "侨情助手",
        detail: {
          message,
          conversationId,
          useKnowledgeBase,
        },
      });
      timer.mark("audit recorded");

      const answer = await timed(timer, "assistant answer", () =>
        useKnowledgeBase
          ? answerAssistantWithRagflow(message, conversationId)
          : answerAssistantWithFoundation(message)
      );

      if (!answer) {
        timer.end("respond empty");
        const fallbackMessage = useKnowledgeBase
          ? "知识库暂未返回相关结果，请换个问法再试一次。"
          : "大模型暂未返回相关结果，请换个问法再试一次。";
        return res.json({
          answer: fallbackMessage,
          answerWithReferences: fallbackMessage,
          source: useKnowledgeBase ? "ragflow" : "model",
          references: [],
        });
      }

      timer.end("respond fresh");
      return res.json({
        answer: answer.clean,
        answerWithReferences: answer.withReferences,
        source: useKnowledgeBase ? "ragflow" : "model",
        references: answer.references ?? [],
      });
    } catch (error) {
      timer.end("failed");
      console.error("Qiaoqing assistant API error:", error);
      return res.status(getStatusCode(error)).json({
        error: "侨情助手暂时无法连接知识库",
        details: getErrorMessage(error),
      });
    }
  });

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
    const timer = createRequestTimer("qiaoqing.ask");
    try {
      const prompt = typeof req.body?.prompt === "string" ? req.body.prompt.trim() : "";
      const useKnowledgeBase = readKnowledgeBasePreference(
        req.body?.useKnowledgeBase
      );

      if (!prompt) {
        return res.status(400).json({ error: "Prompt is required" });
      }

      const cacheKey = getQueryCacheKey(prompt, useKnowledgeBase);
      const cachedResponse = readCachedQueryResponse(cacheKey);
      if (cachedResponse) {
        timer.mark("cache hit", {
          locations: cachedResponse.locations.length,
          source: cachedResponse.source ?? "unknown",
        });
        timer.end("respond cached");
        return res.json(cachedResponse);
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
      timer.mark("audit recorded");

      const responsePayload = await resolvePromptOptimized(
        prompt,
        useKnowledgeBase,
        timer
      );
      writeCachedQueryResponse(cacheKey, responsePayload);
      timer.mark("cache write", {
        locations: responsePayload.locations.length,
        source: responsePayload.source ?? "unknown",
      });
      timer.end("respond fresh");

      return res.json(responsePayload);
    } catch (error) {
      timer.end("failed");
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
