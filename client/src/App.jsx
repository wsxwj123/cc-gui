import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useStore } from './stores/sessionStore.js';
import { useWebSocket } from './hooks/useWebSocket.js';
import { MessageBubble } from './components/MessageBubble.jsx';
import { TurnBubble } from './components/TurnBubble.jsx';
import { ChatInput } from './components/ChatInput.jsx';
import { ModelBadge } from './components/ModelBadge.jsx';
import { UsagePanel } from './components/UsagePanel.jsx';
import { ProcessPanel } from './components/ProcessPanel.jsx';
import { SettingsPanel } from './components/SettingsPanel.jsx';
import { MCPPanel } from './components/MCPPanel.jsx';
import { FileChangesPanel } from './components/FileChangesPanel.jsx';
import {
  FolderOpen, MessageSquare, ChevronLeft, ChevronRight, ChevronDown,
  Search, Hash, Layers, BarChart3, ArrowLeft, Plus,
  RefreshCw, Activity, Settings, Server, GitBranch, FileDiff, Check, Wrench, X
} from 'lucide-react';

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const diff = now - d;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
  if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前';
  if (diff < 86400000 * 7) return Math.floor(diff / 86400000) + ' 天前';
  return d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
}

function formatPath(path) {
  if (!path) return '';
  return path.replace(/^\/Users\/[^/]+/, '~');
}

function formatPathShort(path) {
  if (!path) return '';
  const parts = formatPath(path).split('/').filter(Boolean);
  return parts[parts.length - 1] || path;
}

// ─── Right Panel (overlay) ────────────────────────────────────
const PANEL_MAP = {
  usage: { label: '用量统计', icon: BarChart3, component: UsagePanel },
  processes: { label: '进程管理', icon: Activity, component: ProcessPanel },
  mcp: { label: 'MCP 服务器', icon: Server, component: MCPPanel },
  settings: { label: '设置', icon: Settings, component: SettingsPanel },
};

function RightPanel({ panelId, onClose }) {
  if (!panelId || !PANEL_MAP[panelId]) return null;
  const { label, icon: Icon, component: PanelComponent } = PANEL_MAP[panelId];

  return (
    <div className="w-[320px] border-l border-canvas-deep bg-canvas shrink-0 flex flex-col animate-fade-in">
      <div className="flex items-center justify-between px-4 py-3 border-b border-canvas-deep shrink-0">
        <div className="flex items-center gap-2">
          <Icon size={14} className="text-accent" />
          <span className="text-sm font-medium text-ink font-body">{label}</span>
        </div>
        <button onClick={onClose} className="p-1 hover:bg-canvas-warm rounded transition-colors">
          <X size={14} className="text-ink-faint" />
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-hidden">
        <PanelComponent />
      </div>
    </div>
  );
}

