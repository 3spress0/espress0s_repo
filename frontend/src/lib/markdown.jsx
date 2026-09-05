/**
 * The <Markdown> component - a thin JSX shell over `markdown-core.js`.
 *
 * Everything about what markdown is supported and why the renderer builds
 * React elements instead of HTML strings lives in markdown-core.js (kept JSX-
 * free so `node --test` can cover it). Admin page bodies and Barista answers
 * are markdown; both come from input the browser must not execute, so this
 * pipeline never produces an HTML string and never uses
 * dangerouslySetInnerHTML: raw `<script>` is text, not markup.
 */
import { renderMarkdown } from './markdown-core.js';

export { renderMarkdown } from './markdown-core.js';

/** Convenience component. */
export default function Markdown({ children, className = '' }) {
  if (!children || !String(children).trim()) return null;
  return <div className={className}>{renderMarkdown(children)}</div>;
}
