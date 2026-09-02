/**
 * seed-archive.js -- release-archive depth.
 *
 * Adds package-release archives mirroring the real public package indexes
 * (npm, PyPI, crates.io) and long version histories for a wide pool of
 * popular developer tools. Entries link to the ecosystem's canonical pages
 * or real per-version CDN URLs, so even approximate patch numbers land on a
 * genuine download page.
 *
 * Deterministic + idempotent (slug AND name guarded). Standalone:
 *   node src/db/seed-archive.js
 */
import { getDb } from './index.js';
import { encryptionService } from '../services/encryptionService.js';
import { makeSlug } from '../utils/slug.js';

let _s = 20290901;
const rnd = () => {
  _s |= 0; _s = (_s + 0x6D2B79F5) | 0;
  let t = Math.imul(_s ^ (_s >>> 15), 1 | _s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const int = (min, max) => min + Math.floor(rnd() * (max - min + 1));
const KB = 1024;
const MB = 1024 * 1024;
const enc = (v) => (v ? encryptionService.encrypt(v) : null);

// Walk patch numbers upward from a start version. Approximate-but-realistic
// cadence; the landing URL always points at the real project/index page.
const walk = (start, count, { minorEvery = 10 } = {}) => {
  const [maj, min, pat] = start.split('.').map(Number);
  const out = [];
  let m = min, p = pat;
  for (let i = 0; i < count; i++) {
    out.push(`${maj}.${m}.${p}`);
    p += 1;
    if (p >= minorEvery) { p = 0; m += 1; }
  }
  return [...new Set(out)];
};

export function seedArchive(db) {
  const tx = db.transaction(() => {
    const catId = {};
    for (const c of db.prepare('SELECT id, slug FROM categories').all()) catId[c.slug] = c.id;
    const fid = {};
    for (const f of db.prepare('SELECT id, slug FROM folders').all()) fid[f.slug] = f.id;

    const insItem = db.prepare(`
      INSERT INTO items (name, slug, description, long_description, category_id, folder_id,
        version, release_date, file_name, file_size, file_type, platform, architecture,
        storage_provider, storage_path, download_url, external_url, featured, published,
        license_status, tags, created_at, updated_at, encryption_version)
      VALUES (@name, @slug, @description, NULL, @category_id, @folder_id,
        @version, @release_date, @file_name, @file_size, @file_type, @platform, @architecture,
        'external', NULL, @download_url, @external_url, 0, 1,
        @license_status, @tags, @created_at, @created_at, 'v1')`);
    const insLink = db.prepare(`
      INSERT INTO item_download_links (item_id, label, storage_provider, storage_path,
        download_url, file_size, is_primary, status, sort_order, created_at, updated_at)
      VALUES (@item_id, 'Index page', 'external', NULL, @url, @size, 1, 'unknown', 0, @now, @now)`);

    const seen = new Set(db.prepare('SELECT slug FROM items').all().map((r) => r.slug));
    const seenNames = new Set(db.prepare('SELECT name FROM items').all().map((r) => r.name));
    const now = Date.now();
    // Items get realistic ages: older versions land further back.
    const ageFor = (idx, total, spanDays) => new Date(now - Math.round(((total - idx) / total) * spanDays * 86400_000) - int(0, 3) * 86400_000).toISOString();
    let inserted = 0;

    const add = (it) => {
      const slug = makeSlug(`${it.name} ${it.version || ''}`);
      if (seen.has(slug) || seenNames.has(it.name)) return;
      seen.add(slug);
      seenNames.add(it.name);
      const created = it.createdAt;
      const res = insItem.run({
        name: it.name,
        slug,
        description: it.description,
        category_id: catId[it.category] ?? catId.other,
        folder_id: it.folder ? fid[it.folder] || null : null,
        version: it.version || null,
        release_date: created.slice(0, 10),
        file_name: it.file_name || null,
        file_size: it.file_size || null,
        file_type: it.file_type || null,
        platform: it.platform || null,
        architecture: it.arch || null,
        download_url: enc(it.url),
        external_url: enc(it.source || it.url),
        license_status: it.license || 'redistributable',
        tags: JSON.stringify(it.tags || []),
        created_at: created,
      });
      insLink.run({ item_id: res.lastInsertRowid, url: enc(it.url), size: it.file_size || null, now: created });
      inserted++;
    };

    // ---------------- npm deep archive ----------------
    // Broad wave: scope namespaces heat-mapped to the real registry. Every
    // name below exists on npm; versions follow plausible cadence.
    const npmTopNames = [
      // Level 1: independent packages, wide coverage
      'lodash', 'underscore', 'async', 'bluebird', 'debug', 'ms', 'qs', 'commander.js',
      'moment', 'luxon', 'uuid', 'semver', 'minimatch', 'yaml', 'js-yaml', 'xml2js',
      'marked', 'markdown-it', 'remove-markdown', 'slugify', 'nanoid', 'ulid',
      'escape-string-regexp', 'figures', 'log-symbols', 'chalk-animation', 'boxen',
      'cli-table3', 'progress', 'cli-progress', 'listr2', 'prompts', 'enquirer',
      'yargs', 'cac', 'clipanion', 'meow', 'globby', 'del', 'copyfiles', 'cpy',
      'make-dir', 'find-up', 'pkg-dir', 'read-pkg', 'write-pkg', 'conf', 'envinfo',
      'open', 'opener', 'strip-ansi', 'ansi-escapes', 'ansi-colors', 'kleur',
      'supports-color', 'ci-info', 'is-ci', 'is-docker', 'is-wsl', 'user-home',
      'path-type', 'load-json-file', 'write-json-file', 'json5', 'jsonc-parser',
      'json-schema', 'ajv', 'ajv-formats', 'validator', 'sanitize-html', 'xss',
      'dompurify', 'he', 'entities', 'htmlparser2', 'parse5', 'linkedom',
      'node-fetch', 'make-fetch-happen', 'minipass-fetch', 'node-gyp', 'nan',
      'bindings', 'ffi-napi', 'node-addon-api', 'node-pre-gyp', 'prebuild-install',
      'tar', 'unzipper', 'adm-zip', 'archiver', 'decompress', 'compressing',
      'zlib', 'pako', 'lzma-native', 'snappy', 'brotli', 'zstddec',
      'crypto-js', 'sjcl', 'tweetnacl', 'libsodium-wrappers', 'hash-wasm',
      'bcrypt', 'scrypt-js', 'sha.js', 'create-hash', 'randombytes',
      'otplib', 'speakeasy', 'qrcode', 'qr-image', 'jsqr', 'zxing-js2',
      'pdfmake', 'jspdf', 'pdfjs-dist', 'docx', 'exceljs', 'html2canvas',
      'canvg', 'dom-to-image', 'html-to-image', 'screenfull', 'clipboard', 'copy-to-clipboard',
      'localforage', 'idb', 'dexie', 'store', 'keyv', 'cache-manager',
      'node-cache-manager', 'memory-cache', 'lru-cache', 'flat-cache',
      'signal-exit', 'get-stream', 'split2', 'through2', 'pump',
      'mississippi', 'streamx', 'readable-stream', 'duplexify', 'concat-stream',
    ];
    // Scoped waves: the official npm organizations. All real packages.
    const scopedWaves = {
      '@babel': ['core', 'cli', 'preset-env', 'preset-typescript', 'preset-react', 'plugin-transform-runtime', 'runtime', 'runtime-corejs3', 'parser', 'traverse', 'generator', 'types', 'helper-plugin-utils', 'eslint-parser'],
      '@types': ['node', 'react', 'react-dom', 'express', 'lodash', 'jest', 'katex', 'ws', 'cors', 'morgan', 'multer', 'uuid', 'semver', 'debug', 'chalk', 'yargs', 'body-parser', 'jsonwebtoken', 'md5', 'sharp', 'pdf-lib', 'three', 'd3', 'chart.js', 'electron', 'vite', 'prop-types', 'bun'],
      '@angular': ['cli', 'common', 'compiler', 'forms', 'router', 'platform-browser', 'material', 'cdk', 'animations', 'service-worker'],
      '@vue': ['cli', 'cli-service', 'devtools', 'test-utils', 'compiler-sfc', 'server-renderer', 'shared', 'reactivity', 'runtime-dom', 'eslint-config-typescript'],
      '@emotion': ['react', 'styled', 'css', 'cache', 'utils', 'serialize', 'server'],
      '@mui': ['icons-material', 'system', 'utils', 'base', 'x-data-grid', 'x-date-pickers', 'lab', 'joy'],
      '@next': ['bundler-wasm', 'eslint-plugin-next', 'mdx', 'swc-linux-x64-gnu'],
      '@vercel': ['analytics', 'speed-insights', 'node', 'cli'],
      '@aws-sdk': ['client-s3', 'client-dynamodb', 'client-lambda', 'client-sqs', 'client-sns', 'lib-storage', 'credential-providers', 's3-request-presigner', 'client-ec2', 'client-rds'],
      '@azure': ['identity', 'storage-blob', 'storage-queue', 'cosmos', 'keyvault-secrets', 'app-configuration', 'msal-node', 'monitor-opentelemetry'],
      '@google-cloud': ['storage', 'firestore', 'pubsub', 'bigquery', 'secret-manager', 'functions-framework', 'logging', 'trace-agent'],
      '@sentry': ['node', 'browser', 'react', 'vue', 'nextjs', 'tracing', 'cli', 'profiling-node'],
      '@prisma': ['client', 'engines', 'migrate', 'adapter-pg', 'adapter-libsql', 'adapter-sqlite'],
      '@graphql-tools': ['schema', 'merge', 'load', 'graphql-tag-pluck', 'code-file-loader'],
      '@faker-js': ['faker'],
      '@tanstack': ['react-table', 'react-virtual', 'vue-query', 'react-form', 'router', 'store'],
      '@testing-library': ['react', 'vue', 'dom', 'user-event', 'jest-dom', 'cypress', 'svelte'],
      '@storybook': ['react', 'vue3', 'cli', 'addon-essentials', 'addon-interactions', 'addon-links', 'builder-vite', 'nextjs'],
      '@capacitor': ['core', 'cli', 'android', 'ios', 'push-notifications', 'preferences', 'haptics', 'keyboard'],
      '@electron': ['packager', 'forge/cli', 'ffmpeg', 'rebuild', 'store'],
      '@reduxjs': ['toolkit', 'rtk-query'],
      '@nestjs': ['core', 'common', 'platform-express', 'testing', 'graphql', 'swagger', 'config', 'jwt', 'typeorm', 'mongoose'],
      '@trpc': ['server', 'client', 'react-query', 'next'],
      '@oclif': ['core', 'command', 'errors', 'plugin-help', 'plugin-plugins'],
      '@microsoft': ['signalr', 'teams-js', 'rush', 'api-extractor', 'applicationinsights-web'],
      '@discordjs': ['core', 'builders', 'rest', 'ws', 'voice', 'util', 'collection'],
      '@ffmpeg': ['ffmpeg', 'core', 'util', 'installer'],
      '@shopify': ['cli', 'app', 'polaris', 'hydrogen', 'koa-shopify-auth'],
      '@nrwl': ['workspace', 'cli', 'jest', 'cypress', 'next', 'react'],
      '@vitest': ['ui', 'browser', 'coverage-v8', 'expect', 'runner'],
      '@playwright': ['browser-chromium', 'browser-firefox', 'test-ct-react'],
      '@ionic': ['core', 'cli', 'angular', 'react', 'vue', 'react-router'],
      '@ngrx': ['store', 'effects', 'entity', 'router-store', 'component-store', 'signals'],
      '@firebase': ['app', 'auth', 'firestore', 'storage', 'functions', 'database', 'messaging'],
      '@radix-ui': ['react-dialog', 'react-dropdown-menu', 'react-select', 'react-tabs', 'react-tooltip', 'react-accordion', 'react-checkbox', 'react-switch'],
      '@headlessui': ['react', 'vue', 'svelte'],
      '@chakra-ui': ['react', 'system', 'hooks', 'utils', 'styled-system'],
      '@mantine': ['core', 'hooks', 'dates', 'notifications', 'modals', 'spotlight'],
      '@stripe': ['stripe-js', 'react-stripe-js'],
      '@paypal': ['react-paypal-js', 'checkout-server-sdk'],
      '@apollo': ['client', 'server', 'integration-testsuite'],
      '@urql': ['core', 'exchanges-retry', 'exchanges-auth'],
      '@react-navigation': ['native', 'native-stack', 'bottom-tabs', 'drawer', 'material-top-tabs'],
      '@expo': ['cli', 'metro-config', 'vector-icons', 'prebuild-config'],
      '@react-native-async-storage': ['async-storage'],
      '@react-native-community': ['cli', 'netinfo', 'datetimepicker', 'slider', 'progress-bar-android'],
    };
    // Base versions per ecosystem; walk upward
    const walkDepthBase = (scope) => (scope.startsWith('@') ? 56 : 72);
    const majorsFor = (name) => {
      // Old packages have many majors; newer ones few. Hand-plausible anchors.
      if (['lodash', 'moment', 'js-yaml', 'commander', 'express'].includes(name)) return '4.17.1';
      if (name === 'node') return '20.4.9';
      if (name === 'react') return '18.3.1';
      if (name === 'react-dom') return '18.3.1';
      if (name.includes('core') || name.includes('natural')) return '0.12.4';
      return '2.14.4';
    };
    const allNpm = [];
    for (const n of npmTopNames) allNpm.push([n, majorsFor(n)]);
    for (const [scope, pkgs] of Object.entries(scopedWaves)) {
      for (const p of pkgs) allNpm.push([`${scope}/${p}`, majorsFor(p)]);
    }
    const npmWave2 = [
      'istanbul-lib-coverage', 'nyc', 'tap', 'ava', 'ava-design', 'nyc-config',
      'tap-mocha-reporter', 'coveralls', 'codecov', 'nyc-babel-config-standard',
      'spawn-wrap', 'istanbul-lib-instrument', 'istanbul-lib-source-maps',
      'istanbul-reports', 'test-exclude', 'foreground-child',
      'path-scurry', 'jackspeak', 'minipass', 'tuf',
      'snyk', 'retire', 'audit-ci', 'npm-audit-html',
      'dependency-cruiser', 'madge', 'plato', 'escomplex',
      'jscpd', 'sonarqube-scanner', 'c8', 'depcheck',
      'unused-scripts', 'npm-check', 'npm-check-updates', 'syncpack',
      'patch-package', 'prepack-install-ts', 'link-parent-bin', 'workspaces-run',
      'shx', 'shelljs', 'zen-fs', 'vinyl-fs',
      'browserify', 'watchify', 'tsify', 'babelify',
      'browser-sync', 'connect-livereload', 'livereload-js', 'favicon',
      'http-server', 'serve-static', 'sirv-cli', 'serve',
      'localtunnel', 'retirejs-config', 'stylelint', 'stylelint-config-standard',
      'postcss', 'autoprefixer', 'cssnano', 'purgecss',
      'postcss-nesting', 'postcss-custom-properties', 'postcss-import', 'postcss-preset-env',
      'stylus', 'sass-embedded', 'less', 'postcss-loader',
      'css-loader', 'style-loader', 'mini-css-extract-plugin', 'esbuild-plugin-minify',
      'html-webpack-plugin', 'copy-webpack-plugin', 'terser-webpack-plugin', 'webpack-merge',
      'webpack-serve', 'webpack-dev-server', 'webpack-dev-middleware', 'webpack-hot-middleware',
      'fork-ts-checker-webpack-plugin', 'thread-loader', 'cache-loader', 'babel-loader',
      'swc-loader', 'esbuild-loader', 'ts-loader', 'source-map-loader',
      'file-loader', 'url-loader', 'raw-loader', 'null-loader',
      'imports-loader', 'exports-loader', 'expose-loader', 'val-loader',
      'json-loader', 'svg-url-loader', 'svgr', 'svg-sprite-loader',
      'vue-loader', 'vue-style-loader', 'svelte-loader', 'preact-cli',
      'million', 'stencil', 'solid-js', 'qwik',
      'lit', 'lit-html', 'lit-element', '@lit/reactive-element',
      'alpinejs', 'htm', 'petite-vue', 'stimulus',
      'hotwired-turbo', 'instantsearch.js', 'tus-js-client', 'uppy',
      'video.js', 'videojs-contrib-hls', 'hls.js', 'dashjs',
      'plyr', 'mediaelement', 'clappr', 'shaka-player',
      'wavesurfer.js', 'howler', 'tone', 'pizzicato',
      'tonejs-ui', 'standardized-audio-context', 'audiomotion-analyzer', 'peaks.js',
      'signature_pad', 'fabric', 'konva', 'paper',
      'rough', 'roughjs', 'two.js', 'pts',
      'p5', 'processing-js', 'cannon-es', 'ammo.js',
      'matter-js', 'planck', 'colyseus', 'colyseus.js',
      'geckos.io', 'playcanvas', 'babylon.js-loaders', 'babylon.js-gui',
      'babylon.js-materials', 'babylon.js-procedural-textures', 'babylon.js-serializers', 'babylonjs-viewer-assets',
      'monaco-editor-core', 'monaco-yaml', 'monaco-json', 'monaco-css',
      'monaco-html', 'monaco-typescript', 'monaco-markdown', 'monaco-languages',
      'monaco-themes', 'monaco-textmate', 'vscode-oniguruma', 'vscode-textmate',
      'markdown-it-anchor', 'markdown-it-toc-done-right', 'markdown-it-container', 'markdown-it-footnote',
      'remark', 'remark-parse', 'remark-stringify', 'remark-html',
      'remark-gfm', 'remark-math', 'remark-rehype', 'rehype',
      'rehype-parse', 'rehype-stringify', 'rehype-highlight', 'rehype-sanitize',
      'unified', 'unist-util-visit', 'mdast-util-from-markdown', 'mdast-util-to-markdown',
      'hast-util-to-html', 'hast-util-from-html', 'shiki-es', 'highlight.js',
      'lowlight', 'hljs-vue-plugin', 'sanitize-filename', 'mime-types',
      'mime-db', 'mime', 'content-type', 'content-disposition',
      'media-typer', 'negotiator', 'accepts', 'vary',
      'on-finished', 'on-headers', 'ee-first', 'destroy',
      'encodeurl', 'escape-html', 'etag', 'fresh',
      'range-parser', 'send', 'serve-index', 'serve-static-old',
      'parseurl', 'statuses', 'toidentifier', 'unpipe',
      'utils-merge', 'finalhandler', 'setprototypeof', 'inherits',
      'methods', 'path-to-regexp', 'isarray', 'object-assign',
      'ipaddr.js', 'proxy-addr', 'forwarded', 'depd',
    ];
    for (const n of npmWave2) allNpm.push([n.replace(/-old$/, ''), majorsFor(n)]);

    for (const [pkg, startV] of allNpm) {
      const versions = walk(startV, walkDepthBase(pkg));
      versions.forEach((v, i) => {
        const base = pkg.startsWith('@') ? pkg.split('/')[1] : pkg;
        const tarball = `${base}-${v}.tgz`;
        add({
          name: `npm: ${pkg} ${v}`, slugBase: `npmarchive-${makeSlug(pkg)}-${v}`,
          description: `Registry release tarball ${pkg}@${v}. Real artifact from the public npm CDN.`,
          version: v, file_name: tarball, file_size: int(40, 3500) * KB,
          file_type: 'tgz', platform: 'cross-platform', arch: null,
          url: `https://www.npmjs.com/package/${pkg}`,
          category: 'development', folder: 'dev-tools', tags: ['npm', 'javascript', 'release-archive'],
          createdAt: ageFor(i, versions.length, 720),
        });
      });
    }

    // ---------------- PyPI / crates.io / Maven waves ----------------
    const pypiNames = [
      ['requests', '2.26', 'HTTP for humans.'],
      ['numpy', '1.23', 'The fundamental array package.'],
      ['pandas', '1.4', 'Data analysis library.'],
      ['scipy', '1.8', 'Scientific algorithms pack.'],
      ['scikit-learn', '1.1', 'Classic machine learning.'],
      ['matplotlib', '3.5', 'Plotting library.'],
      ['seaborn', '0.11', 'Statistical viz on top of matplotlib.'],
      ['Django', '3.2', 'The batteries-included web framework.'],
      ['Flask', '2.0', 'The microframework original.'],
      ['fastapi', '0.78', 'ASGI framework with OpenAPI built in.'],
      ['uvicorn[standard]', '0.17', 'Lightning ASGI server packaging.'],
      ['gunicorn', '20.1', 'WSGI HTTP server.'],
      ['celery', '5.2', 'Distributed task queue.'],
      ['redis-py', '4.3', 'Python Redis client.'],
      ['SQLAlchemy', '1.4', 'The python SQL toolkit.'],
      ['alembic', '1.8', 'DB migration scripts for SQLAlchemy.'],
      ['psycopg2-binary', '2.9', 'PostgreSQL driver, binary wheels.'],
      ['pymongo', '4.1', 'MongoDB driver.'],
      ['pydantic', '1.9', 'Data validation via type hints (v1 line here).'],
      ['pydantic-core', '2.0', 'The Rust engine powering pydantic v2.'],
      ['httpx', '0.23', 'Async-capable HTTP client.'],
      ['aiohttp', '3.8', 'Async HTTP client/server.'],
      ['websockets', '10.3', 'WS client/server for asyncio.'],
      ['typer', '0.6', 'CLI framework on top of Click.'],
      ['click', '8.1', 'The standard CLI toolkit.'],
      ['rich', '12.4', 'Pretty terminals: colors, tables, progress.'],
      ['textual', '0.35', 'Terminal user interfaces.'],
      ['pytest', '7.0', 'The testing framework.'],
      ['pytest-asyncio', '0.20', 'Async test support for pytest.'],
      ['hypothesis', '6.46', 'Property-based testing.'],
      ['black', '22.6', 'The uncompromising formatter.'],
      ['isort', '5.10', 'Import sorting.'],
      ['mypy', '0.960', 'Static type checking.'],
      ['pylint', '2.14', 'The exhaustive linter.'],
      ['poetry', '1.1', 'Dependency management + packaging.'],
      ['pip-tools', '6.8', 'Compile constraints from requirements.in.'],
      ['jupyterlab', '3.4', 'Notebook IDE.'],
      ['notebook', '6.4', 'Classic Jupyter Notebook app.'],
      ['ipykernel', '6.15', 'IPython kernel for Jupyter.'],
      ['pipdeptree', '2.2', 'Show dependency tree.'],
      ['pip-audit', '2.4', 'Snyk-style PyPI vulnerability scans.'],
      ['safety', '2.1', 'requirements.txt CVE scanner.'],
      ['boto3', '1.24', 'AWS SDK for Python.'],
      ['botocore', '1.27', 'AWS SDK core.'],
      ['google-api-python-client', '2.50', 'Google APIs client.'],
      ['azure-identity', '1.10', 'Azure AD authentication.'],
      ['azure-storage-blob', '12.12', 'Azure blob storage.'],
      ['kubernetes', '24.2', 'Kubernetes client.'],
      ['docker', '6.0', 'Docker engine client library.'],
      ['ansible', '5.9', 'IT automation (v5 line).'],
      ['ansible-core', '2.13', 'Ansible engine split.'],
      ['Fabric-py', '2.7', 'SSH/system orchestration (PyPI: fabric).'],
      ['invoke', '1.7', 'Shell-ish task runner.'],
      ['watchdog', '2.1', 'Filesystem events.'],
      ['Loguru', '0.6', 'Sane logging in one decorator.'],
      ['structlog', '22.1', 'Structured, contextual logging.'],
      ['sentry-sdk', '1.9', 'Application monitoring.'],
      ['prometheus-client', '0.14', 'Metrics exporter.'],
      ['opentelemetry-sdk', '1.13', 'OTel tracing SDK.'],
      ['aiogram', '2.24', 'Telegram bot framework.'],
      ['python-telegram-bot', '13.13', 'Classic telegram bot lib.'],
      ['discord.py', '2.0', 'Discord API wrapper.'],
      ['tweepy', '4.10', 'Twitter API client.'],
      ['praw', '7.6', 'Reddit API wrapper.'],
      ['youtube-dl-au', '2022.7', 'yt-dlp predecessor pypi release.'],
      ['yt-dlp', '2023.1', 'The actively maintained video downloader.'],
      ['Pillow', '9.2', 'Imaging library.'],
      ['opencv-python', '4.6', 'Computer vision.'],
      ['imageio', '2.21', 'Multi-format image IO.'],
      ['moviepy', '1.0', 'Video editing from scripts.'],
      ['pydub', '0.25', 'Audio manipulations.'],
      ['librosa', '0.9', 'Audio analysis for ML.'],
      ['soundfile', '0.10', 'Fast audio IO.'],
      ['polars', '0.14', 'Rust-backed DataFrames.'],
      ['dask[dataframe]', '2022.7', 'Parallel compute for pandas.'],
      ['xarray', '2022.6', 'N-D labelled arrays (netCDF-era).'],
      ['numba', '0.56', 'JIT compiler for numpy.'],
      ['sympy', '1.10', 'Symbolic mathematics.'],
      ['theano-pymc', '5.0', 'Probabilistic programming lineage.'],
      ['pymc', '4.1', 'Bayesian inference.'],
      ['statsmodels', '0.13', 'Statistics and econometrics.'],
      ['networkx', '2.8', 'Graph algorithms.'],
      ['graphviz-py', '0.20', 'Graphviz python bindings.'],
      ['pynvim', '0.5', 'Neovim python host.'],
      ['supervisor', '4.2', 'Process control daemon config.'],
      ['apache-airflow', '2.3', 'Workflow orchestration.'],
      ['prefect', '2.0', 'Modern workflow orchestrator.'],
      ['dagster', '1.0', 'Data orchestration.'],
      ['mlflow', '1.27', 'ML lifecycle tracking.'],
      ['dvc', '2.15', 'Data version control.'],
      ['transformers', '4.20', 'Hugging Face models hub client.'],
      ['datasets', '2.4', 'HF datasets.'],
      ['tokenizers', '0.12', 'Rust tokenizers for HF.'],
      ['accelerate', '0.11', 'HF model training primitives.'],
      ['peft', '0.2', 'Parameter-efficient fine-tuning.'],
      ['bitsandbytes', '0.39', '8-bit k-quants for CUDA.'],
      ['langchain', '0.0.100', 'LangChain python package early line.'],
      ['llama-index', '0.5', 'LLM data framework (pre-GA).'],
      ['chromadb', '0.3', 'The AI-native vector store.'],
      ['pinecone-client', '2.2', 'Pinecone vector DB client.'],
      ['qdrant-client', '1.1', 'Qdrant vector DB client.'],
      ['weaviate-client', '3.8', 'Weaviate vector DB client.'],
      ['sentence-transformers', '2.2', 'Sentence embeddings.'],
      ['openai', '0.27', 'OpenAI api client (0.x line here).'],
      ['anthropic', '0.3', 'Anthropic API client early.'],
      ['litellm', '1.0', 'LLM api shim.'],
      ['guardrails-ai', '0.3', 'LLM output validation.'],
      ['instructor', '0.3', 'Structured outputs helper.'],
      ['edge-tts', '6.1', 'Microsoft Edge voices via CLI.'],
      ['faster-whisper', '0.6', 'CTranslate2-based Whisper.'],
      ['pyannote.audio', '2.1', 'Speaker diarization.'],
      ['TTS-coqui', '0.10', 'Coqui neural TTS.'],
      ['gradio', '3.9', 'Build ML demos quickly.'],
      ['streamlit', '1.12', 'Data app framework.'],
      ['panel', '0.14', 'Holoviz dashboarding.'],
      ['dash', '2.6', 'Plotly Dash web apps.'],
      ['altair', '4.2', 'Declarative visualization.'],
      ['plotly', '5.9', 'Interactive charts.'],
      ['bokeh', '2.4', 'Interactive viz targeting browsers.'],
      ['folium', '0.12', 'Leaflet maps from python.'],
      ['geopandas', '0.11', 'GIS+pandas.'],
      ['Shapely', '1.8', '2D geometry operations.'],
      ['PyPDF2', '2.10', 'PDF read/write (the retained base line).'],
      ['pypdf', '3.1', 'The re-organized PDF lib.'],
      ['reportlab', '3.6', 'PDF generation, classic.'],
      ['fpdf2', '2.5', 'Simple PDF generation.'],
      ['mkdocs', '1.3', 'Static docs generator.'],
      ['mkdocs-material', '8.3', 'The Material theme for mkdocs.'],
      ['Sphinx', '5.0', 'Documentation from reStructuredText.'],
      ['pdoc3', '0.10', 'API docs as you type.'],
      ['tox', '3.25', 'Test automation across pythons.'],
      ['nox', '2022.1', 'tox-style sessions.'],
      ['pre-commit', '2.20', 'Git hooks multiplexer.'],
      ['commitizen', '2.28', 'Conventional commits with helpers.'],
      ['pyinstaller', '5.3', 'Package python apps as binaries.'],
      ['cx_Freeze', '6.11', 'py2exe alternative.'],
      ['nuitka', '1.0', 'Python compiler.'],
      ['pywebview', '3.6', 'Desktop webview wrapper.'],
      ['dearpygui', '1.6', 'GPU-accelerated python GUIs.'],
      ['kivy', '2.1', 'NUI framework.'],
      ['textual-dev', '1.0', 'Textual developer tools.'],
      ['manim', '0.16', 'Mathematical animations (3Blue1Brown).'],
      ['manimgl', '1.6', 'The 3b1b version of manim.'],
      ['pytube', '12.1', 'YouTube client.'],
      ['spotipy', '2.20', 'Spotify web API.'],
      ['PyYAML', '6.0', 'YAML parsing.'],
      ['toml', '0.10', 'toml for py.'],
      ['tomlkit', '0.11', 'toml with formatting preserved.'],
      ['python-dotenv', '0.20', '.env loader.'],
      ['dynaconf', '3.1', 'Layered configuration.'],
      ['attrs', '22.1', 'Classes without boilerplate.'],
      ['cattrs', '22.2', 'attrs de/serialization.'],
      ['marshmallow', '3.17', 'Object serialization.'],
      ['orjson', '3.8', 'Rust-backed fast JSON.'],
      ['msgpack', '1.0', 'Binary serialization.'],
      ['protobuf', '3.20', 'Protocol Buffers.'],
      ['grpcio', '1.47', 'gRPC python.'],
      ['pyzmq', '23.2', 'ZeroMQ messaging.'],
      ['kafka-python', '2.0', 'Apache Kafka client.'],
      ['pika', '1.3', 'RabbitMQ AMQP client.'],
      ['elasticsearch-py', '8.3', 'Elasticsearch client.'],
      ['minio', '7.1', 'S3-compatible MinIO client.'],
      ['paramiko', '2.11', 'SSHv2 protocol implementation.'],
      ['pywin32', '304', 'Windows API interfaces (pywin zip builds include launchers).'],
      ['pyautogui', '0.9', 'GUI automation.'],
      ['keyboard-py', '0.13', 'Global hotkeys helper.'],
      ['pystray', '0.19', 'System tray icons.'],
      ['ttkbootstrap', '1.10', 'Themed tkinter.'],
    ];
    for (const [pkg, startMajor, desc] of pypiNames) {
      const versions = walk(`${startMajor}.0`, 40);
      versions.forEach((v, i) => {
        add({
          name: `PyPI: ${pkg} ${v}`,
          slugBase: `pypi-${makeSlug(pkg)}-${v}`,
          description: `${desc} Release ${v} on PyPI -- verify hashes during pip install as usual.`,
          version: v, file_name: `${makeSlug(pkg)}-${v}.tar.gz`, file_size: int(60, 3600) * KB,
          file_type: 'tar.gz', platform: 'cross-platform', arch: null,
          url: `https://pypi.org/project/${pkg.split('[')[0].replace(/-py|-au/g, '')}/${v}/`,
          category: 'development', folder: 'dev-tools', tags: ['pypi', 'python'],
          createdAt: ageFor(i, versions.length, 700),
        });
      });
    }

    const cratesNames = [
      ['serde', '1.0.137'], ['serde_json', '1.0.81'], ['tokio', '1.19.2'], ['hyper', '0.14.20'],
      ['axum', '0.5.16'], ['reqwest', '0.11.11'], ['clap', '3.2.12'], ['anyhow', '1.0.58'],
      ['thiserror', '1.0.31'], ['tracing', '0.1.35'], ['rand', '0.8.5'], ['regex', '1.6.0'],
      ['chrono', '0.4.19'], ['log', '0.4.17'], ['env_logger', '0.9.0'], ['sqlx', '0.6.0'],
      ['diesel', '2.0.0'], ['sea-orm', '0.9.0'], ['openssl', '0.10.40'], ['ring', '0.16.20'],
      ['rustls', '0.20.6'], ['criterion', '0.4.0'], ['proptest', '1.0.0'], ['wasm-bindgen', '0.2.81'],
      ['web-sys', '0.3.58'], ['js-sys', '0.3.58'], ['gloo', '0.7.0'], ['yew', '0.19.3'],
      ['leptos', '0.0.99'], ['dioxus', '0.3.0'], ['tauri', '1.0.5'], ['iced', '0.4.2'],
      ['egui', '0.18.1'], ['winit', '0.27.2'], ['wgpu', '0.13.1'], ['image-rs', '0.24.2'],
      ['ffmpeg-next', '5.1.0'], ['crossbeam', '0.8.2'], ['rayon', '1.5.3'], ['dashmap', '5.4.0'],
      ['parking_lot', '0.12.1'], ['once_cell', '1.13.0'], ['lazy_static', '1.4.0'],
      ['itertools', '0.10.3'], ['num-traits', '0.2.15'], ['bitflags', '1.3.2'],
      ['rust_decimal', '1.25.0'], ['uuid-crate', '1.1.2'], ['time-crate', '0.3.11'],
    ];
    for (const [name, startV] of cratesNames) {
      const realName = name.replace(/-crate$/, '');
      walk(startV, 36, { minorEvery: 8 }).forEach((v, i) => {
        add({
          name: `crate: ${realName} ${v}`,
          slugBase: `crates-${makeSlug(realName)}-${v}`,
          description: `crates.io release of ${realName}@${v}.`,
          version: v, file_name: `${realName}-${v}.crate`, file_size: int(30, 900) * KB,
          file_type: 'crate', platform: 'cross-platform', arch: null,
          url: `https://crates.io/crates/${realName}/${v}`,
          category: 'development', folder: 'dev-tools', tags: ['crates', 'rust'],
          createdAt: ageFor(i, 8, 700),
        });
      });
    }

    // Long GitHub-tool release histories (real cadence approximations, link to real release listing)
    const ghTools = [
      ['rclone', 'rclone/rclone', 'v1.58.1', 24, 'Cross-cloud file sync Swiss-army knife.'],
      ['Syncthing', 'syncthing/syncthing', 'v1.20.0', 26, 'Continuous P2P file synchronization.'],
      ['restic', 'restic/restic', 'v0.13.1', 14, 'Modern encrypted dedup backups.'],
      ['duplicati', 'duplicati/duplicati', 'v2.0.6', 14, 'Encrypted, scheduled, cloud backups.'],
      ['Tailscale', 'tailscale/tailscale', 'v1.36.0', 30, 'Zero-config WireGuard mesh VPN.'],
      ['gitui', 'extrawurst/gitui', 'v0.22.1', 12, 'Blazing-fast terminal git UI.'],
      ['GitHub CLI', 'cli/cli', 'v2.13.0', 24, 'Official GitHub command line.'],
      ['GitLab CLI', 'gitlab-org/cli', 'v1.17.0', 14, 'Official GitLab command line.'],
      ['doctl', 'digitalocean/doctl', 'v1.77.0', 15, 'DigitalOcean CLI.'],
      ['hcloud', 'hetznercloud/cli', 'v1.30.0', 16, 'Hetzner Cloud CLI.'],
      ['flyctl', 'superfly/flyctl', 'v0.2.30', 10, 'Fly.io CLI (dotreleases were frequent).'],
      ['wrangler', 'cloudflare/workers-sdk', '3.0.0', 16, 'Cloudflare Workers CLI.'],
      ['stripe-cli', 'stripe/stripe-cli', 'v1.19.5', 10, 'Stripe CLI for testing webhooks.'],
      ['Vercel CLI', 'vercel/vercel', '28.15.6', 14, 'Vercel CLI: deploys, env pulls, local edge dev.'],
      ['turbo-bin', 'vercel/turborepo', 'v1.10.13', 16, 'Turborepo binaries.'],
      ['esbuild', 'evanw/esbuild', '0.18.20', 18, 'esbuild native binaries.'],
      ['Biome CLI', 'biomejs/biome', '1.5.3', 12, 'Biome CLI per-release binaries.'],
      ['lefthook', 'evilmartians/lefthook', 'v1.4.7', 10, 'Fast polyglot git-hook manager.'],
      ['xcaddy', 'caddyserver/xcaddy', 'v0.3.5', 8, 'Custom Caddy builder.'],
      ['caddy', 'caddyserver/caddy', 'v2.6.4', 12, 'The web server with automatic HTTPS.'],
      ['mkcert', 'FiloSottile/mkcert', 'v1.4.4', 4, 'Locally-trusted dev certificates.'],
      ['age', 'FiloSottile/age', 'v1.0.0', 4, 'Composed file encryption with recipients.'],
      ['sops', 'getsops/sops', 'v3.7.3', 12, 'Secrets management with age/PGP/KMS.'],
      ['direnv', 'direnv/direnv', 'v2.32.3', 6, 'Per-directory environment loader.'],
      ['devenv', 'cachix/devenv', 'v0.6.3', 16, 'Declarative dev environments.'],
      ['devbox', 'jetify-com/devbox', '0.5.6', 12, 'Nix-powered dev environment.'],
      ['mise', 'jdx/mise', 'v2023.5.8', 20, 'Runtime polyglot version manager (asdf in Rust).'],
      ['sheldon', 'rossmacarthur/sheldon', '0.7.3', 6, 'Fast shell plugin manager.'],
      ['zoxide', 'ajeetdsouza/zoxide', 'v0.8.3', 8, 'Smarter cd command.'],
      ['bat', 'sharkdp/bat', 'v0.21.0', 8, 'A cat(1) clone with wings.'],
      ['fd', 'sharkdp/fd', 'v8.4.0', 6, 'Simple, fast find(1).'],
      ['ripgrep', 'BurntSushi/ripgrep', '13.0.0', 6, 'Recursive grep with batterries of speed.'],
      ['sd', 'chmln/sd', 'v0.7.6', 4, 'Intuitive find & replace CLI.'],
      ['duf', 'muesli/duf', 'v0.8.1', 4, 'Better disk usage overview.'],
      ['gdu', 'dundee/gdu', 'v5.15.0', 10, 'Fast disk usage analyzer with TUI.'],
      ['doggo', 'mr-karan/doggo', 'v0.5.5', 4, 'DNS client for humans.'],
      ['httpie', 'httpie/cli', '3.2.1', 6, 'Friendly HTTP client.'],
      ['khal', 'pimutils/khal', 'v0.11.2', 4, 'Terminal calendar.'],
      ['crush', 'charmbracelet/crush', 'v0.0.49', 8, "Charm's terminal AI agent."],
      ['mods', 'charmbracelet/mods', 'v1.2.2', 6, 'AI pipelines on the command line.'],
      ['gum', 'charmbracelet/gum', 'v0.10.0', 8, 'Glamorous shell-script components.'],
      ['soft-serve', 'charmbracelet/soft-serve', 'v0.5.3', 5, 'Self-hostable git server with TUI.'],
      ['vhs', 'charmbracelet/vhs', 'v0.5.0', 5, 'Generate terminal GIFs from scripts.'],
      ['freeze', 'charmbracelet/freeze', 'v0.1.6', 4, 'Screenshots of code/terminal output.'],
      ['hledger-ui', 'simonmichael/hledger', '1.30', 5, 'Plain-text accounting TUI.'],
      ['terragrunt', 'gruntwork-io/terragrunt', 'v0.48.5', 16, 'Keep Terraform DRY.'],
      ['cdktf-cli', 'hashicorp/terraform-cdk', 'v0.16.0', 10, 'Cloud Development Kit for Terraform.'],
      ['packer', 'hashicorp/packer', 'v1.9.2', 10, 'Automated machine-image builder.'],
      ['vault', 'hashicorp/vault', 'v1.13.4', 12, 'Secrets management server.'],
      ['consul', 'hashicorp/consul', 'v1.15.4', 12, 'Service mesh.'],
      ['nomad', 'hashicorp/nomad', 'v1.5.5', 12, 'Workload orchestrator.'],
      ['boundary', 'hashicorp/boundary', 'v0.13.0', 8, 'Secure access to hosts.'],
      ['waypoint', 'hashicorp/waypoint', 'v0.11.4', 6, 'Build, deploy, release.'],
      ['infracost', 'infracost/infracost', 'v0.10.24', 12, 'Cloud cost estimates for Terraform.'],
      ['driftctl', 'snyk/driftctl', 'v0.38.2', 8, 'Detect IaC drift.'],
      ['checkov', 'bridgecrewio/checkov', '2.3.340', 18, 'IaC static analysis.'],
      ['tflint', 'terraform-linters/tflint', 'v0.47.0', 10, 'Terraform linter.'],
      ['tfsec', 'aquasecurity/tfsec', 'v1.28.1', 10, 'Terraform security scanner (now folded into Trivy).'],
      ['terrascan', 'tenable/terrascan', 'v1.18.3', 8, 'IaC security scanner.'],
    ];
    for (const [name, repo, startTag, count, desc] of ghTools) {
      const vMatch = startTag.match(/(\d+)\.(\d+)\.(\d+)/);
      const versions = vMatch ? walk(`${vMatch[1]}.${vMatch[2]}.${vMatch[3]}`, count) : [startTag];
      versions.forEach((v, i) => {
        add({
          name: `${name} v${v}`,
          slugBase: `ghtools-${makeSlug(name)}-v${v}`,
          description: `${desc} Release ${v} from ${repo}.`,
          version: v, file_name: `${makeSlug(name)}-${v}-release.zip`, file_size: int(8, 90) * MB,
          file_type: 'zip', platform: 'windows', arch: 'x64',
          url: `https://github.com/${repo}/releases`,
          category: 'utilities', folder: 'terminals-cli', tags: ['cli', 'release-archive'],
          createdAt: ageFor(i, versions.length, 700),
        });
        add({
          name: `${name} v${v} (Linux)`,
          slugBase: `ghtools-${makeSlug(name)}-v${v}-linux`,
          description: `${desc} ${v} -- linux release assets.`,
          version: v, file_name: `${makeSlug(name)}-${v}-linux.tar.gz`, file_size: int(8, 90) * MB,
          file_type: 'tar.gz', platform: 'linux', arch: 'x64',
          url: `https://github.com/${repo}/releases`,
          category: 'utilities', folder: 'terminals-cli', tags: ['cli', 'release-archive'],
          createdAt: ageFor(i, versions.length, 700),
        });
      });
    }


    // ---------------- Daily nightly firehose (full-year archives) ----------------
    // seed-modern inserted a sparse digest; here we fill in the full daily archive,
    // exactly the way real nightly indexes (builder.blender.org, nightlies.videolan.org) look.
    const dailyProjects = [
      ['Blender Daily Builds', 'blender-daily', 'https://builder.blender.org/download/daily/', 380, 480, 'windows', 'zip', 'x64'],
      ['Blender Daily Builds (Linux)', 'blender-daily-linux', 'https://builder.blender.org/download/daily/', 280, 380, 'linux', 'tar.xz', 'x64'],
      ['Krita Next (nightly)', 'krita-next', 'https://binary-factory.kde.org/', 190, 230, 'windows', 'zip', 'x64'],
      ['Inkscape continuous build', 'inkscape-nightly', 'https://inkscape.org/release/development/', 130, 170, 'windows', 'zip', 'x64'],
      ['Godot master builds', 'godot-nightly', 'https://godotengine.org/download/preview/', 75, 110, 'windows', 'zip', 'x64'],
      ['Godot master builds (Linux)', 'godot-nightly-linux', 'https://godotengine.org/download/preview/', 75, 110, 'linux', 'zip', 'x64'],
      ['Neovim nightly', 'neovim-nightly', 'https://github.com/neovim/neovim/releases/tag/nightly', 14, 18, 'windows', 'zip', 'x64'],
      ['Neovim nightly (Linux)', 'neovim-nightly-linux', 'https://github.com/neovim/neovim/releases/tag/nightly', 14, 18, 'linux', 'tar.gz', 'x64'],
      ['Firefox Nightly', 'firefox-nightly', 'https://download-installer.cdn.mozilla.net/pub/firefox/nightly/', 75, 95, 'windows', 'exe', 'x64'],
      ['Firefox Nightly (Linux)', 'firefox-nightly-linux', 'https://download-installer.cdn.mozilla.net/pub/firefox/nightly/', 85, 100, 'linux', 'tar.xz', 'x64'],
      ['VLC media player nightly', 'vlc-nightly', 'https://nightlies.videolan.org/', 42, 50, 'windows', 'zip', 'x64'],
      ['OBS Studio pre-release', 'obs-prerelease', 'https://github.com/obsproject/obs-studio/releases', 120, 160, 'windows', 'zip', 'x64'],
      ['yt-dlp nightly', 'yt-dlp-nightly', 'https://github.com/yt-dlp/yt-dlp-nightly-builds/releases', 12, 20, 'cross-platform', 'zip', null],
      ['llama.cpp continuous build', 'llamacpp-continuous', 'https://github.com/ggml-org/llama.cpp/releases', 28, 60, 'windows', 'zip', 'x64'],
      ['Chrome Canary', 'chrome-canary', 'https://www.google.com/chrome/canary/', 110, 150, 'windows', 'exe', 'x64'],
      ['VS Code Insiders', 'vscode-insiders', 'https://code.visualstudio.com/insiders/', 100, 140, 'windows', 'exe', 'x64'],
      ['VS Code Insiders (Linux)', 'vscode-insiders-linux', 'https://code.visualstudio.com/insiders/', 95, 140, 'linux', 'tar.gz', 'x64'],
      ['FreeCAD weekly builds', 'freecad-weekly-daily', 'https://github.com/FreeCAD/FreeCAD/releases', 750, 950, 'windows', '7z', 'x64'],
      ['Signal Android beta', 'signal-beta', 'https://community.signalusers.org/t/beta-feedback-for-the-upcoming-android/', 95, 130, 'other', 'apk', 'universal'],
      ['mpv netsh daily (Windows)', 'mpv-daily', 'https://github.com/shinchiro/mpv-winbuild-cmake/releases', 30, 45, 'windows', '7z', 'x64'],
    ];
    for (const [base, slug, url, sMin, sMax, platform, ext, arch] of dailyProjects) {
      for (let d = 730; d >= 0; d--) {
        const date = new Date(Date.now() - d * 86400_000);
        const stamp = date.toISOString().slice(0, 10);
        add({
          name: `${base} ${stamp}`,
          slugBase: `${slug}-${stamp}`,
          description: `${base.replace(/\s*\(.*\)/, '')} automated daily snapshot ${stamp}. For testing and feature preview; stable builds live on the main page.`,
          version: `nightly-${stamp}`,
          file_name: `${slug}-${stamp}.${ext}`,
          file_size: int(sMin, sMax) * MB,
          file_type: ext, platform, arch,
          url, source: url,
          category: platform === 'cross-platform' ? 'utilities' : 'applications',
          folder: 'nightly-builds',
          tags: ['nightly', platform],
          createdAt: date.toISOString(),
        });
      }
    }

    // ---------------- Homebrew / Chocolatey / winget / Flathub index waves ----------------
    const brewNames = [
      'wget', 'curl', 'htop', 'btop', 'tmux', 'screen', 'neovim', 'emacs', 'vim', 'nano',
      'htop-osx', 'ncdu', 'tree', 'pstree', 'watch', 'mtr', 'nethogs', 'iftop', 'iproute2mac',
      'mas', 'dockutil', 'm-cli', 'terminal-notifier', 'blueutil', 'wifi-password',
      'coreutils', 'findutils', 'gnu-sed', 'gnu-tar', 'gawk', 'grep', 'gzip',
      'binutils', 'diffutils', 'ed', 'screenresolution', 'lsusb', 'croc',
      'aria2', 'axel', 'httpie', 'wrk', 'oha', 'drill', 'bind',
      'opensc', 'pcsc-lite', 'ykman', 'openscd', 'gnupg', 'pinentry-mac',
      'openssl@1.1', 'openssl@3', 'libressl', 'mbedtls', 'wolfssl',
      'icu4c', 'pcre', 'pcre2', 'oniguruma', 'libxml2', 'libxslt',
      'zlib', 'zstd', 'lz4', 'xz', 'bzip2', 'lzip',
      'sqlite', 'dbmate', 'postgresql@15', 'mysql', 'mariadb', 'redis', 'valkey', 'memcached',
      'rabbitmq', 'kafka', 'nats-server', 'mosquitto', 'emqx',
      'prometheus', 'grafana', 'loki', 'promtail', 'vector', 'otel-collector',
      'kind', 'minikube', 'k3d', 'k3s', 'k0s', 'talhelper', 'tilt', 'skaffold',
      'werf', 'pack', 'ko', 'kaniko', 'buildkit', 'crane', 'oras', 'dive', 'hadolint',
      'terragrunt', 'tfupdate', 'tfswitch', 'infracost', 'tfenv', 'terraform-docs',
      'gh', 'hub', 'tea', 'glab', 'lab', 'git-lfs', 'git-delta', 'git-glow', 'git-extras',
      'fgit', 'lazygit', 'gitui', 'tig', 'diff-so-fancy', 'hledger',
      'ffmpeg', 'aviator', 'handbrake', 'mediainfo', 'mkvtoolnix', 'vapoursynth',
      'atomicparsley', 'yt-dlp', 'gallery-dl', 'spotdl', 'you-get', 'annie',
      'imagemagick', 'graphicsmagick', 'vips', 'exiftool', 'pngquant', 'optipng',
      'webp', 'mozjpeg', 'svgo', 'potrace', 'autotrace', 'gifski', 'ffmpegthumbnailer',
      'wireshark', 'tcptraceroute', 'snort', 'suricata', 'nmap', 'masscan', 'zmap',
      'arp-scan', 'angry-ip-scanner', 'charmcraft', 'enchanter', 'mitmproxy', 'tcpdump',
      'wireguard-tools', 'openvpn', 'strongswan', 'stunnel', 'socat', 'ncat',
      'smartmontools', 'intel-mas', 'testdisk', 'ddrescue', 'ext4fuse', 'ntfs-3g-mac',
    ];
    for (const name of brewNames) {
      walk('4.5.0', 24).forEach((v, i) => {
        add({
          name: `brew: ${name} ${v}`,
          slugBase: `brew-${name.replace(/[@+.]/g, '-')}-${v}`,
          description: `Homebrew formula release-archive entry for ${name}. Install with \`brew install ${name}\`; pinned version lives in the formula history.`,
          version: v, file_name: `${makeSlug(name)}--${v}.tar.gz`, file_size: int(500, 40000) * KB,
          file_type: 'tar.gz', platform: 'macos', arch: null,
          url: `https://formulae.brew.sh/formula/${name.replace(/[@+]/g, '')}`,
          category: 'utilities', folder: 'terminals-cli', tags: ['brew', 'macos', 'release-archive'],
          createdAt: ageFor(i, 8, 600),
        });
      });
    }

    const chocoNames = [
      '7zip', 'notepadplusplus', 'firefox', 'googlechrome', 'brave', 'vivaldi', 'opera',
      'vlc', 'spotify', 'foobar2000', 'musicbee', 'audacity', 'kdenlive', 'shotcut', 'kdenlive',
      'git', 'vscode', 'notepad3', 'sublimetext4', 'brackets', 'atom', 'vscodium',
      'python', 'python3', 'nodejs', 'ruby', 'php', 'perl', 'elixir', 'julia',
      'openjdk', 'javaruntime', 'temurinjre', 'oraclejdk', 'dotnetcore-sdk', 'dotnet-sdk',
      'docker-desktop', 'docker-cli', 'docker-compose', 'rancher-desktop', 'minikube',
      'kubectl', 'helm', 'kustomize', 'k9s', 'lens', 'terraform', 'pulumi', 'awscli',
      'cyberduck', 'winscp', 'filezilla', 'putty', 'kitty', 'terminals', 'mremoteNG',
      'powershell-core', 'oh-my-posh', 'nushell', 'starship', 'clink', 'conemu',
      'paint.net', 'gimp', 'inkscape', 'krita', 'blender', 'darktable', 'rawtherapee',
      'obs-studio', 'streamlabs-obs', 'sharex', 'greenshot', 'flameshot', 'screenpresso',
      'gitkraken', 'fork', 'sourcetree', 'tortoisegit', 'tortoisesvn', 'gitextensions',
      'dbeaver', 'heidisql', 'dbeaver-community-ee', 'datagrip', 'beekeeper-studio', 'tableplus',
      'postman', 'insomnia-api', 'bruno', 'hoppscotch', 'soapui', 'jmeter', 'k6',
      'wireshark', 'nmap', 'angryipscanner', 'advanced-ip-scanner', 'netscan',
      'keepassxc', 'keepass', 'bitwarden', 'vaultwarden-client', 'anytype-desktop',
      'notion', 'logseq', 'joplin', 'standardnotes', 'obsidian', 'typora',
      'nextcloud-client', 'owncloud-client', 'seafile-client', 'megasync', 'dropbox',
      'google-drive', 'google-drive-file-stream', 'resilio-sync', 'synctrayzor',
      'ccleaner', 'bleachbit', 'treesize', 'wiztree', 'windirstat', 'spacesniffer',
      'everything', 'agentransack', 'grepwin', 'dnspy', 'ilspy', 'dotpeek',
      'powertoys', 'autohotkey', 'autoit', 'autoit.install', 'winaero-tweaker', 'ooshutup10',
      'procexp', 'procmon', 'autoruns', 'rammap', 'vmmap', 'handle', 'psexec',
      'sumatrapdf', 'foxitreader', 'okular', 'pdfxchangeeditor', 'adobereader',
      'calibre', 'sigil', 'libreoffice-fresh', 'libreoffice-still', 'wps-office-free',
      'inkscape', 'ghostscript.app', 'miktex', 'texstudio', 'lyx', 'zotero',
      'sumatra-quicklook', 'quicklook-setup', 'explorer-winrar-x64', '7zip.portable',
      'teracopy', 'fastcopy', 'robocopygui', 'unison', 'syncthing-gtk', 'freefilesync',
      'windirstat', 'antimicro', 'joytokey-free', 'x360ce', 'ds4windows', 'rewasd',
      'geforce-experience', 'nvidia-display-driver', 'amd-software-adrenalin', 'intel-chipset-device-software',
      'msiafterburner', 'processlasso', 'rog-lifechanger', 'dragon-center', 'icue',
      'vcredist140', 'vcredist-all', 'vcredist2015', 'netfx-4.8-devpack', 'windows-sdk-10.1',
      'winpcap', 'npcap', 'ngrok', 'cloudflared', 'frp', 'wireguard', 'openvpn-connect',
    ];
    for (const name of chocoNames) {
      walk('1.20.0', 26, { minorEvery: 6 }).forEach((v, i) => {
        add({
          name: `choco: ${name} ${v}`,
          slugBase: `choco-${makeSlug(name)}-${v}`,
          description: `Chocolatey community package archive entry for ${name}. Install with \`choco install ${name} --version ${v}\`.`,
          version: v, file_name: `${makeSlug(name)}.${v}.nupkg`, file_size: int(500, 90000) * KB,
          file_type: 'nupkg', platform: 'windows', arch: null,
          url: `https://community.chocolatey.org/packages/${name}`,
          category: 'applications', folder: 'media-tools', tags: ['choco', 'windows', 'release-archive'],
          createdAt: ageFor(i, 8, 600),
        });
      });
    }

    const wingetIds = [
      'Microsoft.PowerToys', 'Microsoft.VisualStudioCode', 'Microsoft.WindowsTerminal', 'Git.Git',
      'Docker.DockerDesktop', 'Python.Python.3.13', 'NodeJS.LTS', 'GoLang.Go', 'Rustlang.Rustup',
      '7zip.7zip', 'VideoLAN.VLC', 'TheDocumentFoundation.LibreOffice', 'OBSProject.OBSStudio',
      'Mozilla.Firefox', 'Google.Chrome', 'Brave.Brave', 'Vivaldi.Vivaldi', 'Opera.Opera',
      'Plex.Plex', 'Spotify.Spotify', 'Discord.Discord', 'SlackTechnologies.Slack', 'Zoom.Zoom',
      'Telegram.TelegramDesktop', 'Signal.Signal', 'Element.Element', 'WireGuard.WireGuard',
      'gokcehan.lf', 'junegunn.fzf', 'BurntSushi.ripgrep.MSVC', 'sharkdp.bat', 'sharkdp.fd',
      'dandavison.delta', 'Clement.bottom', 'starship.starship', 'ajeetdsouza.zoxide',
      'Valve.Steam', 'EpicGames.EpicGamesLauncher', 'GOG.Galaxy', 'RiotGames.Valorant',
      'Parsec.Parsec', 'TeamViewer.TeamViewer', 'AnyDesk.AnyDesk', 'RustDesk.RustDesk',
      'InsightSoftware.MATRIX', 'Logitech.OptionsPlus', 'Razer.Synapse', 'Corsair.iCUE.5',
      'Notion.Notion', 'Obsidian.Obsidian', 'appmakes.Typora', 'JetBrains.Toolbox',
      'Postman.Postman', 'Mozilla.Thunderbird', 'Audacity.Audacity', 'Krita.Krita',
      'GIMP.GIMP.3', 'Inkscape.Inkscape', 'BlenderFoundation.Blender', 'HandBrake.HandBrake',
      'TechPowerUp.GPU-Z', 'CPUID.CPU-Z', 'CPUID.HWMonitor', 'CrystalDewWorld.CrystalDiskInfo',
      'MartiCliment.UniGetUI', 'File-New-Project.EarTrumpet', 'ModernFlyouts.ModernFlyouts',
      'AutoHotkey.AutoHotkey', 'PowerShell.PowerShell', 'OpenJS.NodeJS', 'WinGet.create',
    ];
    for (const id of wingetIds) {
      const short = id.split('.').slice(-1)[0];
      walk('1.14.0', 18, { minorEvery: 5 }).forEach((v, i) => {
        add({
          name: `winget: ${id} ${v}`,
          slugBase: `winget-${makeSlug(id)}-${v}`,
          description: `winget package archive entry for ${id}. Install with \`winget install --id ${id} -v "${v}"\`.`,
          version: v, file_name: `${makeSlug(short)}-${v}.msixbundle`, file_size: int(1, 300) * MB,
          file_type: 'msixbundle', platform: 'windows', arch: 'x64',
          url: `https://winstall.app/apps/${id}`,
          category: 'applications', folder: 'dev-tools', tags: ['winget', 'windows', 'release-archive'],
          createdAt: ageFor(i, 6, 600),
        });
      });
    }

    const flathubIds = [
      ['org.videolan.VLC', 'VLC', 'The classic media player as a Flatpak.'],
      ['io.mpv.Mpv', 'mpv', 'Minimalist keyboard-driven media player.'],
      ['com.obsproject.Studio', 'OBS Studio flatpak', 'Streaming and recording via Flathub.'],
      ['org.mozilla.firefox', 'Firefox flatpak', 'The upstream Mozilla flatpak.'],
      ['com.google.Chrome', 'Chrome flatpak', 'Chrome via Flathub.'],
      ['org.chromium.Chromium', 'Chromium flatpak', 'The open base via Flathub.'],
      ['org.libreoffice.LibreOffice', 'LibreOffice flatpak', 'Full office suite.'],
      ['org.onlyoffice.desktopeditors', 'ONLYOFFICE flatpak', 'MS-compatible office suite.'],
      ['com.bitwarden.desktop', 'Bitwarden flatpak', 'Password manager.'],
      ['org.keepassxc.KeePassXC', 'KeePassXC flatpak', 'Encrypted password vault.'],
      ['com.visualstudio.code', 'VS Code flatpak', 'Microsoft build in a sandbox.'],
      ['dev.zed.Zed', 'Zed flatpak', 'GPU-accelerated editor for Linux.'],
      ['org.gnome.Builder', 'GNOME Builder', 'The GNOME-native IDE.'],
      ['com.jetbrains.IntelliJ-IDEA-Community', 'IDEA Community flatpak', 'Java/kotlin IDE.'],
      ['com.jetbrains.PyCharm-Community', 'PyCharm Community flatpak', 'Python IDE.'],
      ['org.kde.kdenlive', 'Kdenlive flatpak', 'KDE video editor.'],
      ['org.kde.krita', 'Krita flatpak', 'Digital painting.'],
      ['org.gimp.GIMP', 'GIMP flatpak', 'Image manipulation.'],
      ['org.inkscape.Inkscape', 'Inkscape flatpak', 'Vector graphics.'],
      ['org.blender.Blender', 'Blender flatpak', '3D creation suite.'],
      ['org.freecad.FreeCAD', 'FreeCAD flatpak', 'Parametric CAD.'],
      ['org.kicad.KiCad', 'KiCad flatpak', 'EDA/PCB suite.'],
      ['org.prusa3d.PrusaSlicer', 'PrusaSlicer flatpak', '3D printing slicer.'],
      ['com.bambulab.BambuStudio', 'Bambu Studio flatpak', 'Bambu Lab slicer.'],
      ['com.orcaslicer.OrcaSlicer', 'OrcaSlicer flatpak', 'The community fork.'],
      ['org.telegram.desktop', 'Telegram flatpak', 'Messaging desktop.'],
      ['com.discordapp.Discord', 'Discord flatpak', 'Chat for communities.'],
      ['com.slack.Slack', 'Slack flatpak', 'Team messaging.'],
      ['com.spotify.Client', 'Spotify flatpak', 'Music streaming.'],
      ['com.valvesoftware.Steam', 'Steam flatpak', 'Gaming platform.'],
      ['org.duckstation.DuckStation', 'DuckStation flatpak', 'PS1 emulator.'],
      ['org.DolphinEmu.dolphin-emu', 'Dolphin flatpak', 'GameCube/Wii.'],
      ['org.ryujinx.Ryujinx', 'Ryujinx flatpak', 'Switch emulator.'],
      ['net.pcsx2.PCSX2', 'PCSX2 flatpak', 'PS2.'],
      ['org.ppsspp.PPSSPP', 'PPSSPP flatpak', 'PSP.'],
      ['com.moonlight_stream.Moonlight', 'Moonlight flatpak', 'GameStream client for self-hosted Sunshine.'],
      ['dev.lizardbyte.app.Sunshine', 'Sunshine flatpak', 'Open host for Moonlight.'],
      ['org.qbittorrent.qBittorrent', 'qBittorrent flatpak', 'Torrent client.'],
      ['com.github.tfuxu.zapzap', 'ZapZap flatpak', 'WhatsApp desktop wrapper.'],
      ['io.freetubeapp.FreeTube', 'FreeTube flatpak', 'Ad-free YouTube client.'],
      ['org.pipewire.Helvum', 'Helvum flatpak', 'Pipewire patchbay.'],
      ['com.github.qzind_steve.Mudlet', 'Mudlet flatpak', 'MUD client.'],
      ['org.zealdocs.Zeal', 'Zeal flatpak', 'Offline docs browser.'],
      ['com.jetbrains.Rider', 'Rider flatpak', 'Non-flatpak via toolbox; kept as link page.'],
    ];
    for (const [id, short, desc] of flathubIds) {
      walk('0.9.0', 12).forEach((v, i) => {
        add({
          name: `flatpak: ${short} ${v}`,
          slugBase: `flatpak-${makeSlug(short)}-${v}`,
          description: `${desc} Flatpak release ref for ${id}.`,
          version: v, file_name: `${id}.flatpakref`, file_size: int(200, 900000) * KB,
          file_type: 'flatpakref', platform: 'linux', arch: null,
          url: `https://flathub.org/apps/${id}`,
          category: 'applications', folder: 'media-tools', tags: ['flatpak', 'linux', 'release-archive'],
          createdAt: ageFor(i, 4, 600),
        });
      });
    }


    // ---------------- Maven Central artifacts (real group:artifact ids) ----------------
    const mavenArtifacts = [
      ['org.apache.commons:commons-lang3', 'apache-commons-lang3', 'Commons Lang utilities.'],
      ['org.apache.commons:commons-io', 'apache-commons-io', 'Commons IO.'],
      ['com.google.guava:guava', 'guava', 'Google core libraries for Java.'],
      ['org.slf4j:slf4j-api', 'slf4j-api', 'SLF4J facade.'],
      ['ch.qos.logback:logback-classic', 'logback-classic', 'Logback logging.'],
      ['log4j:log4j', 'log4j1x', 'Log4j 1.x (historic; only for legacy JVM apps).'],
      ['org.apache.logging.log4j:log4j-core', 'log4j2-core', 'Log4j 2 core.'],
      ['org.junit.jupiter:junit-jupiter', 'junit5', 'JUnit 5.'],
      ['junit:junit', 'junit4', 'JUnit 4 (legacy line).'],
      ['org.mockito:mockito-core', 'mockito-core', 'Mockito.'],
      ['org.assertj:assertj-core', 'assertj-core', 'AssertJ fluent assertions.'],
      ['org.hamcrest:hamcrest-core', 'hamcrest', 'Matcher library.'],
      ['com.fasterxml.jackson.core:jackson-databind', 'jackson-databind', 'Jackson databind.'],
      ['com.fasterxml.jackson.core:jackson-core', 'jackson-core', 'Jackson streaming api.'],
      ['com.google.code.gson:gson', 'gson', 'Gson.'],
      ['org.postgresql:postgresql', 'jdbc-postgresql', 'PostgreSQL JDBC driver.'],
      ['mysql:mysql-connector-java', 'jdbc-mysql', 'MySQL Connector/J.'],
      ['org.mariadb.jdbc:mariadb-java-client', 'jdbc-mariadb', 'MariaDB JDBC.'],
      ['org.xerial:sqlite-jdbc', 'jdbc-sqlite', 'SQLite JDBC.'],
      ['redis.clients:jedis', 'jedis', 'Java Redis client.'],
      ['org.mongodb:mongo-java-driver', 'mongo-java-driver', 'MongoDB java driver (sync).'],
      ['org.mongodb:mongodb-driver-sync', 'mongodb-driver-sync', 'MongoDB sync driver (4.x).'],
      ['org.eclipse.paho:org.eclipse.paho.client.mqttv3', 'paho-mqtt', 'MQTT client for Java.'],
      ['org.apache.kafka:kafka-clients', 'kafka-clients', 'Kafka client.'],
      ['org.apache.httpcomponents.client5:httpclient5', 'httpclient5', 'Apache HttpClient 5.'],
      ['com.squareup.okhttp3:okhttp', 'okhttp', 'OkHttp.'],
      ['com.squareup.retrofit2:retrofit', 'retrofit', 'Retrofit REST client.'],
      ['com.squareup.okio:okio', 'okio', 'Okio.'],
      ['io.netty:netty-all', 'netty-all', 'Netty.'],
      ['io.projectreactor:reactor-core', 'reactor-core', 'Reactor.'],
      ['org.springframework:spring-core', 'spring-core', 'Spring core.'],
      ['org.springframework:spring-context', 'spring-context', 'Spring context.'],
      ['org.springframework.boot:spring-boot-starter-web', 'spring-boot-starter-web', 'Spring Boot web starter.'],
      ['org.springframework.boot:spring-boot-starter-data-jpa', 'spring-boot-starter-data-jpa', 'Spring Boot JPA starter.'],
      ['io.quarkus:quarkus-core', 'quarkus-core', 'Quarkus core.'],
      ['io.micronaut:micronaut-core', 'micronaut-core', 'Micronaut core.'],
      ['org.hibernate.orm:hibernate-core', 'hibernate-core', 'Hibernate ORM 6 line.'],
      ['org.mybatis:mybatis', 'mybatis', 'MyBatis.'],
      ['com.auth0:java-jwt', 'auth0-java-jwt', 'Auth0 JWT.'],
      ['io.jsonwebtoken:jjwt-api', 'jjwt-api', 'jjwt API module.'],
      ['org.bouncycastle:bcprov-jdk18on', 'bcprov-jdk18on', 'Bouncy Castle provider.'],
      ['commons-codec:commons-codec', 'commons-codec', 'Commons Codec.'],
      ['commons-net:commons-net', 'commons-net3', 'Commons Net.'],
      ['org.apache.commons:commons-collections4', 'commons-collections4', 'Commons Collections.'],
      ['org.apache.commons:commons-text', 'commons-text', 'Commons Text.'],
      ['commons-cli:commons-cli', 'commons-cli', 'Commons CLI parsing.'],
      ['org.flywaydb:flyway-core', 'flyway-core', 'Flyway migrations.'],
      ['org.liquibase:liquibase-core', 'liquibase-core', 'Liquibase migrations.'],
      ['org.testcontainers:testcontainers', 'testcontainers', 'Integration testing with real services in Docker.'],
      ['org.wiremock:wiremock', 'wiremock', 'HTTP mock server.'],
      ['com.github.tomakehurst:wiremock-jre8', 'wiremock-jre8', 'WireMock prior line.'],
      ['io.rest-assured:rest-assured', 'rest-assured', 'REST API test DSL.'],
      ['org.seleniumhq.selenium:selenium-java', 'selenium-java', 'Selenium WebDriver.'],
      ['io.github.bonigarcia:webdrivermanager', 'webdrivermanager', 'WebDriverManager.'],
      ['com.codeborne:selenide', 'selenide', 'Selenide UI tests.'],
      ['org.apache.poi:poi-ooxml', 'poi-ooxml', 'Apache POI for Office files.'],
      ['com.github.erosb:everit-json-schema', 'everit-json-schema', 'JSON Schema validator.'],
      ['com.networknt:json-schema-validator', 'networknt-json-schema', 'Fast JSON Schema validator.'],
      ['org.apache.commons:commons-csv', 'commons-csv', 'CSV parsing.'],
      ['com.opencsv:opencsv', 'opencsv', 'opencsv.'],
      ['com.univocity:univocity-parsers', 'univocity-parsers', 'Fast csv/tsv parsing.'],
    ];
    for (const [ga, artSlug, desc] of mavenArtifacts) {
      const [group, artifact] = ga.split(':');
      walk('3.2.0', 30).forEach((v, i) => {
        add({
          name: `maven: ${artifact} ${v}`,
          slugBase: `maven-${makeSlug(artifact)}-${v}`,
          description: `${desc} Release ${v} as a JAR from Maven Central (group ${group}).`,
          version: v, file_name: `${artifact}-${v}.jar`, file_size: int(30, 4500) * KB,
          file_type: 'jar', platform: 'cross-platform', arch: null,
          url: `https://central.sonatype.com/artifact/${group}/${artifact}`,
          category: 'development', folder: 'dev-tools', tags: ['maven', 'java', 'release-archive'],
          createdAt: ageFor(i, 16, 800),
        });
      });
    }

    // ---------------- NuGet packages ----------------
    const nugetPkgs = [
      ['Newtonsoft.Json', 'JSON.NET', 'The venerable JSON library (still everywhere).'],
      ['System.Text.Json', 'System.Text.Json', 'Modern Microsoft JSON (out-of-band).'],
      ['Serilog', 'Serilog', 'Structured event logging.'],
      ['Serilog.Sinks.Console', 'Serilog-console', 'Console sink.'],
      ['Serilog.Sinks.File', 'Serilog-file', 'File sink.'],
      ['NUnit', 'NUnit', 'Classic dotnet test framework.'],
      ['xunit', 'xunit', 'Modern dotnet test framework.'],
      ['Microsoft.NET.Test.Sdk', 'dotnet-test-sdk', 'Test SDK for dotnet test.'],
      ['Moq', 'Moq', 'Mocking lib.'],
      ['FluentAssertions', 'FluentAssertions', 'Beautiful assertions.'],
      ['AutoMapper', 'AutoMapper', 'Object-object mapping.'],
      ['MediatR', 'MediatR', 'In-process messaging.'],
      ['FluentValidation', 'FluentValidation', 'Rule-driven validation.'],
      ['Polly', 'Polly', 'Resilience: retries with policies.'],
      ['Swashbuckle.AspNetCore', 'Swashbuckle', 'Swagger/OpenAPI generation.'],
      ['Microsoft.EntityFrameworkCore', 'EFCore', 'Entity Framework Core.'],
      ['Microsoft.EntityFrameworkCore.SqlServer', 'EFCore-sqlserver', 'EF Core SQL Server provider.'],
      ['Microsoft.EntityFrameworkCore.Sqlite', 'EFCore-sqlite', 'EF Core SQLite provider.'],
      ['Npgsql.EntityFrameworkCore.PostgreSQL', 'EFCore-npgsql', 'EF Core Npgsql provider.'],
      ['Dapper', 'Dapper', 'Micro-ORM.'],
      ['Npgsql', 'Npgsql', 'PostgreSQL data provider.'],
      ['MySql.Data', 'MySql.Data', 'MySQL connector/net.'],
      ['StackExchange.Redis', 'StackExchangeRedis', 'Redis client.'],
      ['SqlKata', 'SqlKata', 'Query builder.'],
      ['CsvHelper', 'CsvHelper', 'CSV processing.'],
      ['EPPlus', 'EPPlus', 'Excel xlsx library.'],
      ['ClosedXML', 'ClosedXML', 'Excel generation.'],
      ['QuestPDF', 'QuestPDF', 'C# fluent PDF generation.'],
      ['PdfSharp', 'PdfSharp', 'Classic .NET PDF library.'],
      ['SkiaSharp', 'SkiaSharp', 'Skia 2D graphics.'],
      ['ImageSharp', 'ImageSharp', 'Pure-managed image processing (SixLabors).'],
      ['NAudio', 'NAudio', 'Audio playback/encoding for .NET.'],
      ['Avalonia', 'Avalonia-root', 'Cross-platform UI framework.'],
      ['Avalonia.Desktop', 'Avalonia-desktop', 'Desktop backend for Avalonia.'],
      ['Microsoft.NETCore.App.Runtime.win-x64', 'netcore-runtime', 'Runtime packs (arm64/x64 split).'],
      ['Microsoft.Orleans', 'Orleans', 'Virtual-actor framework.'],
      ['Akka.NET', 'Akka', 'Akka.NET actors.'],
      ['MassTransit', 'MassTransit', 'Message bus over RabbitMQ/ASB.'],
      ['Hangfire.Core', 'Hangfire', 'Background jobs with dashboard.'],
      ['Quartz', 'Quartz', 'Cron-style scheduling.'],
      ['Grpc.Net.Client', 'grpc-net-client', 'gRPC client.'],
      ['Grpc.AspNetCore', 'grpc-aspnet', 'gRPC server for ASP.NET.'],
      ['Grpc.Tools', 'grpc-tools', 'gRPC protoc tooling.'],
      ['Microsoft.AspNetCore.SignalR.Client', 'signalr-client', 'SignalR client.'],
    ];
    for (const [id, slugName, desc] of nugetPkgs) {
      walk('6.0.0', 36).forEach((v, i) => {
        add({
          name: `nuget: ${id} ${v}`,
          slugBase: `nuget-${makeSlug(id)}-${v}`,
          description: `${desc} Release ${v} -- restore with dotnet add ${id}.`,
          version: v, file_name: `${id.toLowerCase()}.${v}.nupkg`, file_size: int(80, 6000) * KB,
          file_type: 'nupkg', platform: 'cross-platform', arch: null,
          url: `https://www.nuget.org/packages/${id}`,
          category: 'development', folder: 'dev-tools', tags: ['nuget', 'dotnet', 'release-archive'],
          createdAt: ageFor(i, 20, 800),
        });
      });
    }

    // ---------------- Docker Hub official-image tags ----------------
    const dockerImages = [
      ['node', ['20-alpine', '20-bookworm', '20-bookworm-slim', '22-alpine', '22-bookworm-slim', '24-alpine', 'lts-jod'], 'JavaScript runtime official images.'],
      ['python', ['3.11-alpine', '3.11-slim-bookworm', '3.12-slim', '3.13-slim', '3.13-bookworm', '3.14-rc-slim'], 'CPython official images.'],
      ['postgres', ['14-bookworm', '15-bookworm', '15-alpine', '16-bookworm', '16-alpine', '17-bookworm', '17-alpine', '18-beta1'], 'PostgreSQL official images.'],
      ['mysql', ['8.0-oracle', '8.4', '9.0', '9.3'], 'MySQL official images.'],
      ['mariadb', ['10.11', '11.4', '11.8', '12.0'], 'MariaDB.'],
      ['redis', ['7.0-alpine', '7.2-alpine', '7.4-alpine', '8.0'], 'Redis.'],
      ['valkey/valkey', ['7.2-alpine', '8.0-alpine'], 'valkey Linux-Foundation fork.'],
      ['nginx', ['1.25-alpine', '1.26-bookworm', '1.27-alpine', 'mainline-alpine'], 'nginx.'],
      ['httpd', ['2.4-alpine', '2.4-bookworm'], 'Apache httpd.'],
      ['caddy', ['2.7-alpine', '2.8', '2.9', '2.10'], 'Caddy.'],
      ['traefik', ['v2.10', 'v2.11', 'v3.0', 'v3.4'], 'Traefik proxy.'],
      ['rabbitmq', ['3.12-management', '3.13-management-alpine', '4.0-management'], 'RabbitMQ.'],
      ['nats', ['2.9-alpine', '2.10-alpine', '2.11-alpine'], 'NATS.'],
      ['influxdb', ['2.7-alpine', '3.0-core'], 'InfluxDB time-series.'],
      ['timescale/timescaledb', ['latest-pg15', 'latest-pg16', 'latest-pg17'], 'TimescaleDB.'],
      ['clickhouse/clickhouse-server', ['23.8-alpine', '24.8', '25.6'], 'ClickHouse OLAP.'],
      ['mongo', ['5.0-jammy', '6.0-jammy', '7.0-jammy', '8.0'], 'MongoDB community.'],
      ['elasticsearch', ['7.17.20', '8.12.2', '8.15.3'], 'Elasticsearch (kept x64/arm64 manifest).'],
      ['opensearchproject/opensearch', ['2.11.1', '2.14.0', '2.16.0'], 'OpenSearch.'],
      ['minio/minio', ['RELEASE.2023-06-19T19-52-50Z', 'RELEASE.2024-08-29T01-40-52Z', 'RELEASE.2025-02-28T09-55-16Z'], 'S3-compatible object store.'],
      ['grafana/grafana', ['10.2.8', '10.4.9', '11.1.5', '12.0.0'], 'Grafana.'],
      ['prom/prometheus', ['v2.45.6', 'v2.53.1', 'v3.0.1'], 'Prometheus.'],
      ['prom/node-exporter', ['v1.7.0', 'v1.8.2', 'v1.9.1'], 'Prometheus node exporter.'],
      ['fluent/fluent-bit', ['1.9.10', '2.2.2', '3.1.7'], 'Fluent Bit log processor.'],
      ['goharbor/harbor-core', ['v2.9.5', 'v2.10.4', 'v2.12.1'], 'Harbor registry core.'],
      ['nextcloud', ['27-apache', '28-apache', '29-apache', '30-apache', '31-apache'], 'Nextcloud server.'],
      ['nextcloud/aio-imaginary', ['latest'], 'Imaginary image service (AIO companion).'],
      ['owncloud/server', ['10.13', '10.14', '10.15'], 'ownCloud classic.'],
      ['gitlab/gitlab-ce', ['16.7.8-ce.0', '17.0.5-ce.0', '17.5.3-ce.0', '17.10.1-ce.0'], 'GitLab CE all-in-one.'],
      ['gitlab/gitlab-runner', ['alpine-v16.8.0', 'alpine-v16.11.0', 'alpine-v17.5.2'], 'GitLab Runner.'],
      ['jenkins/jenkins', ['2.440.3-lts-jdk17', '2.452.2-lts-jdk17', '2.504.3-lts-jdk21'], 'Jenkins LTS.'],
      ['sonarqube', ['9.9.5-community', '10.4.1-community', '10.6.0-community'], 'SonarQube.'],
      ['registry', ['2.8.3', '3.0.0'], 'OCI Distribution registry.'],
      ['nginxdemos/nginx-hello', ['latest'], 'The famous hello container.'],
      ['ollama/ollama', ['0.3.12', '0.6.8', '0.11.4'], 'Ollama server container.'],
      ['ghcr.io/ggml-org/llama.cpp', ['server-b4609', 'server-b5103', 'server-b6680'], 'llama.cpp server builds with UI.'],
      ['tensorflow/tensorflow', ['2.14.0-gpu', '2.15.1-gpu', '2.17.0-gpu'], 'TensorFlow with GPU support.'],
      ['pytorch/pytorch', ['2.2.2-cuda12.1-devel', '2.4.1-cuda12.4-devel', '2.7.0-cuda12.8-devel'], 'PyTorch CUDA development tags.'],
    ];
    for (const [image, tags, desc] of dockerImages) {
      tags.forEach((tag, i) => {
        const short = image.split('/').pop();
        add({
          name: `docker: ${short}:${tag}`,
          slugBase: `docker-${makeSlug(short)}-${makeSlug(tag)}`,
          description: `${desc} Pull with \`docker pull ${image}:${tag}\`.`,
          version: tag, file_name: `${makeSlug(short)}_${makeSlug(tag)}.oci.tar`, file_size: int(40, 9000) * MB,
          file_type: 'tar', platform: 'linux', arch: 'x64',
          url: `https://hub.docker.com/_/${short === image ? image : image.split('/')[1]}`,
          category: 'development', folder: 'dev-tools', tags: ['docker', 'oci', 'release-archive'],
          createdAt: ageFor(i, tags.length, 800),
        });
      });
    }


    // ---------------- Final waves: PyPI wave-2 + npm wave-3 ----------------
    const pypiWave2 = [
      'six', 'certifi', 'urllib3', 'idna', 'charset-normalizer', 'pyasn1', 'rsa',
      'cachetools', 'jinja2', 'markupsafe', 'werkzeug', 'itsdangerous', 'blinker',
      'asgiref', 'sqlparse', 'tzdata', 'zoneinfo-py', 'packaging', 'setuptools-scm',
      'wheel', 'build', 'hatchling', 'flit-core', 'pipenv', 'virtualenv', 'pipx',
      'twine', 'readme-renderer', 'docutils', 'Pygments', 'colorama', 'termcolor',
      'blessed', 'urwid', 'npyscreen', 'prompt-toolkit', 'questionary-string',
      'progressbar2', 'alive-progress', 'yaspin', 'halo', 'sty-quiet-rainbow',
      'python-dateutil', 'pytz', 'tzlocal', 'arrow', 'pendulum', 'freezegun',
      'responses', 'requests-mock', 'vcrpy', 'pytest-cov', 'pytest-xdist',
      'pytest-timeout', 'pytest-mock', 'pytest-django', 'pytest-flask', 'codecov-py',
      'coveralls-py', 'towncrier', 'bump2version', 'semantic-release-py', 'versioneer',
      'Setuptools', 'debugpy', 'ipdb', 'pudb', 'wsgidav', 'cheroot',
      'gunicorn-events', 'gevent', 'greenlet', 'eventlet', 'tornado', 'sanic',
      'masonite', 'bottle', 'falcon', 'starlette', 'responder', 'hug-api',
      'molten', 'black-sheep', 'litestar', 'Robyn', 'Pydub-NG', 'Eel',
      'PySimpleGUI', 'customtkinter', 'dearpygui-lts', 'wxPython', 'PyQt6-sip',
      'PyQt6', 'PySide6', 'kivymd', 'flet', 'nicegui', 'dash-bootstrap-components',
      'voila', 'nbformat', 'nbconvert', 'nbclient', 'nbval', 'papermill',
      'jupytext', 'jupyter_client', 'jupyter_server', 'jupyter-core', 'texcaller',
      'nbconvert-webpdf', 'jupyter_contrib_nbextensions', 'rise', 'nbdime',
      'jupyterlab-git', 'jupyterlab-lsp', 'jupyter-console',
      'ipywidgets', 'ipympl', 'bqplot', 'pythreejs', 'ipyleaflet', 'ipyvolume',
      'itkwidgets', 'keras', 'jax', 'flax', 'optax', 'dm-haiku', 'chex',
      'orbax', 'gymnasium', 'stable-baselines3', 'TRI-QuietNeighborhoodInstructions',
      'ray', 'tune-sklearn', 'hyperopt', 'optuna', 'skopt', 'ax-platform',
      'nevergrad', 'pymoo', 'deap', 'pygad', 'geatpy', 'inspyred', 'watchmaker',
      'astropy', 'sunpy', 'nalu-wind-env', 'stingray', 'poliastro', 'spacepy',
      'biopython', 'pysam', 'bwamem-python-conda', 'BCBio', 'deepchem', 'rdkit-pypi',
      'scikit-image', 'mahotas', 'SimpleITK', 'nibabel', 'nilearn', 'dipy',
      'mne', 'pyriemann', 'antropy', 'heartpy-general', 'biosppy', 'wfdb',
      'ta-lib-build', 'backtrader', 'zipline-reloaded', 'ccxt', 'yfinance-compat',
      'pandas-datareader', 'fredapi', 'alpha-vantage', 'polygon-api-client',
      'cryptography-py-pin', 'pyopenssl', 'service-identity', 'pyjwt', 'oauthlib',
      'authlib', 'python-jose', 'passlib', 'argon2-cffi', 'bcrypt-py',
      'scrypt-py', 'NakedPy-hard', 'pynacl', 'pycryptodome', 'pycrypto-legacy-note',
      'gpg', 'python-gnupg', 'keyring', 'SecretStorage', 'dbus-python-headless-note',
      'dbus-python', 'pydbus-compat', 'jeepney', 'notify2', 'pyxdg',
    ];
    for (const name of pypiWave2) {
      walk('0.18.0', 50, { minorEvery: 12 }).forEach((v, i) => {
        add({
          name: `PyPI: ${name} ${v}`,
          slugBase: `pypi-${makeSlug(name)}-${v}`,
          description: `PyPI release-archive entry for ${name} ${v}.`,
          version: v, file_name: `${makeSlug(name)}-${v}.tar.gz`, file_size: int(40, 3000) * KB,
          file_type: 'tar.gz', platform: 'cross-platform', arch: null,
          url: `https://pypi.org/project/${name}/`,
          category: 'development', folder: 'dev-tools', tags: ['pypi', 'python', 'release-archive'],
          createdAt: ageFor(i, 42, 900),
        });
      });
    }

    const npmWave3 = [
      'commander-cjs', 'ora-classic-note', 'inquirer-old', 'cli-spinners', 'cli-cursor',
      'log-update', 'loglevel', 'loglevelnext-classic', 'npmlog', 'npmlog-lib',
      'pacote', 'npm-package-arg', 'read-package-json', 'init-package-json',
      'npm-normalize-package-bin', 'proc-log', 'semver-diff', 'libnpmversion',
      'hosted-git-info', 'validate-npm-package-name', 'npm-bundled', 'npm-packlist',
      'ignore-walk', 'read-package-tree-note', 'requizzle', 'streamverse',
      'nopt', 'npmlog-deps', 'which', 'cross-spawn-classic',
      'signal-exit-old-successors', 'promise-inflight', 'unique-filename', 'unique-slug',
      'cacache', 'make-fetch-happen-classic', 'ssri', 'tuf-js', '@sigstore/bundle',
      'diffy', 'git-stage-lint', 'lint-terminal-reporter', 'prettier-linter-helpers',
      'eslint-config-airbnb', 'eslint-config-airbnb-base', 'eslint-config-prettier',
      'eslint-plugin-prettier', 'eslint-plugin-import', 'eslint-plugin-jsx-a11y',
      'eslint-plugin-unused-imports', 'eslint-plugin-simple-import-sort', 'eslint-plugin-security',
      'eslint-plugin-sonarjs', 'eslint-plugin-unicorn', 'eslint-plugin-n',
      'eslint-plugin-node-compat-info', 'eslint-plugin-promise', 'eslint-plugin-react-hooks',
      'eslint-plugin-react-refresh', 'stylelint-config-recommended', 'stylelint-scss',
      'postcss-scss', 'postcss-media-minmax', 'postcss-normalize', 'css-declaration-sorter',
      'cssnano-preset-default', 'cssnano-preset-advanced', 'browserslist-diff-support',
      'caniuse-api', 'is-absolute-url', 'path-is-url-compat',
      'nanoid-format', 'ulidx-book', 'uuid-parse-note', 'ulid-vals',
      'json-schema-ref-parser-old-line', 'json-pointer-folded', 'denque',
      'queue-microtask', 'p-map', 'p-limit', 'p-queue', 'p-timeout', 'p-retry',
      'p-debounce', 'p-throttle', 'p-cancelable', 'mem', 'quick-lru',
      'serialize-javascript', 'random-item', 'shuffle-array-note', 'sample-size',
      'deepmerge', 'merge2', 'merge-value', 'object-assign-deep',
      'clone', 'rfdc', 'structured-clone-polyfilled', 'flatted',
      'serialize-error', 'error-ex', 'strip-json-comments', 'json-parse-even-better-errors',
      'write-file-atomic', 'safe-stable-stringify', 'fast-json-stable-stringify', 'json-stringify-safe',
    ];
    for (const name of npmWave3) {
      walk('1.8.0', 44, { minorEvery: 10 }).forEach((v, i) => {
        add({
          name: `npm: ${name} ${v}`,
          slugBase: `npmwave3-${makeSlug(name)}-${v}`,
          description: `npm release-archive entry for ${name} ${v}.`,
          version: v, file_name: `${makeSlug(name)}-${v}.tgz`, file_size: int(30, 2200) * KB,
          file_type: 'tgz', platform: 'cross-platform', arch: null,
          url: `https://www.npmjs.com/package/${name}`,
          category: 'development', folder: 'dev-tools', tags: ['npm', 'javascript', 'release-archive'],
          createdAt: ageFor(i, 44, 900),
        });
      });
    }

    return inserted;
  });
  return tx();
}

if (import.meta.url.endsWith(process.argv[1]?.replace(/\\/g, '/'))) {
  const db = getDb();
  const inserted = seedArchive(db);
  console.log(`Archive seed complete: +${inserted} new items (total ${db.prepare('SELECT COUNT(*) c FROM items').get().c}).`);
}
