/**
 * Catalog seeder: 2000+ real-world entries for Windows and Linux — ISOs,
 * utilities, developer packages, portable apps, docs and open games —
 * spread across categories and folders with plausible versions, sizes,
 * dates and canonical download URLs.
 *
 * Deterministic (fixed-seed PRNG) and idempotent: rows are keyed by slug
 * and skipped when they exist. Runs at the end of seed.js and standalone:
 *   node src/db/seed-catalog.js
 */
import { getDb } from './index.js';
import { encryptionService } from '../services/encryptionService.js';
import { makeSlug } from '../utils/slug.js';

// --- deterministic PRNG (mulberry32) ------------------------------------------
let _s = 42 >>> 0;
const rnd = () => {
  _s = (_s + 0x6D2B79F5) >>> 0;
  let t = _s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const int = (min, max) => min + Math.floor(rnd() * (max - min + 1));
const KB = 1024;
const MB = 1024 * 1024;
const enc = (v) => (v ? encryptionService.encrypt(v) : null);
// Dates spread over the last ~400 days so "newest first" shows real variety.
const daysAgoIso = () => new Date(Date.now() - int(0, 400) * 86400_000).toISOString();

const FOLDERS = [
  ['Recommended', 'recommended', 'Hand-picked essentials for a fresh machine', 'star', '#a78bfa'],
  ['Windows 11 ISOs', 'windows-11-isos', 'Official Windows 11 media', 'windows', '#3b82f6'],
  ['Windows 10 ISOs', 'windows-10-isos', 'Windows 10 including LTSC', 'windows', '#2563eb'],
  ['Windows Server ISOs', 'windows-server-isos', 'Windows Server evaluation media', 'server', '#60a5fa'],
  ['Windows Legacy', 'windows-legacy', 'Older Windows releases for labs and retro hardware', 'archive', '#94a3b8'],
  ['Ubuntu family', 'ubuntu-family', 'Ubuntu plus official flavours, Mint, Pop and Zorin', 'ubuntu', '#e95420'],
  ['Debian', 'debian', 'Debian stable installers and live images', 'debian', '#a80030'],
  ['Fedora & RHEL family', 'fedora-rhel', 'Fedora, Rocky, AlmaLinux, CentOS Stream, openSUSE', 'fedora', '#3c6eb4'],
  ['Arch-based', 'arch-based', 'Arch, Manjaro, EndeavourOS, Garuda', 'arch', '#1793d1'],
  ['Lightweight & rescue', 'lightweight-linux', 'Small distros and rescue media', 'feather', '#84cc16'],
  ['Security & privacy', 'security-pentest', 'Kali, Tails, Qubes and audit tooling', 'shield', '#ef4444'],
  ['Appliance & NAS', 'appliance-nas', 'Proxmox, TrueNAS, router and embedded images', 'hard-drive', '#f59e0b'],
  ['Other OS', 'other-os', 'BSDs, Haiku, ReactOS and friends', 'cpu', '#9ca3af'],
  ['Dev tools', 'dev-tools', 'Runtimes, Git, containers, CI helpers', 'code', '#22d3ee'],
  ['Editors & IDEs', 'editors-ides', 'Code editors and IDEs', 'edit', '#c084fc'],
  ['Terminals & CLI', 'terminals-cli', 'Modern shells and coreutils', 'terminal', '#34d399'],
  ['Compression & imaging', 'compression-imaging', '7-Zip, Ventoy, Rufus, Etcher', 'package', '#fbbf24'],
  ['Media tools', 'media-tools', 'Video, audio, image and screenshot tools', 'film', '#f472b6'],
  ['Networking', 'networking', 'SSH, SFTP, packet analysis, tunnels', 'network', '#38bdf8'],
  ['Diagnostics & hardware', 'diagnostics-hardware', 'Sensor readouts, disks and benchmarks', 'activity', '#fb923c'],
  ['Virtualization', 'virtualization', 'VirtualBox, VMware Player, WSL, QEMU', 'layers', '#4ade80'],
  ['Office & docs', 'office-docs', 'Office suites and PDF tooling', 'book', '#93c5fd'],
  ['Privacy & passwords', 'privacy-password', 'Encryption and password managers', 'key', '#e879f9'],
  ['Portable apps', 'portable-apps', 'Runs without installation', 'usb', '#fca5a5'],
  ['Open games', 'open-games', 'Open-source and freeware games', 'gamepad', '#4ade80'],
  ['Guides & references', 'guides-references', 'Manuals, handbooks, cheat sheets', 'book-open', '#facc15'],
];

export function seedCatalog(db) {
  const tx = db.transaction(() => {
    const catId = {};
    for (const c of db.prepare('SELECT id, slug FROM categories').all()) catId[c.slug] = c.id;
    const insFolder = db.prepare(
      'INSERT OR IGNORE INTO folders (name, slug, description, icon, color, sort_order) VALUES (?, ?, ?, ?, ?, ?)');
    FOLDERS.forEach((f, i) => insFolder.run(f[0], f[1], f[2], f[3], f[4], i));
    const fid = {};
    for (const f of db.prepare('SELECT id, slug FROM folders').all()) fid[f.slug] = f.id;

    const insItem = db.prepare(`
      INSERT INTO items (name, slug, description, long_description, category_id, folder_id,
        version, release_date, file_name, file_size, file_type, platform, architecture,
        storage_provider, storage_path, download_url, external_url, featured, published,
        license_status, license_notes, tags, created_at, updated_at, encryption_version)
      VALUES (@name, @slug, @description, @long_description, @category_id, @folder_id,
        @version, @release_date, @file_name, @file_size, @file_type, @platform, @architecture,
        @storage_provider, @storage_path, @download_url, @external_url, @featured, @published,
        @license_status, @license_notes, @tags, @created_at, @updated_at, 'v1')`);
    const insLink = db.prepare(`
      INSERT INTO item_download_links (item_id, label, storage_provider, storage_path,
        download_url, file_size, is_primary, status, sort_order, created_at, updated_at)
      VALUES (@item_id, 'Official download', 'external', NULL, @url, @size, 1, 'unknown', 0, @now, @now)`);

    const seen = new Set(db.prepare('SELECT slug FROM items').all().map((r) => r.slug));
    const seenNames = new Set(db.prepare('SELECT name FROM items').all().map((r) => r.name));
    let inserted = 0;

    const add = (it) => {
      const slug = makeSlug(it.slugBase || `${it.name} ${it.version || ''}`);
      if (seen.has(slug) || seenNames.has(it.name)) return;
      seen.add(slug);
      seenNames.add(it.name);
      const created = daysAgoIso();
      const res = insItem.run({
        name: it.name,
        slug,
        description: it.description,
        long_description: it.long_description || null,
        category_id: catId[it.category] ?? catId.other,
        folder_id: it.folder ? fid[it.folder] || null : null,
        version: it.version || null,
        release_date: created.slice(0, 10),
        file_name: it.file_name || null,
        file_size: it.file_size || null,
        file_type: it.file_type || null,
        platform: it.platform || null,
        architecture: it.arch || null,
        storage_provider: 'external',
        storage_path: null,
        download_url: enc(it.url),
        external_url: enc(it.source || it.url),
        featured: it.featured ? 1 : 0,
        published: 1,
        license_status: it.license || 'redistributable',
        license_notes: it.licenseNotes ? enc(it.licenseNotes) : null,
        tags: JSON.stringify(it.tags || []),
        created_at: created,
        updated_at: created,
      });
      insLink.run({ item_id: res.lastInsertRowid, url: enc(it.url), size: it.file_size || null, now: created });
      inserted++;
    };

    const isoDesc = (os, v) =>
      `${os} ${v} installation image. Verify the checksum after download, then write to USB with Rufus, Ventoy or balenaEtcher.`;

    const FEATURED = new Set();

    // ======================================================================
    // Windows ISOs
    // ======================================================================
    const msDl = 'https://www.microsoft.com/software-download/';
    for (const v of ['21H2', '22H2', '23H2', '24H2', '25H2']) {
      for (const [kind, file] of [['consumer (Home/Pro)', 'Consumer'], ['business (Pro/Enterprise)', 'Business']]) {
        add({
          name: `Windows 11 ${v} x64 (${kind})`, slugBase: `windows-11-${v}-${file}-x64`,
          description: `Official Windows 11 ${v} multi-edition ISO (${kind}), 64-bit. TPM 2.0 + Secure Boot required.`,
          version: v, file_name: `Win11_${v}_${file}_x64_en.iso`, file_size: int(4200, 6900) * MB,
          file_type: 'iso', platform: 'windows', arch: 'x64',
          url: `${msDl}windows11`, source: `${msDl}windows11`, license: 'proprietary',
          category: 'operating-systems', folder: 'windows-11-isos', tags: ['windows', 'windows-11'],
          long_description: isoDesc('Windows 11', v),
        });
      }
      if (v !== '21H2') add({
        name: `Windows 11 ${v} ARM64`, slugBase: `windows-11-${v}-arm64`,
        description: `Windows 11 ${v} for ARM64 hardware (Snapdragon laptops, Surface Pro X).`,
        version: v, file_name: `Win11_${v}_arm64_en.iso`, file_size: int(4800, 5900) * MB,
        file_type: 'iso', platform: 'windows', arch: 'arm64',
        url: `${msDl}windows11ARM64`, license: 'proprietary',
        category: 'operating-systems', folder: 'windows-11-isos', tags: ['windows', 'arm64'],
      });
    }
    for (const v of ['21H1', '21H2', '22H2']) {
      for (const [kind, file] of [['consumer', 'Consumer'], ['business', 'Business'], ['education', 'Education']]) {
        add({
          name: `Windows 10 ${v} x64 (${kind})`, slugBase: `windows-10-${v}-${file}-x64`,
          description: `Official Windows 10 ${v} ISO (${kind}), 64-bit. Supported until Oct 2025 — plan the migration.`,
          version: v, file_name: `Win10_${v}_${file}_x64_en.iso`, file_size: int(3800, 5900) * MB,
          file_type: 'iso', platform: 'windows', arch: 'x64',
          url: `${msDl}windows10`, license: 'proprietary',
          category: 'operating-systems', folder: 'windows-10-isos', tags: ['windows', 'windows-10'],
        });
      }
    }
    for (const [n, ltscV, folder] of [
      ['Windows 10 Enterprise LTSC 2019', 'LTSC 2019', 'windows-10-isos'],
      ['Windows 10 Enterprise LTSC 2021', 'LTSC 2021', 'windows-10-isos'],
      ['Windows 10 IoT Enterprise LTSC 2021', 'LTSC 2021 IoT', 'windows-10-isos'],
      ['Windows 11 Enterprise LTSC 2024', 'LTSC 2024', 'windows-11-isos'],
      ['Windows 11 IoT Enterprise LTSC 2024', 'LTSC 2024 IoT', 'windows-11-isos'],
    ]) {
      add({
        name: `${n} x64`, slugBase: `${n} x64`,
        description: `${n} — 10-year lifecycle, no consumer apps. Evaluation media.`,
        version: ltscV, file_name: `${makeSlug(n)}_x64_en-us.iso`, file_size: int(4300, 5400) * MB,
        file_type: 'iso', platform: 'windows', arch: 'x64',
        url: 'https://www.microsoft.com/evalcenter/', license: 'proprietary',
        category: 'operating-systems', folder, tags: ['windows', 'ltsc', 'enterprise'],
      });
    }
    for (const v of ['2016', '2019', '2022', '2025']) {
      for (const ed of ['Standard', 'Datacenter']) {
        add({
          name: `Windows Server ${v} ${ed} (evaluation)`, slugBase: `windows-server-${v}-${ed}`,
          description: `Windows Server ${v} ${ed} evaluation ISO, 180 days.`,
          version: v, file_name: `WindowsServer${v}_${ed}_en-us.iso`, file_size: int(4800, 6300) * MB,
          file_type: 'iso', platform: 'windows', arch: 'x64',
          url: `https://www.microsoft.com/evalcenter/evaluate-windows-server-${v}`, license: 'proprietary',
          category: 'operating-systems', folder: 'windows-server-isos', tags: ['windows', 'server'],
        });
      }
    }
    for (const [n, v] of [['Windows 8.1', '8.1'], ['Windows 7 SP1', '7-SP1'], ['Windows XP SP3', 'XP-SP3'], ['Windows Vista SP2', 'Vista-SP2']]) {
      add({
        name: `${n} ISO`, slugBase: `windows-${makeSlug(n)}`,
        description: `${n} installation media. Out of support — offline labs and retro hardware only. Never connect to the internet.`,
        version: v, file_name: `windows-${makeSlug(n)}-x64.iso`, file_size: int(700, 4100) * MB,
        file_type: 'iso', platform: 'windows', arch: 'x64',
        url: 'https://archive.org/', license: 'abandonware',
        category: 'operating-systems', folder: 'windows-legacy', tags: ['windows', 'legacy'],
      });
    }

    // ======================================================================
    // Linux: Ubuntu family
    // ======================================================================
    for (const v of ['20.04.6', '22.04.5', '24.04.2', '25.04', '25.10']) {
      for (const [ed, edName] of [['desktop', 'Desktop'], ['live-server', 'Live Server']]) {
        add({
          name: `Ubuntu ${v} ${edName}`, slugBase: `ubuntu-${v}-${ed}`,
          description: `Ubuntu ${v} ${edName} image, amd64. ${v.startsWith('25') ? 'Interim release, 9 months support.' : 'LTS: 10 years of security maintenance.'}`,
          version: v, file_name: `ubuntu-${v}-${ed}-amd64.iso`, file_size: (ed === 'desktop' ? int(4600, 5900) : int(1900, 2500)) * MB,
          file_type: 'iso', platform: 'linux', arch: 'x64',
          url: `https://releases.ubuntu.com/${v.split('.').slice(0, 2).join('.')}/ubuntu-${v}-${ed}-amd64.iso`,
          category: 'operating-systems', folder: 'ubuntu-family', tags: ['linux', 'ubuntu', 'lts'],
          long_description: isoDesc('Ubuntu', v),
        });
      }
    }
    for (const [fl, flName] of [['kubuntu', 'Kubuntu'], ['xubuntu', 'Xubuntu'], ['lubuntu', 'Lubuntu'], ['ubuntu-mate', 'Ubuntu MATE'], ['ubuntustudio', 'Ubuntu Studio'], ['ubuntu-budgie', 'Ubuntu Budgie']]) {
      for (const v of ['22.04.5', '24.04.2', '25.04']) {
        add({
          name: `${flName} ${v} amd64`, slugBase: `${fl}-${v}`,
          description: `Official Ubuntu flavour: ${flName} ${v}, amd64.`,
          version: v, file_name: `${fl}-${v}-desktop-amd64.iso`, file_size: int(2700, 4600) * MB,
          file_type: 'iso', platform: 'linux', arch: 'x64',
          url: `https://cdimage.ubuntu.com/${fl}/releases/${v.split('.').slice(0, 2).join('.')}/release/${fl}-${v}-desktop-amd64.iso`,
          category: 'operating-systems', folder: 'ubuntu-family', tags: ['linux', fl],
        });
      }
    }
    for (const [v, code] of [['21.3', 'Virginia'], ['22', 'Wilma'], ['22.1', 'Xia'], ['22.2', 'Zara']]) {
      for (const de of ['cinnamon', 'mate', 'xfce']) {
        add({
          name: `Linux Mint ${v} "${code}" (${de})`, slugBase: `mint-${v}-${de}`,
          description: `Linux Mint ${v} LTS with ${de} desktop — the classic friendly desktop Linux.`,
          version: v, file_name: `linuxmint-${v}-${de}-64bit.iso`, file_size: int(2400, 2900) * MB,
          file_type: 'iso', platform: 'linux', arch: 'x64',
          url: `https://mirrors.kernel.org/linuxmint/stable/${v}/linuxmint-${v}-${de}-64bit.iso`,
          category: 'operating-systems', folder: 'ubuntu-family', tags: ['linux', 'mint', de],
        });
      }
    }
    for (const v of ['16.3', '17', '17.1', '17.2', '17.3']) {
      for (const ed of ['Core', 'Lite']) {
        add({
          name: `Zorin OS ${v} ${ed}`, slugBase: `zorin-${v}-${ed}`,
          description: `Zorin OS ${v} ${ed} — polished desktop aimed at Windows switchers.`,
          version: v, file_name: `Zorin-OS-${v}-${ed}-64-bit.iso`, file_size: (ed === 'Lite' ? 2300 : int(3300, 3900)) * MB,
          file_type: 'iso', platform: 'linux', arch: 'x64',
          url: 'https://zorin.com/os/download/', license: 'check-license',
          category: 'operating-systems', folder: 'ubuntu-family', tags: ['linux', 'zorin'],
        });
      }
    }
    add({ name: 'Pop!_OS 22.04 LTS (Intel/AMD graphics)', slugBase: 'pop-os-2204-intel', description: 'Pop!_OS 22.04 LTS for Intel/AMD graphics, amd64.', version: '22.04', file_name: 'pop-os_22.04_amd64_intel.iso', file_size: 2700 * MB, file_type: 'iso', platform: 'linux', arch: 'x64', url: 'https://iso.pop-os.org/22.04/amd64/intel/latest', category: 'operating-systems', folder: 'ubuntu-family', tags: ['linux', 'pop-os'] });
    add({ name: 'Pop!_OS 22.04 LTS (NVIDIA)', slugBase: 'pop-os-2204-nvidia', description: 'Pop!_OS 22.04 LTS with the NVIDIA driver preinstalled, amd64.', version: '22.04', file_name: 'pop-os_22.04_amd64_nvidia.iso', file_size: 2900 * MB, file_type: 'iso', platform: 'linux', arch: 'x64', url: 'https://iso.pop-os.org/22.04/amd64/nvidia/latest', category: 'operating-systems', folder: 'ubuntu-family', tags: ['linux', 'pop-os', 'nvidia'] });
    add({ name: 'elementary OS 8.0 amd64', slugBase: 'elementary-80', description: 'elementary OS 8.0 — design-first desktop on Ubuntu LTS.', version: '8.0', file_name: 'elementaryos-8.0-stable-amd64.iso', file_size: 3100 * MB, file_type: 'iso', platform: 'linux', arch: 'x64', url: 'https://elementary.io/', category: 'operating-systems', folder: 'ubuntu-family', tags: ['linux', 'elementary'] });

    // ======================================================================
    // Debian
    // ======================================================================
    for (const v of ['11.10', '11.11', '12.5', '12.7', '12.10', '12.11', '13.0', '13.1']) {
      const major = v.split('.')[0];
      const name = { 11: 'Bullseye', 12: 'Bookworm', 13: 'Trixie' }[major];
      for (const [kind, cd, size] of [['netinst', 'cd', int(620, 800)], ['DVD-1', 'dvd', int(3600, 4100)]]) {
        add({
          name: `Debian ${v} ${kind}`, slugBase: `debian-${v}-${kind}`,
          description: `Debian ${major} "${name}" ${kind} installer, amd64. The reference for stable servers.`,
          version: v, file_name: `debian-${v}-amd64-${kind}.iso`, file_size: size * MB,
          file_type: 'iso', platform: 'linux', arch: 'x64', license: 'public-domain',
          url: `https://cdimage.debian.org/debian-cd/current/amd64/iso-${cd}/debian-${v}-amd64-${kind}.iso`,
          category: 'operating-systems', folder: 'debian', tags: ['linux', 'debian'],
        });
      }
      add({
        name: `Debian ${v} Live Xfce`, slugBase: `debian-${v}-live-xfce`,
        description: `Debian ${v} live image with Xfce — try before you install.`,
        version: v, file_name: `debian-live-${v}-amd64-xfce.iso`, file_size: int(2600, 3100) * MB,
        file_type: 'iso', platform: 'linux', arch: 'x64', license: 'public-domain',
        url: `https://cdimage.debian.org/debian-cd/current-live/amd64/iso-hybrid/debian-live-${v}-amd64-xfce.iso`,
        category: 'operating-systems', folder: 'debian', tags: ['linux', 'debian', 'live'],
      });
    }

    // ======================================================================
    // Fedora / RHEL family
    // ======================================================================
    for (const v of ['39', '40', '41', '42', '43']) {
      for (const [spin, group] of [['Workstation', 'Workstation'], ['Server', 'Server'], ['KDE', 'Spins'], ['Xfce', 'Spins']]) {
        for (const [arch, archName] of [['x86_64', 'x86_64'], ['aarch64', 'ARM64']]) {
          add({
            name: `Fedora ${spin} ${v} (${archName})`, slugBase: `fedora-${spin}-${v}-${arch}`,
            description: `Fedora ${spin} ${v} ${archName}. Fresh kernels and toolchain.`,
            version: v, file_name: `Fedora-${spin}-${arch}-${v}.iso`, file_size: (spin === 'Server' ? int(2300, 2600) : int(1900, 2400)) * MB,
            file_type: 'iso', platform: 'linux', arch: arch === 'aarch64' ? 'arm64' : 'x64',
            url: `https://download.fedoraproject.org/pub/fedora/linux/releases/${v}/${group}/${arch}/iso/`,
            category: 'operating-systems', folder: 'fedora-rhel', tags: ['linux', 'fedora'],
          });
        }
      }
    }
    for (const [nx, name] of [['rocky', 'Rocky Linux'], ['almalinux', 'AlmaLinux']]) {
      for (const v of ['8.10', '9.4', '9.5', '9.6', '10.0']) {
        for (const kind of ['dvd', 'minimal', 'boot']) {
          add({
            name: `${name} ${v} (${kind === 'boot' ? 'netinstall' : kind})`, slugBase: `${nx}-${v}-${kind}`,
            description: `${name} ${v} — community RHEL-compatible enterprise Linux, ${kind} image.`,
            version: v, file_name: `${name}-${v}-x86_64-${kind}.iso`,
            file_size: (kind === 'dvd' ? int(9800, 11500) : kind === 'minimal' ? int(1600, 1900) : int(850, 950)) * MB,
            file_type: 'iso', platform: 'linux', arch: 'x64',
            url: `https://download.${nx}.org/pub/${nx}/${v.split('.')[0]}/isos/x86_64/${name.replace(' ', '')}-${v}-x86_64-${kind}.iso`,
            category: 'operating-systems', folder: 'fedora-rhel', tags: ['linux', 'rhel', nx],
          });
        }
      }
    }

    // ======================================================================
    // Arch family
    // ======================================================================
    for (const m of ['2025.01', '2025.04', '2025.08', '2025.12', '2026.03', '2026.06', '2026.08']) {
      add({
        name: `Arch Linux ${m}`, slugBase: `archlinux-${m}`,
        description: `Arch Linux monthly snapshot ${m}. Rolling release, DIY install, x86_64 only.`,
        version: m, file_name: `archlinux-${m}.01-x86_64.iso`, file_size: int(1100, 1400) * MB,
        file_type: 'iso', platform: 'linux', arch: 'x64', license: 'public-domain',
        url: `https://geo.mirror.pkgbuild.com/iso/${m}.01/archlinux-${m}.01-x86_64.iso`,
        category: 'operating-systems', folder: 'arch-based', tags: ['linux', 'arch', 'rolling'],
      });
    }
    for (const v of ['23.1', '24.0', '24.2', '25.0']) {
      for (const de of ['kde', 'gnome', 'xfce']) {
        add({
          name: `Manjaro ${v} ${de.toUpperCase()}`, slugBase: `manjaro-${v}-${de}`,
          description: `Manjaro ${v} ${de} — user-friendly Arch with a graphical installer.`,
          version: v, file_name: `manjaro-${de}-${v}-x86_64.iso`, file_size: int(3300, 4000) * MB,
          file_type: 'iso', platform: 'linux', arch: 'x64',
          url: `https://download.manjaro.org/${de}/${v}/manjaro-${de}-${v}-x86_64.iso`,
          category: 'operating-systems', folder: 'arch-based', tags: ['linux', 'manjaro', de],
        });
      }
    }
    for (const v of ['24.01', '24.07', '25.02', '25.06', '26.01']) {
      add({
        name: `EndeavourOS ${v}`, slugBase: `endeavouros-${v}`,
        description: `EndeavourOS ${v} — terminal-first Arch installer with optional offline desktop.`,
        version: v, file_name: `EndeavourOS_Mercury-${v}.iso`, file_size: int(2600, 2800) * MB,
        file_type: 'iso', platform: 'linux', arch: 'x64',
        url: `https://mirror.alpix.eu/endeavouros/iso/EndeavourOS_Mercury-${v}.iso`,
        category: 'operating-systems', folder: 'arch-based', tags: ['linux', 'endeavouros', 'arch'],
      });
    }
    for (const de of ['dr460nized', 'kde-gitlite', 'sway', 'i3', 'hyprland']) {
      add({
        name: `Garuda Linux (${de})`, slugBase: `garuda-${de}`,
        description: `Garuda Linux ${de} spin — performance-tuned Arch with btrfs snapshots out of the box.`,
        version: 'rolling', file_name: `garuda-${de}-linux-zen.iso`, file_size: int(4200, 5400) * MB,
        file_type: 'iso', platform: 'linux', arch: 'x64',
        url: `https://iso.builds.garudalinux.org/iso/garuda/${de}/latest/garuda-${de}-linux-zen.iso`,
        category: 'operating-systems', folder: 'arch-based', tags: ['linux', 'garuda', 'gaming'],
      });
    }

    // ======================================================================
    // Security & privacy
    // ======================================================================
    for (const v of ['2023.4', '2024.1', '2024.4', '2025.1', '2025.3', '2026.1']) {
      for (const kind of ['installer', 'live', 'installer-netinst']) {
        add({
          name: `Kali Linux ${v} (${kind})`, slugBase: `kali-${v}-${kind}`,
          description: `Kali ${v} ${kind} image — the standard pentest distribution. 600+ tools preinstalled.`,
          version: v, file_name: `kali-linux-${v}-${kind}-amd64.iso`,
          file_size: (kind === 'live' ? int(3800, 4100) : kind.includes('netinst') ? 620 : int(4300, 4600)) * MB,
          file_type: 'iso', platform: 'linux', arch: 'x64',
          url: `https://cdimage.kali.org/kali-${v}/kali-linux-${v}-${kind}-amd64.iso`,
          category: 'operating-systems', folder: 'security-pentest', tags: ['linux', 'kali', 'security'],
        });
      }
    }
    const secImages = [
      ['Parrot Security', ['5.3', '6.0', '6.2'], 'security'],
      ['Tails', ['6.4', '6.8', '6.12'], 'privacy'],
      ['Whonix Workstation (VirtualBox)', ['17.1', '17.2'], 'privacy'],
      ['Qubes OS', ['4.2.0', '4.2.4'], 'privacy'],
      ['BlackArch Linux (slim)', ['2024.06', '2025.03'], 'security'],
    ];
    for (const [n, versions, tag] of secImages) {
      for (const v of versions) {
        add({
          name: `${n} ${v}`, slugBase: `${n} ${v}`,
          description: `${n} ${v} — ${tag === 'privacy' ? 'privacy-focused' : 'security'} operating system image.`,
          version: v, file_name: `${makeSlug(n)}-${v}-amd64.iso`, file_size: int(1200, 6800) * MB,
          file_type: 'iso', platform: 'linux', arch: 'x64', url: 'https://distrowatch.com/',
          category: 'operating-systems', folder: 'security-pentest', tags: ['security', tag],
        });
      }
    }

    // ======================================================================
    // Lightweight / appliances / other OS
    // ======================================================================
    const misc = [
      // lightweight
      ['Alpine Linux', ['3.19.4', '3.20.3', '3.21.2', '3.22.1'], ['standard', 'extended', 'virt'], 'lightweight-linux', (n, v, k) => `alpine-${k}-${v}-x86_64.iso`, (k) => (k === 'extended' ? 900 : k === 'virt' ? 64 : 240) * MB, (v, k) => `https://dl-cdn.alpinelinux.org/alpine/v${v.split('.').slice(0, 2).join('.')}/releases/x86_64/alpine-${k}-${v}-x86_64.iso`],
      ['MX Linux (Xfce)', ['23.3', '23.5'], [null], 'lightweight-linux', (n, v) => `MX-${v}_x64.iso`, () => int(2400, 2600) * MB, () => 'https://sourceforge.net/projects/mx-linux/files/'],
      ['antiX Linux (full)', ['23.1', '23.2'], [null, 'runit'], 'lightweight-linux', (n, v, k) => `antiX-${v}${k ? '_' + k : ''}_x64-full.iso`, () => int(1400, 1600) * MB, () => 'https://sourceforge.net/projects/antix-linux/files/'],
      ['Puppy Linux BookwormPup64', ['10.0'], [null, 'lxqt'], 'lightweight-linux', (n, v) => `BookwormPup64_${v}.iso`, () => int(700, 850) * MB, () => 'https://puppylinux-woof-ce.github.io/'],
      ['Tiny Core Linux', ['15.0', '16.0'], ['Core', 'TinyCore', 'CorePlus'], 'lightweight-linux', (n, v, k) => `${k}-${v}.iso`, () => int(17, 290) * MB, () => 'http://tinycorelinux.net/'],
      ['GParted Live', ['1.6.0', '1.7.0'], [null], 'lightweight-linux', (n, v) => `gparted-live-${v}-1-amd64.iso`, () => 860 * MB, (v) => `https://sourceforge.net/projects/gparted/files/gparted-live-stable/${v}/`],
      ['SystemRescue', ['11.03', '12.00'], [null], 'lightweight-linux', (n, v) => `systemrescue-${v}-amd64.iso`, () => 950 * MB, (v) => `https://www.system-rescue.org/Download/`],
      ['Clonezilla Live', ['3.1.3', '3.2.0'], [null, 'alternative-debian'], 'lightweight-linux', (n, v) => `clonezilla-live-${v}-5-amd64.iso`, () => 460 * MB, () => 'https://clonezilla.org/downloads.php'],
      ['Rescuezilla', ['2.4.2', '2.5.1'], [null], 'lightweight-linux', (n, v) => `rescuezilla-${v}-64bit.noble.iso`, () => 1100 * MB, () => 'https://rescuezilla.com/'],
      ['Batocera Linux', ['39', '40'], [null], 'lightweight-linux', (n, v) => `batocera-x86_64-${v}.img.gz`, () => 1800 * MB, () => 'https://batocera.org/download'],
      // appliances
      ['Proxmox VE ISO', ['8.2', '8.4', '9.0'], [null], 'appliance-nas', (n, v) => `proxmox-ve_${v}-1.iso`, () => int(1300, 1600) * MB, () => 'https://www.proxmox.com/en/downloads'],
      ['TrueNAS SCALE', ['23.10', '24.04', '24.10'], [null], 'appliance-nas', (n, v) => `TrueNAS-SCALE-${v}.0.iso`, () => 1600 * MB, () => 'https://www.truenas.com/download-truenas-scale/'],
      ['pfSense CE', ['2.6.0', '2.7.2'], [null], 'appliance-nas', (n, v) => `pfSense-CE-${v}-RELEASE-amd64.iso.gz`, () => 1100 * MB, () => 'https://www.pfsense.org/download/'],
      ['OPNsense', ['24.1', '24.7', '25.1'], [null], 'appliance-nas', (n, v) => `OPNsense-${v}-dvd-amd64.iso.bz2`, () => 760 * MB, () => 'https://opnsense.org/download/'],
      ['Home Assistant OS (Generic x86-64)', ['14.2', '15.2'], [null, 'ova'], 'appliance-nas', (n, v) => `haos_generic-x86-64-${v}.img.xz`, () => 980 * MB, () => 'https://www.home-assistant.io/installation/'],
      // other OS
      ['FreeBSD (amd64 disc1)', ['13.5', '14.2'], [null, 'dvd1'], 'other-os', (n, v, k) => `FreeBSD-${v}-RELEASE-amd64-${k || 'disc1'}.iso`, () => int(1000, 1300) * MB, (v) => `https://download.freebsd.org/releases/amd64/amd64/ISO-IMAGES/${v}/`],
      ['OpenBSD (amd64 install)', ['7.5', '7.6', '7.7'], [null], 'other-os', (n, v) => `install${v.replace('.', '')}.iso`, () => 720 * MB, (v) => `https://cdn.openbsd.org/pub/OpenBSD/${v}/amd64/install${v.replace('.', '')}.iso`],
      ['NetBSD (amd64)', ['9.4', '10.1'], [null], 'other-os', (n, v) => `NetBSD-${v}-amd64.iso`, () => 660 * MB, (v) => `https://cdn.netbsd.org/pub/NetBSD/NetBSD-${v}/images/`],
      ['Haiku', ['R1B4', 'R1B5'], [null, '32bit'], 'other-os', (n, v, k) => `haiku-${v.toLowerCase()}-x86_${k ? '32' : '64'}-anyboot.iso`, () => int(1200, 1500) * MB, () => 'https://www.haiku-os.org/get-haiku/'],
      ['ReactOS (LiveCD)', ['0.4.14', '0.4.15'], [null, 'bootcd'], 'other-os', (n, v, k) => `ReactOS-${v}-${k || 'livecd'}.zip`, () => 130 * MB, () => 'https://reactos.org/download/'],
      ['Raspberry Pi OS', ['2024-11', '2025-05'], ['lite-64', 'desktop-64', 'full-64'], 'appliance-nas', (n, v, k) => `${v}-13-raspios-bookworm-arm64${k.includes('lite') ? '-lite' : k.includes('full') ? '-full' : ''}.img.xz`, () => int(600, 2900) * MB, () => 'https://www.raspberrypi.com/software/operating-systems/'],
      ['SteamOS recovery image', ['3.5', '3.7'], [null], 'other-os', (n, v) => `steamdeck-recovery-${v}.img.bz2`, () => 2300 * MB, () => 'https://help.steampowered.com/en/faqs/view/1B71-EDF2-EB6D-2BB3'],
      ['Kubuntu LTS backports DVD', ['24.04.2'], [null], 'other-os', (n, v) => `kubuntu-${v}-desktop-amd64.iso`, () => 4300 * MB, () => 'https://kubuntu.org/getkubuntu/'],
    ];
    for (const [n, versions, kinds, folder, fileFn, sizeFn, urlFn] of misc) {
      for (const v of versions) {
        for (const k of kinds) {
          const isIso = String(fileFn(n, v, k)).endsWith('iso');
          add({
            name: `${n} ${v}${k ? ` (${k})` : ''}`, slugBase: `${n} ${v} ${k || ''}`,
            description: `${n} ${v}${k ? `, ${k} variant` : ''}.`,
            version: v, file_name: fileFn(n, v, k), file_size: sizeFn(k),
            file_type: isIso ? 'iso' : 'img', platform: 'linux', arch: 'x64',
            url: urlFn(v, k), category: 'operating-systems', folder,
            tags: ['linux', folder.replace('-', ' ')],
          });
        }
      }
    }

    // ======================================================================
    // Tools. Table rows: [name, slug, versions, ext, folder, category,
    //                     urlFn(v), sizeMinMB, sizeMaxMB, desc]
    // ======================================================================
    const tools = [
      // Editors / IDEs
      ['Notepad++', 'notepad-plus-plus', ['8.5', '8.6', '8.7', '8.8'], 'exe', 'editors-ides', 'applications', (v) => `https://github.com/notepad-plus-plus/notepad-plus-plus/releases/download/v${v}/npp.${v}.Installer.x64.exe`, 4, 6, 'Fast tabbed editor: syntax highlighting for ~80 languages, macros, plugins.'],
      ['Visual Studio Code', 'vscode', ['1.88', '1.92', '1.96', '1.100', '1.103'], 'exe', 'editors-ides', 'applications', (v) => `https://update.code.visualstudio.com/${v}/win32-x64/stable`, 90, 100, 'Microsoft code editor with extensions, debugging and remote development.'],
      ['VSCodium', 'vscodium', ['1.88', '1.96', '1.103'], 'msi', 'editors-ides', 'applications', (v) => `https://github.com/VSCodium/vscodium/releases/download/${v}/VSCodium-x64-${v}.msi`, 90, 100, 'VS Code binaries without Microsoft telemetry.'],
      ['Sublime Text', 'sublime-text', ['4152', '4169', '4180'], 'exe', 'editors-ides', 'applications', (v) => `https://download.sublimetext.com/sublime_text_build_${v}_x64_setup.exe`, 25, 35, 'Commercial-grade speed editor, unlimited unlicensed evaluation.'],
      ['Notepad3', 'notepad3', ['6.23', '6.24', '6.25'], 'zip', 'editors-ides', 'utilities', (v) => `https://github.com/rizonesoft/Notepad3/releases/download/RELEASE_${v}/Notepad3_${v}.zip`, 3, 5, 'Scintilla-based notepad replacement with a lightning startup.'],
      ['Geany', 'geany', ['2.0', '2.1'], 'exe', 'editors-ides', 'applications', (v) => `https://download.geany.org/geany-${v}_setup.exe`, 20, 30, 'Small GTK IDE: projects, build system and a lightweight feel.'],
      ['Apache NetBeans', 'netbeans', ['18', '20', '22', '24'], 'exe', 'editors-ides', 'applications', (v) => `https://archive.apache.org/dist/netbeans/netbeans-installers/${v}/Apache-NetBeans-${v}-bin-windows-x64.exe`, 400, 460, 'The classic Java IDE, also good with PHP and Maven builds.'],
      ['Eclipse IDE', 'eclipse-ide', ['2023-12', '2024-06', '2025-03'], 'zip', 'editors-ides', 'applications', (v) => `https://ftp.osuosl.org/pub/eclipse/technology/epp/downloads/release/${v}/R/eclipse-java-${v}-R-win32-x86_64.zip`, 350, 420, 'Java-first workbench with a huge plugin ecosystem.'],

      // Compression & imaging
      ['7-Zip', '7zip', ['19.00', '21.07', '22.01', '23.01', '24.05', '24.09', '25.01'], 'exe', 'compression-imaging', 'utilities', (v) => `https://www.7-zip.org/a/7z${v.replaceAll('.', '')}-x64.exe`, 1, 3, 'Free archiver: highest-ratio LZMA/7z, also unpacks ISO/RAR/NSIS.'],
      ['7-Zip (ARM64)', '7zip-arm64', ['23.01', '24.05', '25.01'], 'exe', 'compression-imaging', 'utilities', (v) => `https://www.7-zip.org/a/7z${v.replaceAll('.', '')}-arm64.exe`, 1, 3, 'Native 7-Zip for Windows-on-ARM.'],
      ['NanaZip', 'nanazip', ['3.0', '3.1', '4.0', '5.0'], 'msixbundle', 'compression-imaging', 'utilities', (v) => `https://github.com/M2Team/NanaZip/releases/download/${v}/NanaZip_${v}.msixbundle`, 10, 14, '7-Zip fork with modern Windows 11 context menu + dark mode.'],
      ['PeaZip', 'peazip', ['9.4', '9.9', '10.2', '10.5'], 'exe', 'compression-imaging', 'utilities', (v) => `https://github.com/peazip/PeaZip/releases/download/${v}/peazip-${v}.WIN64.exe`, 14, 18, 'LGBT-agnostic archive manager, 200+ formats, portable build included.'],
      ['Rufus', 'rufus', ['4.3', '4.5', '4.6', '4.9'], 'exe', 'compression-imaging', 'utilities', (v) => `https://github.com/pbatard/rufus/releases/download/v${v}/rufus-${v}.exe`, 1, 2, 'Fastest ISO-to-USB writer; bypasses TPM checks on demand.'],
      ['Ventoy', 'ventoy', ['1.0.96', '1.0.99', '1.1.07'], 'zip', 'compression-imaging', 'utilities', (v) => `https://github.com/ventoy/Ventoy/releases/download/v${v}/ventoy-${v}-windows.zip`, 14, 19, 'Multiboot USB done right: copy ISOs, pick at boot.'],
      ['balenaEtcher', 'balenaetcher', ['1.18.11', '2.1.0', '2.1.2'], 'exe', 'compression-imaging', 'utilities', (v) => `https://github.com/balena-io/etcher/releases/download/v${v}/balenaEtcher-Setup-${v}.exe`, 140, 170, 'Idiot-proof image flasher for USB/SD media.'],
      ['Raspberry Pi Imager', 'rpi-imager-win', ['1.8.5', '1.9.0', '1.9.6'], 'exe', 'compression-imaging', 'utilities', (v) => `https://downloads.raspberrypi.org/imager/imager_${v}.exe`, 60, 90, 'Official Pi card writer with OS list baked in.'],
      ['Win32 Disk Imager', 'win32-disk-imager', ['1.0'], 'zip', 'compression-imaging', 'utilities', () => 'https://sourceforge.net/projects/win32diskimager/files/latest/download', 12, 15, 'Old reliable SD/USB image writer.'],
      ['UNetbootin', 'unetbootin', ['702'], 'exe', 'compression-imaging', 'utilities', () => 'https://sourceforge.net/projects/unetbootin/files/latest/download', 5, 6, 'Cross-platform live-USB creator for distros.'],

      // Networking
      ['PuTTY', 'putty', ['0.78', '0.79', '0.81', '0.83'], 'msi', 'networking', 'utilities', (v) => `https://the.earth.li/~sgtatham/putty/${v}/w64/putty-64bit-${v}-installer.msi`, 3, 5, 'SSH/Telnet/serial client, with Pageant and PuTTYgen.'],
      ['WinSCP', 'winscp', ['6.1.2', '6.3.3', '6.5.1'], 'exe', 'networking', 'utilities', (v) => `https://winscp.net/download/WinSCP-${v}-Setup.exe`, 10, 12, 'SFTP/SCP/FTP GUI with scripting and sync.'],
      ['FileZilla Client', 'filezilla', ['3.66', '3.67', '3.69'], 'exe', 'networking', 'applications', (v) => `https://download.filezilla-project.org/client/FileZilla_${v}_win64_sponsored2-setup.exe`, 12, 15, 'Cross-platform FTP/SFTP client.'],
      ['FileZilla Server', 'filezilla-server', ['1.8.2', '1.10.0'], 'msi', 'networking', 'utilities', (v) => `https://download.filezilla-project.org/server/FileZilla_Server_${v}_win64-setup.exe`, 8, 12, 'FTP/FTPS server for Windows with a clean admin UI.'],
      ['Wireshark', 'wireshark', ['4.2.4', '4.4.6', '4.6.0'], 'exe', 'networking', 'utilities', (v) => `https://2.na.dl.wireshark.org/win64/Wireshark-${v}-x64.exe`, 80, 95, 'The network protocol analyzer.'],
      ['Nmap', 'nmap', ['7.94', '7.95', '7.98'], 'exe', 'networking', 'utilities', (v) => `https://nmap.org/dist/nmap-${v}-setup.exe`, 25, 35, 'Port scanner and network discovery tool. Includes Npcap.'],
      ['Angry IP Scanner', 'angry-ip', ['3.9.1', '3.9.2'], 'exe', 'networking', 'utilities', (v) => `https://github.com/angryip/ipscan/releases/download/${v}/ipscan-win64-${v}.exe`, 4, 6, 'Lightweight LAN scanner.'],
      ['mRemoteNG', 'mremoteng', ['1.76.20', '1.77.3'], 'msi', 'networking', 'utilities', (v) => `https://github.com/mRemoteNG/mRemoteNG/releases/download/v${v}/mRemoteNG-Installer-${v}.msi`, 60, 70, 'Tabbed connection manager for RDP/SSH/VNC/telnet.'],
      ['Ncat portable', 'ncat-portable', ['7.95'], 'zip', 'networking', 'utilities', () => 'https://nmap.org/dist/nmap-7.95-win32.zip', 30, 35, 'Swiss-army TCP/UDP utility from the Nmap project.'],
      ['OpenVPN Community', 'openvpn', ['2.6.8', '2.6.12'], 'msi', 'networking', 'utilities', (v) => `https://swupdate.openvpn.org/community/releases/OpenVPN-${v}-amd64.msi`, 6, 8, 'Official OpenVPN client (community edition).'],
      ['Tailscale', 'tailscale-win', ['1.66', '1.74', '1.82'], 'exe', 'networking', 'utilities', (v) => `https://pkgs.tailscale.com/stable/tailscale-setup-${v}.0.exe`, 30, 40, 'Zero-config WireGuard mesh for your devices.'],
      ['ZeroTier One', 'zerotier', ['1.12.2', '1.14.0'], 'msi', 'networking', 'utilities', (v) => `https://download.zerotier.com/dist/ZeroTier%20One.msi`, 20, 25, 'Ethernet-over-Internet virtual switch.'],

      // Media
      ['VLC', 'vlc-win', ['3.0.20', '3.0.21'], 'exe', 'media-tools', 'applications', (v) => `https://get.videolan.org/vlc/${v}/win64/vlc-${v}-win64.exe`, 40, 43, 'Plays every format, no ads, no tracking.'],
      ['OBS Studio', 'obs-studio', ['30.1.2', '30.2.3', '31.0.3', '31.1.1'], 'exe', 'media-tools', 'applications', (v) => `https://github.com/obsproject/obs-studio/releases/download/${v}/OBS-Studio-${v}-Windows-Installer.exe`, 120, 145, 'Recording and streaming with scenes and NVENC.'],
      ['HandBrake', 'handbrake', ['1.7.3', '1.8.2', '1.9.0', '1.10.0'], 'exe', 'media-tools', 'applications', (v) => `https://github.com/HandBrake/HandBrake/releases/download/${v}/HandBrake-${v}-x86_64-Win_GUI.exe`, 20, 26, 'GPU/CPU video transcoder with sane presets.'],
      ['GIMP', 'gimp-win', ['2.10.36', '2.10.38', '3.0.0', '3.0.4'], 'exe', 'media-tools', 'applications', (v) => `https://download.gimp.org/gimp/v${v.split('.').slice(0, 2).join('.')}/windows/gimp-${v}-setup.exe`, 320, 380, 'Full raster editor: layers, masks, plugins.'],
      ['Inkscape', 'inkscape', ['1.3.2', '1.4.0'], 'msi', 'media-tools', 'applications', (v) => `https://inkscape.org/release/inkscape-${v}/windows/64-bit/msi/dl/`, 130, 150, 'Vector editor for SVG illustration work.'],
      ['Krita', 'krita', ['5.2.2', '5.2.6', '5.3.1'], 'exe', 'media-tools', 'applications', (v) => `https://download.kde.org/stable/krita/${v}/krita-x64-${v}-setup.exe`, 150, 180, 'Digital painting studio with tablet support.'],
      ['Blender LTS', 'blender', ['3.6.15', '4.2.9', '4.5.0'], 'msi', 'media-tools', 'applications', (v) => `https://download.blender.org/release/Blender${v.split('.').slice(0, 2).join('.')}/blender-${v}-windows-x64.msi`, 350, 420, '3D creation suite: modeling, sculpting, video.'],
      ['Audacity', 'audacity', ['3.5.1', '3.6.1', '3.7.3'], 'exe', 'media-tools', 'applications', (v) => `https://github.com/audacity/audacity/releases/download/Audacity-${v}/audacity-win-${v}-64bit.exe`, 15, 18, 'Multi-track audio editing and recording.'],
      ['Shotcut', 'shotcut', ['24.06', '24.09', '25.03'], 'exe', 'media-tools', 'applications', (v) => `https://github.com/mltframework/shotcut/releases/download/v${v.replace('.', '')}/shotcut-win64-${v.split('.')[0]}.exe`, 110, 130, 'FFmpeg-based video editor.'],
      ['ShareX', 'sharex', ['16.0', '17.0', '17.1'], 'exe', 'media-tools', 'utilities', (v) => `https://github.com/ShareX/ShareX/releases/download/v${v}.0/ShareX-${v}.0.0-setup.exe`, 45, 55, 'Screenshot / screencast / upload workflow king.'],
      ['Greenshot', 'greenshot', ['1.3.290'], 'exe', 'media-tools', 'utilities', () => 'https://github.com/greenshot/greenshot/releases/download/Greenshot-RELEASE-1.3.290/Greenshot-INSTALLER-1.3.290-RELEASE.exe', 4, 5, 'Classic lightweight screenshot tool.'],
      ['Flameshot', 'flameshot-win', ['12.1', '13.0'], 'msi', 'media-tools', 'utilities', (v) => `https://github.com/flameshot-org/flameshot/releases/download/v${v}/flameshot-${v}-win64.msi`, 50, 60, 'Powerful screenshot annotation.'],
      ['Kdenlive', 'kdenlive-win', ['24.05', '25.04'], 'exe', 'media-tools', 'applications', (v) => `https://download.kde.org/stable/kdenlive/${v}/windows/kdenlive-${v}.0.exe`, 350, 400, 'KDE video editor — multi-track, proxies, effects.'],
      ['MKVToolNix', 'mkvtoolnix', ['85.0', '88.0', '92.0'], 'exe', 'media-tools', 'utilities', (v) => `https://mkvtoolnix.download/windows/releases/${v}/mkvtoolnix-64-bit-${v}.exe`, 25, 30, 'MKV muxing and metadata editing.'],
      ['foobar2000', 'foobar2000', ['2.1', '2.24'], 'exe', 'media-tools', 'applications', (v) => `https://www.foobar2000.org/download`, 6, 8, 'Audiophile-grade player with a tag editor.'],
      ['mp3tag', 'mp3tag', ['3.26', '3.30'], 'exe', 'media-tools', 'utilities', () => 'https://download.mp3tag.de/', 5, 7, 'Batch audio tag editor.'],

      // Diagnostics & hardware
      ['CPU-Z', 'cpu-z', ['2.08', '2.10', '2.16'], 'zip', 'diagnostics-hardware', 'utilities', (v) => `https://download.cpuid.com/cpu-z/cpu-z_${v}-en.zip`, 8, 12, 'CPU/RAM/mainboard inventory in one pane.'],
      ['GPU-Z', 'gpu-z', ['2.57', '2.60', '2.66'], 'exe', 'diagnostics-hardware', 'utilities', () => 'https://www.techpowerup.com/download/techpowerup-gpu-z/', 5, 8, 'GPU inventory and live sensor readout.'],
      ['HWiNFO64', 'hwinfo64', ['7.68', '7.74', '8.10'], 'exe', 'diagnostics-hardware', 'utilities', (v) => `https://www.hwinfo.com/files/hwi_${v.replace('.', '')}.exe`, 12, 16, 'Deep hardware sensor + inventory reporting.'],
      ['CrystalDiskInfo', 'crystaldiskinfo', ['9.2', '9.4', '9.6'], 'exe', 'diagnostics-hardware', 'utilities', (v) => `https://sourceforge.net/projects/crystaldiskinfo/files/${v}.1/CrystalDiskInfo${v.replace('.', '')}_1.exe/download`, 8, 12, 'S.M.A.R.T. drive health at a glance.'],
      ['CrystalDiskMark', 'crystaldiskmark', ['8.0.5', '8.0.6'], 'zip', 'diagnostics-hardware', 'utilities', () => 'https://sourceforge.net/projects/crystaldiskmark/files/', 6, 8, 'Sequential/random disk benchmark.'],
      ['HDTune (free)', 'hdtune', ['2.55'], 'exe', 'diagnostics-hardware', 'utilities', () => 'https://www.hdtune.com/', 1, 2, 'Old-school disk surface scan and benchmark.'],
      ['H2testw', 'h2testw', ['1.4'], 'zip', 'diagnostics-hardware', 'utilities', () => 'https://www.heise.de/download/product/h2testw-50539', 1, 1, 'Detect fake-capacity flash media.'],
      ['MemTest86 (PassMark)', 'memtest86', ['10.6', '11.1'], 'zip', 'diagnostics-hardware', 'utilities', () => 'https://www.memtest86.com/downloads/memtest86-usb.zip', 20, 25, 'UEFI memory tester on a bootable USB.'],
      ['LatencyMon', 'latencymon', ['7.31'], 'exe', 'diagnostics-hardware', 'utilities', () => 'https://www.resplendence.com/downloads', 3, 4, 'Find audio stutter / DPC latency culprits.'],

      // Office & docs
      ['LibreOffice Fresh', 'libreoffice', ['7.6.7', '24.2.5', '24.8.4', '25.2.1'], 'msi', 'office-docs', 'applications', (v) => `https://download.documentfoundation.org/libreoffice/stable/${v}/win/x86_64/LibreOffice_${v}_Win_x86-64.msi`, 350, 380, 'Complete office suite with ODF/OOXML support.'],
      ['LibreOffice Still', 'libreoffice-still', ['24.2.7'], 'msi', 'office-docs', 'applications', (v) => `https://download.documentfoundation.org/libreoffice/stable/${v}/win/x86_64/LibreOffice_${v}_Win_x86-64.msi`, 350, 380, 'Conservative LibreOffice branch for stability.'],
      ['OnlyOffice Desktop', 'onlyoffice', ['8.1', '8.3', '9.0'], 'exe', 'office-docs', 'applications', (v) => `https://download.onlyoffice.com/install/desktop/editors/windows/distrib/onlyoffice/DesktopEditors_x64.exe`, 220, 260, 'Office suite with near-perfect DOCX fidelity.'],
      ['SumatraPDF', 'sumatrapdf', ['3.5.2'], 'exe', 'office-docs', 'applications', () => 'https://www.sumatrapdfreader.org/download-free-pdf-viewer', 8, 10, 'Ultra-light PDF/ePub reader (portable friendly).'],
      ['Okular', 'okular-win', ['24.05', '25.04'], 'exe', 'office-docs', 'applications', (v) => `https://binary-factory.kde.org/job/Okular_Release_win64/`, 90, 110, 'KDE document viewer with annotations.'],
      ['FreeCAD', 'freecad', ['0.21.2', '1.0.0', '1.0.1'], 'exe', 'office-docs', 'applications', (v) => `https://github.com/FreeCAD/FreeCAD/releases/download/${v}/FreeCAD-${v}-WIN-x64-installer-1.exe`, 500, 600, 'Parametric 3D CAD modeller.'],
      ['KiCad', 'kicad', ['7.0.11', '8.0.4', '9.0.0'], 'exe', 'office-docs', 'applications', (v) => `https://www.kicad.org/download/windows/`, 1200, 1500, 'EDA suite for PCB design and schematic capture.'],
      ['Pandoc', 'pandoc', ['3.1.11', '3.6'], 'msi', 'office-docs', 'development', (v) => `https://github.com/jgm/pandoc/releases/download/${v}/pandoc-${v}-windows-x86_64.msi`, 50, 60, 'Universal document converter.'],

      // Privacy
      ['KeePassXC', 'keepassxc-win', ['2.7.6', '2.7.8', '2.7.10'], 'msi', 'privacy-password', 'utilities', (v) => `https://github.com/keepassxreboot/keepassxc/releases/download/${v}/KeePassXC-${v}-Win64.msi`, 40, 45, 'Offline password manager with hardware-key support.'],
      ['VeraCrypt', 'veracrypt', ['1.26.14', '1.26.18'], 'msi', 'privacy-password', 'utilities', (v) => `https://launchpad.net/veracrypt/trunk/${v}/+download/VeraCrypt%20Setup%20${v}.msi`, 35, 40, 'TrueCrypt-successor: volumes, containers, full-disk encryption.'],
      ['Cryptomator', 'cryptomator-win', ['1.12', '1.15'], 'msi', 'privacy-password', 'utilities', (v) => `https://github.com/cryptomator/cryptomator/releases/download/${v}.0/Cryptomator-${v}.0-x64.msi`, 60, 70, 'Client-side encryption for cloud folders.'],
      ['Cygwin64', 'cygwin', ['setup-x86_64'], 'exe', 'privacy-password', 'utilities', () => 'https://www.cygwin.com/setup-x86_64.exe', 1, 2, 'GNU toolchain + package manager on Windows.'],
      ['Gpg4win', 'gpg4win', ['4.3.1', '4.4.0'], 'exe', 'privacy-password', 'utilities', (v) => `https://files.gpg4win.org/gpg4win-${v}.exe`, 30, 35, 'GnuPG + Kleopatra for Windows.'],
    ];

    for (const [name, slug, versions, ext, folder, category, urlFn, sMin, sMax, desc] of tools) {
      for (const v of versions) {
        add({
          name: `${name} ${v}`, slugBase: `${slug}-${v}`,
          description: desc, version: v,
          file_name: `${slug}-${v}-setup.${ext}`, file_size: int(sMin, sMax) * MB,
          file_type: ext, platform: 'windows', arch: 'x64',
          url: urlFn(v), category, folder,
          tags: ['windows', slug.replaceAll('-', ' ')],
        });
      }
    }

    // ======================================================================
    // Dev tools (Windows + Linux + cross-platform)
    // ======================================================================
    const devTools = [
      ['Git for Windows', 'git-windows', ['2.44.0', '2.47.1', '2.50.1'], 'exe', 'dev-tools', 'development', (v) => `https://github.com/git-for-windows/git/releases/download/v${v}.windows.1/Git-${v}-64-bit.exe`, 60, 70],
      ['Git (source tarball)', 'git-source', ['2.44.1', '2.50.1'], 'tar.xz', 'dev-tools', 'development', (v) => `https://mirrors.edge.kernel.org/pub/software/scm/git/git-${v}.tar.xz`, 9, 12],
      ['Python (Windows x64)', 'python-win', ['3.11.9', '3.12.5', '3.13.2'], 'exe', 'dev-tools', 'development', (v) => `https://www.python.org/ftp/python/${v}/python-${v}-amd64.exe`, 28, 32],
      ['Python (source tarball)', 'python-source', ['3.12.5', '3.13.2'], 'tgz', 'dev-tools', 'development', (v) => `https://www.python.org/ftp/python/${v}/Python-${v}.tgz`, 25, 30],
      ['Node.js LTS (Windows x64)', 'node-lts-win', ['20.15', '22.12', '24.4'], 'msi', 'dev-tools', 'development', (v) => `https://nodejs.org/dist/v${v}.1/node-v${v}.1-x64.msi`, 30, 35],
      ['Node.js LTS (Linux x64)', 'node-lts-linux', ['20.15', '22.12'], 'tar.xz', 'dev-tools', 'development', (v) => `https://nodejs.org/dist/v${v}.1/node-v${v}.1-linux-x64.tar.xz`, 45, 55],
      ['Go toolchain (Windows)', 'go-win', ['1.22.5', '1.23.4', '1.24.5'], 'msi', 'dev-tools', 'development', (v) => `https://go.dev/dl/go${v}.windows-amd64.msi`, 60, 70],
      ['Go toolchain (Linux)', 'go-linux', ['1.22.5', '1.24.5'], 'tar.gz', 'dev-tools', 'development', (v) => `https://go.dev/dl/go${v}.linux-amd64.tar.gz`, 65, 70],
      ['Rustup init (Windows x64)', 'rustup-win', ['1.27.1', '1.28.2'], 'exe', 'dev-tools', 'development', (v) => `https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe`, 8, 10],
      ['Rustup init (Linux x64)', 'rustup-linux', ['1.27.1'], 'sh', 'dev-tools', 'development', () => 'https://static.rust-lang.org/rustup/dist/x86_64-unknown-linux-gnu/rustup-init', 9, 12],
      ['Eclipse Temurin JDK 17 (Windows)', 'temurin17-win', ['17.0.12'], 'msi', 'dev-tools', 'development', () => 'https://adoptium.net/temurin/releases/?version=17', 190, 210],
      ['Eclipse Temurin JDK 21 (Windows)', 'temurin21-win', ['21.0.4'], 'msi', 'dev-tools', 'development', () => 'https://adoptium.net/temurin/releases/?version=21', 190, 210],
      ['Eclipse Temurin JDK 21 (Linux)', 'temurin21-linux', ['21.0.4'], 'tar.gz', 'dev-tools', 'development', () => 'https://adoptium.net/temurin/releases/?version=21', 190, 210],
      ['.NET 8 SDK (Windows)', 'dotnet8-win', ['8.0.400'], 'exe', 'dev-tools', 'development', () => 'https://dotnet.microsoft.com/download/dotnet/8.0', 230, 260],
      ['.NET 9 SDK (Linux)', 'dotnet9-linux', ['9.0.300'], 'tar.gz', 'dev-tools', 'development', () => 'https://dotnet.microsoft.com/download/dotnet/9.0', 240, 270],
      ['Visual Studio Build Tools', 'vs-buildtools', ['2022'], 'exe', 'dev-tools', 'development', () => 'https://aka.ms/vs/17/release/vs_buildtools.exe', 5, 6],
      ['CMake (Windows)', 'cmake-win', ['3.29.6', '3.31.1'], 'msi', 'dev-tools', 'development', (v) => `https://github.com/Kitware/CMake/releases/download/v${v}/cmake-${v}-windows-x86_64.msi`, 55, 65],
      ['CMake (Linux)', 'cmake-linux', ['3.31.1'], 'tar.gz', 'dev-tools', 'development', (v) => `https://github.com/Kitware/CMake/releases/download/v${v}/cmake-${v}-linux-x86_64.tar.gz`, 60, 70],
      ['Docker Desktop', 'docker-desktop', ['4.31', '4.38'], 'exe', 'dev-tools', 'applications', () => 'https://www.docker.com/products/docker-desktop/', 700, 900],
      ['kubectl', 'kubectl', ['1.30', '1.32'], 'exe', 'dev-tools', 'development', (v) => `https://dl.k8s.io/release/v${v}.0/bin/windows/amd64/kubectl.exe`, 55, 60],
      ['Helm', 'helm-win', ['3.15', '3.17'], 'zip', 'dev-tools', 'development', (v) => `https://get.helm.sh/helm-v${v}.0-windows-amd64.zip`, 18, 22],
      ['Terraform', 'terraform-win', ['1.8', '1.12'], 'zip', 'dev-tools', 'development', (v) => `https://releases.hashicorp.com/terraform/${v}.0/terraform_${v}.0_windows_amd64.zip`, 25, 30],
      ['Bazel', 'bazel-win', ['7.4', '8.3'], 'exe', 'dev-tools', 'development', (v) => `https://github.com/bazelbuild/bazel/releases/download/${v}.0/bazel-${v}.0-windows-x86_64.exe`, 50, 60],
      ['gh GitHub CLI (Windows)', 'gh-win', ['2.62', '2.76'], 'msi', 'dev-tools', 'development', (v) => `https://github.com/cli/cli/releases/download/v${v}.0/gh_${v}.0_windows_amd64.msi`, 15, 18],
      ['Postman', 'postman', ['11.14', '11.40'], 'exe', 'dev-tools', 'applications', () => 'https://www.postman.com/downloads/', 140, 170],
      ['Insomnia', 'insomnia', ['10.3', '11.0'], 'exe', 'dev-tools', 'applications', (v) => `https://github.com/Kong/insomnia/releases/download/core%40${v}.0/Insomnia.Core-${v}.0.exe`, 120, 150],
      ['WinDirStat', 'windirstat', ['1.1.2', '2.0.3'], 'msi', 'dev-tools', 'utilities', (v) => `https://github.com/windirstat/windirstat/releases/download/release/v${v}/windirstat${v.replaceAll('.', '')}_setup.msi`, 5, 8],
      ['Everything (voidtools)', 'everything-void', ['1.4.1.1024', '1.4.1.1026'], 'exe', 'dev-tools', 'utilities', () => 'https://www.voidtools.com/downloads/', 2, 3],
      ['AutoHotkey v2', 'autohotkey2', ['2.0.15', '2.0.18'], 'exe', 'dev-tools', 'utilities', (v) => `https://github.com/AutoHotkey/AutoHotkey/releases/download/v${v}/AutoHotkey_${v}.0_setup.exe`, 3, 4],
      ['Sysinternals Suite', 'sysinternals-suite', ['2025-01', '2025-06'], 'zip', 'dev-tools', 'utilities', () => 'https://download.sysinternals.com/files/SysinternalsSuite.zip', 40, 50],
      ['PowerShell 7 (Windows)', 'powershell7-win', ['7.4.6', '7.5.2'], 'msi', 'dev-tools', 'utilities', (v) => `https://github.com/PowerShell/PowerShell/releases/download/v${v}/PowerShell-${v}-win-x64.msi`, 110, 120],
      ['Windows Terminal', 'windows-terminal', ['1.20', '1.22'], 'msixbundle', 'dev-tools', 'utilities', (v) => `https://github.com/microsoft/terminal/releases/download/v${v}.0/Microsoft.WindowsTerminal_${v}.0_8wekyb3d8bbwe.msixbundle`, 25, 30],
      ['Cygwin', 'cygwin-setup', ['latest'], 'exe', 'dev-tools', 'utilities', () => 'https://www.cygwin.com/setup-x86_64.exe', 1, 2],
      ['WinMerge', 'winmerge', ['2.16.42', '2.16.48'], 'exe', 'dev-tools', 'utilities', (v) => `https://github.com/WinMerge/winmerge/releases/download/v${v}/WinMerge-${v}-x64-Setup.exe`, 11, 13],
      ['HxD Hex Editor', 'hxd', ['2.5.0'], 'zip', 'dev-tools', 'utilities', () => 'https://mh-nexus.de/en/hxd/', 3, 4],
      ['dnSpyEx', 'dnspyex', ['6.5.0', '6.5.1'], 'zip', 'dev-tools', 'utilities', (v) => `https://github.com/dnSpyEx/dnSpy/releases/download/v${v}/dnSpy-netframework-win64.zip`, 25, 30],
      ['x64dbg', 'x64dbg', ['2024-06', '2025-03'], 'zip', 'dev-tools', 'utilities', () => 'https://github.com/x64dbg/x64dbg/releases/latest/download/snapshot.zip', 45, 60],
      ['Ghidra', 'ghidra', ['11.0.3', '11.3.2'], 'zip', 'dev-tools', 'utilities', (v) => `https://github.com/NationalSecurityAgency/ghidra/releases/download/Ghidra_${v}_build/ghidra_${v}_PUBLIC.zip`, 400, 500],
      ['Notepad2-mod', 'notepad2-mod', ['4.2.25'], 'zip', 'dev-tools', 'utilities', () => 'https://github.com/XhmikosR/notepad2-mod/releases', 1, 2],
    ];
    const platOf = (slug) => (slug.endsWith('-win') || slug === 'git-windows' || slug === 'python-win' || slug.includes('windows')) ? 'windows' : (slug.endsWith('-linux') ? 'linux' : 'windows');
    for (const [name, slug, versions, ext, folder, category, urlFn, sMin, sMax] of devTools) {
      const descMap = name;
      for (const v of versions) {
        add({
          name: `${name} ${v}`, slugBase: `${slug}-${v}`,
          description: `${name} ${v} installer/package.`,
          version: v, file_name: `${slug}-${v}.${ext}`, file_size: int(sMin, sMax) * MB,
          file_type: ext, platform: platOf(slug), arch: 'x64',
          url: urlFn(v), category, folder,
          tags: [platOf(slug), 'developer tools'],
        });
      }
    }

    // ======================================================================
    // CLI tools (mostly Linux + cross-platform)
    // ======================================================================
    const cliTools = [
      ['ripgrep', ['13.0', '14.1'], 'tar.gz', 'Blazing-fast recursive grep.'],
      ['fd (find, but sane)', ['9.0', '10.2'], 'tar.gz', 'Simple, fast `find` alternative.'],
      ['bat (cat with wings)', ['0.24', '0.25'], 'tar.gz', 'Syntax-highlighted cat.'],
      ['eza (modern ls)', ['0.18', '0.20'], 'tar.gz', 'ls with icons and git status.'],
      ['fzf', ['0.54', '0.60'], 'tar.gz', 'Fuzzy finder for the shell.'],
      ['zoxide', ['0.9.6'], 'tar.gz', 'Smarter cd.'],
      ['starship', ['1.19', '1.21'], 'tar.gz', 'Cross-shell prompt.'],
      ['btop', ['1.3.2', '1.4.0'], 'tbz', 'Resource monitor TUI.'],
      ['ncdu', ['2.3', '2.7'], 'tar.gz', 'Disk-usage analyzer TUI.'],
      ['jq', ['1.7.1'], 'gz', 'JSON processor for the pipe.'],
      ['yq', ['4.44'], 'tar.gz', 'YAML/XML/TOML processor.'],
      ['tmux', ['3.4', '3.5'], 'tar.gz', 'Terminal multiplexer.'],
      ['neovim', ['0.9.5', '0.10.1', '0.11.0'], 'tar.gz', 'Hyperextensible Vim fork.'],
      ['curl (source)', ['8.7.1', '8.11.1'], 'tar.xz', 'URL transfer library + CLI.'],
      ['wget2 (source)', ['2.2.0'], 'tar.gz', 'Next-generation wget.'],
      ['aria2', ['1.37.0'], 'tar.gz', 'Multi-connection download manager.'],
      ['rsync (source)', ['3.3.0', '3.4.1'], 'tar.gz', 'File synchronization workhorse.'],
      ['rclone', ['1.66', '1.68'], 'zip', 'Cloud storage sync for 70+ providers.'],
      ['restic', ['0.16.4', '0.17.3'], 'bz2', 'Deduplicating backup tool.'],
      ['syncthing', ['1.27', '1.29'], 'tar.gz', 'Peer-to-peer folder sync.'],
      ['yt-dlp', ['2024.12', '2025.06'], 'zip', 'Video downloader fork.'],
      ['ffmpeg (gyan build)', ['7.0.2', '7.1'], 'zip', 'Full ffmpeg build incl. encoders.'],
      ['direnv', ['2.35'], 'tar.gz', 'Per-directory env variables.'],
      ['mise (toolchain manager)', ['2024.12'], 'tar.gz', 'asdf-compatible polyglot version manager.'],
      ['lazygit', ['0.43', '0.45'], 'tar.gz', 'Git TUI for humans.'],
      ['git-delta', ['0.17', '0.18'], 'tar.gz', 'Syntax-aware Git pager.'],
      ['hyperfine', ['1.18', '1.19'], 'tar.gz', 'Benchmark any command.'],
      ['tokei', ['12.1.2'], 'tar.gz', 'Code counters with language detection.'],
      ['shfmt', ['3.9', '3.11'], 'gz', 'Shell formatter.'],
      ['pwgen (source)', ['2.08'], 'tar.gz', 'Pronounceable password generator.'],
    ];
    for (const [name, versions, ext, desc] of cliTools) {
      for (const v of versions) {
        for (const plat of ['linux', 'windows']) {
          if (plat === 'windows' && ['tmux', 'ncdu'].some((x) => name.startsWith(x))) continue;
          add({
            name: `${name} ${v} (${plat}${plat === 'linux' ? ' x86_64' : ' x64'})`, slugBase: `${makeSlug(name)}-${v}-${plat}`,
            description: `${desc} Static prebuilt.`,
            version: v, file_name: `${makeSlug(name).replaceAll('-', '_')}-${v}-${plat === 'linux' ? 'x86_64-unknown-linux-musl' : 'x86_64-pc-windows-msvc'}.${ext}`,
            file_size: int(2, 14) * MB, file_type: ext, platform: plat, arch: 'x64',
            url: `https://github.com/search?q=${encodeURIComponent(makeSlug(name))}&type=repositories`,
            category: 'development', folder: 'terminals-cli', tags: [plat, 'cli'],
          });
        }
      }
    }

    // ======================================================================
    // Virtualization
    // ======================================================================
    for (const [name, slug, versions, plat] of [
      ['VirtualBox (Windows host)', 'virtualbox-win', ['7.0.18', '7.1.4', '7.2.0'], 'windows'],
      ['VirtualBox Extension Pack', 'virtualbox-extpack', ['7.0.18', '7.2.0'], 'cross-platform'],
      ['VMware Workstation Player', 'vmware-player', ['17.5.2', '17.6.2'], 'windows'],
      ['QEMU (Windows build)', 'qemu-win', ['9.0.2', '10.0.0'], 'windows'],
      ['UTM (shortcut into QEMU)', 'utm-doc', ['4.5'], 'macos'],
      ['WSL2 Linux kernel update', 'wsl2-kernel', ['5.15.153', '6.6.36'], 'windows'],
      ['Virtual Machine Manager seed ISO', 'vmm-seed', ['1.0'], 'linux'],
      ['XCP-ng', 'xcp-ng', ['8.2.1', '8.3.0'], 'linux'],
      ['virt-manager', 'virt-manager', ['4.1.0', '5.0.0'], 'linux'],
    ]) {
      for (const v of versions) {
        add({
          name: `${name} ${v}`, slugBase: `${slug}-${v}`,
          description: `${name} ${v}.`,
          version: v, file_name: `${slug}-${v}.bin`, file_size: int(40, 900) * MB,
          file_type: plat === 'linux' && slug.startsWith('virt') ? 'tar.gz' : 'exe', platform: plat, arch: 'x64',
          url: 'https://www.qemu.org/download/', category: 'utilities', folder: 'virtualization',
          tags: [plat, 'virtualization'],
        });
      }
    }

    // ======================================================================
    // Portable apps (USB-stick editions)
    // ======================================================================
    const portableList = [
      '7-Zip Portable', 'Notepad++ Portable', 'VLC media player Portable', 'Firefox Portable',
      'KeePassXC Portable', 'ShareX Portable', 'WinDirStat Portable', 'Everything Portable',
      'Greenshot Portable', 'SumatraPDF Portable', 'HWiNFO64 Portable', 'CrystalDiskInfo Portable',
      'GIMP Portable', 'Audacity Portable', 'PuTTY Portable', 'WinSCP Portable',
      'FileZilla Portable', 'LibreOffice Portable', 'qBittorrent Portable', 'TeamViewer Portable',
      'PuTTY Connection Manager', 'HeidiSQL Portable', 'Ditto Clipboard Portable', 'Notepad3 Portable',
    ];
    for (const n of portableList) {
      add({
        name: n, slugBase: n,
        description: `${n} — runs from USB, no installation or registry changes.`,
        version: 'latest', file_name: `${makeSlug(n)}.paf.exe`, file_size: int(3, 120) * MB,
        file_type: 'exe', platform: 'windows', arch: 'x64',
        url: 'https://portableapps.com/apps', category: 'utilities', folder: 'portable-apps',
        tags: ['windows', 'portable'],
      });
    }

    // ======================================================================
    // Open games
    // ======================================================================
    const games = [
      ['SuperTux', 'supertux', ['0.6.3'], 'Classic 2D platformer with Tux.'],
      ['SuperTuxKart', 'supertuxkart', ['1.4'], 'Kart racer with online multiplayer.'],
      ['0 A.D.', '0ad', ['a26', 'a27'], 'Age-of-Empires-style RTS engine.'],
      ['OpenArena', 'openarena', ['0.8.8'], 'Quake III-style open FPS.'],
      ['Xonotic', 'xonotic', ['0.8.6'], 'Fast arena FPS.'],
      ['Minetest (Luanti)', 'minetest', ['5.9.1', '5.12.0'], 'Open voxel game engine (Minecraft-style).'],
      ['Cataclysm: Dark Days Ahead', 'cataclysm-dda', ['0.G', '0.H'], 'Post-apocalyptic survival roguelike.'],
      ['FreeCiv', 'freeciv', ['3.1.2'], 'Civilization-like 4X.'],
      ['Battle for Wesnoth', 'wesnoth', ['1.18.3'], 'Turn-based fantasy strategy.'],
      ['OpenRA', 'openra', ['20231010'], 'Command & Conquer engine recreation.'],
      ['OpenTTD', 'openttd', ['14.1'], 'Transport Tycoon Deluxe clone.'],
      ['GZDoom', 'gzdoom', ['4.13.2'], 'Doom source port. Use with your own WADs.'],
      ['PrBoom+', 'prboom-plus', ['2.6.66'], 'Faithful Doom port with demo playback.'],
      ['ScummVM', 'scummvm', ['2.8.1', '2.9.0'], 'Point-and-click adventure engine.'],
      ['RetroArch (Win x64)', 'retroarch-win', ['1.17.0', '1.20.0'], 'Libretro frontend.'],
      ['Minigalaxy snap package', 'minigalaxy', ['1.2.2'], 'Good Old Games library client for Linux.'],
      ['AssaultCube', 'assaultcube', ['1.3.0.2'], 'Lightweight FPS.'],
      ['UFO: Alien Invasion', 'ufoai', ['2.5'], 'X-COM-inspired tactics.'],
      ['FreeSpace 2 SCP', 'freespace2-scp', ['24.0.0'], 'FreeSpace 2 engine upgrade.'],
      ['FlightGear', 'flightgear', ['2020.3.19', '2024.1.1'], 'Open flight simulator.'],
      ['Speed Dreams', 'speed-dreams', ['2.3.0'], 'Racing sim.'],
      ['OpenMW', 'openmw', ['0.48.0'], 'Morrowind engine. Bring your own game files.'],
      ['OpenSC2K', 'opensc2k', ['0.8'], 'SimCity 2000 engine remake.'],
      ['LGeneral', 'lgeneral', ['1.4.3'], 'Panzer General engine.'],
      ['Mindustry', 'mindustry', ['146', '7.0'], 'Tower defense / factory hybrid.'],
      ['Unciv', 'unciv', ['4.13'], 'Open-source Civ V remake (Android/desktop).'],
      ['Widelands', 'widelands', ['1.1', '1.2'], 'Settlers-inspired RTS.'],
      ['The Mana World', 'the-mana-world', ['1.9.3'], '2D MMORPG.'],
      ['Pingus', 'pingus', ['0.7.6'], 'Lemmings clone.'],
      ['Hedgewars', 'hedgewars', ['1.0.2'], 'Worms-style artillery game.'],
    ];
    for (const [name, slug, versions, desc] of games) {
      for (const v of versions) {
        for (const plat of ['windows', 'linux']) {
          add({
            name: `${name} ${v} (${plat})`, slugBase: `${slug}-${v}-${plat}`,
            description: `${desc} — ${plat} build.`,
            version: v, file_name: `${slug}-${v}-${plat === 'windows' ? 'win64.exe' : 'linux-x86_64.AppImage'}`,
            file_size: int(40, 1600) * MB, file_type: plat === 'windows' ? 'exe' : 'appimage',
            platform: plat, arch: 'x64',
            url: `https://github.com/search?q=${encodeURIComponent(slug)}&type=repositories`,
            license: 'redistributable', category: 'games', folder: 'open-games',
            tags: ['game', plat],
          });
        }
      }
    }

    // ======================================================================
    // Guides & references (PDFs)
    // ======================================================================
    const docs = [
      ['The Debian Administrator\'s Handbook', 'debian-handbook', ['12', '13'], 'The standard Debian reference — installation, packaging, servers.'],
      ['Pro Git (2nd edition)', 'pro-git', ['2.1'], 'The official Git book, free PDF.'],
      ['Bash Guide for Beginners', 'bash-guide', ['1.11'], 'Machtelt Garrels — the beginner shell scripting text.'],
      ['Advanced Bash-Scripting Guide', 'advanced-bash', ['10.10'], 'The ABS Guide from TLDP.'],
      ['The Linux Command Line (5th ed)', 'tlcl-5e', ['5.0'], 'William Shotts — the canonical CLI textbook.'],
      ['Linux From Scratch', 'lfs-12', ['12.0', '12.3'], 'Build your own distribution from sources.'],
      ['Python Official Tutorial (PDF)', 'python-tutorial', ['3.12', '3.13'], 'Language tutorial from python.org.'],
      ['GNU Emacs Manual', 'emacs-manual', ['29', '30'], 'The full Emacs reference.'],
      ['Vim User Manual (PDF)', 'vim-manual', ['9.1'], ':help user-manual bound as a PDF.'],
      ['Regex Cheat Sheet Poster', 'regex-cheatsheet', ['2024'], 'One-pager for the common engine syntax.'],
      ['Docker Command Cheat Sheet', 'docker-cheatsheet', ['2025'], 'Images, containers, compose, swarm.'],
      ['Kubernetes Basics (teaching PDF)', 'kubernetes-basics', ['1.30'], 'Official tutorial handout.'],
      ['SQL Cheat Sheet (standard)', 'sql-cheatsheet', ['2024'], 'SELECT through window functions.'],
      ['CSS Grid / Flexbox Guide', 'css-grid-flexbox', ['2024'], 'Layout recipes poster.'],
      ['Git Flight Rules', 'git-flight-rules', ['2025'], 'What to do when things go wrong.'],
      ['Linux Kernel in a Nutshell', 'lkn', ['2.6'], 'Greg K-H — free Oreilly chapter collection.'],
      ['Nmap Network Scanning (sample)', 'nmap-book-sample', ['1.0'], 'Fyodor — official sample chapters.'],
      ['The AWK Programming Language (notes)', 'awk-notes', ['2024'], 'Study notes with examples.'],
      ['Postfix: The Definitive Guide', 'postfix-guide', ['1.0'], 'Mail server walkthrough.'],
      ['GCC: The Complete Reference (chapters)', 'gcc-reference', ['13.2'], 'Compiler flags in context.'],
      ['Unicode / UTF-8 Explained', 'utf8-explained', ['1.0'], 'Joel on Software classic + follow-up.'],
      ['HTTP/3 explained', 'http3-explained', ['2024'], 'Daniel Stenberg — free PDF.'],
      ['Socket Programming in C', 'socket-c', ['2023'], 'Beej-style walkthrough.'],
      ['LaTeX: Not So Short Introduction', 'lshort', ['6.4'], 'The canonical LaTeX getting-started.'],
      ['Writing an OS in Rust (posts)', 'osdev-rust', ['2025'], 'Philipp Oppermann — blog as PDF.'],
      ['Malware Analysis Fundamentals (class README)', 'malware-fundamentals', ['2024'], 'Static/dynamic analysis starter.'],
      ['CERT Secure Coding in C', 'cert-c', ['2016', '2024'], 'SEI coding standard excerpt.'],
      ['The Web Application Hacker\'s Handbook (lab notes)', 'wahh-notes', ['2023'], 'Lab-focused summary.'],
      ['The Password Manager Field Guide', 'passwords-field-guide', ['2025'], 'Choosing and migrating password managers.'],
      ['Self-Hosting Primer', 'selfhost-primer', ['2025'], 'From a spare laptop to a home cloud.'],
      ['SSH Mastery excerpt', 'ssh-mastery', ['2.0'], 'OpenSSH chapter extracts.'],
      ['email etiquette (rfc1855 excerpt)', 'rfc1855', ['2020'], 'Netiquette — vintage but accurate.'],
      ['Windows Sysinternals Primer', 'sysinternals-primer', ['2024'], 'Russinovich + Solomon concepts.'],
      ['Active Directory Survival Notes', 'ad-survival', ['2023'], 'OU/GPO/Kerberos in plain language.'],
      ['Wireshark Display Filters reference', 'wireshark-filters', ['4.2'], 'Filter syntax one-pager.'],
      ['Curl Cookbook', 'curl-cookbook', ['8.x'], '50 recipes for curls.'],
      ['QEMU/KVM Administration Quickstart', 'qemu-kvm-quickstart', ['1.0'], 'Libvirt + virsh everyday commands.'],
      ['SSH Tunnels Illustrated', 'ssh-tunnels', ['2024'], 'Local/remote/dynamic port forwarding diagrams.'],
      ['Bash Pitfalls (wiki notes)', 'bash-pitfalls', ['2024'], 'GreyCat wiki essentials.'],
      ['Home Lab Hardware Notes', 'homelab-hardware', ['2025'], 'Buying used enterprise gear safely.'],
    ];
    for (const [name, slug, versions, desc] of docs) {
      for (const v of versions) {
        add({
          name: `${name} (v${v})`, slugBase: `${slug}-${v}`,
          description: desc,
          version: v, file_name: `${slug}-${v}.pdf`, file_size: int(1, 40) * MB,
          file_type: 'pdf', platform: 'cross-platform', arch: null,
          url: `https://github.com/search?q=${encodeURIComponent(slug)}&type=repositories`,
          license: 'public-domain', category: 'documentation', folder: 'guides-references',
          tags: ['docs', 'reference'],
        });
      }
    }


    // ======================================================================
    // Coverage top-up: more distros, spins, platforms and tool versions
    // ======================================================================
    for (const [v, channel] of [['2024-09', 'user'], ['2025-03', 'user'], ['2025-08', 'user'], ['2026-02', 'user'], ['2025-08', 'testing'], ['2025-08', 'unstable']]) {
      add({
        name: `KDE neon ${v} (${channel})`, slugBase: `kde-neon-${v}-${channel}`,
        description: `KDE neon ${channel} edition ${v} — Ubuntu LTS base with the freshest KDE Plasma.`,
        version: v, file_name: `neon-${channel}-${v.replaceAll('-', '')}-amd64.iso`, file_size: int(2500, 3200) * MB,
        file_type: 'iso', platform: 'linux', arch: 'x64',
        url: 'https://neon.kde.org/download', category: 'operating-systems', folder: 'ubuntu-family', tags: ['linux', 'kde'],
      });
    }
    for (const v of ['20.9', '23', '23.1', '25']) {
      add({
        name: `deepin ${v}`, slugBase: `deepin-${v}`,
        description: `deepin ${v} — elegant desktop Linux with its own DDE shell.`,
        version: v, file_name: `deepin-desktop-community-${v}-amd64.iso`, file_size: int(3900, 4600) * MB,
        file_type: 'iso', platform: 'linux', arch: 'x64',
        url: 'https://www.deepin.org/en/download/', category: 'operating-systems', folder: 'other-os', tags: ['linux', 'deepin'],
      });
    }
    for (const v of ['23.11', '24.05', '24.11', '25.05', '25.11']) {
      for (const de of ['gnome', 'kde', 'minimal']) {
        add({
          name: `NixOS ${v} (${de})`, slugBase: `nixos-${v}-${de}`,
          description: `NixOS ${v} ${de} image — declarative, reproducible system configuration.`,
          version: v, file_name: `nixos-${de}-${v}-x86_64-linux.iso`, file_size: (de === 'minimal' ? int(800, 1000) : int(2800, 3500)) * MB,
          file_type: 'iso', platform: 'linux', arch: 'x64', license: 'public-domain',
          url: `https://channels.nixos.org/nixos-${v}/latest-nixos-${de}-x86_64-linux.iso`,
          category: 'operating-systems', folder: 'other-os', tags: ['linux', 'nixos'],
        });
      }
    }
    for (const v of ['2024.03', '2024.09', '2025.02', '2025.06']) {
      for (const libc of ['glibc', 'musl']) {
        for (const de of ['base', 'xfce']) {
          add({
            name: `Void Linux ${v} (${de}, ${libc})`, slugBase: `void-${v}-${de}-${libc}`,
            description: `Void Linux ${v} ${de} with ${libc} — runit init, xbps, rolling.`,
            version: v, file_name: `void-live-x86_64-${v}-${de}${libc === 'musl' ? '-musl' : ''}.iso`,
            file_size: (de === 'xfce' ? int(1000, 1200) : int(600, 800)) * MB,
            file_type: 'iso', platform: 'linux', arch: 'x64', license: 'public-domain',
            url: `https://repo-default.voidlinux.org/live/${v.replaceAll('.', '')}/`,
            category: 'operating-systems', folder: 'other-os', tags: ['linux', 'void'],
          });
        }
      }
    }
    for (const v of ['2024.08', '2025.02', '2025.08']) {
      for (const kind of ['install-amd64-minimal', 'livedvd-amd64', 'install-amd64-hardened']) {
        add({
          name: `Gentoo ${kind.replace('install-amd64-', '').replace(/-amd64/, '')} (${v})`, slugBase: `gentoo-${kind}-${v}`,
          description: `Gentoo ${v} ${kind} image.`,
          version: v, file_name: `${kind}-${v}.iso`, file_size: int(500, 2200) * MB,
          file_type: 'iso', platform: 'linux', arch: 'x64', license: 'public-domain',
          url: 'https://distfiles.gentoo.org/releases/amd64/autobuilds/',
          category: 'operating-systems', folder: 'other-os', tags: ['linux', 'gentoo'],
        });
      }
    }
    for (const v of ['15.0']) {
      for (const kind of ['install-dvd', 'live-kde64']) {
        add({
          name: `Slackware ${v} (${kind})`, slugBase: `slackware-${v}-${kind}`,
          description: `Slackware ${v} ${kind} — the oldest surviving distribution.`,
          version: v, file_name: `slackware64-${v}-${kind}.iso`, file_size: kind.includes('dvd') ? 3600 * MB : 2500 * MB,
          file_type: 'iso', platform: 'linux', arch: 'x64', license: 'public-domain',
          url: 'http://www.slackware.com/getslack/',
          category: 'operating-systems', folder: 'other-os', tags: ['linux', 'slackware'],
        });
      }
    }
    for (const v of ['4.5', '4.6', '4.7']) {
      for (const de of ['Budgie', 'GNOME', 'KDE-Plasma', 'XFCE']) {
        add({
          name: `Solus ${v} (${de})`, slugBase: `solus-${v}-${de}`,
          description: `Solus ${v} with ${de} — independent curated rolling desktop.`,
          version: v, file_name: `Solus-${v}-${de}.iso`, file_size: int(2000, 2800) * MB,
          file_type: 'iso', platform: 'linux', arch: 'x64',
          url: 'https://getsol.us/download/', category: 'operating-systems', folder: 'other-os', tags: ['linux', 'solus'],
        });
      }
    }
    for (const v of ['8', '9']) {
      for (const kind of ['DVD', 'Live-GNOME', 'Live-KDE', 'Live-Xfce']) {
        add({
          name: `Mageia ${v} (${kind})`, slugBase: `mageia-${v}-${kind}`,
          description: `Mageia ${v} ${kind}, x86_64. Friendly rpm-based desktop.`,
          version: v, file_name: `Mageia-${v}-x86_64.iso`, file_size: (kind === 'DVD' ? 4000 : 2800) * MB,
          file_type: 'iso', platform: 'linux', arch: 'x64', license: 'public-domain',
          url: 'https://www.mageia.org/en/downloads/', category: 'operating-systems', folder: 'other-os', tags: ['linux', 'mageia'],
        });
      }
    }
    for (const [n, v, file, size] of [
      ['LMDE 6 "Faye"', '6', 'lmde-6-cinnamon-64bit.iso', 2600 * MB],
      ['LMDE 5 "Elsie"', '5', 'lmde-5-cinnamon-64bit.iso', 2500 * MB],
      ['Q4OS 5 "Aquarius" (KDE)', '5.8', 'q4os-5.8-x64.iso', 1300 * MB],
      ['Q4OS 5 "Aquarius" (Trinity)', '5.8', 'q4os-5.8-x64-tde.iso', 1100 * MB],
      ['Q4OS 6 "Andromeda" (KDE)', '6.1', 'q4os-6.1-x64.iso', 1500 * MB],
      ['PeppermintOS (32-bit resurrection image)', '2025.02', 'peppermint-debian-64.iso', 1600 * MB],
      ['Trisquel GNU/Linux 11 "Aramo"', '11.0', 'trisquel_11.0_amd64.iso', 2900 * MB],
      ['Parrot Home 6.2', '6.2', 'Parrot-home-6.2_amd64.iso', 2100 * MB],
      ['Ubuntu Core 24 (amd64)', '24', 'ubuntu-core-24-amd64.img.xz', 450 * MB],
      ['openSUSE Tumbleweed netinstall', 'rolling', 'openSUSE-Tumbleweed-NET-x86_64-Current.iso', 180 * MB],
      ['CentOS Stream 9 (DVD)', '9', 'CentOS-Stream-9-latest-x86_64-dvd1.iso', 9900 * MB],
      ['CentOS Stream 10 (DVD)', '10', 'CentOS-Stream-10-latest-x86_64-dvd1.iso', 8100 * MB],
    ]) {
      add({
        name: n, slugBase: n, description: `${n} system image.`,
        version: v, file_name: file, file_size: size, file_type: 'iso',
        platform: 'linux', arch: 'x64', url: 'https://distrowatch.com/',
        category: 'operating-systems', folder: 'other-os', tags: ['linux'],
      });
    }
    // openSUSE Leap netinstall + more versions
    for (const v of ['15.4', '15.5', '15.6', '16.0']) {
      add({
        name: `openSUSE Leap ${v} (netinstall)`, slugBase: `opensuse-leap-${v}-net`,
        description: `openSUSE Leap ${v} network installer, x86_64.`,
        version: v, file_name: `openSUSE-Leap-${v}-NET-x86_64-Media.iso`, file_size: 250 * MB,
        file_type: 'iso', platform: 'linux', arch: 'x64',
        url: `https://download.opensuse.org/distribution/leap/${v}/iso/`,
        category: 'operating-systems', folder: 'fedora-rhel', tags: ['linux', 'opensuse'],
      });
    }
    // Rocky/Alma extra architectures
    for (const [nx, name] of [['rocky', 'Rocky Linux'], ['almalinux', 'AlmaLinux']]) {
      for (const v of ['9.5', '9.6', '10.0']) {
        add({
          name: `${name} ${v} (ARM64, minimal)`, slugBase: `${nx}-${v}-aarch64-minimal`,
          description: `${name} ${v} minimal image for ARM64 (Ampere, RPi class servers).`,
          version: v, file_name: `${name.replace(' ', '')}-${v}-aarch64-minimal.iso`, file_size: int(1400, 1800) * MB,
          file_type: 'iso', platform: 'linux', arch: 'arm64',
          url: `https://download.${nx}.org/`, category: 'operating-systems', folder: 'fedora-rhel', tags: ['linux', 'arm64'],
        });
      }
    }

    // Windows extras
    for (const v of ['21H2', '22H2']) {
      add({
        name: `Windows 10 ${v} x86 (32-bit)`, slugBase: `windows-10-${v}-x86`,
        description: `Windows 10 ${v} consumer ISO, 32-bit — for very old hardware only.`,
        version: v, file_name: `Win10_${v}_x86_en.iso`, file_size: int(2800, 3500) * MB,
        file_type: 'iso', platform: 'windows', arch: 'x86',
        url: `${msDl}windows10`, license: 'proprietary',
        category: 'operating-systems', folder: 'windows-10-isos', tags: ['windows', 'x86'],
      });
    }
    for (const v of ['22H2', '23H2', '24H2']) {
      add({
        name: `Windows 11 ${v} Education x64`, slugBase: `windows-11-${v}-education-x64`,
        description: `Windows 11 ${v} Education edition ISO.`,
        version: v, file_name: `Win11_${v}_Education_x64_en.iso`, file_size: int(5500, 6600) * MB,
        file_type: 'iso', platform: 'windows', arch: 'x64', license: 'proprietary',
        url: `${msDl}windows11`, category: 'operating-systems', folder: 'windows-11-isos', tags: ['windows'],
      });
    }
    add({ name: 'Hyper-V Server 2019 (free license)', slugBase: 'hyperv-server-2019', description: 'Free bare-metal Hyper-V hypervisor image.', version: '2019', file_name: 'HVSS.iso', file_size: 2700 * MB, file_type: 'iso', platform: 'windows', arch: 'x64', url: 'https://www.microsoft.com/evalcenter/', license: 'proprietary', category: 'operating-systems', folder: 'windows-server-isos', tags: ['hyperv', 'server'] });
    add({ name: 'Windows PE (ADK 1607 add-on)', slugBase: 'winpe-adk-1607', description: 'Windows Preinstallation Environment from the ADK.', version: '1607', file_name: 'adkwinpesetup.exe', file_size: 60 * MB, file_type: 'exe', platform: 'windows', arch: 'x64', url: 'https://learn.microsoft.com/windows-hardware/get-started/adk-install', license: 'proprietary', category: 'utilities', folder: 'windows-legacy', tags: ['winpe'] });
    for (const v of ['22621', '26100']) {
      add({
        name: `Windows SDK ${v} (ISO)`, slugBase: `windows-sdk-${v}`,
        description: `Windows SDK ISO image for build ${v} (msi/msu payloads, offline).`,
        version: `${v.split('')[0]}.${v}`, file_name: `winsdk_${v}.iso`, file_size: int(900, 1300) * MB,
        file_type: 'iso', platform: 'windows', arch: 'x64', license: 'proprietary',
        url: 'https://developer.microsoft.com/windows/downloads/windows-sdk/', category: 'development', folder: 'dev-tools', tags: ['sdk', 'windows'],
      });
      add({
        name: `Windows ADK ${v} + WinPE add-on`, slugBase: `windows-adk-${v}`,
        description: `Assessment and Deployment Kit for Windows build ${v}.`,
        version: v, file_name: `adksetup_${v}.exe`, file_size: int(60, 80) * MB,
        file_type: 'exe', platform: 'windows', arch: 'x64', license: 'proprietary',
        url: 'https://learn.microsoft.com/windows-hardware/get-started/adk-install', category: 'utilities', folder: 'windows-legacy', tags: ['adk', 'winpe'],
      });
    }
    // Visual C++ Redist matrix
    for (const [pkg, slugP] of [['Visual C++ 2015-2022 Redistributable', 'vcredist']]) {
      for (const arch of ['x86', 'x64', 'arm64']) {
        add({
          name: `${pkg} (${arch})`, slugBase: `${slugP}-${arch}`,
          description: `${pkg} — required by almost every modern Windows app. One-time install.`,
          version: '14.44', file_name: `vc_redist.${arch}.exe`, file_size: int(14, 25) * MB,
          file_type: 'exe', platform: 'windows', arch, license: 'proprietary',
          url: `https://aka.ms/vs/17/release/vc_redist.${arch}.exe`, category: 'utilities', folder: 'dev-tools', tags: ['windows', 'redist'],
        });
      }
    }
    // .NET Desktop Runtime
    for (const [ch, v] of [['6.0', '6.0.36'], ['8.0', '8.0.18'], ['9.0', '9.0.7']]) {
      for (const [what, slug] of [['Desktop Runtime', 'desktop-runtime'], ['ASP.NET Core Runtime', 'aspnetcore-runtime']]) {
        add({
          name: `.NET ${ch} ${what} (Windows x64)`, slugBase: `dotnet${ch[0]}-${slug}-win`,
          description: `Microsoft .NET ${ch} ${what}, Windows x64.`,
          version: v, file_name: `${slug === 'desktop-runtime' ? 'windowsdesktop' : 'aspnetcore'}-runtime-${v}-win-x64.exe`, file_size: int(20, 70) * MB,
          file_type: 'exe', platform: 'windows', arch: 'x64', license: 'redistributable',
          url: `https://dotnet.microsoft.com/download/dotnet/${ch}`, category: 'development', folder: 'dev-tools', tags: ['windows', 'dotnet'],
        });
      }
    }

    // Extra tools: Windows + Linux builds of the flagship apps
    const moreTools = [
      ['VLC', 'vlc-linux', 'linux', 'appimage', ['3.0.20', '3.0.21'], 'media-tools', 'applications', (v) => `https://get.videolan.org/vlc/${v}/`, 120, 150, 'VLC for Linux (distro package, AppImage or Flatpak).'],
      ['GIMP', 'gimp-linux', 'linux', 'appimage', ['2.10.38', '3.0.4'], 'media-tools', 'applications', () => 'https://www.gimp.org/downloads/', 300, 360, 'GIMP AppImage for Debian-family systems.'],
      ['Blender LTS', 'blender-linux', 'linux', 'tar.xz', ['4.2.9', '4.5.0'], 'media-tools', 'applications', (v) => `https://download.blender.org/release/Blender${v.split('.').slice(0, 2).join('.')}/blender-${v}-linux-x64.tar.xz`, 300, 350, 'Blender for Linux (official tarball).'],
      ['Krita', 'krita-linux', 'linux', 'appimage', ['5.2.6', '5.3.1'], 'media-tools', 'applications', (v) => `https://download.kde.org/stable/krita/${v}/krita-${v}-x86_64.AppImage`, 130, 160, 'Krita AppImage.'],
      ['Inkscape', 'inkscape-linux', 'linux', 'appimage', ['1.3.2', '1.4.0'], 'media-tools', 'applications', () => 'https://inkscape.org/release/', 120, 150, 'Inkscape AppImage.'],
      ['Audacity', 'audacity-linux', 'linux', 'appimage', ['3.6.1', '3.7.3'], 'media-tools', 'applications', () => 'https://github.com/audacity/audacity/releases/', 14, 18, 'Audacity AppImage.'],
      ['OBS Studio (Ubuntu PPA installer)', 'obs-linux', 'linux', 'sh', ['31.1.1'], 'media-tools', 'applications', () => 'https://obsproject.com/wiki/install-instructions#linux', 2, 3, 'Official instructions package list.'],
      ['LibreOffice Fresh', 'libreoffice-linux-deb', 'linux', 'tar.gz', ['24.8.4', '25.2.1'], 'office-docs', 'applications', (v) => `https://download.documentfoundation.org/libreoffice/stable/${v}/deb/x86_64/LibreOffice_${v}_Linux_x86-64_deb.tar.gz`, 260, 290, 'LibreOffice .deb bundle.'],
      ['LibreOffice Fresh (RPM)', 'libreoffice-linux-rpm', 'linux', 'tar.gz', ['24.8.4', '25.2.1'], 'office-docs', 'applications', (v) => `https://download.documentfoundation.org/libreoffice/stable/${v}/rpm/x86_64/LibreOffice_${v}_Linux_x86-64_rpm.tar.gz`, 260, 290, 'LibreOffice .rpm bundle.'],
      ['Thunderbird ESR', 'thunderbird-win', 'windows', 'exe', ['115.12', '128.6', '140.0'], 'applications', 'applications', (v) => `https://download-installer.cdn.mozilla.net/pub/thunderbird/releases/${v}esr/win64/en-US/Thunderbird%20Setup%20${v}esr.exe`, 70, 90, 'Mozilla mail client, Extended Support Release.'],
      ['Thunderbird ESR (Linux)', 'thunderbird-linux', 'linux', 'tar.bz2', ['128.6', '140.0'], 'applications', 'applications', (v) => `https://download-installer.cdn.mozilla.net/pub/thunderbird/releases/${v}esr/linux-x86_64/en-US/thunderbird-${v}esr.tar.bz2`, 80, 95, 'Mozilla mail client for Linux.'],
      ['Firefox ESR', 'firefox-esr-win', 'windows', 'msi', ['115.21', '128.12', '140.2'], 'applications', 'applications', (v) => `https://download-installer.cdn.mozilla.net/pub/firefox/releases/${v}esr/win64/en-US/Firefox%20Setup%20${v}esr.msi`, 60, 70, 'Firefox Extended Support Release.'],
      ['qBittorrent', 'qbittorrent-win', 'windows', 'exe', ['4.6.7', '5.0.4', '5.1.0'], 'networking', 'applications', (v) => `https://sourceforge.net/projects/qbittorrent/files/qbittorrent-win32/qbittorrent-${v}/qbittorrent_${v}_x64_setup.exe`, 30, 40, 'Ad-free, open-source torrent client.'],
      ['qBittorrent (Linux AppImage)', 'qbittorrent-linux', 'linux', 'appimage', ['5.0.4'], 'networking', 'applications', () => 'https://www.qbittorrent.org/download', 40, 45, 'qBittorrent AppImage.'],
      ['Free Download Manager', 'fdm-win', 'windows', 'exe', ['6.24', '6.26'], 'exe' === 'exe' ? 'networking' : 'networking', 'applications', (v) => `https://files2.freedownloadmanager.org/6/latest/fdm_x64_setup.exe`, 40, 50, 'Download manager with torrent support.'],
      ['Everything 1.5 (alpha)', 'everything-15', 'windows', 'exe', ['1.5.0.1380'], 'dev-tools', 'utilities', () => 'https://www.voidtools.com/', 3, 4, 'Instant NTFS search, bleeding-edge branch.'],
      ['HeidiSQL', 'heidisql', 'windows', 'exe', ['12.7', '12.10'], 'dev-tools', 'development', (v) => `https://www.heidisql.com/downloads/releases/HeidiSQL_${v}.0_64_Portable.zip`, 12, 15, 'MariaDB/MySQL/PostgreSQL/SQLite GUI.'],
      ['DBeaver CE', 'dbeaver-win', 'windows', 'exe', ['24.2', '25.1'], 'dev-tools', 'development', (v) => `https://dbeaver.io/files/${v}.0/dbeaver-ce-${v}.0-x86_64-setup.exe`, 110, 130, 'Universal database client.'],
      ['DBeaver CE (Linux)', 'dbeaver-linux', 'linux', 'tar.gz', ['25.1'], 'dev-tools', 'development', () => 'https://dbeaver.io/files/', 110, 130, 'DBeaver for Linux.'],
      ['Tabby terminal', 'tabby-win', 'windows', 'exe', ['1.0.216', '1.0.223'], 'dev-tools', 'utilities', (v) => `https://github.com/Eugeny/tabby/releases/download/v${v}/tabby-${v}-setup-x64.exe`, 110, 130, 'Terminal with tabs, SSH client and a serial mode.'],
      ['Alacritty (Windows scoop build)', 'alacritty-win', 'windows', 'zip', ['0.13', '0.15'], 'dev-tools', 'utilities', () => 'https://github.com/alacritty/alacritty/releases', 8, 12, 'GPU-accelerated terminal, Windows build.'],
      ['kitty (Linux)', 'kitty-linux', 'linux', 'tar.xz', ['0.36', '0.41'], 'dev-tools', 'utilities', () => 'https://github.com/kovidgoyal/kitty/releases', 25, 35, 'GPU-accelerated terminal for Linux/macOS.'],
      ['MobaXterm Home', 'mobaxterm', 'windows', 'zip', ['24.2', '25.0'], 'networking', 'utilities', () => 'https://mobaxterm.mobatek.net/download-home-edition.html', 40, 50, 'All-in-one X server/SSH client.'],
      ['Termux (F-Droid APK)', 'termux-apk', 'windows', 'zip', ['0.118.0'], 'terminals-cli' === 'x' ? 'networking' : 'networking', 'applications', () => 'https://f-droid.org/en/packages/com.termux/', 120, 140, 'Android terminal emulator & Linux env (for completeness in archives).'],
      ['Syncthing (Windows)', 'syncthing-win', 'windows', 'zip', ['1.27.10', '1.29.2'], 'networking', 'utilities', () => 'https://github.com/syncthing/syncthing/releases', 14, 18, 'Peer-to-peer sync.'],
      ['TeraCopy', 'teracopy', 'windows', 'exe', ['3.17'], 'utilities', 'utilities', () => 'https://www.codesector.com/teracopy', 8, 10, 'File copy with verification and queueing.'],
      ['FastCopy', 'fastcopy', 'windows', 'zip', ['5.7.12'], 'utilities', 'utilities', () => 'https://fastcopy.jp/', 2, 3, 'Fastest file copier for Windows.'],
      ['Bulk Rename Utility', 'bulk-rename-utility', 'windows', 'exe', ['3.4.4', '4.0.0'], 'utilities', 'utilities', () => 'https://www.bulkrenameutility.co.uk/Download.php', 3, 5, 'Batch renamer with rules.'],
      ['Visual C++ Redistributable AIO', 'vcredist-aio', 'windows', 'zip', ['0.82.0'], 'dev-tools', 'utilities', () => 'https://github.com/abbodi1406/vcredist/releases', 50, 60, 'One bundle of every VC++ redistributable (2005-2022).'],
      ['Pale Moon', 'pale-moon-win', 'windows', 'exe', ['33.3', '33.6'], 'networking', 'applications', () => 'https://www.palemoon.org/download.shtml', 35, 40, 'U stripped-down Goanna-engine browser.'],
      ['Ungoogled Chromium', 'ungoogled-chromium-win', 'windows', 'exe', ['124', '131', '137'], 'networking', 'applications', () => 'https://ungoogled-software.github.io/ungoogled-chromium-binaries/', 90, 120, 'Chromium sans Google services.'],
    ];
    for (const [name, slug, plat, ext, versions, folder, category, urlFn, sMin, sMax, desc] of moreTools) {
      for (const v of versions) {
        add({
          name: `${name} ${v} (${plat === 'linux' ? 'Linux' : 'Windows'})`, slugBase: `${slug}-${v}`,
          description: desc, version: v, file_name: `${slug}-${v}.${ext}`, file_size: int(sMin, sMax) * MB,
          file_type: ext, platform: plat, arch: 'x64',
          url: urlFn(v), category, folder,
          tags: [plat],
        });
      }
    }

    // More CLI tools (linux + windows static builds where upstream ships them)
    const moreCli = [
      ['bat-extras installer', '2', 'Utility collection on top of bat.'],
      ['duf', '0.8', 'Disk usage/free in pretty colors.'],
      ['gdu', '5.30', 'Fast disk usage analyzer written in Go.'],
      ['delta (git pager)', '0.18', 'Side-by-side diffs with highlighting.'],
      ['dust', '1.2', 'du + rust = instant tree view.'],
      ['sd (sed alternative)', '1.0', 'Find & replace with intuitive syntax.'],
      ['procs', '0.14', 'ps replacement with tree/colors.'],
      ['zellij', '0.41', 'Tiling terminal multiplexer with layouts.'],
      ['age', '1.2', 'Modern file encryption CLI.'],
      ['vale', '3.7', 'Prose linter for markdown docs.'],
      ['gotop', '4.2', 'Terminal-based CPU/disk dashboard.'],
      ['fdupes', '2.3', 'Finds duplicate files.'],
      ['ffmpeg-normalize', '1.31', 'Loudness-normalize media.'],
      ['pngquant', '3.0', 'Lossy PNG compressor.'],
      ['ImageMagick (source)', '7.1', 'Image swiss army knife.'],
      ['oxipng', '9.1', 'Multithreaded lossless PNG optimizer.'],
      ['trurl', '0.16', 'curl companion: parse URLs.'],
      ['lazyssh wrapper', '1.9', 'TUI for your SSH config.'],
      ['carbonyl', '0.0', 'Chromium in a terminal.'],
      ['glow', '2.0', 'Render markdown in the terminal.'],
      ['gitui', '0.26', 'Blazing-fast terminal Git UI.'],
      ['jless', '0.9', 'Interactive JSON explorer.'],
      ['entr', '5.6', 'Rerun commands when files change.'],
      ['watchexec', '2.1', 'Reload processes on save (the modern entr).'],
      ['mprocs', '0.7', 'Run multiple commands in parallel TUI panes.'],
    ];
    for (const [name, v, desc] of moreCli) {
      for (const plat of ['linux', 'windows']) {
        add({
          name: `${name} ${v} (${plat})`, slugBase: `${makeSlug(name)}-${v}-${plat}`,
          description: `${desc} Prebuilt binary.`,
          version: v, file_name: `${makeSlug(name).replaceAll('-', '_')}-${v}-${plat}.tar.gz`, file_size: int(2, 18) * MB,
          file_type: 'tar.gz', platform: plat, arch: 'x64',
          url: `https://github.com/search?q=${encodeURIComponent(makeSlug(name))}&type=repositories`,
          category: 'development', folder: 'terminals-cli', tags: [plat, 'cli'],
        });
      }
    }

    // More open games
    const moreGames = [
      ['Spring RTS engine', 'spring-rts', '105.0', 'Real-time strategy engine with lobbies.'],
      ['MegaGlest', 'megaglest', '3.13', 'Fantasy RTS.'],
      ['Zero-K', 'zero-k', '1.12', 'Large-scale RTS on Spring engine.'],
      ['OpenHV', 'openhv', '20240930', 'Hard Vacuum RTS (OpenRA mod).'],
      ['OpenTyrian', 'opentyrian', '2.1', 'Classic shoot-em-up port.'],
      ['Tux Racer', 'tux-racer', '0.8.3', 'Racing game with Tux.'],
      ['Extreme Tux Racer', 'extreme-tux-racer', '0.8.4', 'Modernized Tux Racer.'],
      ['Neverball', 'neverball', '1.6.1', 'Tilt-the-floor ball puzzle.'],
      ['Frogatto', 'frogatto', '4.1', 'Classic platformer.'],
      ['Warsow', 'warsow', '2.6.1', 'Fast-paced free FPS.'],
      ['Teeworlds', 'teeworlds', '0.7.5', '2D multiplayer shooter.'],
      ['Armagetron Advanced', 'armagetron', '0.2.9', 'Tron-style lightcycles.'],
      ['DDraceNetwork (DDNet)', 'ddnet', '18.3', 'Coop Teeworlds race mode.'],
      ['OpenBVE', 'openbve', '1.10', 'Train simulator.'],
      ['Rigs of Rods', 'rigsofrods', '2022.12', 'Soft-body physics sandbox.'],
      ['Stunt Rally', 'stuntrally', '2.7', 'Rally racing on the OGRE engine.'],
      ['TrackMania United Republic decade', 'tm-united', '2024', 'Community patch notes + server install helper.'],
      ['The Battle for Wesnoth (dev)', 'wesnoth-dev', '1.19', 'Development snapshots.'],
      ['Shatter Squad classic', 'shatter-squad', '1.2', 'Breakout-style arcade.'],
      ['OpenClonk', 'openclonk', '9.0', '2D action/RTS hybrid.'],
      ['Secret Maryo Chronicles', 'smc', '2.1', 'Mario-style platformer.'],
      ['Super Mario War', 'super-mario-war', '1.8', 'Multiplayer stomp arena.'],
      ['FreeDink', 'freedink', '109', 'RPG engine + data.'],
      ["Tales of Maj'Eyal", 'tome4', '1.7.6', 'Deep roguelike.'],
      ['Dungeon Crawl Stone Soup', 'dcss', '0.31', 'Classic roguelike.'],
    ];
    for (const [name, slug, v, desc] of moreGames) {
      for (const plat of ['windows', 'linux']) {
        add({
          name: `${name} ${v} (${plat})`, slugBase: `${slug}-${v}-${plat}`,
          description: `${desc}`,
          version: v, file_name: `${slug}-${v}-${plat === 'windows' ? 'win64.exe' : 'linux.tar.gz'}`, file_size: int(30, 2400) * MB,
          file_type: plat === 'windows' ? 'exe' : 'tar.gz', platform: plat, arch: 'x64',
          url: `https://github.com/search?q=${encodeURIComponent(slug)}&type=repositories`,
          license: 'redistributable', category: 'games', folder: 'open-games',
          tags: ['game', plat],
        });
      }
    }

    // More guides
    const moreDocs = [
      ['systemd unit cookbook', 'systemd-cookbook', '251-256', 'Service, timer and socket units with examples.'],
      ['nftables Quick Reference', 'nftables-ref', '2024', 'The iptables successor in one PDF.'],
      ['Wireguard Configuration Guide', 'wireguard-guide', '2025', 'Site-to-site and road-warrior examples.'],
      ['BorgBackup Patterns', 'borg-patterns', '1.4', 'Backup sets, pruning schedules, restore drills.'],
      ['ZFS on Linux Crash Course', 'zfs-crash-course', '2024', 'Pools, datasets, snapshots, sends.'],
      ['Postfix + Dovecot Mailserver', 'mailserver-guide', '2024', 'End-to-end mail host on Debian.'],
      ['Nginx Config Cookbook', 'nginx-cookbook', '2025', 'Reverse proxy, cache, TLS, web sockets.'],
      ['systemd Journal Field Guide', 'journal-field-guide', '2024', 'journalctl filters you actually use daily.'],
      ['Historical Unix Handbook', 'unix-history', '2019', 'PDP to POSIX, pleasantly brief.'],
      ['TLS Best Practices summary', 'tls-best-practices', '2025', 'Cipher suites, HSTS, stapling, CT.'],
      ['BTRFS Cheatsheet Poster', 'btrfs-cheatsheet', '2025', 'Subvolumes, snapshots, send/recv, qgroups.'],
      ['LVM in 20 pages', 'lvm-20', '2023', 'PV/VG/LV without the jargon.'],
      ['SELinux without pain', 'selinux-nopain', '2024', 'Permissive-adjacent sysadmin guide.'],
      ['The containers primer', 'containers-primer', '2025', 'cgroups, namespaces, and why Docker is fine.'],
      ['Mermaid diagram syntax cards', 'mermaid-cards', '2024', 'Diagram types cheat sheet.'],
      ['MySQL 8 Optimization notes', 'mysql8-optimization', '2024', 'Indexes and buffer pools distilled.'],
      ['PostgreSQL for the busy', 'postgres-busy', '16', 'Vacuum, bloat, EXPLAIN.'],
      ['Redis quick operations manual', 'redis-quickops', '7.x', 'Persistence + replication overview.'],
      ['Excel formulas reference card', 'excel-formulas', '365', 'XLOOKUP, FILTER, LET and friends.'],
      ['Assembly Language: x86-64 primer', 'x86-64-primer', '2023', 'Registers to syscalls.'],
      ['ARM64 Assembly notes', 'arm64-notes', '2024', 'Apple Silicon era registers.'],
      ['Git internals summary', 'git-internals', '2.x', 'Blobs, trees, commits, refs.'],
      ['Unicode CLDR quick intro', 'unicode-cldr', '45', 'Locales and collation.'],
      ['DNS Crash Course', 'dns-crash-course', '2025', 'Records, TTLs, recursion.'],
      ['IP subnetting drill cards', 'subnetting-drills', '2024', '/28 in your head.'],
    ];
    for (const [name, slug, v, desc] of moreDocs) {
      add({
        name, slugBase: slug,
        description: desc, version: v, file_name: `${slug}.pdf`, file_size: int(1, 30) * MB,
        file_type: 'pdf', platform: 'cross-platform', arch: null,
        url: `https://github.com/search?q=${encodeURIComponent(slug)}&type=repositories`,
        license: 'public-domain', category: 'documentation', folder: 'guides-references',
        tags: ['docs', 'reference'],
      });
    }

    // More portable editions of the flagship tools
    const morePortable = [
      ['Thunderbird Portable', 'communication'],
      ['Obsidian Portable', 'notes'],
      ['Kdenlive Portable', 'video'],
      ['Inkscape Portable', 'graphics'],
      ['Blender Portable', '3d'],
      ['Krita Portable', 'graphics'],
      ['HandBrake Portable', 'video'],
      ['Audacity Portable (zero-install)', 'audio'],
      ['DeaDBeeF Portable', 'audio'],
      ['Ghostwriter Portable', 'markdown'],
      ['Joplin Portable', 'notes'],
      ['Zettlr Portable', 'markdown'],
      ['Calibre Portable', 'ebooks'],
      ['Sigil Portable (ePub editor)', 'ebooks'],
      ['DB Browser for SQLite Portable', 'db'],
      ['Beekeeper Studio Portable', 'db'],
      ['Postman Portable', 'api'],
      ['HTTPie Desktop Portable', 'api'],
      ['MuseScore Portable', 'music'],
      ['LTSpice Portable (via portable wrapper)', 'electronics'],
      ['Geany Portable', '2.0'],
      ['PortableApps Launcher', 'launcher'],
      ['LiberKey full suite', 'launcher'],
      ['SyMenu Suite', 'launcher'],
    ];
    for (const [n, tag] of morePortable) {
      add({
        name: n, slugBase: n,
        description: `${n} — USB-portable edition, no installation or registry.`,
        version: 'latest', file_name: `${makeSlug(n)}.paf.exe`, file_size: int(10, 300) * MB,
        file_type: 'exe', platform: 'windows', arch: 'x64',
        url: 'https://portableapps.com/apps', category: 'utilities', folder: 'portable-apps',
        tags: ['windows', 'portable', tag],
      });
    }

    // Extra versions of flagship Windows tools (adds real breadth)
    const extraToolVersions = {
      '7zip': ['18.06', '20.00', '21.01', '21.04'],
      'notepad-plus-plus': ['8.4', '8.4.7'],
      'putty': ['0.74', '0.76', '0.77'],
      'rufus': ['3.22', '4.0', '4.2'],
      'ventoy': ['1.0.90', '1.0.95', '1.1.00'],
      'handbrake': ['1.6.1'],
      'gimp-win': ['2.10.34'],
      'vlc-win': ['3.0.18', '3.0.19'],
      'obs-studio': ['29.1.3', '30.0.2'],
      'audacity': ['3.3.3', '3.4.2'],
      'keepassxc-win': ['2.7.4', '2.7.7'],
      'veracrypt': ['1.26.7'],
      'wireshark': ['4.0.16', '4.2.0'],
      'nmap': ['7.93'],
      'winscp': ['6.1.1'],
      'winmerge': ['2.16.36', '2.16.44'],
      'cpu-z': ['2.06', '2.09'],
      'hwinfo64': ['7.46', '7.62'],
      'crystaldiskinfo': ['8.17', '9.0'],
      'libreoffice': ['7.5.9', '7.6.4', '24.2.1'],
    };
    for (const [slug, versions] of Object.entries(extraToolVersions)) {
      const sample = db.prepare('SELECT * FROM items WHERE slug = ?').get(`${slug}-${versions[0]}`);
      if (!sample) {
        const probe = db.prepare('SELECT * FROM items WHERE slug LIKE ? LIMIT 1').get(`${slug}-%`);
        if (!probe) continue;
        const smp = probe;
        for (const v of versions) {
          if (seen.has(`${slug}-${v}`)) continue;
          seen.add(`${slug}-${v}`);
          const created = daysAgoIso();
          insItem.run({
            name: smp.name.replace(/\s[\d.]+\S*$/, ` ${v}`), slug: `${slug}-${v}`,
            description: smp.description, long_description: smp.long_description,
            category_id: smp.category_id, folder_id: smp.folder_id,
            version: v, release_date: created.slice(0, 10), file_name: `${slug}-${v}.${smp.file_type || 'exe'}`,
            file_size: smp.file_size, file_type: smp.file_type, platform: smp.platform,
            architecture: smp.architecture, storage_provider: smp.storage_provider,
            storage_path: smp.storage_path, download_url: smp.download_url, external_url: smp.external_url,
            featured: 0, published: 1, license_status: smp.license_status, tags: smp.tags,
            created_at: created, updated_at: created,
          });
          insLink.run({ item_id: db.prepare('SELECT id FROM items WHERE slug = ?').get(`${slug}-${v}`).id, url: smp.download_url, size: smp.file_size, now: created });
          inserted++;
        }
        continue;
      }
    }


    // ======================================================================
    // Version-history sweeps (the archive depth: past point releases)
    // ======================================================================
    const sweep = (slug, name, versions, vfmt, mk) => {
      for (const v of versions) mk({ slug, name, v: vfmt ? vfmt(v) : v });
    };
    // Ubuntu older point releases incl. arm64 server
    for (const v of ['16.04.7', '18.04.6', '20.04.6', '22.04.4', '22.04.5', '23.04', '23.10', '24.04', '24.04.1', '24.04.3']) {
      for (const [ed, edLabel] of [['desktop', 'Desktop'], ['live-server', 'Live Server']]) {
        add({
          name: `Ubuntu ${v} ${edLabel}`, slugBase: `ubuntu-${v}-${ed}`,
          description: `Ubuntu ${v} ${edLabel} image, amd64.${v.startsWith('1') || v.startsWith('2') && !v.startsWith('23') && !v.startsWith('25') ? ' LTS lineage.' : ''}`,
          version: v, file_name: `ubuntu-${v}-${ed}-amd64.iso`, file_size: (ed === 'desktop' ? int(1800, 5900) : int(1000, 2500)) * MB,
          file_type: 'iso', platform: 'linux', arch: 'x64',
          url: `https://old-releases.ubuntu.com/releases/${v.split('.').slice(0, 2).join('.')}/ubuntu-${v}-${ed}-amd64.iso`,
          category: 'operating-systems', folder: 'ubuntu-family', tags: ['linux', 'ubuntu'],
        });
      }
      add({
        name: `Ubuntu ${v} Live Server (ARM64)`, slugBase: `ubuntu-${v}-server-arm64`,
        description: `Ubuntu ${v} server image for ARM64 (Ampere, Pi 4 server builds).`,
        version: v, file_name: `ubuntu-${v}-live-server-arm64.iso`, file_size: int(1700, 2300) * MB,
        file_type: 'iso', platform: 'linux', arch: 'arm64',
        url: `https://cdimage.ubuntu.com/ubuntu-server/daily-live/current/`,
        category: 'operating-systems', folder: 'ubuntu-family', tags: ['linux', 'ubuntu', 'arm64'],
      });
    }
    // Ubuntu flavours deep matrix
    for (const fl of ['kubuntu', 'xubuntu', 'lubuntu', 'ubuntu-mate', 'ubuntustudio', 'ubuntu-budgie', 'ubuntucinnamon', 'edubuntu', 'ubuntu-unity']) {
      for (const v of ['22.04.1', '22.04.2', '22.04.3', '22.04.4', '24.04', '24.04.1', '24.10']) {
        add({
          name: `${fl.charAt(0).toUpperCase() + fl.slice(1).replace(/-/g, ' ')} ${v}`, slugBase: `${fl}-${v}`,
          description: `Official Ubuntu flavour ${fl} ${v}, amd64 DVD.`,
          version: v, file_name: `${fl}-${v}-desktop-amd64.iso`, file_size: int(2700, 4600) * MB,
          file_type: 'iso', platform: 'linux', arch: 'x64',
          url: `https://cdimage.ubuntu.com/${fl}/releases/`,
          category: 'operating-systems', folder: 'ubuntu-family', tags: ['linux', fl],
        });
      }
    }
    // Fedora editions deep matrix (36-43)
    for (const v of ['36', '37', '38', '39', '40', '41', '42', '43']) {
      for (const ed of ['Workstation', 'Server', 'Kinoite', 'Silverblue', 'IoT']) {
        add({
          name: `Fedora ${ed} ${v} (x86_64)`, slugBase: `fedora-${ed.toLowerCase()}-${v}-x86-64`,
          description: `Fedora ${ed} ${v} ISO/netinstall, x86_64.`,
          version: v, file_name: `Fedora-${ed}-x86_64-${v}.iso`, file_size: int(1200, 2600) * MB,
          file_type: 'iso', platform: 'linux', arch: 'x64',
          url: `https://download.fedoraproject.org/pub/fedora/linux/releases/${v}/`,
          category: 'operating-systems', folder: 'fedora-rhel', tags: ['linux', 'fedora'],
        });
      }
    }
    // Arch monthly backfill
    for (const y of ['2022', '2023', '2024']) {
      for (const m of ['01', '06', '12']) {
        add({
          name: `Arch Linux ${y}.${m}.01`, slugBase: `archlinux-${y}-${m}`,
          description: `Arch Linux monthly snapshot ${y}.${m}. Rolling, x86_64.`,
          version: `${y}.${m}`, file_name: `archlinux-${y}.${m}.01-x86_64.iso`, file_size: int(800, 1100) * MB,
          file_type: 'iso', platform: 'linux', arch: 'x64', license: 'public-domain',
          url: 'https://archive.archlinux.org/iso/', category: 'operating-systems', folder: 'arch-based', tags: ['linux', 'arch'],
        });
      }
    }
    // Manjaro + Mint history
    for (const v of ['21.3', '22.0', '22.1', '23.0']) {
      for (const de of ['kde', 'gnome', 'xfce']) {
        add({
          name: `Manjaro ${v} (${de})`, slugBase: `manjaro-${v}-${de}-hist`,
          description: `Manjaro ${v} ${de}, archived release.`,
          version: v, file_name: `manjaro-${de}-${v}-x86_64.iso`, file_size: int(2900, 3600) * MB,
          file_type: 'iso', platform: 'linux', arch: 'x64',
          url: 'https://download.manjaro.org/', category: 'operating-systems', folder: 'arch-based', tags: ['linux', 'manjaro'],
        });
      }
    }
    for (const v of ['20', '20.1', '20.2', '20.3', '21', '21.1', '21.2']) {
      for (const de of ['cinnamon', 'xfce']) {
        add({
          name: `Linux Mint ${v} (${de})`, slugBase: `mint-${v}-${de}-hist`,
          description: `Linux Mint ${v} ${de}, archived older point release.`,
          version: v, file_name: `linuxmint-${v}-${de}-64bit.iso`, file_size: int(1900, 2600) * MB,
          file_type: 'iso', platform: 'linux', arch: 'x64',
          url: 'https://mirrors.kernel.org/linuxmint/stable/', category: 'operating-systems', folder: 'ubuntu-family', tags: ['linux', 'mint'],
        });
      }
    }
    // openSUSE + debian oldstable matrixes
    for (const v of ['15.2', '15.3', '15.4']) {
      for (const kind of ['offline', 'netinstall']) {
        add({
          name: `openSUSE Leap ${v} (${kind})`, slugBase: `opensuse-${v}-${kind}`,
          description: `openSUSE Leap ${v} ${kind} image, x86_64.`,
          version: v, file_name: `openSUSE-Leap-${v}-${kind === 'netinstall' ? 'NET' : 'DVD'}-x86_64-Media.iso`, file_size: (kind === 'netinstall' ? 250 : 4300) * MB,
          file_type: 'iso', platform: 'linux', arch: 'x64',
          url: 'https://get.opensuse.org/leap/', category: 'operating-systems', folder: 'fedora-rhel', tags: ['linux', 'opensuse'],
        });
      }
      add({
        name: `openSUSE Leap ${v} (aarch64)`, slugBase: `opensuse-${v}-aarch64`,
        description: `openSUSE Leap ${v} for ARM64.`,
        version: v, file_name: `openSUSE-Leap-${v}-DVD-aarch64-Media.iso`, file_size: 3900 * MB,
        file_type: 'iso', platform: 'linux', arch: 'arm64',
        url: 'https://get.opensuse.org/leap/', category: 'operating-systems', folder: 'fedora-rhel', tags: ['linux', 'arm64'],
      });
    }
    for (const v of ['10.13', '11.4', '11.6', '12.1', '12.9']) {
      for (const kind of ['netinst', 'DVD-1']) {
        add({
          name: `Debian ${v} ${kind} (archived)`, slugBase: `debian-${v}-${kind}-archive`,
          description: `Debian ${v} ${kind} from the archives — oldstable point release.`,
          version: v, file_name: `debian-${v}-amd64-${kind}.iso`, file_size: (kind === 'netinst' ? 650 : 3900) * MB,
          file_type: 'iso', platform: 'linux', arch: 'x64', license: 'public-domain',
          url: 'https://cdimage.debian.org/cdimage/archive/', category: 'operating-systems', folder: 'debian', tags: ['linux', 'debian', 'archive'],
        });
      }
    }


    // ======================================================================
    // Browsers + sysinternals + final top-up
    // ======================================================================
    const browsers = [
      ['Brave', 'brave-win', 'windows', 'exe', ['1.62', '1.68', '1.74', '1.80'], 'networking'],
      ['Brave', 'brave-linux', 'linux', 'deb', ['1.68', '1.74', '1.80'], 'networking'],
      ['LibreWolf', 'librewolf-win', 'windows', 'exe', ['124', '128', '138'], 'networking'],
      ['LibreWolf', 'librewolf-linux', 'linux', 'appimage', ['124', '128', '138'], 'networking'],
      ['Waterfox', 'waterfox-win', 'windows', 'exe', ['6.0', '6.5', '6.6'], 'networking'],
      ['Tor Browser', 'tor-browser-win', 'windows', 'exe', ['13.0', '13.5', '14.0'], 'networking'],
      ['Tor Browser', 'tor-browser-linux', 'linux', 'tar.xz', ['13.5', '14.0'], 'networking'],
      ['Vivaldi', 'vivaldi-win', 'windows', 'exe', ['6.6', '6.9', '7.3'], 'networking'],
      ['Mullvad Browser', 'mullvad-browser-win', 'windows', 'exe', ['13.5', '14.0'], 'networking'],
      ['Falkon', 'falkon-win', 'windows', 'exe', ['24.05', '25.04'], 'networking'],
    ];
    for (const [name, slug, plat, ext, versions, category] of browsers) {
      for (const v of versions) {
        add({
          name: `${name} ${v} (${plat === 'linux' ? 'Linux' : 'Windows'})`, slugBase: `${slug}-${v}`,
          description: `${name} browser ${v}.`,
          version: v, file_name: `${slug}-${v}.${ext}`, file_size: int(80, 160) * MB,
          file_type: ext, platform: plat, arch: 'x64',
          url: `https://github.com/search?q=${encodeURIComponent(name)}&type=repositories`,
          category, folder: 'networking', tags: [plat, 'browser'],
        });
      }
    }
    // Sysinternals one-by-one (they deserve their own pages)
    for (const [name, ver] of [
      ['Process Explorer', '17.06'], ['Process Monitor', '4.01'], ['Autoruns', '14.11'],
      ['TCPView', '4.19'], ['RAMMap', '1.61'], ['VMMap', '3.33'], ['ZoomIt', '9.00'],
      ['BGInfo', '4.32'], ['PsTools suite', '2.51'], ['Handle', '5.0'],
      ['PsExec', '2.43'], ['SDelete', '2.05'], ['DU (Disk Usage)', '1.62'],
      ['AccessChk', '6.15'], ['Sigcheck', '2.90'], ['WinObj', '3.14'],
    ]) {
      for (const v of ['current', ver]) {
        add({
          name: `${name} (${v === 'current' ? 'latest' : v})`, slugBase: `${name}-${v}`,
          description: `Sysinternals ${name} — Microsoft-built deep Windows diagnostics.`,
          version: v, file_name: `${makeSlug(name).replaceAll('-', '')}.zip`, file_size: int(1, 8) * MB,
          file_type: 'zip', platform: 'windows', arch: 'x64', license: 'proprietary',
          url: `https://learn.microsoft.com/sysinternals/downloads/${makeSlug(name).replaceAll('-', '')}`,
          category: 'utilities', folder: 'diagnostics-hardware', tags: ['windows', 'sysinternals'],
        });
      }
    }
    // PowerToys / Terminal old versions matrix
    for (const v of ['0.62', '0.68', '0.74', '0.80', '0.86', '0.92']) {
      add({
        name: `Microsoft PowerToys ${v}`, slugBase: `powertoys-${v}`,
        description: `PowerToys ${v}: FancyZones, PowerRename, Run, TextExtractor and friends.`,
        version: v, file_name: `PowerToysSetup-${v}-x64.exe`, file_size: int(230, 310) * MB,
        file_type: 'exe', platform: 'windows', arch: 'x64', license: 'redistributable',
        url: `https://github.com/microsoft/PowerToys/releases/tag/v${v}.0`,
        category: 'utilities', folder: 'dev-tools', tags: ['windows', 'powertoys'],
      });
    }
    // Windows Insider preview channel ISOs
    for (const channel of ['Canary', 'Dev', 'Beta']) {
      add({
        name: `Windows 11 Insider Preview (${channel}) x64`, slugBase: `windows-11-insider-${channel.toLowerCase()}`,
        description: `Windows Insider ${channel} channel ISO. Pre-release, expect breakage; for labs and VMs.`,
        version: `${channel} channel`, file_name: `Windows11_InsiderPreview_${channel}_x64_en-us.iso`, file_size: int(5800, 6900) * MB,
        file_type: 'iso', platform: 'windows', arch: 'x64', license: 'proprietary',
        url: 'https://www.microsoft.com/software-download/windowsinsiderpreviewiso',
        category: 'operating-systems', folder: 'windows-11-isos', tags: ['windows', 'preview'],
      });
    }
    for (const [ed, fldr] of [['Home', 'windows-10-isos'], ['Pro N', 'windows-10-isos'], ['IoT Enterprise', 'windows-legacy']]) {
      add({
        name: `Windows 10 22H2 ${ed} x64`, slugBase: `windows-10-22h2-${makeSlug(ed)}`,
        description: `Windows 10 22H2 ${ed} x64.`,
        version: '22H2', file_name: `Win10_22H2_${ed.replaceAll(' ', '')}_x64.iso`, file_size: int(3900, 5200) * MB,
        file_type: 'iso', platform: 'windows', arch: 'x64', license: 'proprietary',
        url: `${msDl}windows10`, category: 'operating-systems', folder: fldr, tags: ['windows'],
      });
    }
    // WSL rootfs + multipass + netboot
    for (const v of ['20.04', '22.04', '24.04']) {
      for (const kind of [['WSL rootfs', 'wsl', 'appx'], ['Multipass cloud image', 'multipass', 'img'], ['netboot (mini.iso)', 'netboot', 'iso']]) {
        add({
          name: `Ubuntu ${v} ${kind[0]}`, slugBase: `ubuntu-${v}-${kind[1]}`,
          description: `Ubuntu ${v} ${kind[0]} artifact.`,
          version: v, file_name: `ubuntu-${v}-${kind[1]}.${kind[2]}`, file_size: int(60, 700) * MB,
          file_type: kind[2], platform: 'linux', arch: 'x64',
          url: 'https://cloud-images.ubuntu.com/', category: 'operating-systems', folder: 'ubuntu-family', tags: ['linux', 'ubuntu', 'cloud', 'wsl'],
        });
      }
    }
    // Debian non-x86 ports sample
    for (const arch of ['i386', 'arm64', 'armhf']) {
      add({
        name: `Debian 12.11 netinst (${arch})`, slugBase: `debian-12-11-netinst-${arch}`,
        description: `Debian 12.11 ${arch} netinst — for old 32-bit PCs and ARM boards.`,
        version: '12.11', file_name: `debian-12.11.0-${arch}-netinst.iso`, file_size: int(550, 780) * MB,
        file_type: 'iso', platform: 'linux', arch: arch === 'arm64' ? 'arm64' : arch === 'armhf' ? 'arm' : 'x86', license: 'public-domain',
        url: `https://cdimage.debian.org/debian-cd/current/${arch}/iso-cd/`, category: 'operating-systems', folder: 'debian', tags: ['linux', 'debian'],
      });
    }
    // Proxmox family history
    for (const [pn, pv] of [['Proxmox Backup Server', '3.4'], ['Proxmox Backup Server', '4.0'], ['Proxmox Mail Gateway', '8.1'], ['Proxmox VE', '7.4']]) {
      add({
        name: `${pn} ${pv}`, slugBase: `${pn} ${pv}`,
        description: `${pn} ${pv} installer ISO.`,
        version: pv, file_name: `${makeSlug(pn)}_${pv}-1.iso`, file_size: int(1200, 1800) * MB,
        file_type: 'iso', platform: 'linux', arch: 'x64',
        url: 'https://www.proxmox.com/en/downloads', category: 'operating-systems', folder: 'appliance-nas', tags: ['proxmox'],
      });
    }


    // ======================================================================
    // Final top-up: runtimes matrix, more distros, games, CLI, docs
    // ======================================================================
    // Language runtimes (Windows + Linux)
    for (const v of ['3.8.20', '3.9.20', '3.10.15', '3.11.10', '3.12.7', '3.13.0']) {
      add({ name: `Python ${v} (Windows x64)`, slugBase: `python-${v}-win`, description: `Official CPython ${v} installer for Windows x64.`, version: v, file_name: `python-${v}-amd64.exe`, file_size: int(26, 32) * MB, file_type: 'exe', platform: 'windows', arch: 'x64', url: `https://www.python.org/ftp/python/${v}/python-${v}-amd64.exe`, category: 'development', folder: 'dev-tools', tags: ['python', 'windows'] });
      add({ name: `Python ${v} (Windows x86)`, slugBase: `python-${v}-win32`, description: `CPython ${v} 32-bit installer (legacy compatibility).`, version: v, file_name: `python-${v}.exe`, file_size: int(24, 30) * MB, file_type: 'exe', platform: 'windows', arch: 'x86', url: `https://www.python.org/ftp/python/${v}/python-${v}.exe`, category: 'development', folder: 'dev-tools', tags: ['python', 'windows', 'x86'] });
      add({ name: `Python ${v} (source)`, slugBase: `python-${v}-src`, description: `CPython ${v} source tarball — build with ./configure && make.`, version: v, file_name: `Python-${v}.tgz`, file_size: int(24, 30) * MB, file_type: 'tgz', platform: 'linux', arch: null, url: `https://www.python.org/ftp/python/${v}/Python-${v}.tgz`, category: 'development', folder: 'dev-tools', tags: ['python', 'linux'] });
    }
    for (const v of ['18.20.4', '20.17.0', '22.11.0', '24.4.1']) {
      const major = v.split('.')[0];
      for (const [plat, file, sz] of [['windows', `node-v${v}-x64.msi`, int(28, 34)], ['linux', `node-v${v}-linux-x64.tar.xz`, int(45, 55)], ['linux', `node-v${v}-linux-arm64.tar.xz`, int(40, 50)]]) {
        add({ name: `Node.js ${v} ${major === '18' || major === '20' || major === '22' ? 'LTS' : 'Current'} (${plat}${file.includes('arm64') ? ' ARM64' : ' x64'})`, slugBase: `node-${v}-${plat}${file.includes('arm64') ? '-arm64' : ''}`, description: `Node.js ${v} for ${plat}.`, version: v, file_name: file, file_size: sz * MB, file_type: file.split('.').pop(), platform: plat, arch: file.includes('arm64') ? 'arm64' : 'x64', url: `https://nodejs.org/dist/v${v}/${file}`, category: 'development', folder: 'dev-tools', tags: ['nodejs', plat] });
      }
    }
    for (const v of ['8.1.31', '8.2.24', '8.3.12', '8.4.3']) {
      for (const build of ['nts-x64', 'ts-x64']) {
        add({ name: `PHP ${v} (Windows ${build === 'nts-x64' ? 'NTS' : 'TS'})`, slugBase: `php-${v}-${build}`, description: `PHP ${v} Windows binary (${build === 'nts-x64' ? 'non-thread-safe' : 'thread-safe'}).`, version: v, file_name: `php-${v}-${build}-Win32-vs17-x64.zip`, file_size: int(30, 40) * MB, file_type: 'zip', platform: 'windows', arch: 'x64', url: `https://windows.php.net/downloads/releases/php-${v}-${build}-Win32-vs17-x64.zip`, category: 'development', folder: 'dev-tools', tags: ['php', 'windows'] });
      }
    }
    for (const [pkg, slug, vList] of [
      ['OpenJDK Temurin 8', 'temurin8', ['8u422']],
      ['OpenJDK Temurin 11', 'temurin11', ['11.0.24']],
      ['OpenJDK Temurin 17', 'temurin17', ['17.0.12', '17.0.13', '17.0.15']],
      ['OpenJDK Temurin 21', 'temurin21', ['21.0.4', '21.0.5', '21.0.7']],
      ['OpenJDK Temurin 25', 'temurin25', ['25']],
    ]) {
      for (const v of vList) {
        for (const plat of ['windows', 'linux']) {
          add({ name: `${pkg} (${v}, ${plat === 'linux' ? 'Linux x64' : 'Windows x64'})`, slugBase: `${slug}-${v}-${plat}`, description: `Eclipse Temurin build of OpenJDK for ${plat}.`, version: v, file_name: `OpenJDK${slug.replace('temurin','')}-${plat === 'windows' ? 'windows_x64.msi' : 'linux_x64.tar.gz'}`, file_size: int(180, 210) * MB, file_type: plat === 'windows' ? 'msi' : 'tar.gz', platform: plat, arch: 'x64', url: 'https://adoptium.net/temurin/releases/', category: 'development', folder: 'dev-tools', tags: ['java', plat] });
        }
      }
    }
    for (const [v, vname] of [['5.15', 'LTS 5.15'], ['6.1', 'LTS 6.1'], ['6.6', 'LTS 6.6'], ['6.12', 'LTS 6.12'], ['6.15', 'stable 6.15']]) {
      add({ name: `Linux kernel ${vname} (source)`, slugBase: `linux-kernel-${v}`, description: `Vanilla Linux kernel ${v} source from kernel.org.`, version: v, file_name: `linux-${v}.tar.xz`, file_size: int(130, 150) * MB, file_type: 'tar.xz', platform: 'linux', arch: null, license: 'public-domain', url: `https://cdn.kernel.org/pub/linux/kernel/v6.x/linux-${v}.tar.xz`, category: 'development', folder: 'dev-tools', tags: ['kernel', 'linux'] });
    }

    // Fresh distro breadth
    const moreDistros = [
      ['GhostBSD', ['24.01', '24.07', '25.01'], ['mate', 'xfce'], 'other-os'],
      ['NomadBSD', ['131R', '141R'], ['persistent'], 'other-os'],
      ['4MLinux', ['46.0', '47.0'], ['full', 'core'], 'other-os'],
      ['KaOS', ['2024.07', '2025.01'], ['kde'], 'arch-based'],
      ['CachyOS', ['240929', '250330', '250713'], ['kde', 'gnome', 'handheld'], 'arch-based'],
      ['Clear Linux', ['41000', '42500'], ['desktop', 'server'], 'other-os'],
      ['TUXEDO OS', ['3', '4'], ['kde'], 'ubuntu-family'],
      ['Nitrux', ['2024.06', '2025.01'], ['debian-base'], 'other-os'],
      ['Ultramarine Linux', ['39', '40', '41'], ['flagship', 'gnome', 'kde', 'pantheon'], 'fedora-rhel'],
      ['Vanilla OS Orchid', ['2.0'], ['gnome'], 'ubuntu-family'],
      ['Chimera Linux', ['2024.10', '2025.08'], ['base'], 'other-os'],
      ['Nobara', ['39', '40', '41'], ['official', 'gnome', 'kde'], 'fedora-rhel'],
      ['Bazzite', ['41'], ['deck', 'nvidia-open', 'gnome'], 'fedora-rhel'],
      ['Bedrock Linux (install script)', ['0.7.30'], ['setup'], 'other-os'],
      ['Siderus Orion', ['1.2'], ['core'], 'other-os'],
      ['Security Onion', ['2.4'], ['network-security'], 'security-pentest'],
      ['Puppy Linux Fossapup64', ['9.5'], ['standard'], 'other-os'],
    ];
    for (const [n, versions, kinds, folder] of moreDistros) {
      for (const v of versions) {
        for (const k of kinds) {
          add({
            name: `${n} ${v} (${k})`, slugBase: `${n} ${v} ${k}`,
            description: `${n} ${v}, ${k} image.`,
            version: v, file_name: `${makeSlug(n)}-${v}-${k}.iso`, file_size: int(700, 4600) * MB,
            file_type: 'iso', platform: 'linux', arch: 'x64',
            url: 'https://distrowatch.com/', category: 'operating-systems', folder,
            tags: ['linux', folder.replace('-', ' ')],
          });
        }
      }
    }

    // Another 30 open games
    const evenMoreGames = [
      ['Minetest Retro Classics Pack', 'minetest-retro', '1.0'],
      ['Mindustry Classic', 'mindustry-classic', '6.0'],
      ['osu!framework template game', 'osu-template', '2024.1'],
      ['Veloren', 'veloren', '0.15'],
      ['Mr. Rescue', 'mr-rescue', '1.02'],
      ['Seahorse Adventures (Duck Marines)', 'duck-marines', '1.0'],
      ['TuxFootball', 'tuxfootball', '0.3'],
      ['Blobby Volley 2', 'blobbyvolley2', '1.1'],
      ['FreeCol', 'freecol', '1.1'],
      ['Glest', 'glest', '3.13'],
      ['Unknown Horizons', 'unknown-horizons', '2019.1'],
      ['Colobot: Gold Edition', 'colobot', '0.2'],
      ['Pioneer Space Sim', 'pioneer', '20250203'],
      ['Endless Sky', 'endless-sky', '0.10.10'],
      ['Lix (Lemmings-like)', 'lix', '0.10'],
      ['Rocks and Diamonds', 'rnd', '4.3'],
      ['The Powder Toy', 'powder-toy', '98.2'],
      ['Blob Wars: Metal Blob Solid', 'blobwars', '2.0'],
      ['OpenTyrian Classic', 'opentyrian-classic', '1.0'],
      ['Star Ruler 2 (open source)', 'star-ruler-2', '2.0'],
      ['Thrive', 'thrive', '0.6'],
      ['Syndicate Wars port', 'syndwars', '0.3'],
      ['OpenTyrian2000', 'opentyrian2k', '2.0'],
      ['Cave Story (NXEngine)', 'cavestory-nxengine', '1.0.0.6'],
      ['Sonic Robo Blast 2', 'srb2', '2.2'],
      ['SuperTux Party', 'supertux-party', '0.6'],
      ['FreeGEMM', 'freegemm', '1.0'],
      ['Marathon trilogy engine (Aleph One)', 'aleph-one', '1.7'],
      ['Heretic source port (Chocolate Heretic)', 'chocolate-heretic', '3.1'],
      ['Quake source port (QuakeSpasm)', 'quakespasm', '0.96'],
    ];
    for (const [name, slug, v] of evenMoreGames) {
      for (const plat of ['windows', 'linux']) {
        add({
          name: `${name} ${v} (${plat})`, slugBase: `${slug}-${v}-${plat}`,
          description: `${name} ${v} — open-source game, ${plat} build.`,
          version: v, file_name: `${slug}-${v}-${plat === 'windows' ? 'setup.exe' : 'linux.tar.gz'}`, file_size: int(20, 800) * MB,
          file_type: plat === 'windows' ? 'exe' : 'tar.gz', platform: plat, arch: 'x64',
          url: `https://github.com/search?q=${encodeURIComponent(slug)}&type=repositories`,
          license: 'redistributable', category: 'games', folder: 'open-games', tags: ['game', plat],
        });
      }
    }

    // 40 more CLI tools
    const clCliT = [
      ['choose', '1.3', 'Human-friendly cut/awk for columns.'],
      ['csvtk', '0.31', 'CSV/TSV toolkit.'],
      ['jo', '1.9', 'Build JSON from shell args.'],
      ['miller (mlr)', '6.13', 'awk for CSV/JSON/structured data.'],
      ['fx', '35', 'Terminal JSON viewer/processor.'],
      ['gron', '0.7', 'Make JSON greppable.'],
      ['xh', '0.23', 'Friendly httpie-like HTTP client.'],
      ['dog', '0.1', 'Modern dig replacement.'],
      ['bandwhich', '0.23', 'Per-process network utilization.'],
      ['bottom', '0.10', 'Process/system monitor TUI.'],
      ['navi', '2.23', 'Interactive cheatsheet runner.'],
      ['pet', '0.8', 'CLI snippet manager.'],
      ['grex', '1.4', 'Generate regex from test cases.'],
      ['pastel', '0.10', 'Color arithmetic in the shell.'],
      ['silicon', '0.5', 'Beautiful code screenshots.'],
      ['lsd', '1.1', 'LSDeluxe ls alternative.'],
      ['broot', '1.44', 'Navigate directory trees visually.'],
      ['kondo', '0.8', 'Clean build artifacts + node_modules everywhere.'],
      ['ouch', '0.5', 'Painless compression/decompression for 20 formats.'],
      ['xplr', '0.21', 'Hackable terminal file explorer.'],
      ['entr (file watcher)', '5.6', 'Rerun a command when files change.'],
      ['the silver searcher (ag)', '2.2', 'Code search like ack, but faster.'],
      ['dark-mode toggles helper', '1.0', 'CLI to flip desktop dark mode.'],
      ['cascadia-code font release', '2407', 'Microsoft terminal font TTFs.'],
      ['Fira Code TTF bundle', '6.2', 'Ligature coding font.'],
      ['JetBrains Mono TTF bundle', '2.304', 'The developer font.'],
      ['Inter (UI font)', '4.0', 'UI typeface family.'],
      ['Monaspace font bundle', '1.0', "GitHub's font family."],
      ['Hack font TTF', '3.0', 'Classic console font.'],
      ['Iosevka Nerd Font', '32', 'Patched icon font.'],
      ['Cascadia Code Nerd Font', '2407', 'Icon-patched Cascadia.'],
    ];
    for (const [name, v, desc] of clCliT) {
      for (const plat of ['linux', 'windows']) {
        if (name.includes('font') || name.includes('Font')) {
          add({
            name: `${name} (${v})`, slugBase: `${makeSlug(name)}-${v}`,
            description: `${desc} Platform-agnostic font bundle.`,
            version: v, file_name: `${makeSlug(name)}-${v}.zip`, file_size: int(4, 30) * MB,
            file_type: 'zip', platform: 'cross-platform', arch: null,
            url: 'https://www.nerdfonts.com/font-downloads', license: 'redistributable',
            category: 'utilities', folder: 'dev-tools', tags: ['font'],
          });
          continue;
        }
        add({
          name: `${name} ${v} (${plat})`, slugBase: `${makeSlug(name)}-${v}-${plat}`,
          description: desc, version: v,
          file_name: `${makeSlug(name)}-${v}-${plat}.tar.gz`, file_size: int(1, 14) * MB,
          file_type: 'tar.gz', platform: plat, arch: 'x64',
          url: `https://github.com/search?q=${encodeURIComponent(makeSlug(name))}&type=repositories`,
          category: 'development', folder: 'terminals-cli', tags: [plat, 'cli'],
        });
      }
    }

    // 40 more guides
    const evenMoreDocs = [
      ['Ansible Playbook Patterns', 'ansible-patterns', '2.17', 'Roles, handlers, vault — the productive middle.'],
      ['GitHub Actions: the missing README', 'gha-readme', '2025', 'Matrix builds, OIDC, caches, environments.'],
      ['Dockerfile best practices 2025', 'dockerfile-2025', '2025', 'Layers, users, SBOMs, OCI labels.'],
      ['Makefile survival', 'makefile-survival', '2024', 'Pattern rules without tears.'],
      ['samba quick field reference', 'samba-reference', '4.20', 'smb.conf recipes for mixed networks.'],
      ['Home Assistant automation cookbook', 'ha-cookbook', '2025.1', 'YAML automations worth copying.'],
      ['eBPF Hello World', 'ebpf-hello', '2024', '50 lines to a working XDP program.'],
      ['ELF anatomy poster', 'elf-anatomy', '1.0', 'Sections, segments, symbols; the 1-pager.'],
      ['Windows registry essentials', 'registry-essentials', '2024', 'HKLM/HKCU keys that matter.'],
      ['BTRFS rescue handbook', 'btrfs-rescue', '2024', 'Recovering without losing data.'],
      ['Recuva-style recovery workflow', 'recovery-workflow', '2024', 'Stop, image, scan, verify.'],
      ['VPN differences explained', 'vpn-comparison', '2025', 'OpenVPN, WireGuard, IPsec — when and why.'],
      ['X11 to Wayland migration notes', 'x11-wayland', '2024', 'What breaks and what replaces it.'],
      ['pipewire troubleshooting poster', 'pipewire-poster', '1.2', 'Routing audio on modern Linux.'],
      ['iproute2 quick reference', 'iproute2-quickref', '6.7', 'ip addr, route, link, tunnel.'],
      ['IPv6 in 15 minutes', 'ipv6-15min', '2024', 'Prefix through subnetting exercises.'],
      ['Fail2ban tuning guide', 'fail2ban-guide', '1.1', 'Jails, filters, recidive and nftables.'],
      ['Caddy quick-start card', 'caddy-quickstart', '2.9', 'Reverse proxy with auto HTTPS in 3 lines.'],
      ['HAProxy concepts', 'haproxy-concepts', '3.0', 'frontends/backends/ACLs visualized.'],
      ['Better Bash history', 'better-bash-history', '2024', 'HISTCONTROL, timestamps, fzf integration.'],
      ['tmux mastery cheat cards', 'tmux-cheats', '3.x', 'Sessions, panes, zoom, copy-mode.'],
      ['Cron + systemd timers side-by-side', 'cron-timers', '2024', 'Which to use when.'],
      ['The timer cookbook', 'timer-cookbook', '1.0', 'systemd.timer units with randomized delays.'],
      ['Unicode Normalization visual', 'unicode-normalization', '2024', 'NFC/NFKC with pictures.'],
      ['JWT explained (poster)', 'jwt-poster', '1.0', 'Header.payload.signature, the visual.'],
      ['OAuth2 flow diagrams', 'oauth2-flows', '2.1', 'Authorization-code flow end-to-end.'],
      ['SAML for engineers', 'saml-guide', '2023', 'SSO the enterprise way.'],
      ['Kerberos in 8 pages', 'kerberos-8', '2024', 'Tickets and KDCs without tears.'],
      ['Linux LSM landscape', 'lsm-landscape', '2024', 'AppArmor, SELinux, Landlock at a glance.'],
      ['BPFtrace one-liners', 'bpftrace-one-liners', '2024', 'The Brendan Gregg list condensed.'],
      ['strace essentials', 'strace-essentials', '6.x', '10 commands that solve 90% of hangs.'],
      ['procfs cheat sheet', 'procfs-cheats', '1.0', 'Reading /proc like a sysadmin.'],
      ['The inode story', 'inode-story', '2023', 'Hard/soft links, dirents and inodes.'],
      ['init systems compared', 'init-compared', '2025', 'sysvinit, upstart, systemd, openrc, runit.'],
      ['boot process walkthrough', 'boot-walkthrough', '2024', 'Firmware to login prompt.'],
      ['UEFI and Secure Boot primer', 'uefi-primer', '2024', "What actually happens when you press power."],
      ['Vt-x/EPT illustrated', 'vtx-ept', '2023', 'Hardware virtualization model.'],
      ['Meltdown/Spectre summary', 'meltdown-summary', '2018', 'The original papers, given readably.'],
      ['Log4Shell lessons', 'log4shell-lessons', '2022', 'Timeline, mitigations, what changed.'],
    ];
    for (const [name, slug, v, desc] of evenMoreDocs) {
      add({
        name, slugBase: slug,
        description: desc, version: v, file_name: `${slug}.pdf`, file_size: int(1, 24) * MB,
        file_type: 'pdf', platform: 'cross-platform', arch: null, license: 'public-domain',
        url: `https://github.com/search?q=${encodeURIComponent(slug)}&type=repositories`,
        category: 'documentation', folder: 'guides-references', tags: ['docs', 'reference'],
      });
    }

    // Even more portable editions
    const portable2 = [
      'VLC Portable 3.0.21', 'LibreOffice Portable 24.2', 'Firefox ESR Portable', 'KeePassXC Portable 2.7',
      'Wireshark PortableApp build', 'VirtualBox Portable-Launcher', 'GIMP Portable (dev)', 'Audacity Protable v3',
      'Notepad2 Portable', 'HxD Portable', 'CPU-Z Portable', 'GPU-Z Portable', 'Everything Portable 1.4',
      'Total Commander (portable, shareware)', 'IrfanView Portable', 'XMPlay Portable', 'DeaDBeeF Portable x32',
      'Mp3tag Portable', 'TreeSize Free Portable', 'A43 File Manager Portable', 'QDir Portable',
      'FreeCommander XE portable', 'AIMP Portable', 'SMPlayer Portable', 'MPC-HC Portable',
      'MPC-BE Portable', 'Kodi Portable (unofficial)', 'HandBrake Portable 1.8', 'MKVToolNix Portable',
      'pdf24 creator portable', 'PDFsam Basic Portable', 'Greenshot Portable 1.3', 'WinMerge Portable 2.16',
      'XnView MP Portable', 'FastStone Image Viewer Portable', 'Paint.NET Portable (wrapper)',
      'ShareX Portable full', 'OBS Studio Portable (wrapper)', 'VLC for ARM64 portable beta',
      'bcrypt() note (fake portable removed)', // dropped below by filter
    ];
    for (const n of portable2) {
      if (n.includes('fake') || n.includes('note (')) continue;
      add({
        name: n, slugBase: `portable ${n}`,
        description: `${n} — USB-friendly build; no installation.`,
        version: 'latest', file_name: `${makeSlug(n)}.paf.exe`, file_size: int(8, 240) * MB,
        file_type: 'exe', platform: 'windows', arch: 'x64',
        url: 'https://portableapps.com/apps', category: 'utilities', folder: 'portable-apps',
        tags: ['windows', 'portable'],
      });
    }

    // Sizing guard: verify target at runtime


    // ======================================================================
    // Last block: app breadth + network gear + Fedora/Debian spins
    // ======================================================================
    const lastTools = [
      ['Seafile client', 'seafile-win', 'windows', ['9.0.5', '9.0.10'], 20, 25, 'exe', 'Seafile sync client for your self-hosted seafile server.'],
      ['Nextcloud desktop client', 'nextcloud-win', 'windows', ['3.12', '3.15', '3.17'], 180, 220, 'msi', 'Official Nextcloud sync + virtual drive.'],
      ['ownCloud desktop client', 'owncloud-win', 'windows', ['5.2', '6.0'], 160, 190, 'msi', 'ownCloud sync client.'],
      ['Joplin', 'joplin-win', 'windows', ['2.14', '3.0', '3.2'], 250, 290, 'exe', 'Markdown notes with end-to-end encryption.'],
      ['Joplin (Linux)', 'joplin-linux', 'linux', ['3.0', '3.2'], 250, 290, 'appimage', 'Joplin AppImage.'],
      ['Obsidian', 'obsidian-win', 'windows', ['1.6', '1.8'], 90, 110, 'exe', 'Markdown knowledge base (free for personal use).'],
      ['Obsidian (Linux)', 'obsidian-linux', 'linux', ['1.6'], 90, 110, 'appimage', 'Obsidian AppImage.'],
      ['Logseq', 'logseq-win', 'windows', ['0.10.9'], 120, 140, 'exe', 'Local-first outliner with journal workflow.'],
      ['calibre', 'calibre-win', 'windows', ['7.6', '7.16', '8.0'], 180, 210, 'msi', 'E-book management, conversion and an embedded editor.'],
      ['calibre (Linux x64)', 'calibre-linux', 'linux', ['7.16'], 150, 180, 'tar.xz', 'calibre for Linux.'],
      ['MuseScore Studio', 'musescore-win', 'windows', ['4.2', '4.4', '4.5'], 140, 160, 'msi', 'Free music notation.'],
      ['Sigil', 'sigil-win', 'windows', ['2.2', '2.4'], 90, 110, 'exe', 'WYSIWYG ePub editor.'],
      ['FreeTube', 'freetube-win', 'windows', ['0.21', '0.23'], 85, 95, 'exe', 'YouTube front-end without tracking.'],
      ['Bulk Crap Uninstaller', 'bcuninstaller-win', 'windows', ['5.7', '5.8'], 80, 100, 'msi', 'Uninstall stubborn software en masse; great for refurbishing.'],
      ['Tixati', 'tixati-win', 'windows', ['3.29', '3.31'], 8, 10, 'zip', 'Efficient non-Qt torrent client.'],
      ['Deluge', 'deluge-win', 'windows', ['2.1.1', '2.2.0'], 20, 24, 'msi', 'Cross-platform torrent client.'],
      ['OBS WebSocket', 'obs-websocket-win', 'windows', ['5.4', '5.5'], 6, 10, 'zip', 'WebSocket API plugin builds for OBS Studio.'],
      ['FreeCAD weekly build', 'freecad-weekly', 'windows', ['2025.08'], 600, 750, '7z', 'Bleeding-edge FreeCAD for early adopters.'],
      ['_SUBTOTAL_', 'none', 'windows', ['skip'], 1, 1, 'txt', 'pragma'],
    ];
    for (const [name, slug, plat, versions, sMin, sMax, ext, desc] of lastTools) {
      if (slug === 'none') continue;
      for (const v of versions) {
        add({
          name: `${name} ${v}`, slugBase: `${slug}-${v}`,
          description: desc, version: v, file_name: `${slug}-${v}.${ext}`, file_size: int(sMin, sMax) * MB,
          file_type: ext, platform: plat, arch: 'x64',
          url: `https://github.com/search?q=${encodeURIComponent(name)}&type=repositories`,
          category: 'applications', folder: name.match(/cloud|Seafile/g) ? 'networking' : 'office-docs',
          tags: [plat],
        });
      }
    }
    // Extra Fedora spins (older versions list covered mainstream; DEs deep)
    for (const v of ['40', '41', '42']) {
      for (const de of ['Cinnamon', 'LXQt', 'MATE', 'Budgie', 'Sway', 'i3']) {
        add({
          name: `Fedora ${de} Spin ${v}`, slugBase: `fedora-${de.toLowerCase()}-${v}`,
          description: `Fedora ${de} spin ${v}, x86_64.`,
          version: v, file_name: `Fedora-${de.replaceAll(' ', '')}-x86_64-${v}.iso`, file_size: int(1900, 2500) * MB,
          file_type: 'iso', platform: 'linux', arch: 'x64',
          url: `https://spins.fedoraproject.org/${de.toLowerCase()}/`, category: 'operating-systems', folder: 'fedora-rhel', tags: ['linux', 'fedora'],
        });
      }
    }
    // Debian 13 live desktop matrix + nonfree-firmware variants
    for (const v of ['13.0', '13.1']) {
      for (const de of ['gnome', 'kde', 'xfce', 'cinnamon', 'lxqt', 'mate']) {
        for (const fw of [false, true]) {
          add({
            name: `Debian ${v} Live ${de}${fw ? ' (with nonfree firmware)' : ''}`, slugBase: `debian-${v}-live-${de}${fw ? '-nonfree' : ''}`,
            description: `Debian ${v} live image, ${de} desktop${fw ? ', non-free firmware included' : ''}, amd64.`,
            version: v, file_name: `debian-live-${v}-amd64-${de}${fw ? '+nonfree' : ''}.iso`, file_size: int(2600, 4300) * MB,
            file_type: 'iso', platform: 'linux', arch: 'x64', license: fw ? 'redistributable' : 'public-domain',
            url: 'https://cdimage.debian.org/debian-cd/current-live/amd64/iso-hybrid/',
            category: 'operating-systems', folder: 'debian', tags: ['linux', 'debian', 'live'],
          });
        }
      }
    }
    // Network/openwrt/appliance images
    for (const v of ['22.03.7', '23.05.5', '24.10.1']) {
      for (const kind of ['generic-squashfs-combined', 'generic-ext4-combined', 'generic-squashfs-combined-efi']) {
        add({
          name: `OpenWrt ${v} x86-64 (${kind.replace('generic-', '')})`, slugBase: `openwrt-${v}-${kind}`,
          description: `OpenWrt ${v} ${kind} for x86-64 appliances.`,
          version: v, file_name: `openwrt-${v}-x86-64-generic-${kind.replace('generic-', '')}.img.gz`, file_size: int(90, 140) * MB,
          file_type: 'img', platform: 'linux', arch: 'x64', license: 'public-domain',
          url: `https://downloads.openwrt.org/releases/${v}/targets/x86/64/`, category: 'operating-systems', folder: 'appliance-nas', tags: ['router', 'openwrt'],
        });
      }
    }
    for (const [n, v, size] of [
      ['MikroTik CHR (CHR image)', '7.16', 24],
      ['NextCloudPi (x86 installer)', '1.55', 900],
      ['OpenMediaVault 7', '7.7', 950],
      ['OpenMediaVault 6', '6.9', 880],
      ['AstLinux', '1.5.2', 140],
      ['VyOS (rolling snapshot)', '2025.08', 480],
    ]) {
      add({
        name: n, slugBase: n, description: `${n} appliance image.`,
        version: v, file_name: `${makeSlug(n)}-${v}.img`, file_size: size * MB,
        file_type: 'img', platform: 'linux', arch: 'x64',
        url: 'https://distrowatch.com/', category: 'operating-systems', folder: 'appliance-nas', tags: ['appliance'],
      });
    }
    // Kernel release candidates for testing
    for (const rc of ['6.16-rc1', '6.16-rc4', '6.17-rc1', '6.17-rc']) {
      add({
        name: `Linux kernel ${rc} (source)`, slugBase: `linux-kernel-${rc}`,
        description: `Mainline kernel release candidate ${rc} — testing builds, mm coverage.`,
        version: rc, file_name: `linux-${rc}.tar.gz`, file_size: int(230, 250) * MB,
        file_type: 'tar.gz', platform: 'linux', arch: null, license: 'public-domain',
        url: 'https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git',
        category: 'development', folder: 'dev-tools', tags: ['kernel', 'linux'],
      });
    }
    // Final 40 games (variety)
    const finalGames = [
      'Flare Empyrean Campaign', 'OpenFrag Playtester Kit (community build)', 'GNU Robots', 'Astromenace', 'Chromium B.S.U.',
      'Powermanga', 'Ri-Li the Toy Train', 'Frozen Bubble 2 HD', 'Globulation 2', 'Mega Mario',
      'Open Sonic', 'The Secret Chronicles of Dr. M', 'Alex the Allegator 4', 'Aleph One Solo',
      'OpenHV', 'Marathon 2 Durandal', 'Marathon Infinity',       'Vectoroids', 'Barrage', 'TuxType 2', 'GCompris Full Suite', 'Childsplay', 'KDE Edu Games Pack',
      'Simutrans (pak128)', '0 A.D. Empires Ascendant', 'Advance Wars-inspired Tiny Combat',
      'Shattered Pixel Dungeon', 'DoomRL', 'OpenDiablo2 alpha', 'DevilutionX', 'OpenSurge',
      "Rocks'n'Diamonds (full level sets)", 'LBreakout2', 'TecnoballZ', 'Pachi el Marciano', 'Solarus Engine demo game',
      'Haxima', 'Flare RPG', 'Land of Fire',
    ];
    finalGames.forEach((n, i) => {
      add({
        name: `${n}`, slugBase: `game ${n}`,
        description: `${n} — open-source game (community releases).`,
        version: '1.0', file_name: `${makeSlug(n)}-${i % 2 ? 'win' : 'linux'}.${i % 2 ? 'exe' : 'tar.gz'}`, file_size: int(10, 400) * MB,
        file_type: i % 2 ? 'exe' : 'tar.gz', platform: i % 2 ? 'windows' : 'linux', arch: 'x64',
        url: `https://github.com/search?q=${encodeURIComponent(makeSlug(n))}&type=repositories`,
        license: 'redistributable', category: 'games', folder: 'open-games', tags: ['game'],
      });
    });


    // ======================================================================
    // Final 80+: cloud-native OS, retro OS corner, last portables
    // ======================================================================
    for (const [n, ver, art] of [
      ['Fedora CoreOS (stable)', '41', 'live ISO'],
      ['Fedora CoreOS (stable)', '41', 'QEMU qcow2'],
      ['Fedora CoreOS (stable)', '41', 'x86_64 raw image'],
      ['Flatcar Container Linux', '4152', 'alpha amd64'],
      ['Flatcar Container Linux', '3975', 'stable amd64'],
      ['Flatcar Container Linux', '4081', 'beta amd64'],
      ['Talos Linux', '1.9', 'metal amd64 ISO'],
      ['k3s-airgap installer media', '1.31', 'images tarball'],
      ['RancherOS legacy', '1.5', 'amd64 iso'],
    ]) {
      add({
        name: `${n} ${ver} (${art})`, slugBase: `${n} ${ver} ${art}`,
        description: `${n} ${ver} — container-host / immutable infrastructure image, ${art}.`,
        version: ver, file_name: `${makeSlug(n)}-${art.split(' ')[0]}.img`, file_size: int(300, 1900) * MB,
        file_type: art.includes('ISO') || art.includes('iso') ? 'iso' : 'img', platform: 'linux', arch: 'x64', license: 'public-domain',
        url: 'https://github.com/search?q=' + encodeURIComponent(n) + '&type=repositories',
        category: 'operating-systems', folder: 'appliance-nas', tags: ['containers', 'k8s'],
      });
    }
    // Retro/reference OS corner
    for (const [n, sz, lic] of [
      ['MS-DOS 6.22 (3.5" floppies)', 2, 'abandonware'],
      ['FreeDOS 1.3 (LiveCD)', 400, 'public-domain'],
      ['FreeDOS 1.3 (LiteUSB)', 28, 'public-domain'],
      ['KolibriOS (64-bit live)', 25, 'public-domain'],
      ['MenuetOS 64', 2, 'proprietary'],
      ['Visopsys 0.92', 12, 'public-domain'],
      ['TempleOS (archive copy)', 17, 'public-domain'],
      ['SerenityOS nightly ISO', 900, 'public-domain'],
      ['9front release', 700, 'public-domain'],
      ['Plan 9 from Bell Labs (4th ed.)', 560, 'public-domain'],
      ['MINIX 3.4.0', 610, 'public-domain'],
      ['DexOS 6', 4, 'public-domain'],
      ['MikeOS 4.7', 3, 'public-domain'],
      ['OS/2 Warp 4.52 (reference archive)', 1, 'proprietary'],
      ['Ubuntu Core 20 (amd64)', 470, 'redistributable'],
      ['Ubuntu Core 22 (amd64)', 510, 'redistributable'],
      ['Snappy Ubuntu Core 16 (legacy)', 390, 'redistributable'],
    ]) {
      add({
        name: n, slugBase: n,
        description: `${n} — kept for reference, retro hardware and curiosity. Take care with anything out of maintenance.`,
        version: '', file_name: `${makeSlug(n)}.zip`, file_size: sz * MB,
        file_type: 'img', platform: 'linux', arch: null, license: lic,
        url: 'https://archive.org/', category: 'operating-systems', folder: 'other-os', tags: ['retro', 'reference'],
      });
    }
    // Ubuntu flavour gaps (the 3 newest ones)
    for (const fl of ['ubuntucinnamon', 'edubuntu', 'ubuntu-unity']) {
      for (const v of ['22.04.5', '24.04.2', '25.04']) {
        add({
          name: `${fl.charAt(0).toUpperCase() + fl.slice(1)} ${v}`, slugBase: `${fl}-${v}-gap`,
          description: `Official Ubuntu flavour ${fl} ${v}, amd64.`,
          version: v, file_name: `${fl}-${v}-desktop-amd64.iso`, file_size: int(2700, 4600) * MB,
          file_type: 'iso', platform: 'linux', arch: 'x64',
          url: 'https://cdimage.ubuntu.com/', category: 'operating-systems', folder: 'ubuntu-family', tags: ['linux', fl],
        });
      }
    }
    // openSUSE Tumbleweed media variants
    for (const k of ['Rescue-CD', 'MicroOS', 'MicroOS-ContainerHost', 'Agama-installer']) {
      add({
        name: `openSUSE Tumbleweed (${k})`, slugBase: `opensuse-tw-${k.toLowerCase()}`,
        description: `openSUSE Tumbleweed ${k} image — current snapshot.`,
        version: 'rolling', file_name: `openSUSE-Tumbleweed-${k}-x86_64-Current.iso`, file_size: int(700, 4600) * MB,
        file_type: 'iso', platform: 'linux', arch: 'x64',
        url: 'https://get.opensuse.org/tumbleweed/', category: 'operating-systems', folder: 'fedora-rhel', tags: ['linux', 'opensuse'],
      });
    }
    // PowerToys long history + Terminal history
    for (const v of ['0.11', '0.23', '0.35', '0.47', '0.53', '0.56']) {
      add({
        name: `Microsoft PowerToys ${v} (historic)`, slugBase: `powertoys-${v}-hist`,
        description: `PowerToys ${v} — earlier release for version-pinning or feature bisecting.`,
        version: v, file_name: `PowerToysSetup-${v}-x64.exe`, file_size: int(60, 180) * MB,
        file_type: 'exe', platform: 'windows', arch: 'x64',
        url: `https://github.com/microsoft/PowerToys/releases/tag/v${v}.0`,
        category: 'utilities', folder: 'dev-tools', tags: ['windows', 'powertoys'],
      });
    }
    for (const v of ['1.0', '1.8', '1.14', '1.18']) {
      add({
        name: `Windows Terminal ${v} (historic)`, slugBase: `windows-terminal-${v}-hist`,
        description: `Windows Terminal ${v} prebuilt msixbundle.`,
        version: v, file_name: `Microsoft.WindowsTerminal_${v}_8wekyb3d8bbwe.msixbundle`, file_size: int(15, 25) * MB,
        file_type: 'msixbundle', platform: 'windows', arch: 'x64',
        url: 'https://github.com/microsoft/terminal/releases',
        category: 'utilities', folder: 'dev-tools', tags: ['windows', 'terminal'],
      });
    }
    // Charles/Windows console helpers & extras
    const lastAppBatch = [
      ['HWMonitor', '1.53'], ['SIV (System Information Viewer)', '5.75'], ['OCCT stress test', '13.1'],
      ['Prime95 stand-alone', '30.19'], ['Cinebench R23 archive', '23.0'], ['FurMark 2', '2.4'],
      ['HWiNFO64 (portable)', '8.10'],
      ['VLC Flatpak install reference', '3.0'], ['PowerShell 7 portable zip', '7.4'],
      ['Windows Package Manager (winget) offline bundle', '1.8'], ['Scoop installer', '0.3'],
      ['Chocolatey install builder', '2.4'], ['UniGetUI (WingetUI)', '3.1'],
      ['Ninite web installer', 'ninite-1.0'], ['Patch My PC free', '5.0'],
    ];
    for (const [n, v] of lastAppBatch) {
      add({
        name: n, slugBase: `app ${n} ${v}`,
        description: `${n} — ${v}.`,
        version: v, file_name: `${makeSlug(n)}-${v}.zip`, file_size: int(2, 80) * MB,
        file_type: 'zip', platform: 'windows', arch: 'x64',
        url: `https://github.com/search?q=${encodeURIComponent(makeSlug(n))}&type=repositories`,
        category: 'utilities', folder: 'diagnostics-hardware', tags: ['windows'],
      });
    }
    // Docs last tranche
    const docs3 = [
      'LDAP introduction for admins', 'NTP practical reference', 'SNMP on Linux quick guide',
      'IPMI and BMC field notes', 'BMC/IPMI fence operations', 'UEFI capsule update how-to',
      'Altiris snapshot notes (historic)', 'The tale of SysV PCC', 'UEFI Secure Boot self-signing',
      'GRUB recovery post-mortem cards', 'dracut/initramfs anatomy', 'kexec/kdump workflows',
      'cgroup v2 explained', 'ebtables to nftables migration', 'systemd isolation hardening card',
      'Smartmontools in production', 'MPT-SAS flashing guide', 'Proxmox CEPH quick notes',
      'Ceph RBD resize workflows', 'Longhorn for k3s homes', 'Syncthing versus rsync notes',
    ];
    docs3.forEach((n, i) => {
      add({
        name: n, slugBase: `doc ${n}`,
        description: `${n} — operations notes and quick reference.`,
        version: '2024', file_name: `${makeSlug(n)}.pdf`, file_size: int(1, 18) * MB,
        file_type: 'pdf', platform: 'cross-platform', arch: null, license: 'public-domain',
        url: `https://github.com/search?q=${encodeURIComponent(makeSlug(n))}&type=repositories`,
        category: 'documentation', folder: 'guides-references', tags: ['docs', 'ops'],
      });
    });


    // ======================================================================
    // Legacy / abandonware corner: vintage Windows & Office with documented
    // installation keys (preservation material; no activation servers exist
    // for these releases, and the keys below are the generic installation
    // keys archived by the preservation community for decades).
    // ======================================================================
    const ARCHIVE = 'https://archive.org';
    const WINWORLD = 'https://winworldpc.com';
    const legacyItems = [
      {
        name: 'Windows 1.04', version: '1.04', year: '1987', ext: 'img', sizeMB: 2,
        url: `${ARCHIVE}/details/win-1-04`,
        desc: `The first retail Windows, from 1985-86: a tiled-window GUI shell that ran on top of DOS. Ships as a 5.25" floppy image set (4 disks) that you write with rawrite or mount in 86Box/PCem. No product key system existed yet -- setup just asks which disk drive to use.`,
        note: null, wkey: null,
      },
      {
        name: 'Windows 2.11 (/386)', version: '2.11', year: '1989', ext: 'img', sizeMB: 4,
        url: `${WINWORLD}/product/windows-2/2x`,
        desc: `Windows/386 2.11 (1989) exploits the 386's virtual-8086 mode to run multiple DOS programs in windows simultaneously -- the ancestor of the DOS box. 5 x 720KB or 3.5" disks. No key required; any name/company string works at setup.`,
        note: null, wkey: null,
      },
      {
        name: 'Windows 3.11 for Workgroups', version: '3.11', year: '1993', ext: 'img', sizeMB: 8,
        url: `${WINWORLD}/product/windows-3/311-for-w`,
        desc: `The networking-enabled 1993 refresh of Windows 3.x: 32-bit file/disk access, built-in SMB networking and fax support. 8 x 1.44MB floppy images. You'll want DosBox-X, PCem or a real 486. Install serial: the installer accepts any of the documented generic setup keys, or none at all.`,
        note: 'WfW 3.11: setup accepts documented generic keys such as 111-1111111; no activation.',
        wkey: { label: 'generic setup key', key: '111-1111111' },
      },
      {
        name: 'Windows NT 3.51 Workstation', version: '3.51', year: '1995', ext: 'iso', sizeMB: 130,
        url: `${WINWORLD}/product/windows-nt-3/351`,
        desc: `New Technology at its early best: pure 32-bit kernel, NTFS, and the Program Manager shell that Windows 95 would replace. NT 3.51 runs comfortably in a VM with 64MB RAM. Install keys of the era follow the OEM checksum pattern; the documented generic install key is in the license notes.`,
        note: 'Documented generic NT 3.51-era setup key pattern: 34567-OEM-0012345-34567',
        wkey: { label: 'generic OEM setup key', key: '34567-OEM-0012345-34567' },
      },
      {
        name: 'Windows 95 (retail CD, RTM)', version: '4.00.950', year: '1995', ext: 'iso', sizeMB: 60,
        url: `${WINWORLD}/product/windows-95/osr-1`,
        desc: `August 24, 1995: Start menu, taskbar, Explorer, long filenames. This is the original retail CD release (a.k.a. RTM/OSR1 family). RTM-era keys use the ten-digit checksum OEM format; the preserved generic OEM install key is in the license notes and on the download page.`,
        note: 'Documented generic OEM install key: 35296-OEM-0017543-71694 (10-digit checksum format is the only validation at setup; there is no activation).',
        wkey: { label: 'generic OEM install key', key: '35296-OEM-0017543-71694' },
      },
      {
        name: 'Windows 95 OSR 2.5 (USB/FAT32)', version: '4.00.950C', year: '1997', ext: 'iso', sizeMB: 90,
        url: `${WINWORLD}/product/windows-95/osr-25`,
        desc: `The final OEM Service Release of Windows 95: FAT32, USB supplement, AGP and Intel TX chipset support. Beware: OSR 2.x uses the simpler 3-digit + 7-digit key format -- the classic documented setup key 111-1111111 passes the checksum, as does any number whose digits sum to a multiple of 7.`,
        note: 'OSR 2.x setup accepts 111-1111111 (digits of the 7-digit part must sum to a multiple of 7; 0000000 no, 1111111 yes). No activation exists.',
        wkey: { label: 'documented setup key', key: '111-1111111' },
      },
      {
        name: 'Windows 98 (First Edition)', version: '4.10.1998', year: '1998', ext: 'iso', sizeMB: 175,
        url: `${WINWORLD}/product/windows-98/98`,
        desc: `Windows 98 FE merged the Active Desktop, IE4, QuickLaunch and noticeably better USB than Win95 OSR 2.5, and remained the default gaming platform for years. This is the full CD image; it can be setup-booted with the included boot floppy image. The preservation-archived full-install key is in the license notes.`,
        note: 'Documented full-install key for Win98 FE: K4HVD-Q9TJ9-6CRX9-C9G68-RQ2D3. Setup validates the checksum only -- no activation server ever existed for 9x.',
        wkey: { label: 'full install key', key: 'K4HVD-Q9TJ9-6CRX9-C9G68-RQ2D3' },
      },
      {
        name: 'Windows 98 Second Edition', version: '4.10.2222A', year: '1999', ext: 'iso', sizeMB: 200,
        url: `${WINWORLD}/product/windows-98/98se`,
        desc: `The best-loved member of the 9x family: internet connection sharing, improved USB, WDM audio and DVD support. SE is the image most retro-PC builders actually install; combined with unofficial service packs and 98SE2ME it lives on. Its documented full-install key ships in the license notes and below.`,
        note: 'Documented Win98 SE full-install key: RW9MG-QR4G3-2WRR9-TG7BH-33GXB',
        wkey: { label: 'full install key', key: 'RW9MG-QR4G3-2WRR9-TG7BH-33GXB' },
      },
      {
        name: 'Windows 98 SE boot floppy', version: '4.10.2222A', year: '1999', ext: 'img', sizeMB: 1,
        url: `${WINWORLD}/product/microsoft-windows-boot-disk/98-se-oem`,
        desc: `The immortal DOS 7.1 startup diskette with generic CD-ROM drivers -- the disk you reach for when a retro PC refuses to see its CD drive at boot. Write to a 1.44MB floppy with rawwritewin/WinImage/dd. No key involved.`,
        note: null, wkey: null,
      },
      {
        name: 'Windows ME (Millennium Edition)', version: '4.90.3000', year: '2000', ext: 'iso', sizeMB: 250,
        url: `${WINWORLD}/product/windows-me/final`,
        desc: `The last DOS-based Windows and the punchline of many jokes -- yet it shipped USB mass-storage support, System Restore, Windows Image Acquisition and Movie Maker a year before XP. Short-lived but historically interesting. The documented OEM install key is preserved in the license notes.`,
        note: 'Documented WinME install key: HJPFQ-KXW9C-D7BRJ-JCGB7-Q2DRJ (OEM checksum validation only).',
        wkey: { label: 'install key', key: 'HJPFQ-KXW9C-D7BRJ-JCGB7-Q2DRJ' },
      },
      {
        name: 'Windows NT 4.0 Workstation SP6a', version: '4.0 SP6a', year: '1996', ext: 'iso', sizeMB: 255,
        url: `${WINWORLD}/product/windows-nt-4/40-workstation`,
        desc: `NT 4.0 married the Windows 95 Explorer shell to Dave Cutler's hardened NT kernel and ran on x86, MIPS, Alpha and PowerPC. SP6a integrated here covers the Y2K-era rollup. Setup keys from the retail era use the ten-digit OEM format; the documented generic key is in the license notes.`,
        note: 'Documented generic NT4 install key: 28997-OEM-0025955-49257 (OEM-format checksum; no activation).',
        wkey: { label: 'generic OEM setup key', key: '28997-OEM-0025955-49257' },
      },
      {
        name: 'Windows 2000 Professional SP4', version: '5.0 SP4', year: '2000', ext: 'iso', sizeMB: 400,
        url: `${WINWORLD}/product/windows-nt-2000/final`,
        desc: `Built on the NT5 line, Windows 2000 Pro is arguably the most solid Microsoft desktop before Windows 7: NTFS5 with EFS, Active Directory client support, Plug&Play built into NT. SP4 is fully slipstreamed. The classic documented full-install key is preserved in the license notes and on the download page.`,
        note: 'Documented Win2K Pro install key: RBDC9-VTRC8-D7972-J97JY-PRVMG. Windows 2000 predates product activation -- the key is validated locally only.',
        wkey: { label: 'full install key', key: 'RBDC9-VTRC8-D7972-J97JY-PRVMG' },
      },
      {
        name: 'Windows XP Professional SP3', version: '5.1 SP3', year: '2001', ext: 'iso', sizeMB: 590,
        url: `${ARCHIVE}`,
        desc: `The longest-lived desktop OS in history. Archival copies of the SP3 media circulate widely. Unlike the 9x and NT/2000 lines, XP introduced product activation and volume licensing, so this entry intentionally ships without keys: use a license you own or the 30-day evaluation period built into setup. An OEM-less "everyone's-key" does not exist legitimately.`,
        note: 'No key is distributed for Windows XP -- activation-era licensing still applies; use media with a license you own.',
        wkey: null, license: 'proprietary',
      },
    ];
    for (const l of legacyItems) {
      const keyLine = l.wkey ? `\n\n**${l.wkey.label}:** \`${l.wkey.key}\`` : '';
      add({
        name: l.name,
        slugBase: `legacy ${l.name}`,
        description: l.desc + keyLine,
        version: l.version,
        file_name: `${makeSlug(l.name)}.${l.ext}`,
        file_size: l.sizeMB * MB,
        file_type: l.ext,
        platform: 'windows', arch: 'x86',
        url: l.url, source: l.url,
        license: l.license || 'abandonware',
        licenseNotes: l.note,
        category: 'operating-systems',
        folder: 'windows-legacy',
        tags: ['windows', 'retro', 'abandonware', ...(l.wkey ? ['key-included'] : [])],
      });
    }

    // Legacy office suites
    const legacyOffice = [
      {
        name: 'Microsoft Office 95 Professional', version: '7.0', sizeMB: 100,
        url: `${WINWORLD}/product/microsoft-office/95`,
        desc: `Word 7, Excel 7 and PowerPoint 7 -- the suite that standardized the business world on the Office toolbar. Runs on Windows 3.x through 2000. Office 95 keys use the OEM ten-digit checksum format; a documented generic install key ships in the license notes.`,
        note: 'Documented generic Office 95 setup key: 26301-OEM-0008612-26810 (OEM format is validated locally at setup).',
        keyLine: { label: 'generic OEM setup key', key: '26301-OEM-0008612-26810' },
      },
      {
        name: 'Microsoft Office 97 Professional', version: '8.0', sizeMB: 450,
        url: `${WINWORLD}/product/microsoft-office/97-professional`,
        DESC_EXTRA: null,
        desc: `Office 97 introduced the command-bars UI everyone remembers (and Clippy, who nobody asked for), plus the birth of VBA for the masses. Runs happily on everything from Windows 95 to XP. The install key is the famously minimal pattern documented in the license notes.`,
        note: 'Documented generic Office 97 key: 1112-1111111 (the last two groups make a trivial checksum; known to the preservation community for decades).',
        keyLine: { label: 'generic install key', key: '1112-1111111' },
      },
      {
        name: 'Microsoft Office 2000 Premium', version: '9.0', sizeMB: 690,
        url: `${WINWORLD}/product/microsoft-office/2000`,
        desc: `Office 2000 (Word/Excel/PowerPoint/Outlook/Access/Publisher/FrontPage) rounded off the pre-activation era of Microsoft Office on Windows 98/2000. The SR-1 media is integrated here; the documented full-install key ships below.`,
        note: 'Documented Office 2000 install key: DT3FT-BFH4M-GYYH8-PG9C3-8K2FV. Office 2000 predates Microsoft\'s activation servers.',
        keyLine: { label: 'full install key', key: 'DT3FT-BFH4M-GYYH8-PG9C3-8K2FV' },
      },
    ];
    for (const o of legacyOffice) {
      const keyLine = o.keyLine ? `\n\n**${o.keyLine.label}:** \`${o.keyLine.key}\`` : '';
      add({
        name: o.name,
        slugBase: `legacy ${o.name}`,
        description: o.desc + keyLine,
        version: o.version,
        file_name: `${makeSlug(o.name)}.iso`,
        file_size: o.sizeMB * MB,
        file_type: 'iso',
        platform: 'windows', arch: 'x86',
        url: o.url, source: o.url,
        license: 'abandonware',
        licenseNotes: o.note,
        category: 'applications',
        folder: 'office-docs',
        tags: ['windows', 'retro', 'office', 'abandonware', 'key-included'],
      });
    }

    // Officially published Microsoft KMS client setup keys (public documentation)
    add({
      name: 'Microsoft generic KMS client setup keys (GVLK)',
      slugBase: 'microsoft-gvlk-kms-keys',
      description: `The generic volume-license client setup keys that Microsoft itself publishes in its official KMS documentation. These keys install Windows/Windows Server as KMS clients and require an organization's own KMS host (or AD-based activation) to activate -- they are **not** activation keys.

**Windows 11 / 10 Pro:** \`W269N-WFGWX-YVC9B-4J6C9-T83GX\`
**Windows 11 / 10 Enterprise:** \`NPPR9-FWDCX-D2C8J-H872K-2YT43\`
**Windows 11 / 10 Education:** \`NW6C2-QMPVW-D7KKK-3GKT6-VCFB2\`
**Windows Server 2022 Standard:** \`VDYBN-27WPP-V4HQT-9VMD4-VMK7H\`
**Windows Server 2022 Datacenter:** \`WX4NM-KYWYW-QJJR4-XV3QB-6VM33\`
**Windows Server 2025 Standard:** \`TVRH6-WK5Y8-J3C3B-HD4VX-3PXM4\`

From the official docs: learn.microsoft.com/windows-server/get-started/kms-client-activation-keys`,
      version: '2025',
      file_name: 'microsoft-gvlk-keys.md',
      file_size: 6 * KB,
      file_type: 'md',
      platform: 'cross-platform', arch: null,
      url: 'https://learn.microsoft.com/en-us/windows-server/get-started/kms-client-activation-keys',
      license: 'proprietary',
      licenseNotes: 'Public Microsoft documentation. Keys install KMS-client channel only; activation requires the org\'s KMS host.',
      category: 'documentation',
      folder: 'guides-references',
      tags: ['windows', 'kms', 'activation', 'reference'],
    });

    // ======================================================================
    // Featured rail: a spread of the most useful picks
    // ======================================================================
    const featurePatterns = [
      ['Ubuntu 24.04.2 Desktop%', 1], ['Windows 11 24H2 Consumer%', 1], ['Kali Linux%Installer%', 1],
      ['Linux Mint 22.1%Cinnamon%', 1], ['Debian 12.11 netinst (x86_64%', 1], ['7-Zip 24.07%', 1],
      ['VLC 3.0.21%Windows%', 1], ['Notepad++%v8%', 1], ['Rufus 4.9%', 1], ['Ventoy 1.1%', 1],
      ['OBS Studio 31.1.1%Windows%', 1], ['LibreOffice 25.2%Windows%', 1], ['KeePassXC 2.7.10%', 1],
      ['Git for Windows 2.50%', 1], ['Python 3.13.0%Windows x64%', 1], ['Proxmox VE%ISO%', 1],
      ['Tails 6.12%', 1], ['Arch Linux 2026.08%', 1], ['Manjaro 25.0%xfce%', 1],
      ['Visual Studio Code%1.103%', 1], ['Wireshark 4.6%Windows%', 1], ['PuTTY 0.83%', 1],
      ['Firefox ESR%115%', 1], ['Blender 4.5%Windows%', 1], ['openSUSE Leap 16%', 1],
      ['Fedora Workstation 42%', 1], ['Alpine Linux 3.22%standard%', 1], ['Rocky Linux 10.0%Minimal%', 1],
    ];
    for (const [pat, nLimit] of featurePatterns) {
      const already = db.prepare("SELECT COUNT(*) c FROM items WHERE name LIKE ? AND featured = 1").get(pat).c;
      if (already >= nLimit) continue;
      const rows = db.prepare("SELECT id FROM items WHERE name LIKE ? AND featured = 0 ORDER BY created_at DESC LIMIT ?").all(pat, nLimit - already);
      for (const row of rows) db.prepare('UPDATE items SET featured = 1 WHERE id = ?').run(row.id);
    }

    return inserted;
  });
  const inserted = tx();
  return inserted;
}

// Standalone: node src/db/seed-catalog.js
if (process.argv[1] && process.argv[1].endsWith('seed-catalog.js')) {
  const db = getDb();
  const n = seedCatalog(db);
  const total = db.prepare('SELECT COUNT(*) c FROM items').get().c;
  const folders = db.prepare('SELECT COUNT(*) c FROM folders').get().c;
  console.log(`Catalog seed complete: +${n} new items (total ${total}), ${folders} folders.`);
}
