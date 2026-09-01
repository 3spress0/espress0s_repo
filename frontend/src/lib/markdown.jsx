/**
 * Tiny, dependency-free markdown renderer.
 *
 * Admin-written page bodies are markdown, so they need rendering somewhere.
 * Rather than pulling in a parser + an HTML sanitiser (and shipping
 * `dangerouslySetInnerHTML` into a page that renders admin input), this builds
 * React elements directly: there is no HTML string anywhere in the pipeline, so
 * raw `<script>` in a description is text, not markup.
 *
 * Supported: #/##/### headings, - and * bullets, 1. ordered lists, > quotes,
 * ``` fenced code, --- rules, tables are NOT supported, plus inline **bold**,
 * *italic*, `code`, [links](url) and bare URLs.
 */

const SAFE_LINK = /^(https?:\/\/|\/|mailto:|#)/i;

function safeHref(href) {
  const trimmed = (href || '').trim();
  return SAFE_LINK.test(trimmed) ? trimmed : null;
}

/** Inline formatting -> array of React nodes. */
function renderInline(text, keyPrefix = 'i') {
  const nodes = [];
  // Order matters: code first so ** inside backticks stays literal.
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\n]+\*)|(\[[^\]]+\]\((?:[^()\s]|\([^()\s]*\))+\))|(https?:\/\/[^\s<>()]+)/g;

  let last = 0;
  let match;
  let n = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const token = match[0];
    const key = `${keyPrefix}-${n++}`;

    if (token.startsWith('`')) {
      nodes.push(
        <code key={key} className="px-1.5 py-0.5 rounded bg-background border border-border text-[0.85em] font-mono text-primary">
          {token.slice(1, -1)}
        </code>
      );
    } else if (token.startsWith('**')) {
      nodes.push(<strong key={key} className="font-semibold text-textPrimary">{token.slice(2, -2)}</strong>);
    } else if (token.startsWith('*')) {
      nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    } else if (token.startsWith('[')) {
      const [, label, href] = token.match(/\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/) || [];
      const safe = safeHref(href);
      nodes.push(
        safe
          ? <a key={key} href={safe} target={safe.startsWith('http') ? '_blank' : undefined} rel="noreferrer noopener" className="text-primary hover:underline break-words">{label}</a>
          : <span key={key}>{label}</span>
      );
    } else {
      nodes.push(
        <a key={key} href={token} target="_blank" rel="noreferrer noopener" className="text-primary hover:underline break-words">{token}</a>
      );
    }

    last = match.index + token.length;
  }

  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

/** Markdown source -> array of React block elements. */
export function renderMarkdown(source) {
  const lines = String(source || '').replace(/\r\n/g, '\n').split('\n');
  const blocks = [];

  let i = 0;
  let key = 0;
  const k = () => `md-${key++}`;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code
    if (/^```/.test(line)) {
      const body = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i])) { body.push(lines[i]); i += 1; }
      i += 1; // closing fence
      blocks.push(
        <pre key={k()} className="my-3 p-3 rounded-xl bg-background border border-border overflow-x-auto">
          <code className="text-xs font-mono text-textSecondary whitespace-pre">{body.join('\n')}</code>
        </pre>
      );
      continue;
    }

    // Blank line
    if (!line.trim()) { i += 1; continue; }

    // Horizontal rule
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push(<hr key={k()} className="my-5 border-white/10" />);
      i += 1;
      continue;
    }

    // Headings
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      const content = renderInline(heading[2], k());
      const cls = {
        1: 'text-2xl font-bold text-textPrimary mt-6 mb-3 first:mt-0',
        2: 'text-lg font-bold text-textPrimary mt-6 mb-2 first:mt-0',
        3: 'text-base font-semibold text-textPrimary mt-5 mb-2 first:mt-0',
        4: 'text-sm font-semibold text-textSecondary uppercase tracking-widest mt-4 mb-2 first:mt-0',
      }[level];
      const Tag = `h${Math.min(level + 1, 6)}`;
      blocks.push(<Tag key={k()} className={cls}>{content}</Tag>);
      i += 1;
      continue;
    }

    // Blockquote
    if (/^>\s?/.test(line)) {
      const body = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { body.push(lines[i].replace(/^>\s?/, '')); i += 1; }
      blocks.push(
        <blockquote key={k()} className="my-3 pl-4 border-l-2 border-primary/40 text-sm text-textSecondary italic">
          {renderInline(body.join(' '), k())}
        </blockquote>
      );
      continue;
    }

    // Unordered list
    if (/^\s*[-*+]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ''));
        i += 1;
      }
      blocks.push(
        <ul key={k()} className="my-3 space-y-1.5 list-disc list-outside pl-5 text-sm text-textSecondary marker:text-primary/70">
          {items.map((item, idx) => <li key={idx}>{renderInline(item, `${idx}`)}</li>)}
        </ul>
      );
      continue;
    }

    // Ordered list
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+[.)]\s+/, ''));
        i += 1;
      }
      blocks.push(
        <ol key={k()} className="my-3 space-y-1.5 list-decimal list-outside pl-5 text-sm text-textSecondary marker:text-primary/70">
          {items.map((item, idx) => <li key={idx}>{renderInline(item, `${idx}`)}</li>)}
        </ol>
      );
      continue;
    }

    // Paragraph: gather until a blank line or the start of another block
    const para = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^```|^#{1,4}\s|^>\s?|^\s*[-*+]\s+|^\s*\d+[.)]\s+/.test(lines[i]) &&
      !/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i])
    ) {
      para.push(lines[i]);
      i += 1;
    }
    blocks.push(
      <p key={k()} className="my-3 text-sm text-textSecondary leading-relaxed first:mt-0">
        {renderInline(para.join(' '), k())}
      </p>
    );
  }

  return blocks;
}

/** Convenience component. */
export default function Markdown({ children, className = '' }) {
  if (!children || !String(children).trim()) return null;
  return <div className={className}>{renderMarkdown(children)}</div>;
}
