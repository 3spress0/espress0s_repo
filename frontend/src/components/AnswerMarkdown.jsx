import { useNavigate } from 'react-router-dom';
import Markdown from '../lib/markdown.jsx';

/**
 * A rendered Barista answer.
 *
 * Barista speaks markdown - the model is prompted for it, and the
 * deterministic fallback is literally built from `**bold**`, `- [link](...)`
 * and fenced blocks. This renders that through the app's React-element
 * markdown pipeline (no HTML strings, so anything the model was tricked into
 * echoing is text, not markup) instead of printing it raw.
 *
 * Repo-relative links (/file/slug - the form the answer sanitizer rewrites
 * everything to) navigate inside the SPA: the renderer itself stays
 * router-free because it also renders admin bodies, so the click
 * interception lives here. "//host/..." is excluded - whatever the leading
 * slash suggests, it is off-site.
 */
export default function AnswerMarkdown({ children, onNavigate }) {
  const navigate = useNavigate();

  const onClick = (e) => {
    const anchor = e.target instanceof Element ? e.target.closest('a[href]') : null;
    const href = anchor?.getAttribute('href');
    if (href?.startsWith('/') && !href.startsWith('//')) {
      e.preventDefault();
      // The popup uses this hook to close itself when an answer's own link
      // takes you to a file page, same as the sources chips below.
      if (onNavigate) onNavigate(href);
      navigate(href);
    }
  };

  return (
    <div className="break-words" onClick={onClick}>
      <Markdown className="[&>*:first-child]:mt-0 [&>*:last-child]:mb-0">{children}</Markdown>
    </div>
  );
}
