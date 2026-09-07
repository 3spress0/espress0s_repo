const STORAGE_KEY = 'espress0:barista-conversations';
const createId = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;

export function loadBaristaConversations() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (Array.isArray(raw)) return raw;
    const legacy = JSON.parse(sessionStorage.getItem('espress0:barista-conversation') || '[]');
    if (!Array.isArray(legacy) || !legacy.length) return [];
    return [{ id: createId(), title: legacy.find(m => m.role === 'user')?.content?.slice(0, 48) || 'Conversation', messages: legacy, updatedAt: Date.now() }];
  } catch {
    return [];
  }
}

export function saveBaristaConversations(conversations) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations)); } catch { /* optional browser storage */ }
}

export function newBaristaConversation() {
  return { id: createId(), title: 'New conversation', messages: [], updatedAt: Date.now() };
}
