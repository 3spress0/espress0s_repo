import { clsx } from 'clsx';

export function cn(...inputs) {
  return clsx(inputs);
}

export function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

export function formatDate(dateStr) {
  if (!dateStr) return '—';
  try {
    return new Date(dateStr).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });
  } catch {
    return dateStr;
  }
}

/**
 * Kick off a file download from a URL.
 *
 * Deliberately avoids window.open(): that needs a popup permission which
 * sandboxed iframes (embeds, previews) do not grant, and popup blockers reject
 * it whenever anything async happened before the call - which is exactly our
 * case, since the download URL is fetched first. A synthesised anchor click is
 * a same-document navigation, so it works in both.
 */
export function startDownload(url, fileName) {
  if (!url) return;
  const a = document.createElement('a');
  a.href = url;
  a.rel = 'noopener noreferrer';
  // Only meaningful for same-origin URLs; harmless elsewhere.
  if (fileName) a.download = fileName;
  // Cross-origin destinations must not replace the app inside an iframe.
  const isSameOrigin = url.startsWith('/') || url.startsWith(window.location.origin);
  if (!isSameOrigin) a.target = '_blank';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

export function formatRelativeTime(dateStr) {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now - date;
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays}d ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;
  if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo ago`;
  return `${Math.floor(diffDays / 365)}y ago`;
}