// ─── Project List ──────────────────────────────────────────────
function ProjectList() {
  const { projects, selectedProject, setSelectedProject, fetchProjects, fetchSessions, searchQuery, setSearchQuery } = useStore();

  useEffect(() => { fetchProjects(); }, []);

  const filtered = projects.filter((p) =>
    p.path.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 pt-4 pb-3">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-[11px] font-medium uppercase tracking-widest text-ink-faint font-body">
            项目
          </h2>
          <button
            onClick={() => {
              const path = prompt('输入项目路径（如 ~/Desktop/my-project）');
              if (path) {
                fetch('/api/settings', {
                  method: 'PUT',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ _addProject: path }),
                }).then(() => fetchProjects());
              }
            }}
            className="p-1 hover:bg-canvas-warm rounded transition-colors"
            title="添加项目"
          >
            <Plus size={14} className="text-ink-faint hover:text-accent" />
          </button>
        </div>
        <div className="relative">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-ghost" />
          <input
            type="text"
            placeholder="搜索..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full bg-canvas border border-canvas-sunken rounded-lg pl-8 pr-3 py-1.5 text-xs text-ink placeholder-ink-ghost focus:outline-none focus:border-accent/40 font-body"
          />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-2 stagger">
        {filtered.map((project) => (
          <button
            key={project.hash}
            onClick={() => {
              setSelectedProject(project);
              fetchSessions(project.hash);
            }}
            className={`sidebar-item w-full text-left px-3 py-2.5 rounded-lg mb-0.5 transition-all animate-slide-in ${
              selectedProject?.hash === project.hash
                ? 'active bg-canvas-warm'
                : 'hover:bg-canvas-warm/60'
            }`}
          >
            <div className="flex items-center gap-2">
              <FolderOpen size={13} className="text-warning/70 shrink-0" />
              <span className="text-[13px] text-ink-soft truncate font-body font-medium">
                {formatPathShort(project.path)}
              </span>
            </div>
            <div className="flex items-center gap-3 mt-0.5 ml-[21px]">
              <span className="text-[10px] text-ink-faint font-mono">
                {project.sessionCount} 会话
              </span>
              <span className="text-[10px] text-ink-ghost">
                {formatDate(project.lastActivity)}
              </span>
            </div>
          </button>
        ))}
        {filtered.length === 0 && (
          <div className="px-4 py-8 text-center">
            <p className="text-xs text-ink-faint font-body">
              {searchQuery ? '没有匹配的项目' : '没有找到项目'}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Session List ──────────────────────────────────────────────
function SessionItem({ session, isSelected, onSelect, onFork, forking }) {
  const [expanded, setExpanded] = useState(false);
  const hasSubagents = session.subagents?.length > 0;

  return (
    <div className="relative group">
      <button
        onClick={() => onSelect(session)}
        className={`sidebar-item w-full text-left px-3 py-3 rounded-lg mb-0.5 transition-all ${
          isSelected ? 'active bg-canvas-warm' : 'hover:bg-canvas-warm/60'
        }`}
      >
        <div className="flex items-start gap-2">
          {hasSubagents ? (
            <button
              onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
              className="shrink-0 mt-0.5 p-0.5 hover:bg-canvas-deep rounded"
            >
              <ChevronRight size={12} className={`text-ink-faint transition-transform ${expanded ? 'rotate-90' : ''}`} />
            </button>
          ) : (
            <MessageSquare size={13} className="text-accent/40 shrink-0 mt-0.5" />
          )}
          <div className="min-w-0 flex-1">
            <div className="text-[13px] text-ink-soft line-clamp-2 font-body leading-snug">
              {session.firstPrompt || '(空会话)'}
            </div>
            <div className="flex items-center gap-2 mt-1.5">
              {session.model && <ModelBadge model={session.model} compact />}
              <span className="text-[10px] text-ink-faint font-mono">{session.messageCount}</span>
              {hasSubagents && (
                <span className="text-[10px] text-accent/60 font-mono">+{session.subagents.length} 子任务</span>
              )}
              <span className="text-[10px] text-ink-ghost">{formatDate(session.lastActivity)}</span>
            </div>
          </div>
        </div>
      </button>
      <button
        onClick={(e) => { e.stopPropagation(); onFork(session); }}
        disabled={forking}
        className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity p-1 hover:bg-canvas-deep rounded"
        title="分叉会话"
      >
        <GitBranch size={12} className={forking ? 'text-accent animate-spin' : 'text-ink-faint'} />
      </button>
      {expanded && hasSubagents && (
        <div className="ml-5 pl-2 border-l border-canvas-deep space-y-0.5 mb-1">
          {session.subagents.map((sub) => (
            <button
              key={sub.sessionId}
              onClick={() => onSelect(sub)}
              className={`w-full text-left px-2.5 py-2 rounded-md transition-colors text-[11px] ${
                isSelected ? 'bg-accent-subtle/30' : 'hover:bg-canvas-warm/40'
              }`}
            >
              <div className="flex items-center gap-1.5">
                <Wrench size={10} className="text-ink-ghost shrink-0" />
                <span className="text-ink-muted font-body truncate flex-1">{sub.firstPrompt || '子任务'}</span>
                <span className="text-[9px] text-ink-ghost font-mono shrink-0">{sub.messageCount}</span>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function SessionList() {
  const { sessions, selectedSession, setSelectedSession, fetchMessages, selectedProject } = useStore();
  const [forking, setForking] = useState(null);

  const handleFork = async (session) => {
    setForking(session.sessionId);
    try {
      await fetch('/api/fork', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: session.sessionId, projectHash: session.projectHash }),
      });
      if (selectedProject) {
        setTimeout(() => useStore.getState().fetchSessions(selectedProject.hash), 2000);
      }
    } catch (err) { console.error('Fork failed:', err); }
    setForking(null);
  };

  const handleSelect = (session) => {
    setSelectedSession(session);
    fetchMessages(session.sessionId, session.projectHash);
  };

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 pt-4 pb-3 border-b border-canvas-deep">
        <div className="flex items-center gap-2 mb-1">
          <button onClick={() => useStore.getState().setSelectedProject(null)} className="p-0.5 hover:bg-canvas-deep rounded transition-colors">
            <ArrowLeft size={14} className="text-ink-faint" />
          </button>
          <h2 className="text-[11px] font-medium uppercase tracking-widest text-ink-faint font-body">会话</h2>
          <span className="text-[10px] text-ink-ghost font-mono">{sessions.length}</span>
        </div>
        <p className="text-xs text-ink-muted font-body truncate ml-6">{formatPath(selectedProject?.path)}</p>
      </div>
      <div className="flex-1 overflow-y-auto px-2 stagger">
        {sessions.map((session) => (
          <SessionItem
            key={session.sessionId}
            session={session}
            isSelected={selectedSession?.sessionId === session.sessionId}
            onSelect={handleSelect}
            onFork={handleFork}
            forking={forking === session.sessionId}
          />
        ))}
        {sessions.length === 0 && (
          <div className="px-4 py-8 text-center">
            <p className="text-xs text-ink-faint font-body">该项目没有会话</p>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Empty State ───────────────────────────────────────────────
function EmptyState() {
  return (
    <div className="flex-1 flex items-center justify-center bg-canvas grain relative">
      <div className="text-center animate-fade-up relative z-10">
        <div className="w-16 h-16 rounded-2xl bg-canvas-warm border border-canvas-deep flex items-center justify-center mx-auto mb-5">
          <Layers size={28} className="text-ink-ghost" />
        </div>
        <h3 className="text-lg font-display font-medium text-ink-soft mb-1">选择一个会话</h3>
        <p className="text-sm text-ink-faint font-body">从左侧项目列表开始浏览历史记录</p>
      </div>
    </div>
  );
}

// ─── Session Detail ────────────────────────────────────────────
function SessionDetail() {
  const { messages, selectedSession, selectedProject, loading } = useStore();
  const messagesEndRef = useRef(null);
  const containerRef = useRef(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [chatMessages, setChatMessages] = useState([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [streamingModel, setStreamingModel] = useState(null);
  const [streamingToolCalls, setStreamingToolCalls] = useState([]);
  const [showFileChanges, setShowFileChanges] = useState(false);
  const activeProcRef = useRef(null);
  const abortRef = useRef(null);

  useEffect(() => {
    if (autoScroll && messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, chatMessages, streamingText, autoScroll]);

  const handleScroll = () => {
    if (!containerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    setAutoScroll(scrollHeight - scrollTop - clientHeight < 120);
  };

  const handleSend = useCallback(async (prompt) => {
    setIsStreaming(true);
    setStreamingText('');
    setStreamingToolCalls([]);
    setChatMessages((prev) => [...prev, {
      uuid: 'chat-user-' + Date.now(), type: 'user',
      timestamp: new Date().toISOString(), text: prompt,
    }]);

    try {
      const currentModel = useStore.getState().currentModel;
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt, sessionId: selectedSession?.sessionId,
          cwd: selectedProject?.path || process.env.HOME, model: currentModel,
        }),
      });
      const { pid, model } = await res.json();
      activeProcRef.current = pid;
      setStreamingModel(model);

      const controller = new AbortController();
      abortRef.current = controller;
      const streamRes = await fetch(`/api/chat/${pid}/stream`, { signal: controller.signal });
      const reader = streamRes.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '', accumulatedText = '', currentToolCalls = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const event = JSON.parse(line.slice(6));
            if (event.type === 'assistant' && event.message?.content) {
              for (const block of event.message.content) {
                if (block.type === 'text') { accumulatedText += block.text; setStreamingText(accumulatedText); }
                if (block.type === 'tool_use') {
                  currentToolCalls.push({ id: block.id, name: block.name, input: block.input, result: null });
                  setStreamingToolCalls([...currentToolCalls]);
                }
              }
              if (event.message.model) setStreamingModel(event.message.model);
            }
            if (event.type === 'user' && event.message?.content) {
              for (const block of event.message.content) {
                if (block.type === 'tool_result') {
                  const idx = currentToolCalls.findIndex((tc) => tc.id === block.tool_use_id);
                  if (idx !== -1) {
                    currentToolCalls[idx] = { ...currentToolCalls[idx], result: {
                      toolUseId: block.tool_use_id,
                      content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
                      isError: block.is_error || false,
                    }};
                    setStreamingToolCalls([...currentToolCalls]);
                  }
                }
              }
            }
            if (event.type === 'done') break;
          } catch {}
        }
      }

      if (accumulatedText || currentToolCalls.length > 0) {
        setChatMessages((prev) => [...prev, {
          uuid: 'chat-assistant-' + Date.now(), type: 'turn',
          timestamp: new Date().toISOString(), model: streamingModel,
          text: accumulatedText ? [accumulatedText] : [], thinking: [],
          toolCalls: currentToolCalls.map((tc) => ({ ...tc, category: tc.category || 'call' })),
          usage: null,
        }]);
      }
    } catch (err) {
      if (err.name !== 'AbortError') console.error('Chat error:', err);
    } finally {
      setIsStreaming(false); setStreamingText(''); setStreamingToolCalls([]);
      activeProcRef.current = null; abortRef.current = null;
    }
  }, [selectedSession, selectedProject, streamingModel]);

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
    if (activeProcRef.current) fetch(`/api/chat/${activeProcRef.current}/stop`, { method: 'POST' });
  }, []);

  useEffect(() => {
    setChatMessages([]); setStreamingText(''); setStreamingToolCalls([]); setShowFileChanges(false);
  }, [selectedSession?.sessionId]);

  if (!selectedSession) return <EmptyState />;
  if (loading) return (
    <div className="flex-1 flex items-center justify-center bg-canvas">
      <div className="flex gap-1.5">
        {[0, 0.2, 0.4].map((d) => (
          <div key={d} className="w-2 h-2 rounded-full bg-accent/40" style={{ animation: `breathe 1.4s ease-in-out infinite ${d}s` }} />
        ))}
      </div>
    </div>
  );

  const allMessages = [...messages, ...chatMessages];
  const totalTokens = allMessages.reduce((acc, m) => {
    if (m.usage) { acc.input += m.usage.input_tokens || 0; acc.output += m.usage.output_tokens || 0; acc.cacheRead += m.usage.cache_read_input_tokens || 0; }
    return acc;
  }, { input: 0, output: 0, cacheRead: 0 });
  const toolCallCount = allMessages.reduce((acc, m) => acc + (m.toolCalls?.length || 0), 0);
  const models = [...new Set(allMessages.filter((m) => m.model).map((m) => m.model))];

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-canvas grain relative">
      <div className="shrink-0 px-6 py-3 border-b border-canvas-deep bg-canvas/80 backdrop-blur-sm relative z-10">
        <div className="max-w-3xl mx-auto flex items-center justify-between">
          <div className="min-w-0">
            <div className="text-sm text-ink font-display font-medium truncate">
              {selectedSession.firstPrompt?.slice(0, 80) || '会话详情'}
            </div>
            <div className="flex items-center gap-3 mt-0.5">
              <span className="text-[10px] text-ink-faint font-mono flex items-center gap-1">
                <Hash size={10} />{selectedSession.sessionId.slice(0, 8)}
              </span>
              <span className="text-[10px] text-ink-faint font-mono">{messages.length + chatMessages.length} 条消息</span>
              {toolCallCount > 0 && <span className="text-[10px] text-ink-faint font-mono">{toolCallCount} 工具调用</span>}
              <div className="flex gap-1">{models.map((m) => <ModelBadge key={m} model={m} compact />)}</div>
            </div>
          </div>
          <div className="flex items-center gap-3 shrink-0 ml-4">
            <button
              onClick={() => setShowFileChanges(!showFileChanges)}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-body transition-colors ${
                showFileChanges ? 'bg-accent/10 text-accent' : 'bg-canvas-warm text-ink-faint hover:text-ink-muted'
              }`}
              title="文件变更"
            >
              <FileDiff size={12} />变更
            </button>
            <div className="text-right">
              <div className="text-[10px] text-ink-faint font-mono flex items-center gap-1">
                <BarChart3 size={10} />{(totalTokens.input + totalTokens.output).toLocaleString()} tokens
              </div>
              {totalTokens.cacheRead > 0 && (
                <div className="text-[10px] text-ink-ghost font-mono">缓存命中 {totalTokens.cacheRead.toLocaleString()}</div>
              )}
            </div>
          </div>
        </div>
      </div>

      {showFileChanges ? (
        <div className="flex-1 overflow-y-auto relative z-10 px-6 py-4">
          <div className="max-w-3xl mx-auto">
            <h3 className="text-sm font-display font-medium text-ink mb-4">文件变更记录</h3>
            <FileChangesPanel sessionId={selectedSession.sessionId} projectHash={selectedSession.projectHash} />
          </div>
        </div>
      ) : (
        <div ref={containerRef} onScroll={handleScroll} className="flex-1 overflow-y-auto relative z-10">
          {messages.length === 0 && chatMessages.length === 0 ? (
            <div className="flex items-center justify-center h-full text-ink-faint text-sm font-body">该会话没有可显示的消息</div>
          ) : (
            <>
              {messages.map((msg, i) => msg.type === 'turn'
                ? <TurnBubble key={msg.uuid || i} turn={msg} />
                : <MessageBubble key={msg.uuid || i} message={{ ...msg, role: msg.type }} />
              )}
              {chatMessages.map((msg, i) => msg.type === 'turn'
                ? <TurnBubble key={msg.uuid || i} turn={msg} />
                : <MessageBubble key={msg.uuid || i} message={{ ...msg, role: msg.type }} />
              )}
              {isStreaming && (streamingText || streamingToolCalls.length > 0) && (
                <TurnBubble turn={{
                  uuid: 'streaming', type: 'turn', timestamp: new Date().toISOString(), model: streamingModel,
                  text: streamingText ? [streamingText] : [], thinking: [],
                  toolCalls: streamingToolCalls.map((tc) => ({ ...tc, category: 'call' })), usage: null,
                }} />
              )}
              {isStreaming && !streamingText && streamingToolCalls.length === 0 && (
                <div className="px-6 py-4 bg-canvas-warm animate-fade-in">
                  <div className="max-w-3xl mx-auto flex gap-4">
                    <div className="w-7 h-7 rounded-full bg-accent-subtle flex items-center justify-center shrink-0">
                      <RefreshCw size={14} className="text-accent animate-spin" />
                    </div>
                    <div className="flex items-center gap-1.5 pt-1">
                      {[0, 0.2, 0.4].map((d) => (
                        <div key={d} className="w-2 h-2 rounded-full bg-accent/40" style={{ animation: `breathe 1.4s ease-in-out infinite ${d}s` }} />
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
          <div ref={messagesEndRef} />
        </div>
      )}

      {!autoScroll && !showFileChanges && (
        <div className="absolute bottom-24 right-6 z-20">
          <button onClick={() => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }); setAutoScroll(true); }}
            className="bg-canvas border border-canvas-deep hover:bg-canvas-warm rounded-full p-2 shadow-sm transition-colors">
            <ChevronRight size={14} className="text-ink-muted rotate-90" />
          </button>
        </div>
      )}

      <ChatInput onSend={handleSend} onStop={handleStop} disabled={false} isStreaming={isStreaming} />
    </div>
  );
}

// ─── Model Selector (compact, for chat input area) ─────────────
export function ModelSelector({ compact = false }) {
  const { currentModel, availableModels, setModel } = useStore();
  const [open, setOpen] = useState(false);
  const [customInput, setCustomInput] = useState('');
  const [provider, setProvider] = useState('');

  useEffect(() => {
    fetch('/api/model').then(r => r.json()).then(data => {
      setProvider(data.provider || '');
      if (data.model) setModel(data.model);
      if (data.available) useStore.setState({ availableModels: data.available });
    }).catch(() => {});
  }, []);

  const handleCustomSubmit = () => {
    const id = customInput.trim();
    if (id) { setModel(id); setCustomInput(''); setOpen(false); }
  };

  if (!currentModel) return null;

  return (
    <div className="relative">
      <button onClick={() => setOpen(!open)}
        className={`flex items-center gap-1 px-2 py-1 rounded-md hover:bg-canvas-deep transition-colors ${compact ? '' : 'px-2.5'}`}>
        <ModelBadge model={currentModel} compact={compact} />
        {provider && !compact && (
          <span className="text-[9px] px-1 py-0.5 bg-canvas-deep text-ink-faint rounded font-mono">{provider}</span>
        )}
        <ChevronDown size={10} className="text-ink-faint" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute left-0 bottom-full mb-1 w-72 bg-canvas border border-canvas-deep rounded-lg shadow-lg z-50 py-1 animate-fade-in">
            <div className="px-3 py-1.5 text-[10px] text-ink-faint uppercase tracking-wider font-body flex items-center justify-between">
              <span>选择模型</span>
              {provider && <span className="text-ink-ghost normal-case">{provider}</span>}
            </div>
            {availableModels.map((m) => (
              <button key={m.id} onClick={() => { setModel(m.id); setOpen(false); }}
                className={`w-full text-left px-3 py-2 hover:bg-canvas-warm transition-colors flex items-center gap-2 ${
                  currentModel === m.id ? 'bg-accent-subtle/50' : ''}`}>
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-medium text-ink font-body">{m.name}</div>
                  <div className="text-[10px] text-ink-faint font-mono truncate">{m.id}</div>
                </div>
                <span className="text-[9px] px-1.5 py-0.5 bg-canvas-deep text-ink-faint rounded font-mono shrink-0">{m.tier}</span>
                {currentModel === m.id && <Check size={12} className="text-accent shrink-0" />}
              </button>
            ))}
            <div className="border-t border-canvas-deep mt-1 pt-1 px-3 pb-2">
              <div className="text-[10px] text-ink-faint mb-1 font-body">自定义模型 ID</div>
              <div className="flex gap-1.5">
                <input type="text" value={customInput} onChange={e => setCustomInput(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleCustomSubmit()}
                  placeholder="输入模型 ID..."
                  className="flex-1 bg-canvas-warm border border-canvas-deep rounded px-2 py-1 text-xs font-mono text-ink focus:outline-none focus:border-accent/40" />
                <button onClick={handleCustomSubmit} disabled={!customInput.trim()}
                  className="px-2 py-1 text-[10px] bg-accent text-white rounded hover:bg-accent-hover disabled:bg-canvas-deep disabled:text-ink-ghost transition-colors">
                  应用
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Main App ──────────────────────────────────────────────────
export default function App() {
  useWebSocket();
  const { sidebarCollapsed, toggleSidebar, selectedProject, selectedSession } = useStore();
  const [rightPanel, setRightPanel] = useState(null);

  return (
    <div className="h-screen flex flex-col bg-canvas">
      {/* Top bar */}
      <header className="h-11 px-4 flex items-center justify-between border-b border-canvas-deep bg-canvas shrink-0 relative z-20">
        <div className="flex items-center gap-2">
          <button onClick={toggleSidebar} className="p-1.5 hover:bg-canvas-warm rounded-lg transition-colors" title={sidebarCollapsed ? '展开' : '收起'}>
            {sidebarCollapsed ? <ChevronRight size={15} className="text-ink-faint" /> : <ChevronLeft size={15} className="text-ink-faint" />}
          </button>
          <span className="text-sm font-display font-semibold text-ink tracking-tight">Claude Code</span>
          {selectedProject && (
            <span className="text-[10px] text-ink-faint font-mono bg-canvas-warm px-1.5 py-0.5 rounded truncate max-w-[180px]">
              {formatPathShort(selectedProject.path)}
            </span>
          )}
          {selectedSession && (
            <>
              <span className="text-ink-ghost">/</span>
              <span className="text-[10px] text-ink-muted font-body truncate max-w-[200px]">
                {selectedSession.firstPrompt?.slice(0, 30) || selectedSession.sessionId.slice(0, 8)}
              </span>
            </>
          )}
        </div>
        <div className="flex items-center gap-0.5">
          {Object.entries(PANEL_MAP).map(([id, { icon: Icon, label }]) => (
            <button key={id} onClick={() => setRightPanel(rightPanel === id ? null : id)}
              className={`p-2 rounded-lg transition-colors ${rightPanel === id ? 'bg-accent-subtle text-accent' : 'text-ink-faint hover:text-ink-muted hover:bg-canvas-warm'}`}
              title={label}>
              <Icon size={15} />
            </button>
          ))}
        </div>
      </header>

      {/* Main content */}
      <div className="flex-1 flex min-h-0">
        {!sidebarCollapsed && (
          <div className="w-[260px] border-r border-canvas-deep bg-canvas shrink-0 flex flex-col">
            <div className="flex-1 min-h-0 overflow-hidden">
              {selectedProject ? <SessionList /> : <ProjectList />}
            </div>
          </div>
        )}
        <div className="flex-1 flex flex-col min-w-0 relative">
          <SessionDetail />
        </div>
        {rightPanel && <RightPanel panelId={rightPanel} onClose={() => setRightPanel(null)} />}
      </div>
    </div>
  );
}
