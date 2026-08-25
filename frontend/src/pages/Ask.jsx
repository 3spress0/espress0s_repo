import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { Coffee, Send, Database, AlertCircle, ExternalLink, Lightbulb, Search, Loader2, Sparkles } from 'lucide-react';
import { aiApi } from '../lib/api';
import StarryBackground from '../components/StarryBackground';

export default function Ask() {
  const [query, setQuery] = useState('');
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(false);
  const [suggestions, setSuggestions] = useState([]);
  const [status, setStatus] = useState(null);
  const messagesEndRef = useRef(null);

  useEffect(() => {
    aiApi.suggestions().then(d => setSuggestions(d.suggestions || [])).catch(() => {});
    aiApi.status().then(setStatus).catch(() => {});
  }, []);

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
        usedTgpt: result.usedTgpt,
        metadata: result.metadata,
        timestamp: new Date(),
      };
      
      setMessages(prev => [...prev, aiMessage]);
    } catch (e) {
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: `Sorry, I encountered an error: ${e.response?.data?.error || e.message}. Please try again or browse the repository directly.`,
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

  return (
    <div className="relative min-h-screen">
      <StarryBackground />
      
      <div className="relative max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="text-center mb-8">
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-gradient-subtle border border-purple-500/20 text-sm mb-4 backdrop-blur-sm">
            <Coffee className="w-4 h-4 text-primary" />
            <span className="text-textSecondary font-medium">Barista • Powered by tgpt + metadata search</span>
            {status && (
              <span className={`ml-2 w-2 h-2 rounded-full ${status.tgptAvailable ? 'bg-green-400' : 'bg-amber-400'}`} title={status.tgptAvailable ? 'tgpt available' : 'Fallback mode'} />
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
                <div className="font-medium text-textPrimary">Barista • tgpt Backend</div>
                <div className="text-xs text-textMuted mt-1">Uses aandrew-me/tgpt CLI, auto-installed</div>
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
                    <div className="whitespace-pre-wrap">{renderWithLinks(msg.content)}</div>
                    
                    {msg.role === 'assistant' && !msg.error && (
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
                          <span className={`w-2 h-2 rounded-full ${msg.usedTgpt ? 'bg-green-400' : 'bg-blue-400'}`} />
                          {msg.usedTgpt ? 'Barista answered with tgpt + metadata' : 'Barista answered with metadata search'}
                          {msg.metadata && ` • ${msg.metadata.totalFound} files found`}
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
                  <Loader2 className="w-4 h-4 animate-spin" />
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
                onClick={() => handleAsk()}
                disabled={!query.trim() || loading}
                className="px-6 py-3 bg-gradient-primary hover:bg-gradient-primary-hover disabled:opacity-50 text-white rounded-2xl font-medium text-sm shadow-lg flex items-center gap-2"
              >
                <Send className="w-4 h-4" />
                Ask Barista
              </button>
            </div>
            
            <div className="mt-3 flex items-center justify-between text-[11px] text-textMuted">
              <span>Barista's purpose: easily find files • Press Enter to send</span>
              <span className="flex items-center gap-1.5">
                <span className={`w-2 h-2 rounded-full ${status?.tgptAvailable ? 'bg-green-400' : 'bg-amber-400'}`} />
                {status?.tgptAvailable ? 'tgpt ready' : 'Fallback mode'}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function renderWithLinks(text) {
  const parts = text.split(/(\/item\/[a-z0-9-]+)/g);
  return parts.map((part, i) => {
    if (part.startsWith('/file/')) {
      const slug = part.replace('/file/', '');
      return (
        <Link key={i} to={part} className="text-primary hover:text-primaryHover underline underline-offset-2 font-medium">
          {slug}
        </Link>
      );
    }
    if (part.match(/https?:\/\//)) {
      return <span key={i} className="break-all">{part}</span>;
    }
    return <span key={i}>{part}</span>;
  });
}
