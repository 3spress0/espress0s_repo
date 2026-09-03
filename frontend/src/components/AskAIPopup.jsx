import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { Coffee, Send, Database, AlertCircle, ExternalLink, Lightbulb, Search, Loader2, X, Sparkles } from 'lucide-react';
import { aiApi, describeAi, describeApiError } from '../lib/api';

export default function AskAIPopup({ isOpen, onClose }) {
  const [query, setQuery] = useState('');
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(false);
  const [suggestions, setSuggestions] = useState([]);
  const [status, setStatus] = useState(null);
  const messagesEndRef = useRef(null);

  useEffect(() => {
    if (isOpen) {
      aiApi.suggestions().then(d => setSuggestions(d.suggestions || [])).catch(() => {});
      aiApi.status().then(setStatus).catch(() => {});
    }
  }, [isOpen]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleAsk = async (q) => {
    const question = q || query;
    if (!question.trim() || loading) return;

    const userMessage = { role: 'user', content: question, timestamp: new Date() };
    setMessages(prev => [...prev, userMessage]);
    setQuery('');
    setLoading(true);

    try {
      const result = await aiApi.ask(question);
      const aiMessage = {
        role: 'assistant',
        content: result.answer,
        sources: result.sources || [],
        relatedItems: result.relatedItems || [],
        usedAI: result.usedAI,
        provider: result.provider || null,
        metadata: result.metadata,
        timestamp: new Date(),
      };
      setMessages(prev => [...prev, aiMessage]);
    } catch (e) {
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: describeApiError(e),
        error: true,
        timestamp: new Date(),
      }]);
    } finally {
      setLoading(false);
    }
  };

  const handleKeyPress = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleAsk();
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/70 backdrop-blur-md animate-fade-in">
      <div className="glass-strong rounded-3xl border border-white/10 w-full max-w-2xl max-h-[85vh] flex flex-col shadow-2xl animate-slide-up">
        <div className="flex items-center justify-between p-6 border-b border-white/5">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-primary flex items-center justify-center shadow-lg">
              <Coffee className="w-5 h-5 text-white" />
            </div>
            <div>
              <h2 className="font-bold text-textPrimary">Barista — File Finder</h2>
              <p className="text-xs text-textMuted">Easily find files • {describeAi(status).badge}</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 rounded-xl bg-surface border border-border hover:border-primary/30 transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-4" style={{ minHeight: '300px' }}>
          {messages.length === 0 ? (
            <div className="text-center py-8">
              <div className="w-14 h-14 mx-auto mb-3 rounded-2xl bg-gradient-primary flex items-center justify-center">
                <Coffee className="w-7 h-7 text-white" />
              </div>
              <h3 className="font-semibold text-textPrimary mb-2">How can I help you find files?</h3>
              <p className="text-sm text-textMuted mb-4">Ask about ISOs, tools, versions</p>
              <div className="grid sm:grid-cols-2 gap-2 text-left max-w-xl mx-auto">
                {suggestions.slice(0, 4).map((s, i) => (
                  <button key={i} onClick={() => handleAsk(s)} className="p-2.5 rounded-xl bg-surface border border-border hover:border-primary/30 text-xs text-textSecondary hover:text-textPrimary text-left flex items-start gap-2">
                    <Lightbulb className="w-3 h-3 text-primary mt-0.5 flex-shrink-0" />
                    <span>{s}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((msg, i) => (
              <div key={i} className={`flex gap-2 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                {msg.role === 'assistant' && <div className="w-7 h-7 rounded-xl bg-gradient-primary flex items-center justify-center flex-shrink-0"><Coffee className="w-3.5 h-3.5 text-white" /></div>}
                <div className={`max-w-[80%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed ${msg.role === 'user' ? 'bg-gradient-primary text-white' : msg.error ? 'bg-red-500/10 border border-red-500/20 text-red-200' : 'bg-surface border border-border text-textSecondary'}`}>
                  <div className="whitespace-pre-wrap">{msg.content.slice(0,500)}</div>
                  {msg.sources?.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {msg.sources.map(src => (
                        <Link key={src.id} to={`/file/${src.slug}`} onClick={onClose} className="px-2 py-1 rounded-full bg-surfaceHover border border-border text-[11px] hover:border-primary/30 hover:text-primary">
                          {src.name}
                        </Link>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))
          )}
          {loading && (
            <div className="flex gap-2">
              <div className="w-7 h-7 rounded-xl bg-gradient-primary flex items-center justify-center"><Coffee className="w-3.5 h-3.5 text-white" /></div>
              <div className="bg-surface border border-border rounded-2xl px-3.5 py-2.5 flex items-center gap-2 text-xs text-textMuted">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                Barista searching...
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        <div className="p-4 border-t border-white/5 bg-surface/30">
          <div className="flex gap-2">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyPress={handleKeyPress}
              placeholder="Ask Barista: Which Ubuntu for Intel?"
              className="flex-1 px-4 py-2.5 bg-surface border border-border rounded-xl text-sm focus:outline-none focus:border-primary/50"
              disabled={loading}
            />
            <button onClick={() => handleAsk()} disabled={!query.trim() || loading} className="px-5 py-2.5 bg-gradient-primary text-white rounded-xl text-sm font-medium disabled:opacity-50">
              <Send className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
