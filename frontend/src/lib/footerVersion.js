/**
 * The footer's version stamp.
 *
 * Three states have to be told apart, and only one of them prints anything:
 *
 *   - the admin turned it off (`footer_show_version` = false);
 *   - the server could not name its version: `APP_VERSION` is null when no
 *     manifest is readable, and there is no `app` block at all when the
 *     settings request failed and the site is running on fallbacks;
 *   - there is a version, and visitors get to see it.
 *
 * The value comes from the server rather than a setting on purpose: a version
 * an admin can type into a text box is a version that goes stale on the next
 * deploy, which is exactly what a footer stamp must not do. See
 * backend/src/lib/buildInfo.js for how it is resolved and why it is frozen at
 * boot.
 */
export function footerVersionLabel({ app, showVersion }) {
  if (!showVersion) return null;
  const raw = String(app?.version ?? '').trim();
  if (!raw) return null;
  // A manifest already saying "v1.0.0" must not come out as "vv1.0.0".
  return /^v\d/i.test(raw) ? raw : `v${raw}`;
}
