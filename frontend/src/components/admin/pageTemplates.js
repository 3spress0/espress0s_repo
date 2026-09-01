/**
 * Starting points for a new file page.
 *
 * Creating a page used to mean facing ~25 empty fields with no hint about what
 * a good page looks like. A template pre-fills the mechanical fields (type,
 * platform, architecture, license posture, tags) and drops a markdown skeleton
 * with bracketed prompts into the description, so the admin only fills in the
 * parts that are actually specific to this file.
 *
 * Templates never overwrite anything the admin already typed (see
 * applyTemplate) and are only offered when creating, never when editing.
 */

export const PAGE_TEMPLATES = [
  {
    id: 'blank',
    icon: '📄',
    label: 'Blank page',
    summary: 'Empty form, nothing pre-filled.',
    values: {},
  },
  {
    id: 'linux-iso',
    icon: '💿',
    label: 'Linux distro / ISO',
    summary: 'Bootable image with edition, requirements and checksum notes.',
    categorySlug: 'isos',
    values: {
      file_type: 'iso',
      platform: 'linux',
      architecture: 'x64',
      license_status: 'redistributable',
      tags: 'linux, iso, bootable',
      long_description: [
        '## Overview',
        '',
        '[Distribution name] is [what it is and who should use it]. This page hosts the [edition] image.',
        '',
        '## Editions on this page',
        '',
        '- **[Desktop / Server / Live]** — [what it contains]',
        '',
        '## Requirements',
        '',
        '- CPU: [x64 / arm64]',
        '- RAM: [minimum]',
        '- Disk: [minimum]',
        '- Boot: [UEFI / BIOS / both]',
        '',
        '## Writing the image',
        '',
        '1. Download the ISO from a mirror below.',
        '2. Verify the SHA-256 checksum.',
        '3. Write it with [balenaEtcher / Rufus / `dd`].',
        '',
        '## Notes',
        '',
        '- [release channel, support window, known issues]',
      ].join('\n'),
      linkPresets: ['Google Drive Mirror', 'Official mirror'],
    },
  },
  {
    id: 'windows-app',
    icon: '🪟',
    label: 'Windows application',
    summary: 'Installer with version, requirements and install steps.',
    categorySlug: 'applications',
    values: {
      file_type: 'exe',
      platform: 'windows',
      architecture: 'x64',
      license_status: 'check-license',
      tags: 'windows, application',
      long_description: [
        '## Overview',
        '',
        '[App name] is [what it does]. Use it for [main use case].',
        '',
        '## Key features',
        '',
        '- [feature]',
        '- [feature]',
        '- [feature]',
        '',
        '## Requirements',
        '',
        '- Windows [10 / 11] [x64]',
        '- [.NET / VC++ redistributable / other dependency]',
        '',
        '## Installing',
        '',
        '1. Download the installer below.',
        '2. Verify the SHA-256 checksum.',
        '3. Run the installer and follow the prompts.',
        '',
        '## Licensing',
        '',
        '- [free / trial / requires a licence key — be explicit]',
      ].join('\n'),
      linkPresets: ['Direct download', 'Google Drive Mirror'],
    },
  },
  {
    id: 'utility',
    icon: '🔧',
    label: 'Portable utility',
    summary: 'Small tool, no installer, usage-focused page.',
    categorySlug: 'utilities',
    values: {
      file_type: 'zip',
      platform: 'windows',
      architecture: 'x64',
      license_status: 'redistributable',
      tags: 'utility, portable',
      long_description: [
        '## What it does',
        '',
        '[Tool name] [does X in one sentence].',
        '',
        '## When to use it',
        '',
        '- [scenario]',
        '- [scenario]',
        '',
        '## Usage',
        '',
        '```',
        '[example command or first-run steps]',
        '```',
        '',
        '## Notes',
        '',
        '- Portable: no installation, run it straight from the archive.',
        '- [flags anti-virus? needs admin rights? mention it here]',
      ].join('\n'),
      linkPresets: ['Direct download'],
    },
  },
  {
    id: 'dev-tool',
    icon: '💻',
    label: 'Developer tool / SDK',
    summary: 'Toolchain page with platforms and install commands.',
    categorySlug: 'development',
    values: {
      file_type: 'zip',
      platform: 'cross-platform',
      architecture: 'x64',
      license_status: 'redistributable',
      tags: 'development, sdk',
      long_description: [
        '## Overview',
        '',
        '[Tool name] [version] — [what it is used for].',
        '',
        '## Included',
        '',
        '- [binaries / libraries / headers]',
        '',
        '## Install',
        '',
        '```bash',
        '[install or extract command]',
        '```',
        '',
        '## Compatibility',
        '',
        '- Platforms: [linux / macos / windows]',
        '- Requires: [runtime or compiler version]',
        '',
        '## Docs',
        '',
        '- [link to official documentation]',
      ].join('\n'),
      linkPresets: ['GitHub release', 'Google Drive Mirror'],
    },
  },
  {
    id: 'game',
    icon: '🎮',
    label: 'Game / emulator',
    summary: 'Specs, controls and setup notes.',
    categorySlug: 'games',
    values: {
      file_type: 'zip',
      platform: 'windows',
      architecture: 'x64',
      license_status: 'check-license',
      tags: 'games',
      long_description: [
        '## Overview',
        '',
        '[Title] — [genre, what it is].',
        '',
        '## System requirements',
        '',
        '- OS: [windows 10+]',
        '- CPU / GPU: [minimum]',
        '- RAM: [minimum]',
        '- Disk: [size]',
        '',
        '## Setup',
        '',
        '1. Extract the archive.',
        '2. [run / configure / add BIOS or ROMs]',
        '',
        '## Notes',
        '',
        '- [controller support, mods, known issues]',
        '- [licensing status — be explicit]',
      ].join('\n'),
      linkPresets: ['Google Drive Mirror'],
    },
  },
  {
    id: 'document',
    icon: '📚',
    label: 'Document / manual',
    summary: 'PDF or guide with contents and edition info.',
    categorySlug: 'documentation',
    values: {
      file_type: 'pdf',
      platform: 'cross-platform',
      architecture: 'universal',
      license_status: 'check-license',
      tags: 'documentation, pdf',
      long_description: [
        '## About this document',
        '',
        '[Title] — [what it covers and who it is for].',
        '',
        '## Contents',
        '',
        '- [chapter / section]',
        '- [chapter / section]',
        '',
        '## Edition',
        '',
        '- Version / printing: [edition]',
        '- Pages: [count]',
        '- Language: [language]',
        '',
        '## Source',
        '',
        '- [where it came from, and its licence]',
      ].join('\n'),
      linkPresets: ['Direct download'],
    },
  },
];

