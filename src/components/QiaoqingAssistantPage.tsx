import { FormEvent, useMemo, useRef, useState } from 'react';
import { motion } from 'motion/react';
import {
  ArrowLeft,
  Bot,
  BrainCircuit,
  Check,
  Copy,
  Database,
  Loader2,
  MessageCircle,
  RotateCcw,
  Send,
  Share2,
  Sparkles,
  Trash2,
  UserRound,
  Volume2,
} from 'lucide-react';
import {
  askQiaoqingAssistant,
  QiaoqingAssistantReference,
} from '../lib/qiaoqingAssistantApi';

interface QiaoqingAssistantPageProps {
  onBack: () => void;
}

interface AssistantMessage {
  id: string;
  role: 'assistant' | 'user';
  content: string;
  contentWithReferences?: string;
  references?: QiaoqingAssistantReference[];
  source?: 'ragflow' | 'model';
  status?: 'ok' | 'error';
}

const starterQuestions = [
  '泉州侨批档案的历史价值是什么？',
  '泉籍华侨主要分布在哪些国家和地区？',
  '番仔楼和海外侨汇之间有什么关系？',
  '近年侨商回乡投资有哪些产业方向？',
];

function createId(prefix: string) {
  if (typeof globalThis.crypto !== 'undefined' && 'randomUUID' in globalThis.crypto) {
    return `${prefix}-${globalThis.crypto.randomUUID()}`;
  }

  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function formatReferencesForText(references?: QiaoqingAssistantReference[]) {
  if (!references?.length) return '';

  return [
    '',
    '来源引用：',
    ...references.map((reference, index) => {
      const excerpt = reference.excerpt ? ` - ${reference.excerpt}` : '';
      return `[${index + 1}] ${reference.title}${excerpt}`;
    }),
  ].join('\n');
}

export default function QiaoqingAssistantPage({ onBack }: QiaoqingAssistantPageProps) {
  const [conversationId, setConversationId] = useState(() => createId('assistant-session'));
  const [messages, setMessages] = useState<AssistantMessage[]>([
    {
      id: 'welcome',
      role: 'assistant',
      content:
        '您好，我是侨情助手。可以围绕泉州华侨华人、侨批档案、侨务治理、海外社团与产业回流等主题进行知识库问答。',
    },
  ]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isKnowledgeBaseEnabled, setIsKnowledgeBaseEnabled] = useState(true);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const latestError = useMemo(
    () => [...messages].reverse().find(message => message.status === 'error')?.content,
    [messages]
  );

  async function submitQuestion(question: string) {
    const trimmedQuestion = question.trim();
    if (!trimmedQuestion || isLoading) return;

    const userMessage: AssistantMessage = {
      id: createId('user'),
      role: 'user',
      content: trimmedQuestion,
    };

    setMessages(previous => [...previous, userMessage]);
    setInput('');
    setIsLoading(true);

    try {
      const response = await askQiaoqingAssistant(trimmedQuestion, conversationId, {
        useKnowledgeBase: isKnowledgeBaseEnabled,
      });
      const assistantMessage: AssistantMessage = {
        id: createId('assistant'),
        role: 'assistant',
        content: response.answer,
        contentWithReferences: response.answerWithReferences,
        references: response.references,
        source: response.source,
        status: 'ok',
      };
      setMessages(previous => [...previous, assistantMessage]);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : isKnowledgeBaseEnabled
          ? '知识库暂时无法返回结果，请稍后再试。'
          : '大模型暂时无法返回结果，请稍后再试。';
      setMessages(previous => [
        ...previous,
        {
          id: createId('assistant-error'),
          role: 'assistant',
          content: message,
          status: 'error',
        },
      ]);
    } finally {
      setIsLoading(false);
      inputRef.current?.focus();
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submitQuestion(input);
  }

  function handleReset() {
    window.speechSynthesis?.cancel();
    setConversationId(createId('assistant-session'));
    setInput('');
    setCopiedMessageId(null);
    setMessages([
      {
        id: 'welcome',
        role: 'assistant',
        content: `已开启新的问答会话。当前使用${isKnowledgeBaseEnabled ? '知识库' : '大模型'}模式。`,
      },
    ]);
    inputRef.current?.focus();
  }

  async function copyMessage(message: AssistantMessage) {
    const text = `${message.contentWithReferences ?? message.content}${formatReferencesForText(
      message.references
    )}`;

    try {
      await navigator.clipboard.writeText(text);
      setCopiedMessageId(message.id);
      window.setTimeout(() => {
        setCopiedMessageId(current => (current === message.id ? null : current));
      }, 1600);
    } catch (error) {
      console.error('Copy assistant answer failed:', error);
    }
  }

  function deleteMessage(messageId: string) {
    setMessages(previous => previous.filter(message => message.id !== messageId));
  }

  function playMessage(message: AssistantMessage) {
    if (!('speechSynthesis' in window)) return;

    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(message.content);
    utterance.lang = 'zh-CN';
    window.speechSynthesis.speak(utterance);
  }

  async function shareMessage(message: AssistantMessage) {
    const text = `${message.contentWithReferences ?? message.content}${formatReferencesForText(
      message.references
    )}`;

    try {
      if (navigator.share) {
        await navigator.share({
          title: '侨情助手回答',
          text,
        });
        return;
      }

      await copyMessage(message);
    } catch (error) {
      console.error('Share assistant answer failed:', error);
    }
  }

  return (
    <main className="qiaoqing-assistant-page">
      <header className="assistant-topbar">
        <button type="button" onClick={onBack}>
          <ArrowLeft />
          返回门户
        </button>
        <div>
          <span>{isKnowledgeBaseEnabled ? '知识库问答' : '大模型问答'}</span>
          <strong>侨情助手</strong>
        </div>
        <button type="button" onClick={handleReset}>
          <RotateCcw />
          新会话
        </button>
      </header>

      <section className="assistant-shell">
        <motion.aside
          className="assistant-context"
          initial={{ opacity: 0, x: -18 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.45, ease: 'easeOut' }}
        >
          <div className="assistant-title-block">
            <span>
              <Database />
              RAGFlow Knowledge Base
            </span>
            <h1>侨情助手</h1>
            <p>面向侨情资料、文化遗产、侨务治理与海外社群的互动问答工作台。</p>
          </div>

          <div className="assistant-status-panel">
            <div>
              <Sparkles />
              <span>连接模式</span>
              <strong>{isKnowledgeBaseEnabled ? '知识库' : '大模型'}</strong>
            </div>
            <div>
              <MessageCircle />
              <span>当前会话</span>
              <strong>{messages.filter(message => message.role === 'user').length} 轮提问</strong>
            </div>
          </div>

          <div className="assistant-mode-switch" role="group" aria-label="问答来源">
            <button
              type="button"
              className={isKnowledgeBaseEnabled ? 'is-active' : ''}
              aria-pressed={isKnowledgeBaseEnabled}
              disabled={isLoading}
              onClick={() => setIsKnowledgeBaseEnabled(true)}
            >
              <Database />
              知识库
            </button>
            <button
              type="button"
              className={!isKnowledgeBaseEnabled ? 'is-active' : ''}
              aria-pressed={!isKnowledgeBaseEnabled}
              disabled={isLoading}
              onClick={() => setIsKnowledgeBaseEnabled(false)}
            >
              <BrainCircuit />
              大模型
            </button>
          </div>

          {latestError ? (
            <p className="assistant-inline-alert">{latestError}</p>
          ) : (
            <p className="assistant-inline-note">
              {isKnowledgeBaseEnabled
                ? '默认使用知识库回答，关闭开关后将直接调用大模型进行问答。'
                : '当前已切换为大模型回答，不会检索知识库。'}
            </p>
          )}
        </motion.aside>

        <motion.section
          className="assistant-chat-panel"
          initial={{ opacity: 0, y: 18 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.08, duration: 0.45, ease: 'easeOut' }}
        >
          <div className="assistant-messages" aria-live="polite">
            {messages.map(message => (
              <article
                key={message.id}
                className={`assistant-message is-${message.role} ${
                  message.status === 'error' ? 'is-error' : ''
                }`}
              >
                <span className="assistant-avatar" aria-hidden="true">
                  {message.role === 'assistant' ? <Bot /> : <UserRound />}
                </span>
                <div>
                  <strong>
                    {message.role === 'assistant'
                      ? `侨情助手${
                          message.source === 'model'
                            ? ' · 大模型'
                            : message.source === 'ragflow'
                              ? ' · 知识库'
                              : ''
                        }`
                      : '我的问题'}
                  </strong>
                  <p>{message.content}</p>
                  {message.contentWithReferences &&
                    message.contentWithReferences !== message.content && (
                      <details>
                        <summary>查看含引用原文</summary>
                        <p>{message.contentWithReferences}</p>
                      </details>
                    )}
                  {message.source === 'ragflow' && Boolean(message.references?.length) && (
                    <section className="assistant-references" aria-label="来源引用">
                      <strong>来源引用</strong>
                      <ol>
                        {message.references?.map((reference, index) => (
                          <li key={`${reference.title}-${reference.id ?? index}`}>
                            <span>{index + 1}</span>
                            <div>
                              <b>{reference.title}</b>
                              {typeof reference.score === 'number' && (
                                <small>匹配度 {Math.round(reference.score * 100)}%</small>
                              )}
                              {reference.excerpt && <p>{reference.excerpt}</p>}
                            </div>
                          </li>
                        ))}
                      </ol>
                    </section>
                  )}
                  {message.role === 'assistant' && (
                    <div className="assistant-message-actions" aria-label="回答操作">
                      <button
                        type="button"
                        onClick={() => void copyMessage(message)}
                        title="复制回答"
                        aria-label="复制回答"
                      >
                        {copiedMessageId === message.id ? <Check /> : <Copy />}
                      </button>
                      <button
                        type="button"
                        onClick={() => deleteMessage(message.id)}
                        title="删除回答"
                        aria-label="删除回答"
                      >
                        <Trash2 />
                      </button>
                      <button
                        type="button"
                        onClick={() => playMessage(message)}
                        title="播放回答"
                        aria-label="播放回答"
                      >
                        <Volume2 />
                      </button>
                      <button
                        type="button"
                        onClick={() => void shareMessage(message)}
                        title="分享回答"
                        aria-label="分享回答"
                      >
                        <Share2 />
                      </button>
                    </div>
                  )}
                </div>
              </article>
            ))}

            {isLoading && (
              <article className="assistant-message is-assistant">
                <span className="assistant-avatar" aria-hidden="true">
                  <Bot />
                </span>
                <div>
                  <strong>侨情助手</strong>
                  <p className="assistant-thinking">
                    <Loader2 />
                    {isKnowledgeBaseEnabled ? '正在检索知识库并整理回答' : '正在调用大模型并整理回答'}
                  </p>
                </div>
              </article>
            )}
          </div>

          <div className="assistant-starters">
            {starterQuestions.map(question => (
              <button
                key={question}
                type="button"
                disabled={isLoading}
                onClick={() => void submitQuestion(question)}
              >
                {question}
              </button>
            ))}
          </div>

          <form className="assistant-composer" onSubmit={handleSubmit}>
            <textarea
              ref={inputRef}
              value={input}
              rows={3}
              disabled={isLoading}
              placeholder="请输入侨情相关问题，例如：泉州侨批如何体现海外华侨与家乡的联系？"
              onChange={event => setInput(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                  event.preventDefault();
                  void submitQuestion(input);
                }
              }}
            />
            <button type="submit" disabled={!input.trim() || isLoading}>
              {isLoading ? <Loader2 /> : <Send />}
              发送
            </button>
          </form>
        </motion.section>
      </section>
    </main>
  );
}
