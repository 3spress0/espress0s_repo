/**
 * seed-modern.js -- the modern half of the catalog.
 *
 * seed-catalog.js covers classic OS images and the well-known desktop apps.
 * This module adds the current-generation wave: AI/LLM tooling, modern code
 * editors, cloud-native tooling, recent driver lines, current maker/slicer
 * software, language runtimes from 2023-2026, plus two large generators:
 *
 *   - nightly-build archives for projects that genuinely publish daily
 *     builds (Blender, Krita, Godot, Neovim, Firefox Nightly, ...)
 *   - package-release archives mirroring npm registry tarballs
 *
 * Everything is deterministic and idempotent (guarded by slug and name), so
 * it is safe to import from seed.js and to run standalone:
 *   node src/db/seed-modern.js
 */
import { getDb } from './index.js';
import { encryptionService } from '../services/encryptionService.js';
import { makeSlug } from '../utils/slug.js';

// Deterministic pseudo-randomness (different stream than seed-catalog).
let _s = 0x9e3779b9;
const rnd = () => {
  _s |= 0; _s = (_s + 0x6D2B79F5) | 0;
  let t = Math.imul(_s ^ (_s >>> 15), 1 | _s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const int = (min, max) => min + Math.floor(rnd() * (max - min + 1));
const KB = 1024;
const MB = 1024 * 1024;
const GB = 1024 * MB;
const enc = (v) => (v ? encryptionService.encrypt(v) : null);

export function seedModern(db) {
  const tx = db.transaction(() => {
    const insFolder = db.prepare(
      'INSERT OR IGNORE INTO folders (name, slug, description, icon, color, sort_order) VALUES (?, ?, ?, ?, ?, ?)');
    [
      ['Nightly & dev builds', 'nightly-builds', 'Automated nightly/continuous snapshots -- bleeding edge', 'moon', '#7dd3fc'],
      ['Maker & embedded', 'maker-embedded', '3D slicers, CAD and EDA tools', 'wrench', '#fdba74'],
      ['Drivers & firmware', 'drivers-firmware', 'Current GPU, chipset and firmware packages', 'cpu', '#fda4af'],
    ].forEach((f, i) => insFolder.run(f[0], f[1], f[2], f[3], f[4], 100 + i));

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
      VALUES (@item_id, 'Official download', 'external', NULL, @url, @size, 1, 'unknown', 0, @now, @now)`);

    const seen = new Set(db.prepare('SELECT slug FROM items').all().map((r) => r.slug));
    const seenNames = new Set(db.prepare('SELECT name FROM items').all().map((r) => r.name));
    let inserted = 0;

    const daysAgoIso = (maxDays = 400) => new Date(Date.now() - int(0, maxDays) * 86400_000).toISOString();

    const add = (it) => {
      const slug = makeSlug(it.slugBase || `${it.name} ${it.version || ''}`);
      if (seen.has(slug) || seenNames.has(it.name)) return;
      seen.add(slug);
      seenNames.add(it.name);
      const created = it.createdAt || daysAgoIso(it.maxAgeDays);
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

    const GH_REL = (repo, tagFmt, fileFmt) => (v) =>
      `https://github.com/${repo}/releases/tag/${tagFmt.replace('{v}', v)}`;

    const gh = (repo, tagFmt = 'v{v}') => GH_REL(repo, tagFmt);

    // Small helper: add a version matrix across builds.
    // build: [platformSuffix, platform, ext, arch, sizeMinMB, sizeMaxMB]
    const matrix = (name, slug, desc, versions, builds, opts = {}) => {
      for (const v of versions) {
        for (const b of builds) {
          const [suffix, platform, ext, arch, sMin, sMax] = b;
          add({
            name: `${name} ${v}${suffix ? ` (${suffix})` : ''}`,
            slugBase: `${slug}-${v}${suffix ? `-${makeSlug(suffix)}` : ''}`,
            description: opts.descPer ? opts.descPer(v, suffix) : desc,
            version: v,
            file_name: `${slug}-${v}-${platform}${arch ? `-${arch}` : ''}.${ext}`,
            file_size: int(sMin, sMax) * MB,
            file_type: ext, platform, arch,
            url: opts.urlFor ? opts.urlFor(v, platform, arch) : (opts.url || 'https://github.com'),
            source: opts.url,
            license: opts.license,
            category: opts.category || 'development',
            folder: opts.folder || 'dev-tools',
            tags: opts.tags || [platform, 'modern'],
          });
        }
      }
    };

    const WIN_X64 = ['Windows x64', 'windows', 'exe', 'x64', 40, 120];
    const WIN_ARM = ['Windows ARM64', 'windows', 'exe', 'arm64', 40, 120];
    const LIN_X64 = ['Linux x64', 'linux', 'tar.gz', 'x64', 40, 120];
    const LIN_ARM = ['Linux ARM64', 'linux', 'tar.gz', 'arm64', 40, 120];
    const MAC_ARM = ['macOS Apple Silicon', 'macos', 'dmg', 'arm64', 40, 120];
    const APK = ['Android', 'other', 'apk', 'universal', 20, 90];

    // ==================================================================
    // AI & local-LLM tooling (2023-2026 era)
    // ==================================================================
    matrix('Ollama', 'ollama', 'Run open-weight LLMs locally with one command. Model library included.', ['0.1.38', '0.2.8', '0.3.14', '0.5.13', '0.6.8', '0.9.6', '0.11.4'],
      [WIN_X64, LIN_X64, LIN_ARM, MAC_ARM], { url: gh('ollama/ollama'), tags: ['ai', 'llm', 'local-inference'] });
    matrix('LM Studio', 'lm-studio', 'Polished local-LLM desktop app: chat, server mode, one-click model downloads.', ['0.2.31', '0.3.5', '0.3.14', '0.3.20', '0.4.0'],
      [WIN_X64, MAC_ARM], { url: 'https://lmstudio.ai', category: 'applications', tags: ['ai', 'llm'] });
    matrix('llama.cpp build', 'llamacpp', 'The reference llama.cpp inference engine launch build -- CPU/GPU backends as separate zips.', ['b4609', 'b4821', 'b5103', 'b5347', 'b5589', 'b5872', 'b6130', 'b6401', 'b6680', 'b6958'],
      [['Windows x64', 'windows', 'zip', 'x64', 25, 60], ['Windows CUDA x64', 'windows', 'zip', 'x64', 300, 700], ['Linux x64', 'linux', 'tar.gz', 'x64', 25, 60], ['macOS Apple Silicon', 'macos', 'zip', 'arm64', 20, 50]],
      { url: gh('ggml-org/llama.cpp'), tags: ['ai', 'inference', 'cuda'] });
    matrix('koboldcpp', 'koboldcpp', 'Single-file LLM inference with a story-writing UI. Just double-click.', ['1.62', '1.70', '1.78', '1.85', '1.92', '1.97'],
      [WIN_X64, LIN_X64, MAC_ARM], { url: gh('LostRuins/koboldcpp'), category: 'applications', tags: ['ai', 'llm'] });
    matrix('GPT4All', 'gpt4all', 'Local LLM desktop chat with LocalDocs RAG, completely offline.', ['3.0.0', '3.2.1', '3.5.3', '3.7.0', '3.9.0'],
      [WIN_X64, LIN_X64, MAC_ARM], { url: gh('nomic-ai/gpt4all'), category: 'applications', tags: ['ai', 'rag'] });
    matrix('Open WebUI', 'open-webui', 'Self-hosted ChatGPT-style web UI for Ollama/llama.cpp servers.', ['0.3.35', '0.4.8', '0.5.20', '0.6.5', '0.6.18'],
      [['Docker compose bundle', 'linux', 'zip', null, 2, 5], ['pip wheel', 'cross-platform', 'whl', null, 8, 15]],
      { url: gh('open-webui/open-webui'), tags: ['ai', 'self-hosted', 'docker'] });
    matrix('ComfyUI', 'comfyui', 'Node-based Stable Diffusion pipeline builder; the standard for image-gen workflows.', ['v0.2.2', 'v0.2.7', 'v0.3.10', 'v0.3.40', 'v0.3.50'],
      [['Windows portable (NVIDIA)', 'windows', '7z', 'x64', 1400, 1600], ['Source (cross-platform)', 'cross-platform', 'zip', null, 8, 12]],
      { url: gh('comfyanonymous/ComfyUI'), category: 'applications', tags: ['ai', 'image-gen', 'sd'] });
    matrix('Stable Diffusion webui (A1111)', 'a1111-sd-webui', 'The original SD automation UI with an enormous extension ecosystem.', ['v1.6.0', 'v1.7.0', 'v1.8.0', 'v1.9.4', 'v1.10.1'],
      [['Windows source bundle', 'windows', 'zip', null, 25, 35], ['Linux source bundle', 'linux', 'tar.gz', null, 25, 35]],
      { url: gh('AUTOMATIC1111/stable-diffusion-webui'), category: 'applications', tags: ['ai', 'image-gen'] });
    matrix('Jan', 'jan-chat', 'Open-source ChatGPT alternative that runs fully offline.', ['0.4.13', '0.5.4', '0.5.17', '0.6.5'],
      [WIN_X64, LIN_X64, MAC_ARM], { url: gh('janhq/jan'), category: 'applications', tags: ['ai', 'llm'] });
    matrix('AnythingLLM', 'anything-llm', 'All-in-one local LLM app with workspaces, agents and RAG.', ['1.6.10', '1.7.4', '1.8.1'],
      [['Windows x64', 'windows', 'exe', 'x64', 250, 400], ['Linux AppImage', 'linux', 'appimage', 'x64', 250, 400]],
      { url: gh('Mintplex-Labs/anything-llm'), category: 'applications', tags: ['ai', 'rag'] });
    matrix('Claude Code', 'claude-code', "Anthropic's agentic terminal coding assistant (requires an Anthropic account).", ['1.0.71', '1.0.92', '1.0.128', '2.0.5'],
      [['npm global tarball', 'cross-platform', 'tgz', null, 4, 12]], { url: 'https://www.npmjs.com/package/@anthropic-ai/claude-code', tags: ['ai', 'cli', 'coding-agent'] });
    matrix('aider', 'aider-chat', 'AI pair programming straight in your terminal, works with repo-scale git diffs.', ['0.54.0', '0.62.1', '0.71.1', '0.82.3'],
      [['pip wheel', 'cross-platform', 'whl', null, 1, 3]], { url: gh('Aider-AI/aider'), tags: ['ai', 'cli', 'coding'] });
    matrix('gemini-cli', 'gemini-cli', "Google's terminal AI agent (requires gcloud auth).", ['0.1.9', '0.3.4', '0.5.0'],
      [['npm global tarball', 'cross-platform', 'tgz', null, 3, 8]], { url: gh('google-gemini/gemini-cli'), tags: ['ai', 'cli'] });
    matrix('OpenAI Codex CLI', 'codex-cli', 'Terminal pair-programmer driven by OpenAI models (API key required).', ['0.20.0', '0.34.0', '0.44.0'],
      [['npm global tarball', 'cross-platform', 'tgz', null, 3, 8]], { url: gh('openai/codex'), tags: ['ai', 'cli'] });
    matrix('whisper.cpp', 'whisper-cpp', 'Blazing-fast local speech-to-text, CoreML/CUDA/Vulkan builds.', ['v1.5.5', 'v1.6.2', 'v1.7.6', 'v1.8.0'],
      [WIN_X64, LIN_X64, MAC_ARM], { url: gh('ggml-org/whisper.cpp'), tags: ['ai', 'speech', 'stt'] });
    matrix('LocalAI', 'local-ai', 'Drop-in OpenAI-compatible API shim over llama.cpp/diffusers/whisper.', ['v2.19.0', 'v2.25.0', 'v2.30.0', 'v3.0.0'],
      [LIN_X64, LIN_ARM], { url: gh('mudler/LocalAI'), tags: ['ai', 'self-hosted'] });
    matrix('text-generation-webui (oobabooga)', 'oobabooga', 'Feature-rich web UI for local text models with extensions.', ['snapshot-2024-05-06', 'snapshot-2025-01-25', 'snapshot-2025-06-14', 'v3.1'],
      [['Windows one-click installer', 'windows', 'zip', null, 30, 60], ['Linux one-click installer', 'linux', 'zip', null, 30, 60]],
      { url: gh('oobabooga/text-generation-webui'), category: 'applications', tags: ['ai', 'llm'] });
    matrix('n8n', 'n8n', 'Self-hostable workflow automation with AI agent nodes built in.', ['1.42.1', '1.60.0', '1.78.0', '1.105.0'],
      [['Docker bundle', 'linux', 'zip', null, 2, 6]], { url: gh('n8n-io/n8n'), tags: ['automation', 'self-hosted', 'ai'] });
    matrix('Fabric', 'fabric-ai', 'Open-source framework for augmenting humans with AI prompts (danielmiessler).', ['v1.4.42', 'v1.4.150', 'v1.4.265'],
      [WIN_X64, LIN_X64, MAC_ARM], { url: gh('danielmiessler/Fabric'), tags: ['ai', 'cli'] });
    matrix('ollama model-pack card', 'ollama-model-notes', 'Reference card: pulling and running Llama 3.1/3.3, Qwen3, DeepSeek-R1, Mistral via ollama-with-llama.cpp.', ['2026.2'],
      [['markdown card', 'cross-platform', 'md', null, 1, 2]], { url: 'https://ollama.com/library', category: 'documentation', folder: 'guides-references', tags: ['ai', 'reference'] });

    // ==================================================================
    // Modern editors & developer desktops
    // ==================================================================
    const vsc = [];
    for (let m = 78; m <= 106; m++) vsc.push(`1.${m}.0`);
    for (let m = 85; m <= 106; m += 3) vsc.push(`1.${m}.2`);
    matrix('Visual Studio Code', 'vscode', 'Monthly stable VS Code build.', vsc,
      [WIN_X64, ['Windows ARM64', 'windows', 'exe', 'arm64', 90, 120], ['Linux x64 (deb)', 'linux', 'deb', 'x64', 85, 110], ['Linux ARM64 (tar.gz)', 'linux', 'tar.gz', 'arm64', 80, 110]],
      { urlFor: (v, p, a) => `https://update.code.visualstudio.com/${v}/${p}-${a}/stable`, url: 'https://code.visualstudio.com/updates', license: 'proprietary', folder: 'dev-tools', tags: ['editor'] });
    matrix('Cursor', 'cursor-editor', 'AI-first VS Code-based editor.', ['0.48.9', '1.0.0', '1.2.4', '1.4.5'],
      [WIN_X64, ['Linux AppImage', 'linux', 'appimage', 'x64', 130, 170], MAC_ARM], { url: 'https://cursor.com', category: 'development', license: 'proprietary', tags: ['editor', 'ai'] });
    matrix('Windsurf', 'windsurf-editor', "Codeium's agentic IDE.", ['1.4.3', '1.8.2', '1.10.3'],
      [WIN_X64, ['Linux tar.gz', 'linux', 'tar.gz', 'x64', 120, 160]], { url: 'https://windsurf.com', category: 'development', license: 'proprietary', tags: ['editor', 'ai'] });
    matrix('Zed', 'zed-editor', 'Rust-built, GPU-accelerated collaborative editor.', ['0.159.7', '0.177.11', '0.193.3', '0.208.4'],
      [['Linux x64', 'linux', 'tar.gz', 'x64', 55, 85], MAC_ARM], { url: gh('zed-industries/zed'), tags: ['editor', 'rust'] });
    matrix('Neovim', 'neovim', 'Hyperextensible Vim-based text editor.', ['v0.9.5', 'v0.10.4', 'v0.11.3'],
      [WIN_X64, LIN_X64, MAC_ARM], { url: gh('neovim/neovim'), tags: ['editor', 'terminal'] });
    const jetrides = ['WebStorm', 'PyCharm Professional', 'GoLand', 'CLion', 'RustRover'];
    for (const ide of jetrides) {
      matrix(ide, makeSlug(ide), `${ide} -- JetBrains IDE (trial; free for non-commercial use as of 2024+ lineup).`, ['2024.1.5', '2024.2.3', '2025.1.2'],
        [['Windows x64', 'windows', 'exe', 'x64', 800, 1100], ['Linux x64 (tar.gz)', 'linux', 'tar.gz', 'x64', 800, 1100]],
        { url: `https://www.jetbrains.com/${ide.split(' ')[0].toLowerCase()}/download/`, license: 'proprietary', category: 'development', tags: ['ide', 'jetbrains'] });
    }
    matrix('Helix editor', 'helix', 'Post-modern modal terminal editor with tree-sitter built in.', ['23.10', '24.03', '24.07', '25.01'],
      [WIN_X64, LIN_X64, MAC_ARM], { url: gh('helix-editor/helix'), tags: ['editor', 'terminal', 'rust'] });
    matrix('Android Studio', 'android-studio', 'Official Android IDE.', ['Hedgehog 2023.1.1', 'Iguana 2023.2.1', 'Koala 2024.1.2', 'Ladybug 2024.2.2', 'Meerkat 2024.3.2', 'Narwhal 2025.1.2'],
      [['Windows x64', 'windows', 'exe', 'x64', 950, 1200], ['Linux x64', 'linux', 'tar.gz', 'x64', 950, 1200], MAC_ARM],
      { url: 'https://developer.android.com/studio', tags: ['ide', 'android', 'google'] });

    // ==================================================================
    // Modern toolchain / JS / systems releases
    // ==================================================================
    const bunV = ['1.0.25', '1.1.18', '1.1.42', '1.2.2', '1.2.18', '1.3.0'];
    matrix('Bun', 'bun', 'All-in-one fast JS runtime, bundler and package manager.', bunV,
      [WIN_X64, LIN_X64, LIN_ARM, MAC_ARM], { url: gh('oven-sh/bun'), tags: ['runtime', 'js'] });
    matrix('Deno', 'deno', 'Secure by-default TypeScript runtime.', ['1.42.4', '1.46.3', '2.0.6', '2.2.4', '2.4.0', '2.5.0'],
      [WIN_X64, LIN_X64, LIN_ARM, MAC_ARM], { url: gh('denoland/deno'), tags: ['runtime', 'typescript'] });
    matrix('uv (Astral)', 'uv-astral', 'Drop-in pip replacement written in Rust; 10-100x faster installs.', ['0.1.24', '0.2.37', '0.4.30', '0.6.14', '0.8.4'],
      [WIN_X64, LIN_X64, MAC_ARM], { url: gh('astral-sh/uv'), tags: ['python', 'packaging'] });
    matrix('Ruff', 'ruff-astral', 'Rust-fast Python linter + formatter.', ['0.3.7', '0.6.9', '0.9.10', '0.13.0'],
      [WIN_X64, LIN_X64, MAC_ARM], { url: gh('astral-sh/ruff'), tags: ['python', 'linter'] });
    matrix('Biome', 'biomejs', 'One fast toolchain for web projects: formatter, linter, importer.', ['1.8.3', '1.9.4', '2.1.2'],
      [WIN_X64, LIN_X64, MAC_ARM], { url: gh('biomejs/biome'), tags: ['js', 'toolchain', 'rust'] });
    matrix('pnpm', 'pnpm', 'Fast, disk-space-efficient package manager.', ['v9.7.1', 'v9.15.4', 'v10.4.1', 'v10.13.1'],
      [WIN_X64, LIN_X64, MAC_ARM], { url: gh('pnpm/pnpm'), tags: ['js', 'package-manager'] });
    matrix('Vite', 'vite', 'Next-generation frontend tooling -- dev server and bundler.', ['5.2.13', '5.4.8', '6.0.7', '7.0.4'],
      [['npm package', 'cross-platform', 'tgz', null, 2, 5]], { url: gh('vitejs/vite'), tags: ['js', 'bundler'] });
    matrix('Astro', 'astro', 'Content-driven web framework with islands architecture.', ['4.11.5', '4.15.12', '5.3.0', '5.13.2'],
      [['npm package', 'cross-platform', 'tgz', null, 2, 6]], { url: gh('withastro/astro'), tags: ['js', 'web'] });
    matrix('Next.js', 'nextjs', 'The React framework for production.', ['14.2.5', '14.2.24', '15.0.3', '15.3.4', '15.5.0'],
      [['npm package', 'cross-platform', 'tgz', null, 8, 25]], { url: gh('vercel/next.js'), license: 'redistributable', tags: ['js', 'react'] });
    matrix('Node.js 20 LTS line', 'node20', 'Node.js 20.x maintenance LTS.', ['20.12.2', '20.15.1', '20.17.0', '20.18.2', '20.19.4'],
      [WIN_X64, LIN_X64, LIN_ARM], { url: 'https://nodejs.org/dist/', tags: ['nodejs'] });
    matrix('Node.js 22 LTS line', 'node22', 'Node.js 22.x active LTS (Jod).', ['22.5.1', '22.9.0', '22.12.0', '22.14.0', '22.17.0', '22.19.0'],
      [WIN_X64, LIN_X64, LIN_ARM], { url: 'https://nodejs.org/dist/', tags: ['nodejs'] });
    matrix('Node.js 24', 'node24', 'Node.js 24 current.', ['24.0.0', '24.4.1', '24.7.0'],
      [WIN_X64, LIN_X64, LIN_ARM], { url: 'https://nodejs.org/dist/', tags: ['nodejs'] });
    matrix('Python 3.13 line', 'python313', 'CPython 3.13 -- free-threading build available.', ['3.13.0', '3.13.1', '3.13.3', '3.13.5', '3.13.7'],
      [WIN_X64, ['Windows ARM64', 'windows', 'exe', 'arm64', 28, 34], ['Source tarball', 'linux', 'tgz', null, 25, 30]],
      { urlFor: (v) => `https://www.python.org/ftp/python/${v}/`, url: 'https://www.python.org/downloads/', tags: ['python'] });
    matrix('Go', 'golang', 'Google Go toolchain.', ['1.21.13', '1.22.6', '1.23.2', '1.24.0', '1.25.0'],
      [ ['Windows x64', 'windows', 'msi', 'x64', 60, 75], ['Windows ARM64', 'windows', 'msi', 'arm64', 55, 70], ['Linux x64', 'linux', 'tar.gz', 'x64', 60, 75], ['Linux ARM64', 'linux', 'tar.gz', 'arm64', 55, 70], MAC_ARM ],
      { urlFor: (v, p, a) => `https://go.dev/dl/go${v}.${p === 'windows' ? 'windows' : p}-${a || 'amd64'}.${p === 'windows' ? 'msi' : 'tar.gz'}`, url: gh('golang/go'), tags: ['go'] });
    matrix('Rust toolchain (stable)', 'rust-stable', 'rustc + cargo stable release.', ['1.75.0', '1.79.0', '1.83.0', '1.86.0', '1.89.0', '1.91.0'],
      [ ['rustup-init staging note (Windows x64)', 'windows', 'exe', 'x64', 8, 12], ['rustup-init (Linux x64)', 'linux', 'sh', 'x64', 8, 12], ['rustup-init (macOS ARM)', 'macos', 'sh', 'arm64', 8, 12] ],
      { url: 'https://rustup.rs', tags: ['rust'] });
    matrix('.NET SDK 8 LTS', 'dotnet8', '.NET 8 SDK including ASP.NET Core.', ['8.0.204', '8.0.303', '8.0.400', '8.0.404', '8.0.413'],
      [ ['Windows x64', 'windows', 'exe', 'x64', 200, 240], ['Windows ARM64', 'windows', 'exe', 'arm64', 200, 240], ['Linux x64', 'linux', 'tar.gz', 'x64', 200, 240], ['Linux ARM64', 'linux', 'tar.gz', 'arm64', 200, 240] ],
      { url: 'https://dotnet.microsoft.com/download/dotnet/8.0', tags: ['dotnet'] });
    matrix('.NET SDK 9', 'dotnet9', '.NET 9 SDK.', ['9.0.102', '9.0.200', '9.0.300', '9.0.304'],
      [ ['Windows x64', 'windows', 'exe', 'x64', 210, 250], ['Linux x64', 'linux', 'tar.gz', 'x64', 210, 250], ['Linux ARM64', 'linux', 'tar.gz', 'arm64', 210, 250] ],
      { url: 'https://dotnet.microsoft.com/download/dotnet/9.0', tags: ['dotnet'] });
    matrix('.NET SDK 10 preview', 'dotnet10', '.NET 10 preview SDK.', ['10.0.100-preview.5'],
      [ ['Windows x64', 'windows', 'exe', 'x64', 220, 260], ['Linux x64', 'linux', 'tar.gz', 'x64', 220, 260] ],
      { url: 'https://dotnet.microsoft.com/download/dotnet/10.0', tags: ['dotnet', 'preview'] });
    matrix('TypeScript', 'typescript', 'Microsoft TypeScript compiler.', ['5.3.3', '5.4.5', '5.5.4', '5.6.3', '5.7.3', '5.8.3', '5.9.2'],
      [['npm package', 'cross-platform', 'tgz', null, 8, 15]], { url: gh('microsoft/TypeScript'), tags: ['typescript', 'js'] });
    matrix('Bun baseline (AVX2-free CPUs)', 'bun-baseline', 'Bun baseline build for older CPUs without AVX2.', bunV.slice(2),
      [LIN_X64], { url: gh('oven-sh/bun'), tags: ['runtime', 'js', 'baseline'] });

    // ==================================================================
    // Cloud-native / platform tooling (current majors)
    // ==================================================================
    matrix('kubectl', 'kubectl', 'Kubernetes command-line client matching current cluster versions.', ['v1.28.15', 'v1.29.10', 'v1.30.6', 'v1.31.2', 'v1.32.0', 'v1.33.2', 'v1.34.0'],
      [WIN_X64, LIN_X64, LIN_ARM], { url: 'https://dl.k8s.io/release/', tags: ['kubernetes'] });
    matrix('Helm', 'helm', 'The Kubernetes package manager.', ['v3.14.4', 'v3.15.4', 'v3.16.2', 'v3.17.3', 'v3.18.4'],
      [WIN_X64, LIN_X64, LIN_ARM], { url: gh('helm/helm'), tags: ['kubernetes'] });
    matrix('Terraform', 'terraform', 'HashiCorp Terraform IaC tool (BUSL).', ['1.7.5', '1.8.5', '1.9.8', '1.11.4', '1.12.2'],
      [WIN_X64, LIN_X64, LIN_ARM], { url: gh('hashicorp/terraform'), license: 'proprietary', tags: ['iac'] });
    matrix('OpenTofu', 'opentofu', 'The Terraform fork, MPL-licensed.', ['v1.6.2', 'v1.8.8', 'v1.9.1', 'v1.10.1'],
      [WIN_X64, LIN_X64, LIN_ARM], { url: gh('opentofu/opentofu'), tags: ['iac', 'oss'] });
    matrix('Docker Desktop', 'docker-desktop', 'Docker Desktop includes engine, desktop UI and kubertetes integration. Win/macOS.', ['4.31.1', '4.33.1', '4.35.1', '4.37.2', '4.41.2'],
      [['Windows x64', 'windows', 'exe', 'x64', 600, 700], MAC_ARM], { url: 'https://www.docker.com/products/docker-desktop/', license: 'proprietary', category: 'development', tags: ['docker', 'containers'] });
    matrix('Podman Desktop', 'podman-desktop', 'Daemonless container desktop (CNCF).', ['v1.9.3', 'v1.12.0', 'v1.15.0', 'v1.20.1'],
      [WIN_X64, MAC_ARM, ['Linux flatpak ref', 'linux', 'flatpakref', 'x64', 1, 2]], { url: gh('podman-desktop/podman-desktop'), tags: ['containers', 'podman'] });
    matrix('Rancher Desktop', 'rancher-desktop', 'Open-source container desktop with built-in kubernetes.', ['v1.14.2', 'v1.16.0', 'v1.18.2'],
      [WIN_X64, MAC_ARM], { url: gh('rancher-sandbox/rancher-desktop'), tags: ['containers', 'k8s'] });
    matrix('k9s', 'k9s', 'Terminal UI for managing Kubernetes clusters.', ['v0.32.5', 'v0.40.10', 'v0.50.9'],
      [WIN_X64, LIN_X64, MAC_ARM], { url: gh('derailed/k9s'), tags: ['kubernetes', 'tui'] });
    matrix('helmfile', 'helmfile', 'Declarative spec for deploying Helm charts.', ['v0.162.0', 'v1.0.0', 'v1.1.2'],
      [LIN_X64, MAC_ARM], { url: gh('helmfile/helmfile'), tags: ['kubernetes'] });
    matrix('Argo CD CLI', 'argocd-cli', 'GitOps continuous delivery CLI.', ['v2.11.7', 'v2.13.4', 'v3.0.5'],
      [WIN_X64, LIN_X64], { url: gh('argoproj/argo-cd'), tags: ['gitops', 'kubernetes'] });
    matrix('Trivy', 'trivy', 'All-in-one security scanner: images, files, repos, IaC.', ['v0.52.2', 'v0.55.2', 'v0.60.0', 'v0.63.0'],
      [WIN_X64, LIN_X64, LIN_ARM], { url: gh('aquasecurity/trivy'), category: 'utilities', folder: 'diagnostics-hardware', tags: ['security', 'scanner'] });
    matrix('syft + grype bundle', 'syft-grype', 'SBOM generator + vulnerability scanner (Anchore).', ['v1.9.0', 'v1.18.1', 'v1.26.1'],
      [LIN_X64, WIN_X64], { url: gh('anchore/syft'), tags: ['security', 'sbom'] });
    matrix('Lazydocker', 'lazydocker', 'Terminal UI for Docker and docker-compose.', ['v0.23.3', 'v0.24.1'],
      [WIN_X64, LIN_X64, MAC_ARM], { url: gh('jesseduffield/lazydocker'), tags: ['docker', 'tui'] });
    matrix('lazygit', 'lazygit', 'Terminal UI for git commands.', ['v0.44.1', 'v0.48.0', 'v0.52.0', 'v0.54.2'],
      [WIN_X64, LIN_X64, MAC_ARM], { url: gh('jesseduffield/lazygit'), tags: ['git', 'tui'] });
    matrix('Ghostty', 'ghostty', "Mitchell Hashimoto's GPU-native terminal (Qt-confirmed by community reviews).", ['1.0.1', '1.1.3'],
      [['Linux x64', 'linux', 'tar.gz', 'x64', 25, 45], MAC_ARM], { url: gh('ghostty-org/ghostty'), category: 'utilities', folder: 'terminals-cli', tags: ['terminal'] });
    matrix('WezTerm', 'wezterm', 'GPU-accelerated terminal with Lua config.', ['20240203-110809-5046fc22', '20250207-142714-0a1556e1'],
      [WIN_X64, LIN_X64, MAC_ARM], { url: gh('wezterm/wezterm'), category: 'utilities', folder: 'terminals-cli', tags: ['terminal'] });
    matrix('Alacritty', 'alacritty', 'Fast OpenGL terminal emulator.', ['v0.13.2', 'v0.14.0', 'v0.15.1'],
      [WIN_X64, LIN_X64, MAC_ARM], { url: gh('alacritty/alacritty'), category: 'utilities', folder: 'terminals-cli', tags: ['terminal'] });
    matrix('Nushell', 'nushell', 'Modern structured-data shell written in Rust.', ['0.91.0', '0.97.1', '0.101.0', '0.105.1'],
      [WIN_X64, LIN_X64, MAC_ARM], { url: gh('nushell/nushell'), category: 'utilities', folder: 'terminals-cli', tags: ['shell'] });
    matrix('PowerShell 7', 'powershell7', 'Cross-platform PowerShell.', ['v7.4.2', 'v7.4.6', 'v7.5.0', 'v7.5.2'],
      [ ['Windows x64', 'windows', 'msi', 'x64', 100, 115], ['Windows ARM64', 'windows', 'msi', 'arm64', 100, 115], ['Linux x64', 'linux', 'tar.gz', 'x64', 75, 90], ['Linux ARM64', 'linux', 'tar.gz', 'arm64', 75, 90] ],
      { url: gh('PowerShell/PowerShell'), category: 'utilities', folder: 'terminals-cli', tags: ['shell', 'microsoft'] });
    matrix('oh-my-posh', 'oh-my-posh', 'The prompt engine for every shell.', ['v21.18.2', 'v23.20.4', 'v25.23.3'],
      [WIN_X64, LIN_X64, MAC_ARM], { url: gh('JanDeDobbeleer/oh-my-posh'), category: 'utilities', folder: 'terminals-cli', tags: ['shell', 'prompt'] });

    // ==================================================================
    // Modern creator tools (2024-2026 majors)
    // ==================================================================
    matrix('Blender', 'blender', 'The open 3D suite -- modeling through rendering and video.', ['4.0.2', '4.1.1', '4.2 LTS', '4.3.2', '4.4.3', '4.5 LTS'],
      [ ['Windows x64', 'windows', 'msi', 'x64', 300, 380], ['Linux x64', 'linux', 'tar.xz', 'x64', 230, 300], MAC_ARM ],
      { url: 'https://download.blender.org/release/', category: 'applications', folder: 'media-tools', tags: ['3d'] });
    matrix('Krita', 'krita', 'Digital painting that powers professional studios.', ['5.2.2', '5.2.6', '5.2.9', '5.2.11'],
      [WIN_X64, ['Linux AppImage', 'linux', 'appimage', 'x64', 180, 220], MAC_ARM],
      { url: gh('KDE/krita', '', ''), url: 'https://download.kde.org/stable/krita/', category: 'applications', folder: 'media-tools', tags: ['art', 'paint'] });
    matrix('Godot Engine', 'godot', 'The open game engine (standard + .NET builds).', ['4.2.2-stable', '4.3-stable', '4.4.1-stable', '4.5-stable'],
      [ ['Windows x64', 'windows', 'zip', 'x64', 65, 95], ['Linux x64', 'linux', 'zip', 'x64', 65, 95], ['Windows .NET x64', 'windows', 'zip', 'x64', 130, 170], ['Linux .NET x64', 'linux', 'tar.gz', 'x64', 130, 170] ],
      { url: gh('godotengine/godot'), category: 'games', folder: 'open-games', tags: ['game-engine'] });
    matrix('OBS Studio', 'obs-studio', 'Streaming and recording studio.', ['30.0.2', '30.1.2', '30.2.3', '31.0.3', '31.1.2', '32.0.0'],
      [WIN_X64, MAC_ARM, ['Linux x64', 'linux', 'tar.gz', 'x64', 130, 170]],
      { url: gh('obsproject/obs-studio'), category: 'applications', folder: 'media-tools', tags: ['streaming', 'recording'] });
    matrix('Shotcut', 'shotcut', 'Timeline-based open video editor.', ['24.06.26', '24.10.29', '25.01.25', '25.05.11', '25.08.16'],
      [WIN_X64, ['Linux AppImage', 'linux', 'appimage', 'x64', 95, 130], MAC_ARM],
      { url: gh('mltframework/shotcut'), category: 'applications', folder: 'media-tools', tags: ['video'] });
    matrix('Kdenlive', 'kdenlive', 'KDE non-linear video editor.', ['24.02.2', '24.08.3', '24.12.3', '25.04.3', '25.08.0'],
      [WIN_X64, ['Linux AppImage', 'linux', 'appimage', 'x64', 110, 150]],
      { url: gh('KDE/kdenlive', '', ''), url: 'https://kdenlive.org/download/', category: 'applications', folder: 'media-tools', tags: ['video'] });
    matrix('GIMP 3', 'gimp3', 'GIMP 3.0 -- GTK3, non-destructive editing, CMYK groundwork.', ['3.0.0', '3.0.2', '3.0.4'],
      [WIN_X64, ['Linux AppImage', 'linux', 'appimage', 'x64', 250, 320], MAC_ARM],
      { url: 'https://download.gimp.org/gimp/v3.0/', category: 'applications', folder: 'media-tools', tags: ['image-editing'] });
    matrix('Audacity', 'audacity', 'Open audio editor and recorder.', ['3.5.1', '3.6.4', '3.7.3'],
      [WIN_X64, ['Linux AppImage', 'linux', 'appimage', 'x64', 15, 25], MAC_ARM],
      { url: gh('audacity/audacity'), category: 'applications', folder: 'media-tools', tags: ['audio'] });
    matrix('Bambu Studio', 'bambu-studio', 'Bambu Lab slicer (forked from PrusaSlicer).', ['v01.09.05', 'v01.10.01', 'v02.00.03', 'v02.02.00'],
      [WIN_X64, ['Linux AppImage/ubuntu22 build', 'linux', 'appimage', 'x64', 260, 320], MAC_ARM],
      { url: gh('bambulab/BambuStudio'), category: 'applications', folder: 'maker-embedded', tags: ['3d-printing', 'slicer'] });
    matrix('OrcaSlicer', 'orca-slicer', 'Advanced open slicer: calibration tests, multi-material, fast.', ['v2.0.0', 'v2.1.1', 'v2.2.0', 'v2.3.0'],
      [WIN_X64, ['Linux AppImage', 'linux', 'appimage', 'x64', 130, 180], MAC_ARM],
      { url: gh('SoftFever/OrcaSlicer'), category: 'applications', folder: 'maker-embedded', tags: ['3d-printing', 'slicer'] });
    matrix('PrusaSlicer', 'prusaslicer', 'Prusa3D slicer.', ['2.7.4', '2.8.1', '2.9.2'],
      [WIN_X64, ['Linux AppImage', 'linux', 'appimage', 'x64', 60, 90], MAC_ARM],
      { url: gh('prusa3d/PrusaSlicer'), category: 'applications', folder: 'maker-embedded', tags: ['3d-printing', 'slicer'] });
    matrix('UltiMaker Cura', 'cura', 'UltiMaker slicer with big printer profiles library.', ['5.6.0', '5.8.1', '5.10.0'],
      [WIN_X64, ['Linux AppImage', 'linux', 'appimage', 'x64', 220, 300], MAC_ARM],
      { url: gh('Ultimaker/Cura'), category: 'applications', folder: 'maker-embedded', tags: ['3d-printing', 'slicer'] });
    matrix('KiCad', 'kicad', 'Open-source electronics design suite.', ['8.0.4', '8.0.7', '9.0.2', '9.0.4'],
      [WIN_X64, ['Linux x64 (archive)', 'linux', 'tar.xz', 'x64', 900, 1100]],
      { url: 'https://www.kicad.org/download/', category: 'applications', folder: 'maker-embedded', tags: ['eda', 'pcb'] });
    matrix('FreeCAD', 'freecad', 'Parametric 3D CAD modeler.', ['1.0.0', '1.0.1', '1.0.2'],
      [WIN_X64, ['Linux AppImage', 'linux', 'appimage', 'x64', 750, 950], MAC_ARM],
      { url: gh('FreeCAD/FreeCAD'), category: 'applications', folder: 'maker-embedded', tags: ['cad'] });

    // ==================================================================
    // Modern security tooling (current majors)
    // ==================================================================
    matrix('Wireshark', 'wireshark-modern', 'World-standard packet analyzer (4.x line).', ['4.2.5', '4.4.2', '4.4.6', '4.6.0'],
      [WIN_X64, ['Linux source', 'linux', 'tar.xz', null, 40, 50], ['macOS universal', 'macos', 'dmg', 'universal', 120, 150]],
      { url: 'https://www.wireshark.org/#download', category: 'utilities', folder: 'security-pentest', tags: ['network', 'pcap'] });
    matrix('Nmap', 'nmap-modern', 'Network discovery and scanning.', ['7.95', '7.98'],
      [WIN_X64, ['Linux RPM', 'linux', 'rpm', 'x64', 26, 30]],
      { url: 'https://nmap.org/download.html', category: 'utilities', folder: 'security-pentest', tags: ['network', 'scanner'] });
    matrix('Ghidra', 'ghidra', 'NSA-released software reverse engineering suite.', ['11.0.3', '11.1.2', '11.2.1', '11.3.2'],
      [['All platforms (needs JDK 21)', 'cross-platform', 'zip', null, 480, 550]],
      { url: 'https://github.com/NationalSecurityAgency/ghidra/releases', category: 'development', folder: 'security-pentest', tags: ['reverse-engineering'] });
    matrix('Frida', 'frida', 'Dynamic instrumentation toolkit.', ['16.2.1', '16.4.10', '17.2.5'],
      [['Windows x64 exe bundle', 'windows', 'zip', 'x64', 30, 55], ['Linux x64 tarball', 'linux', 'tar.gz', 'x64', 30, 55]],
      { url: gh('frida/frida'), category: 'development', folder: 'security-pentest', tags: ['reversing', 'instrumentation'] });
    matrix('rizin + Cutter', 'rizin-cutter', 'radare2 fork + its Qt frontend.', ['v0.7.4', 'v0.8.0'],
      [['Cutter Windows x64', 'windows', 'zip', 'x64', 85, 110], ['Cutter Linux AppImage', 'linux', 'appimage', 'x64', 85, 110]],
      { url: gh('rizinorg/cutter'), category: 'development', folder: 'security-pentest', tags: ['reversing'] });
    matrix('Nuclei', 'nuclei', 'Template-based vulnerability scanner.', ['v3.2.9', 'v3.4.5'],
      [WIN_X64, LIN_X64], { url: gh('projectdiscovery/nuclei'), category: 'utilities', folder: 'security-pentest', tags: ['scanner'] });
    matrix('ProjectDiscovery bundle (httpx+subfinder+katana)', 'pd-bundle', 'HTTP prober, subdomain finder and crawler in one archive.', ['2025-Q2', '2025-Q4'],
      [WIN_X64, LIN_X64], { url: 'https://github.com/projectdiscovery', category: 'utilities', folder: 'security-pentest', tags: ['recon'] });

    // ==================================================================
    // Current Windows line (end 2025 / 2026 refresh)
    // ==================================================================
    const winNow = [
      ['Windows 11 25H2 (consumer, x64)', 'Win11_25H2_English_x64.iso', 6200, 'microsoft windows 11 25h2 consumer', 'Current 2025 feature update: refined Start, new scroll apps, S-mode retirement groundwork.'],
      ['Windows 11 25H2 (business, x64)', 'Win11_25H2_Business_x64.iso', 6100, 'microsoft windows 11 25h2 business', 'Pro/Enterprise/Education editions with WDAC templates updated.'],
      ['Windows 11 25H2 (ARM64)', 'Win11_25H2_ARM64.iso', 5900, 'microsoft windows 11 25h2 arm64', 'For Snapdragon X laptops; includes the x86 emulation layer with AVX support.'],
      ['Windows 11 Enterprise LTSC 2024 (x64)', 'en-us_windows_11_enterprise_ltsc_2024_x64_dvd.iso', 5500, 'microsoft windows 11 ltsc 2024', 'Ten-year servicing channel: no Copilot, no store bloat; the build admins love.'],
      ['Windows Server 2025 (x64)', 'en-us_windows_server_2025_x64_dvd.iso', 5900, 'microsoft windows server 2025', 'Hotpatching by default, SMB over QUIC, dMSA service-account evolution.'],
    ];
    for (const [name, file, sizeMB, source, desc] of winNow) {
      add({
        name, slugBase: name,
        description: `${desc} Multi-edition ISO from Microsoft's download portal; install does not accept activation without a valid license.`,
        version: name.match(/\d{4}|25H2/)?.[0] || '25H2',
        file_name: file, file_size: sizeMB * MB,
        file_type: 'iso', platform: 'windows', arch: name.includes('ARM64') ? 'arm64' : 'x64',
        url: 'https://www.microsoft.com/software-download/windows11',
        license: 'proprietary', category: 'operating-systems',
        folder: name.includes('Server') ? 'windows-server' : 'windows-11-isos',
        tags: ['windows', '2025'],
      });
    }

    // ==================================================================
    // Modern driver lines
    // ==================================================================
    const nv = ['545.84', '551.86', '555.99', '561.09', '566.03', '572.16', '576.80', '580.88'];
    matrix('NVIDIA Game Ready Driver', 'nvidia-grd', 'GeForce Game Ready WHQL driver for RTX 20/30/40/50 series.', nv,
      [['Windows 10/11 x64 DCH', 'windows', 'exe', 'x64', 700, 900]],
      { url: 'https://www.nvidia.com/Download/index.aspx', license: 'proprietary', category: 'applications', folder: 'drivers-firmware', tags: ['driver', 'nvidia'] });
    matrix('NVIDIA Studio Driver', 'nvidia-studio', 'Creator-certified Studio WHQL driver.', nv.slice(1),
      [['Windows 10/11 x64 DCH', 'windows', 'exe', 'x64', 700, 900]],
      { url: 'https://www.nvidia.com/Download/index.aspx', license: 'proprietary', category: 'applications', folder: 'drivers-firmware', tags: ['driver', 'nvidia'] });
    matrix('NVIDIA open kernel modules', 'nvidia-open-kmod', 'Official open Linux GPU kernel modules from NVIDIA (x86_64 + aarch64).', ['555.42.06', '560.35.03', '570.133.07', '580.82.07'],
      [['Linux x64', 'linux', 'run', 'x64', 90, 120], ['Linux aarch64', 'linux', 'run', 'arm64', 90, 120]],
      { url: gh('NVIDIA/open-gpu-kernel-modules'), category: 'applications', folder: 'drivers-firmware', tags: ['driver', 'nvidia', 'linux'] });
    matrix('AMD Adrenalin', 'amd-adrenalin', 'Radeon Software Adrenalin for RX 5000/6000/7000/9000.', ['23.12.1', '24.5.1', '24.9.1', '24.12.1', '25.3.1', '25.6.1', '25.8.1'],
      [['Windows 10/11 x64', 'windows', 'exe', 'x64', 600, 750]],
      { url: 'https://www.amd.com/support', license: 'proprietary', category: 'applications', folder: 'drivers-firmware', tags: ['driver', 'amd'] });
    matrix('Intel Arc Graphics Driver', 'intel-arc', 'Intel Arc + Iris Xe driver.', ['101.5333', '101.5594', '101.6130', '101.6734'],
      [['Windows 10/11 x64', 'windows', 'exe', 'x64', 850, 1000]],
      { url: 'https://www.intel.com/content/www/us/en/download/785597/', license: 'proprietary', category: 'applications', folder: 'drivers-firmware', tags: ['driver', 'intel'] });

    // ==================================================================
    // Nightly-build archives (projects that genuinely publish daily builds)
    // ==================================================================
    const nightlyProjects = [
      ['Blender Daily Builds', 'blender-daily', 'https://builder.blender.org/download/daily/', 380, 480, 'windows', 'zip', 'x64'],
      ['Blender Daily Builds (Linux)', 'blender-daily-linux', 'https://builder.blender.org/download/daily/', 280, 380, 'linux', 'tar.xz', 'x64'],
      ['Krita Next (nightly)', 'krita-next', 'https://binary-factory.kde.org/job/Krita_Nightly_Windows_Build/', 190, 230, 'windows', 'zip', 'x64'],
      ['Inkscape continuous build', 'inkscape-nightly', 'https://inkscape.org/release/development/latest/', 130, 170, 'windows', 'zip', 'x64'],
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
    ];
    // Sparse-but-plausible archive: not 365 rows/project, one snapshot roughly
    // every ~10 days for the last 200 days + last 10 days daily.
    for (const [base, slug, url, sMin, sMax, platform, ext, arch] of nightlyProjects) {
      const now = Date.now();
      const dates = [];
      for (let d = 200; d > 10; d -= 10) dates.push(d);
      for (let d = 9; d >= 0; d -= 2) dates.push(d);
      for (const d of dates) {
        const date = new Date(now - d * 86400_000);
        const stamp = date.toISOString().slice(0, 10);
        add({
          name: `${base} ${stamp}`, slugBase: `${slug}-${stamp}`,
          description: `${base.replace(/\s*\(.*\)/, '')} automated build snapshot from ${stamp}. Bleeding-edge; prefer the stable page unless you are chasing a specific fix.`,
          version: `nightly-${stamp}`,
          file_name: `${slug}-${stamp}.${ext === 'tar.xz' ? 'tar.xz' : ext}`,
          file_size: int(sMin, sMax) * MB,
          file_type: ext, platform, arch,
          url, source: url,
          category: platform === 'cross-platform' ? 'utilities' : 'applications',
          folder: 'nightly-builds',
          tags: ['nightly', platform],
          maxAgeDays: 210,
        });
      }
    }

    // ==================================================================
    // npm registry release archive (real public tarballs)
    // ==================================================================
    const npmPool = [
      ['react', ['18.2.0', '18.3.0', '18.3.1', '19.0.0', '19.1.0', '19.2.0']],
      ['react-dom', ['18.3.1', '19.0.0', '19.1.0']],
      ['vue', ['3.4.21', '3.4.38', '3.5.13', '3.5.18']],
      ['svelte', ['4.2.18', '5.0.0', '5.28.1', '5.38.0']],
      ['@angular/core', ['16.2.12', '17.3.12', '18.2.13', '19.2.14', '20.2.0']],
      ['next', ['14.2.5', '15.0.3', '15.3.4', '15.5.2']],
      ['nuxt', ['3.12.4', '3.15.4', '4.0.0', '4.0.3']],
      ['vite', ['5.2.13', '6.0.7', '7.1.2']],
      ['vitest', ['1.6.0', '2.1.9', '3.1.4', '3.2.4']],
      ['playwright', ['1.44.1', '1.47.2', '1.52.0', '1.55.0']],
      ['typescript', ['5.4.5', '5.6.3', '5.7.3', '5.8.3', '5.9.2']],
      ['tailwindcss', ['3.4.4', '3.4.13', '4.0.0', '4.1.12']],
      ['eslint', ['8.57.0', '9.9.1', '9.17.0', '9.33.0']],
      ['prettier', ['3.2.5', '3.3.3', '3.4.2', '3.6.2']],
      ['lodash-es', ['4.17.21']],
      ['axios', ['1.6.8', '1.7.7', '1.8.4', '1.11.0']],
      ['express', ['4.19.2', '4.21.2', '5.0.1', '5.1.0']],
      ['fastify', ['4.28.1', '5.0.0', '5.4.0', '5.6.0']],
      ['hono', ['4.4.13', '4.6.15', '4.8.3']],
      ['zod', ['3.23.8', '3.24.4', '4.0.17', '4.1.5']],
      ['drizzle-orm', ['0.33.0', '0.38.4', '0.44.4']],
      ['prisma', ['5.15.1', '5.22.0', '6.11.0', '6.15.0']],
      ['better-sqlite3', ['11.1.0', '11.7.0', '12.2.0']],
      ['socket.io', ['4.7.5', '4.8.1']],
      ['pino', ['9.2.0', '9.7.0']],
      ['winston', ['3.13.1', '3.17.0']],
      ['bullmq', ['5.12.9', '5.58.0']],
      ['ioredis', ['5.4.1', '5.7.4']],
      ['mongoose', ['8.4.4', '8.9.7', '8.16.2']],
      ['@supabase/supabase-js', ['2.44.4', '2.55.0']],
      ['firebase', ['10.12.2', '10.14.1', '11.3.1', '11.10.0']],
      ['three', ['0.165.0', '0.170.0', '0.178.0']],
      ['babylonjs', ['7.25.0', '8.14.1']],
      ['@react-three/fiber', ['8.16.8', '9.1.4']],
      ['d3', ['7.9.0']],
      ['chart.js', ['4.4.3', '4.5.0']],
      ['electron', ['30.3.1', '32.2.8', '35.5.1', '37.2.6']],
      ['electron-builder', ['24.13.3', '25.1.8', '26.0.12']],
      ['tauri', ['1.6.9', '2.0.6', '2.6.0']],
      ['@tauri-apps/cli', ['2.0.0', '2.5.0']],
      ['turbo', ['1.13.4', '2.3.3', '2.5.6']],
      ['nx', ['19.5.4', '20.3.3', '21.4.1']],
      ['husky', ['9.0.11', '9.1.7']],
      ['lint-staged', ['15.2.7', '16.1.4']],
      ['storybook', ['8.1.11', '8.3.6', '9.0.18']],
      ['cypress', ['13.13.0', '15.0.0']],
      ['puppeteer', ['22.14.0', '23.11.1', '24.15.0']],
      ['@modelcontextprotocol/sdk', ['1.0.4', '1.12.1', '1.17.4']],
      ['ai', ['3.3.17', '4.3.16', '5.0.15']],
      ['langchain', ['0.2.16', '0.3.33']],
      ['openai', ['4.53.0', '4.104.0', '5.15.0']],
      ['@anthropic-ai/sdk', ['0.24.3', '0.51.0', '0.60.0']],
      ['inquirer', ['9.3.7', '12.6.3']],
      ['commander', ['12.1.0', '14.0.0']],
      ['chalk', ['5.3.0', '5.6.0']],
      ['ora', ['8.0.1', '9.0.2']],
      ['execa', ['9.3.0', '9.6.0']],
      ['dotenv', ['16.4.5', '17.2.0']],
      ['date-fns', ['3.6.0', '4.1.0']],
      ['dayjs', ['1.11.11', '1.11.13']],
      ['zustand', ['4.5.4', '5.0.3', '5.0.6']],
      ['jotai', ['2.8.4', '2.12.5']],
      ['@tanstack/react-query', ['5.45.1', '5.62.0', '5.84.1']],
      ['framer-motion', ['11.3.8', '11.18.2', '12.23.12']],
      ['lucide-react', ['0.405.0', '0.454.0', '0.540.0']],
      ['@shadcn/ui', ['0.0.4']],
      ['antd', ['5.19.2', '5.21.4', '6.0.0-alpha.1']],
      ['@mui/material', ['5.16.4', '6.1.6', '7.2.0']],
      ['bootstrap', ['5.3.3']],
      ['@fontsource/inter', ['5.0.20', '5.2.5']],
      ['swagger-ui', ['5.17.14', '5.28.0']],
      ['marked', ['12.0.2', '16.2.0']],
      ['shiki', ['1.10.3', '3.9.2']],
      ['prismjs', ['1.29.0']],
      ['monaco-editor', ['0.50.0', '0.52.2']],
      ['ace-builds', ['1.36.5', '1.43.2']],
      ['codemirror', ['6.0.1']],
      ['jsdom', ['24.1.0', '25.0.1', '27.0.0']],
      ['sharp', ['0.33.4', '0.34.3']],
      ['jimp', ['1.6.0']],
      ['pdf-lib', ['1.17.1']],
      ['xlsx', ['0.18.5']],
      ['papaparse', ['5.4.1', '5.5.3']],
      ['jsonwebtoken', ['9.0.2']],
      ['bcryptjs', ['2.4.3', '3.0.2']],
      ['argon2', ['0.40.3', '0.43.1']],
      ['nodemailer', ['6.9.14', '7.0.3']],
      ['mqtt', ['5.7.3', '5.14.0']],
      ['ws', ['8.18.0']],
      ['undici', ['6.19.7', '7.11.0']],
      ['got', ['14.4.2']],
      ['cheerio', ['1.0.0', '1.1.2']],
      ['puppeteer-core', ['22.14.0', '24.15.0']],
      ['@playwright/test', ['1.44.1', '1.55.0']],
      ['msw', ['2.3.5', '2.11.3']],
      ['supertest', ['7.0.0']],
      ['chai', ['5.1.1', '6.0.1']],
      ['mocha', ['10.7.3', '11.7.1']],
      ['jest', ['29.7.0', '30.0.5']],
      ['@swc/core', ['1.6.13', '1.12.14']],
      ['esbuild', ['0.21.5', '0.24.0', '0.25.8']],
      ['rollup', ['4.18.1', '4.44.2']],
      ['webpack', ['5.93.0', '5.99.9']],
      ['rspack', ['0.7.5', '1.4.13']],
      ['parcel', ['2.12.0', '2.15.4']],
      ['tsup', ['8.1.0', '8.5.0']],
      ['tsx', ['4.16.2', '4.20.5']],
      ['ts-node', ['10.9.2']],
      ['nodemon', ['3.1.4', '3.1.10']],
      ['concurrently', ['8.2.2', '9.2.1']],
      ['cross-env', ['7.0.3', '10.0.0']],
      ['rimraf', ['5.0.9', '6.0.1']],
      ['fs-extra', ['11.2.0']],
      ['glob', ['10.4.5', '11.0.3']],
      ['globby', ['14.0.2', '15.0.0']],
    ];
    for (const [pkg, versions] of npmPool) {
      for (const v of versions) {
        const tarball = `${pkg.startsWith('@') ? pkg.split('/')[1] : pkg}-${v}.tgz`;
        add({
          name: `npm: ${pkg} ${v}`,
          slugBase: `npm ${pkg.replace('@', '').replace('/', '-')} ${v}`,
          description: `Registry release tarball for ${pkg}@${v}. Straight from the public npm CDN -- verify the integrity hash in the lockfile when pinning.`,
          version: v,
          file_name: tarball,
          file_size: int(80, 4000) * KB,
          file_type: 'tgz', platform: 'cross-platform', arch: null,
          url: `https://registry.npmjs.org/${pkg}/-/${tarball}`,
          license: 'redistributable',
          category: 'development', folder: 'dev-tools',
          tags: ['npm', 'javascript'],
          maxAgeDays: 400,
        });
      }
    }

    // Modern docs (2024-2026 wave)
    const modernDocs = [
      ['The 2026 local-LLM hardware guide', 'local-llm-hardware-2026', '2026.1', 'VRAM math, unified memory, and which GPU actually maps to which model size.'],
      ['Prompt caching by provider', 'prompt-caching-refs', '2025.3', 'Anthropic / OpenAI / Gemini cache pricing and TTL rules compared.'],
      ['Model Context Protocol spec digest', 'mcp-spec-digest', '2025.9', 'What MCP servers can actually expose: tools, resources, prompts.'],
      ['Running agents in Docker securely', 'agents-in-docker', '2025.4', 'Network policy, read-only FS, secret mounts for coding agents.'],
      ['Tailwind v4 migration notes', 'tailwind-v4-migration', '2025.1', 'PostCSS to native CSS config and what to expect for IntelliSense.'],
      ['Svelte 5 runes field guide', 'svelte5-runes', '2025.2', '$state/$derived/$effect with the classic mistakes.'],
      ['React Server Components, honestly', 'rsc-honest', '2025.1', 'Server vs client trees, caching, and the real-world mental model.'],
      ['Biome vs ESLint+Prettier', 'biome-vs-eslint', '2025.3', 'Speed numbers, plugin gap, migration scripts.'],
      ['Rust for backend engineers 2026', 'rust-backend-2026', '2026.2', 'axum/tokio patterns, sqlx typed queries, tracing, cargo-deny.'],
      ['Go 1.25 changes worth knowing', 'go-125-notes', '2025.8', 'green tea GC, encoding/json/v2, sync improvements.'],
      ['Postgres 18 upgrade guide', 'pg18-upgrade', '2026.2', 'IO_uring, virtual generated columns and the extension dance.'],
      ['Zero-downtime migrations handbook', 'zero-downtime-migrations', '2025.5', 'Expand-and-contract, dual-writes, backfill scripts.'],
      ['Kubernetes cost tuning quick notes', 'k8s-cost-notes', '2025.6', 'Requests vs limits, VPA, spot pools, in 6 pages.'],
      ['eBPF-based observability primer', 'ebpf-obs', '2025.7', 'pixie/cilium/parca explained for app teams.'],
      ['Self-hosted AI gateway choices', 'ai-gateway-notes', '2026.1', 'LiteLLM, Portkey CE, Kong AI plugin compared.'],
    ];
    for (const [name, slug, v, desc] of modernDocs) {
      add({
        name, slugBase: `doc ${slug}`, description: desc, version: v,
        file_name: `${slug}.pdf`, file_size: int(1, 20) * MB,
        file_type: 'pdf', platform: 'cross-platform', arch: null,
        url: `https://github.com/search?q=${encodeURIComponent(slug)}&type=repositories`,
        license: 'public-domain', category: 'documentation', folder: 'guides-references',
        tags: ['docs', 'modern'],
      });
    }

    return inserted;
  });
  return tx();
}

if (import.meta.url.endsWith(process.argv[1]?.replace(/\\/g, '/'))) {
  const db = getDb();
  const inserted = seedModern(db);
  const total = db.prepare('SELECT COUNT(*) c FROM items').get().c;
  console.log(`Modern seed complete: +${inserted} new items (total ${total}).`);
}
