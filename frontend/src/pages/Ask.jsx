import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { Coffee, Send, Database, ExternalLink, Lightbulb, Search, Sparkles, Copy, Trash2, RotateCcw, Square, Pencil, Plus, MessageSquare } from 'lucide-react';
import { aiApi, describeAi, describeApiError } from '../lib/api';
import { LoadingDots } from '../components/Loading';
import AnswerMarkdown from '../components/AnswerMarkdown';
import StarryBackground from '../components/StarryBackground';
import { loadBaristaConversations, saveBaristaConversations, newBaristaConversation } from '../lib/baristaConversations';

export default function Ask() {
  const [query, setQuery] = useState('');
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(false);
  const [suggestions, setSuggestions] = useState([]);
  const [status, setStatus] = useState(null);
  const [copied, setCopied] = useState(null);
  const [conversations, setConversations] = useState([]);
  const [activeConversation, setActiveConversation] = useState(null);
  const [editingIndex, setEditingIndex] = useState(null);
  const messagesEndRef = useRef(null);
  const abortRef = useRef(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    const saved = loadBaristaConversations();
    const current = saved[0] || newBaristaConversation();
    setConversations(saved.length ? saved : [current]);
    setActiveConversation(current.id);
    setMessages(current.messages.map((m) => ({ ...m, timestamp: new Date(m.timestamp) })));
  }, []);

  useEffect(() => {
    if (!activeConversation) return;
    setConversations(prev => {
      const next = prev.map(c => c.id === activeConversation
        ? { ...c, messages, title: c.title === 'New conversation' ? messages.find(m => m.role === 'user')?.content?.slice(0, 48) || c.title : c.title, updatedAt: Date.now() }
        : c);
      saveBaristaConversations(next);
      return next;
    });
  }, [messages, activeConversation]);

  const clearConversation = () => {
    setMessages([]);
    setEditingIndex(null);
  };

  const startConversation = () => {
    if (loading) return;
    const next = newBaristaConversation();
    setConversations(prev => { const updated = [next, ...prev]; saveBaristaConversations(updated); return updated; });
    setActiveConversation(next.id);
    setMessages([]);
  };

  const switchConversation = (id) => {
    if (loading || id === activeConversation) return;
    const selected = conversations.find(c => c.id === id);
    if (!selected) return;
    setActiveConversation(id);
    setMessages(selected.messages.map(m => ({ ...m, timestamp: new Date(m.timestamp) })));
    setEditingIndex(null);
  };

  const copyAnswer = async (content, index) => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(index);
      setTimeout(() => setCopied((current) => current === index ? null : current), 1500);
    } catch { /* clipboard permissions are optional */ }
  };

  useEffect(() => {
    aiApi.suggestions().then(d => setSuggestions(d.suggestions || [])).catch(() => {});
    aiApi.status().then(setStatus).catch(() => {});
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleAsk = async (q, { regenerate = false, editIndex = null } = {}) => {
    const question = q || query;
    if (!question.trim() || loading) return;

    const userMessage = { role: 'user', content: question, timestamp: new Date() };
    const baseMessages = regenerate ? messages.slice(0, -1) : editIndex !== null ? messages.slice(0, editIndex) : messages;
    setMessages([...baseMessages, userMessage]);
    setQuery('');
    setEditingIndex(null);
    setLoading(true);
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      // Send the conversation, not just the latest line: a follow-up like
      // "does that work on my pc?" is meaningless without the turns above it.
      let streamed = '';
      let finalResult = null;
      let streamError = null;
      await aiApi.askStream(question, [...baseMessages, userMessage], {
        signal: controller.signal,
        onToken: (token) => {
          streamed += token;
          setMessages(prev => [...prev.filter(m => !m.streaming), { role: 'assistant', content: streamed, streaming: true, timestamp: new Date() }]);
        },
        onDone: (result) => { finalResult = result; },
        onError: (error) => { streamError = error; },
      });
      if (streamError) throw Object.assign(new Error(streamError.error || 'AI stream failed'), { code: 'STREAM_FAILED' });
      const result = finalResult || { answer: streamed };
      setMessages(prev => [...prev.filter(m => !m.streaming), { role: 'assistant', content: result.answer || streamed, sources: result.sources || [], relatedItems: result.relatedItems || [], usedAI: result.usedAI, provider: result.provider || null, metadata: result.metadata, timestamp: new Date() }]);
    } catch (e) {
      if (controller.signal.aborted || e.code === 'ERR_CANCELED') {
        setMessages(prev => prev
          .map(m => m.streaming ? { ...m, streaming: false, partial: true } : m)
          .filter((m, index, all) => !(index === all.length - 1 && m.role === 'user')));
        return;
      }
      setMessages(prev => [...prev.map(m => m.streaming ? { ...m, streaming: false, partial: true } : m), {
        role: 'assistant', content: describeApiError(e), error: true, timestamp: new Date(),
      }]);
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setLoading(false);
    }
  };

  const stopGenerating = () => abortRef.current?.abort();
  const editMessage = (index) => {
    if (loading) return;
    setEditingIndex(index);
    setQuery(messages[index].content);
  };

  const handleKeyPress = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleAsk(undefined, editingIndex === null ? {} : { editIndex: editingIndex });
    }
  };

  const ai = describeAi(status);

  return (
    <div className="relative min-h-dvh">
      <StarryBackground />
      
      <div className="relative max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="text-center mb-8">
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-gradient-subtle border border-purple-500/20 text-sm mb-4 backdrop-blur-sm">
            <Coffee className="w-4 h-4 text-primary" />
            <span className="text-textSecondary font-medium">Barista • {ai.headline}</span>
            {status && (
              <span className={`ml-2 w-2 h-2 rounded-full ${ai.ready ? 'bg-green-400' : 'bg-amber-400'}`} title={ai.blurb} />
            )}
          </div>
          
          <h1 className="text-4xl font-bold tracking-tight mb-3">
            Meet <span className="gradient-text">Barista</span>
          </h1>
          <p className="text-textSecondary max-w-2xl mx-auto">
            Your personal file finder barista — purpose-built to easily find files in espress0's repo. Searches encrypted metadata first, never hallucinates.
          </p>
          <p className="text-xs text-textMuted mt-2">Named Barista — like a coffee barista, but for ISOs, tools, and docs</p>
        </div>

        <div className="glass rounded-2xl border border-white/5 p-5 mb-8 backdrop-blur-md">
          <div className="grid md:grid-cols-3 gap-4 text-sm">
            <div className="flex gap-3">
              <div className="w-8 h-8 rounded-xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center flex-shrink-0">
                <Database className="w-4 h-4 text-blue-400" />
              </div>
              <div>
                <div className="font-medium text-textPrimary">Finds Files Fast</div>
                <div className="text-xs text-textMuted mt-1">Purpose: easily find files via metadata</div>
              </div>
            </div>
            <div className="flex gap-3">
              <div className="w-8 h-8 rounded-xl bg-purple-500/10 border border-purple-500/20 flex items-center justify-center flex-shrink-0">
                <Coffee className="w-4 h-4 text-purple-400" />
              </div>
              <div>
                <div className="font-medium text-textPrimary">Barista • {ai.headline}</div>
                <div className="text-xs text-textMuted mt-1">{ai.badge}</div>
              </div>
            </div>
            <div className="flex gap-3">
              <div className="w-8 h-8 rounded-xl bg-green-500/10 border border-green-500/20 flex items-center justify-center flex-shrink-0">
                <Sparkles className="w-4 h-4 text-green-400" />
              </div>
              <div>
                <div className="font-medium text-textPrimary">No Hallucinations</div>
                <div className="text-xs text-textMuted mt-1">Only links to verified repo items</div>
              </div>
            </div>
          </div>
        </div>

        <div className="glass rounded-3xl border border-white/5 overflow-hidden flex flex-col backdrop-blur-xl" style={{ minHeight: '500px', maxHeight: '700px' }}>
          <div className="flex items-center justify-between px-5 py-3 border-b border-white/5 bg-surface/30">
            <div className="flex items-center gap-2">
              <MessageSquare className="w-3.5 h-3.5 text-primary" />
              <select value={activeConversation || ''} onChange={(e) => switchConversation(e.target.value)} disabled={loading} className="bg-transparent text-xs text-textMuted focus:outline-none max-w-[180px]">
                {conversations.map(c => <option key={c.id} value={c.id}>{c.title}</option>)}
              </select>
            </div>
            <div className="flex items-center gap-2">
            <button type="button" onClick={startConversation} disabled={loading} className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs text-textMuted hover:text-textPrimary disabled:opacity-40" title="New conversation">
              <Plus className="w-3.5 h-3.5" /> New
            </button>
            <button type="button" onClick={clearConversation} disabled={!messages.length || loading} className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs text-textMuted hover:text-red-300 hover:bg-red-500/10 disabled:opacity-40" title="Clear conversation">
              <Trash2 className="w-3.5 h-3.5" /> Clear
            </button>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-6 space-y-6">
            {messages.length === 0 ? (
              <div className="text-center py-12">
                <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-gradient-primary flex items-center justify-center shadow-xl shadow-purple-500/20">
                  <Coffee className="w-8 h-8 text-white" />
                </div>
                <h3 className="font-semibold text-textPrimary mb-2">Hey, I'm Barista — how can I help you find files?</h3>
                <p className="text-sm text-textMuted mb-6 max-w-md mx-auto">
                  I'm your file finder barista. Ask me about ISOs for specific hardware, compare versions, or find the smallest file.
                </p>
                
                <div className="grid sm:grid-cols-2 gap-2 max-w-2xl mx-auto text-left">
                  {suggestions.slice(0, 6).map((s, i) => (
                    <button
                      key={i}
                      onClick={() => handleAsk(s)}
                      className="p-3 rounded-xl bg-surface border border-border hover:border-primary/30 text-sm text-textSecondary hover:text-textPrimary transition-all text-left flex items-start gap-2 group"
                    >
                      <Lightbulb className="w-4 h-4 text-primary mt-0.5 flex-shrink-0 group-hover:scale-110 transition-transform" />
                      <span>{s}</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              messages.map((msg, i) => (
                <div key={i} className={`flex gap-3 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  {msg.role === 'assistant' && (
                    <div className="w-8 h-8 rounded-xl bg-gradient-primary flex items-center justify-center flex-shrink-0">
                      <Coffee className="w-4 h-4 text-white" />
                    </div>
                  )}
                  
                  <div className={`max-w-[80%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                    msg.role === 'user'
                      ? 'bg-gradient-primary text-white rounded-br-md'
                      : msg.error
                      ? 'bg-red-500/10 border border-red-500/20 text-red-200 rounded-bl-md'
                      : 'bg-surface border border-border text-textSecondary rounded-bl-md'
                  }`}>
                    {msg.role === 'assistant' && !msg.error ? (
                      // Barista answers are markdown - render them, don't print them.
                      <AnswerMarkdown>{msg.content}</AnswerMarkdown>
                    ) : (
                      <div className="whitespace-pre-wrap">{msg.content}</div>
                    )}
                    {msg.role === 'user' && !loading && (
                      <button type="button" onClick={() => editMessage(i)} className="mt-2 inline-flex items-center gap-1 text-[11px] opacity-70 hover:opacity-100"><Pencil className="w-3 h-3" /> Edit and resend</button>
                    )}
                    
                    {msg.role === 'assistant' && msg.error && !loading && messages[i - 1]?.role === 'user' && (
                      <button type="button" onClick={() => handleAsk(messages[i - 1].content, { editIndex: i - 1 })} className="mt-2 inline-flex items-center gap-1 text-[11px] text-red-200 hover:text-white">
                        <RotateCcw className="w-3 h-3" /> Retry
                      </button>
                    )}
                    {msg.role === 'assistant' && !msg.error && !msg.streaming && (
                      <>
                        {msg.sources && msg.sources.length > 0 && (
                          <div className="mt-3 pt-3 border-t border-white/10">
                            <div className="text-xs font-medium text-textMuted uppercase tracking-widest mb-2">Sources — found by Barista</div>
                            <div className="flex flex-wrap gap-2">
                              {msg.sources.map(src => (
                                <Link key={src.id} to={`/file/${src.slug}`} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-surfaceHover border border-border text-xs hover:border-primary/30 hover:text-primary transition-colors">
                                  {src.name}
                                  <ExternalLink className="w-3 h-3" />
                                </Link>
                              ))}
                            </div>
                          </div>
                        )}
                        
                        <div className="mt-2 flex items-center gap-2 text-[11px] text-textMuted">
                          <span className={`w-2 h-2 rounded-full ${msg.usedAI ? 'bg-green-400' : 'bg-blue-400'}`} />
                          {msg.usedAI
                            ? `Barista answered with ${msg.provider || 'the model'} + catalogue data`
                            : 'Barista answered from catalogue metadata'}
                          {msg.metadata && ` • ${msg.metadata.totalFound} files found`}
                        </div>
                        <div className="mt-2 flex gap-2">
                          <button type="button" onClick={() => copyAnswer(msg.content, i)} className="inline-flex items-center gap-1 text-[11px] text-textMuted hover:text-textPrimary">
                            <Copy className="w-3 h-3" /> {copied === i ? 'Copied' : 'Copy answer'}
                          </button>
                          {i === messages.length - 1 && !loading && (
                            <button type="button" onClick={() => { const previous = messages[i - 1]; if (previous?.role === 'user') handleAsk(previous.content, { regenerate: true }); }} className="inline-flex items-center gap-1 text-[11px] text-textMuted hover:text-textPrimary">
                              <RotateCcw className="w-3 h-3" /> Regenerate
                            </button>
                          )}
                        </div>
                      </>
                    )}
                    
                    <div className="mt-1 text-[11px] opacity-60">
                      {msg.timestamp.toLocaleTimeString()}
                    </div>
                  </div>

                  {msg.role === 'user' && (
                    <div className="w-8 h-8 rounded-xl bg-surface border border-border flex items-center justify-center flex-shrink-0">
                      <span className="text-xs font-bold">You</span>
                    </div>
                  )}
                </div>
              ))
            )}
            
            {loading && (
              <div className="flex gap-3">
                <div className="w-8 h-8 rounded-xl bg-gradient-primary flex items-center justify-center">
                  <Coffee className="w-4 h-4 text-white" />
                </div>
                <div className="bg-surface border border-border rounded-2xl rounded-bl-md px-4 py-3 flex items-center gap-2 text-sm text-textMuted">
                  <LoadingDots size={16} />
                  Barista is searching metadata...
                </div>
              </div>
            )}
            
            <div ref={messagesEndRef} />
          </div>

          <div className="p-4 border-t border-white/5 bg-surface/50">
            <div className="flex gap-3">
              <div className="flex-1 relative">
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyPress={handleKeyPress}
                  placeholder="Ask Barista: Which Ubuntu for Intel PC?"
                  className="w-full px-4 py-3 pr-12 bg-surface border border-border rounded-2xl focus:outline-none focus:border-primary/50 focus:ring-2 focus:ring-primary/20 text-sm"
                  disabled={loading}
                />
                <Search className="absolute right-4 top-1/2 -translate-y-1/2 w-4 h-4 text-textMuted" />
              </div>
              <button
                onClick={loading ? stopGenerating : () => handleAsk(undefined, editingIndex === null ? {} : { editIndex: editingIndex })}
                disabled={!loading && !query.trim()}
                className="px-6 py-3 bg-gradient-primary hover:bg-gradient-primary-hover disabled:opacity-50 text-white rounded-2xl font-medium text-sm shadow-lg flex items-center gap-2"
              >
                {loading ? <><Square className="w-4 h-4 fill-current" /> Stop</> : <><Send className="w-4 h-4" /> Ask Barista</>}
              </button>
            </div>
            
            <div className="mt-3 flex items-center justify-between text-[11px] text-textMuted">
              <span>{editingIndex !== null ? 'Editing a question — press Enter to resend' : "Barista's purpose: easily find files • Press Enter to send"}</span>
              <span className="flex items-center gap-1.5">
                <span className={`w-2 h-2 rounded-full ${ai.ready ? 'bg-green-400' : 'bg-amber-400'}`} />
                {ai.badge}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