export function getTemplate(id) {
  return PAGE_TEMPLATES.find(t => t.id === id) || PAGE_TEMPLATES[0];
}

/**
 * Merge a template into the current form without clobbering the admin's work.
 * Only fields that are still empty (or still at their default) are filled.
 *
 * @param {object} form        current form state
 * @param {object} template    a PAGE_TEMPLATES entry
 * @param {Array}  categories  categories from the API, to resolve categorySlug
 * @returns {{form: object, links: Array}}
 */
export function applyTemplate(form, template, categories = []) {
  const values = template.values || {};
  const next = { ...form };

  for (const [key, value] of Object.entries(values)) {
    if (key === 'linkPresets') continue;
    const current = next[key];
    const isEmpty = current === '' || current === null || current === undefined;
    const isDefaultLicense = key === 'license_status' && current === 'check-license';
    if (isEmpty || isDefaultLicense) next[key] = value;
  }

  if (template.categorySlug && (next.category_id === '' || next.category_id === null)) {
    const match = categories.find(c => c.slug === template.categorySlug);
    if (match) next.category_id = String(match.id);
  }

  const links = (values.linkPresets || []).map((label, index) => ({
    label,
    storage_provider: label.toLowerCase().includes('drive') ? 'gdrive'
      : label.toLowerCase().includes('github') ? 'github'
      : 'external',
    storage_path: '',
    download_url: '',
    file_size: '',
    is_primary: index === 0,
    is_down: false,
    down_reason: '',
    status: 'up',
    sort_order: index,
  }));

  return { form: next, links };
}
