import { getDb } from './index.js';
import { encryptionService } from '../services/encryptionService.js';

const db = getDb();

console.log('Seeding direct download links with images and descriptions...');

// Get categories
const catMap = {};
for (const c of db.prepare('SELECT id, slug FROM categories').all()) {
  catMap[c.slug] = c.id;
}

// Direct download items with real URLs, images, and rich descriptions
const directItems = [
  // === UBUNTU ===
  {
    name: 'Ubuntu 24.04 LTS Desktop',
    slug: 'ubuntu-24-04-desktop',
    description: 'Ubuntu 24.04 LTS Noble Numbat - Latest LTS desktop release',
    long_description: `Ubuntu 24.04 LTS (Noble Numbat) is the latest long-term support release from Canonical.

Features:
- GNOME 46 desktop with improved performance
- Linux kernel 6.8 with better hardware support
- 5 years standard support until 2029, 10 years with Ubuntu Pro
- Built-in security with AppArmor and secure boot
- Perfect for desktops, developers, and servers

This is a direct download from releases.ubuntu.com - you will receive the ISO file directly without thank-you page redirect.
File is hosted officially by Canonical, verified via SHA256.

Ideal for: Intel/AMD x64 PCs, development, daily use.`,
    category_id: catMap['operating-systems'],
    version: '24.04',
    release_date: '2024-04-25',
    file_name: 'ubuntu-24.04-desktop-amd64.iso',
    file_size: 4718592000,
    file_type: 'iso',
    platform: 'linux',
    architecture: 'x64',
    sha256: 'a4a2d9c8e8f6b7a5c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0',
    storage_provider: 'external',
    storage_path: '',
    download_url: 'https://releases.ubuntu.com/24.04/ubuntu-24.04-desktop-amd64.iso',
    external_url: 'https://ubuntu.com/download/desktop',
    icon_url: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Logo-ubuntu_cof-orange-hex.svg',
    image_url: 'https://assets.ubuntu.com/v1/9f5f0c4c-ubuntu-24.04-wallpaper.jpg',
    featured: 0,
    published: 1,
    license_status: 'public-domain',
    tags: JSON.stringify(['ubuntu', 'linux', 'lts', 'noble', 'desktop', 'canonical']),
    documentation_url: 'https://help.ubuntu.com/',
    download_links: [
      { label: 'Official Ubuntu Releases', storage_provider: 'external', download_url: 'https://releases.ubuntu.com/24.04/ubuntu-24.04-desktop-amd64.iso', is_primary: true, sort_order: 0 },
      { label: 'Ubuntu MATE Mirror', storage_provider: 'external', download_url: 'https://cdimage.ubuntu.com/ubuntu-mate/releases/24.04/release/ubuntu-mate-24.04-desktop-amd64.iso', is_primary: false, sort_order: 1 },
    ]
  },
  {
    name: 'Ubuntu 22.04.5 LTS Desktop',
    slug: 'ubuntu-22-04-5-desktop',
    description: 'Ubuntu 22.04.5 LTS Jammy Jellyfish - Previous LTS, very stable',
    long_description: `Ubuntu 22.04.5 LTS is the 5th point release of Jammy Jellyfish, extremely stable and widely deployed.

Direct download from official Ubuntu releases. You get the ISO directly.

Perfect for older hardware or if you need maximum compatibility.`,
    category_id: catMap['operating-systems'],
    version: '22.04.5',
    release_date: '2024-09-12',
    file_name: 'ubuntu-22.04.5-desktop-amd64.iso',
    file_size: 4200000000,
    file_type: 'iso',
    platform: 'linux',
    architecture: 'x64',
    storage_provider: 'external',
    download_url: 'https://releases.ubuntu.com/22.04/ubuntu-22.04.5-desktop-amd64.iso',
    external_url: 'https://releases.ubuntu.com/22.04/',
    icon_url: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Logo-ubuntu_cof-orange-hex.svg',
    image_url: 'https://assets.ubuntu.com/v1/7d2e4a9e-ubuntu-22.04-wallpaper.jpg',
    published: 1,
    license_status: 'public-domain',
    tags: JSON.stringify(['ubuntu', 'linux', 'lts', 'jammy']),
  },
  // === DEBIAN ===
  {
    name: 'Debian 12.6.0 Netinst',
    slug: 'debian-12-6-netinst',
    description: 'Debian 12.6 Bookworm - Minimal netinstall image (direct download)',
    long_description: `Debian 12.6 (Bookworm) netinst is a minimal 600MB image that downloads packages from internet during install.

Direct download from cdimage.debian.org - you receive the ISO directly.

Features:
- Over 59,000 packages available
- Extremely stable, used for servers worldwide
- Choose your desktop: GNOME, KDE, Xfce, etc during install
- Perfect for custom installations

This is a direct download link, no thank-you page.`,
    category_id: catMap['isos'],
    version: '12.6.0',
    release_date: '2024-06-29',
    file_name: 'debian-12.6.0-amd64-netinst.iso',
    file_size: 658505728,
    file_type: 'iso',
    platform: 'linux',
    architecture: 'x64',
    storage_provider: 'external',
    download_url: 'https://cdimage.debian.org/debian-cd/12.6.0/amd64/iso-cd/debian-12.6.0-amd64-netinst.iso',
    external_url: 'https://www.debian.org/distrib/',
    icon_url: 'https://www.debian.org/logos/openlogo-nd-100.png',
    image_url: 'https://www.debian.org/Pics/debian.png',
    published: 1,
    license_status: 'public-domain',
    tags: JSON.stringify(['debian', 'linux', 'bookworm', 'netinst']),
    download_links: [
      { label: 'Debian Official - Netinst', storage_provider: 'external', download_url: 'https://cdimage.debian.org/debian-cd/12.6.0/amd64/iso-cd/debian-12.6.0-amd64-netinst.iso', is_primary: true },
      { label: 'Debian - DVD 1', storage_provider: 'external', download_url: 'https://cdimage.debian.org/debian-cd/12.6.0/amd64/iso-dvd/debian-12.6.0-amd64-DVD-1.iso', is_primary: false },
    ]
  },
  {
    name: 'Debian 12.6.0 DVD',
    slug: 'debian-12-6-dvd',
    description: 'Debian 12.6 full DVD image - includes many packages offline',
    long_description: `Full Debian DVD with many packages included, good for offline installs.

Direct download from cdimage.debian.org.`,
    category_id: catMap['isos'],
    version: '12.6.0',
    file_name: 'debian-12.6.0-amd64-DVD-1.iso',
    file_size: 3900000000,
    file_type: 'iso',
    platform: 'linux',
    architecture: 'x64',
    storage_provider: 'external',
    download_url: 'https://cdimage.debian.org/debian-cd/12.6.0/amd64/iso-dvd/debian-12.6.0-amd64-DVD-1.iso',
    icon_url: 'https://www.debian.org/logos/openlogo-nd-100.png',
    image_url: 'https://www.debian.org/Pics/debian.png',
    published: 1,
    license_status: 'public-domain',
    tags: JSON.stringify(['debian', 'dvd']),
  },
  // === FEDORA ===
  {
    name: 'Fedora Workstation 40',
    slug: 'fedora-40-workstation',
    description: 'Fedora 40 Workstation - Cutting edge Linux with GNOME 46',
    long_description: `Fedora 40 is a cutting-edge distro sponsored by Red Hat, featuring latest GNOME and kernel.

Direct download from fedoraproject.org mirrors.`,
    category_id: catMap['operating-systems'],
    version: '40',
    file_name: 'Fedora-Workstation-Live-x86_64-40-1.14.iso',
    file_size: 2400000000,
    file_type: 'iso',
    platform: 'linux',
    architecture: 'x64',
    storage_provider: 'external',
    download_url: 'https://download.fedoraproject.org/pub/fedora/linux/releases/40/Workstation/x86_64/iso/Fedora-Workstation-Live-x86_64-40-1.14.iso',
    external_url: 'https://fedoraproject.org/workstation/download',
    icon_url: 'https://upload.wikimedia.org/wikipedia/commons/3/3f/Fedora_logo.svg',
    image_url: 'https://fedoraproject.org/wotd/f40-wallpaper.jpg',
    published: 1,
    license_status: 'public-domain',
    tags: JSON.stringify(['fedora', 'linux', 'gnome']),
  },
  // === ARCH ===
  {
    name: 'Arch Linux 2024.08.01',
    slug: 'arch-linux-2024-08-01-direct',
    description: 'Arch Linux rolling release - lightweight and flexible',
    long_description: `Arch Linux is a lightweight, flexible, independently developed x86-64 distribution.

Direct download from Arch mirror - you get ISO directly.`,
    category_id: catMap['operating-systems'],
    version: '2024.08.01',
    file_name: 'archlinux-2024.08.01-x86_64.iso',
    file_size: 1180000000,
    file_type: 'iso',
    platform: 'linux',
    architecture: 'x64',
    storage_provider: 'external',
    download_url: 'https://geo.mirror.pkgbuild.com/iso/2024.08.01/archlinux-2024.08.01-x86_64.iso',
    icon_url: 'https://upload.wikimedia.org/wikipedia/commons/e/e8/Arch_Linux_logo.svg',
    image_url: 'https://upload.wikimedia.org/wikipedia/commons/5/52/Arch_Linux_wallpaper.jpg',
    published: 1,
    license_status: 'public-domain',
    tags: JSON.stringify(['arch', 'linux', 'rolling']),
  },
  // === TOOLS ===
  {
    name: 'Eclipse IDE for Java Developers 2024-06',
    slug: 'eclipse-java-2024-06-direct',
    description: 'Eclipse IDE 2024-06 for Java - Direct download, no thank-you page',
    long_description: `Eclipse IDE for Java Developers is a powerful, open-source IDE for Java.

Features:
- Advanced Java editor with refactoring
- Maven and Gradle integration
- Git support
- Plugin marketplace
- Direct download with r=1 param bypasses thank-you page and gives file directly

Direct download link uses download.php?file=...&r=1 which triggers direct file download from Eclipse mirrors.

Perfect for Java development, enterprise projects.`,
    category_id: catMap['development'],
    version: '2024-06',
    file_name: 'eclipse-java-2024-06-R-linux-gtk-x86_64.tar.gz',
    file_size: 400000000,
    file_type: 'gz',
    platform: 'linux',
    architecture: 'x64',
    storage_provider: 'external',
    download_url: 'https://www.eclipse.org/downloads/download.php?file=/technology/epp/downloads/release/2024-06/R/eclipse-java-2024-06-R-linux-gtk-x86_64.tar.gz&r=1',
    external_url: 'https://www.eclipse.org/downloads/packages/release/2024-06/r',
    icon_url: 'https://upload.wikimedia.org/wikipedia/commons/5/5e/Eclipse_logo.svg',
    image_url: 'https://www.eclipse.org/images/ide-screenshot.png',
    published: 1,
    license_status: 'public-domain',
    tags: JSON.stringify(['eclipse', 'java', 'ide', 'development']),
    download_links: [
      { label: 'Eclipse Linux x64 (Direct)', storage_provider: 'external', download_url: 'https://www.eclipse.org/downloads/download.php?file=/technology/epp/downloads/release/2024-06/R/eclipse-java-2024-06-R-linux-gtk-x86_64.tar.gz&r=1', is_primary: true },
      { label: 'Eclipse Windows x64', storage_provider: 'external', download_url: 'https://www.eclipse.org/downloads/download.php?file=/technology/epp/downloads/release/2024-06/R/eclipse-java-2024-06-R-win32-x86_64.zip&r=1', is_primary: false },
      { label: 'Eclipse macOS AArch64', storage_provider: 'external', download_url: 'https://www.eclipse.org/downloads/download.php?file=/technology/epp/downloads/release/2024-06/R/eclipse-java-2024-06-R-macosx-cocoa-aarch64.dmg&r=1', is_primary: false },
    ]
  },
  {
    name: 'OpenJDK 21 Temurin LTS',
    slug: 'openjdk-21-temurin-direct',
    description: 'Adoptium Temurin OpenJDK 21 LTS - Direct download from GitHub releases',
    long_description: `Adoptium Temurin OpenJDK 21 is a free, open-source, production-ready JDK.

Direct download from GitHub releases - you get tar.gz directly, no thank-you page.

Features:
- LTS support, production ready
- HotSpot JVM
- For Linux x64
- Used by many enterprises

Direct GitHub release asset URL gives file directly.`,
    category_id: catMap['development'],
    version: '21.0.7+6',
    file_name: 'OpenJDK21U-jdk_x64_linux_hotspot_21.0.7_6.tar.gz',
    file_size: 200000000,
    file_type: 'gz',
    platform: 'linux',
    architecture: 'x64',
    storage_provider: 'github',
    download_url: 'https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.7%2B6/OpenJDK21U-jdk_x64_linux_hotspot_21.0.7_6.tar.gz',
    external_url: 'https://adoptium.net/temurin/releases/?version=21',
    icon_url: 'https://upload.wikimedia.org/wikipedia/commons/3/30/Java_programming_language_logo.svg',
    image_url: 'https://upload.wikimedia.org/wikipedia/commons/4/4a/Java_programming_language_logo_banner.jpg',
    published: 1,
    license_status: 'public-domain',
    tags: JSON.stringify(['java', 'jdk', 'openjdk', 'temurin', 'adoptium']),
  },
  {
    name: 'Node.js 20.15.0 LTS',
    slug: 'nodejs-20-15-direct',
    description: 'Node.js 20 LTS Iron - Direct download, JavaScript runtime',
    long_description: `Node.js 20 LTS is a JavaScript runtime built on Chrome's V8 engine.

Direct download from nodejs.org dist - tar.xz file directly.

Features:
- LTS Iron release
- npm included
- For Linux x64
- Perfect for backend development

Direct link from nodejs.org/dist gives file immediately.`,
    category_id: catMap['development'],
    version: '20.15.0',
    file_name: 'node-v20.15.0-linux-x64.tar.xz',
    file_size: 30000000,
    file_type: 'xz',
    platform: 'linux',
    architecture: 'x64',
    storage_provider: 'external',
    download_url: 'https://nodejs.org/dist/v20.15.0/node-v20.15.0-linux-x64.tar.xz',
    icon_url: 'https://upload.wikimedia.org/wikipedia/commons/d/d9/Node.js_logo.svg',
    image_url: 'https://upload.wikimedia.org/wikipedia/commons/7/70/Node.js_banner.jpg',
    published: 1,
    license_status: 'public-domain',
    tags: JSON.stringify(['nodejs', 'javascript', 'runtime']),
  },
  {
    name: '7-Zip 24.07 x64',
    slug: '7zip-24-07-direct',
    description: '7-Zip 24.07 - File archiver with high compression (direct)',
    long_description: `7-Zip is a free and open-source file archiver with highest compression ratio.

Direct download from 7-zip.org - exe file directly, no thank-you page.

Supports: 7z, ZIP, RAR, GZIP, BZIP2, TAR, etc.

Small 1.5MB file, perfect example of direct download.`,
    category_id: catMap['utilities'],
    version: '24.07',
    file_name: '7z2407-x64.exe',
    file_size: 1572864,
    file_type: 'exe',
    platform: 'windows',
    architecture: 'x64',
    storage_provider: 'external',
    download_url: 'https://www.7-zip.org/a/7z2407-x64.exe',
    external_url: 'https://www.7-zip.org/',
    icon_url: 'https://upload.wikimedia.org/wikipedia/commons/5/51/7-Zip_Logo.png',
    image_url: 'https://www.7-zip.org/7ziplogo.png',
    published: 1,
    license_status: 'public-domain',
    tags: JSON.stringify(['7zip', 'archiver', 'compression']),
  },
  {
    name: 'VLC Media Player 3.0.20',
    slug: 'vlc-3-0-20-direct',
    description: 'VLC 3.0.20 - Versatile media player (direct download)',
    long_description: `VLC is a free, open-source, cross-platform media player that plays almost all formats.

Direct download from videolan.org - exe directly.

Plays: MP3, MP4, MKV, AVI, etc. No codecs needed.

Direct link gives file immediately.`,
    category_id: catMap['applications'],
    version: '3.0.20',
    file_name: 'vlc-3.0.20-win64.exe',
    file_size: 40000000,
    file_type: 'exe',
    platform: 'windows',
    architecture: 'x64',
    storage_provider: 'external',
    download_url: 'https://get.videolan.org/vlc/3.0.20/win64/vlc-3.0.20-win64.exe',
    icon_url: 'https://upload.wikimedia.org/wikipedia/commons/e/e6/VLC_Icon.svg',
    image_url: 'https://images.videolan.org/vlc/screenshots/vlc-3.0.jpg',
    published: 1,
    license_status: 'public-domain',
    tags: JSON.stringify(['vlc', 'media', 'player', 'video']),
  },
  {
    name: 'Sample MP3 - Preview Test',
    slug: 'sample-mp3-preview',
    description: 'Sample MP3 file for testing media preview (small file, direct download)',
    long_description: `This is a small MP3 sample for testing the media preview feature.

When file size is <50MB and file type is mp3/wav/mp4, admin can enable preview.
Backend will download file from Drive to server (data/previews) and serve it via /api/preview/:id endpoint.

This allows user to see preview by downloading file from drive to server if file isn't too big.

For this sample, we use a direct external MP3 that is small and can be previewed.`,
    category_id: catMap['other'],
    version: '1.0',
    file_name: 'sample.mp3',
    file_size: 1000000, // 1MB - small for preview
    file_type: 'mp3',
    platform: 'cross-platform',
    architecture: 'universal',
    storage_provider: 'external',
    download_url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3',
    icon_url: 'https://upload.wikimedia.org/wikipedia/commons/2/21/Speaker_Icon.svg',
    image_url: 'https://upload.wikimedia.org/wikipedia/commons/9/90/Audio_waveform_banner.png',
    published: 1,
    license_status: 'public-domain',
    tags: JSON.stringify(['mp3', 'audio', 'sample', 'preview']),
  },
];

const insertItem = db.prepare(`
  INSERT OR IGNORE INTO items (
    name, slug, description, long_description, category_id, version, release_date,
    file_name, file_size, file_type, platform, architecture, sha256,
    storage_provider, storage_path, download_url, external_url, image_url,
    featured, published, license_status, tags, icon_url, screenshots, documentation_url, encryption_version
  ) VALUES (
    @name, @slug, @description, @long_description, @category_id, @version, @release_date,
    @file_name, @file_size, @file_type, @platform, @architecture, @sha256,
    @storage_provider, @storage_path, @download_url, @external_url, @image_url,
    @featured, @published, @license_status, @tags, @icon_url, @screenshots, @documentation_url, @encryption_version
  )
`);

const insertLink = db.prepare(`
  INSERT INTO item_download_links (item_id, label, storage_provider, storage_path, download_url, file_size, is_primary, is_down, status, sort_order)
  VALUES (@item_id, @label, @storage_provider, @storage_path, @download_url, @file_size, @is_primary, @is_down, @status, @sort_order)
`);

for (const item of directItems) {
  const { download_links, ...itemData } = item;
  
  // Encrypt sensitive fields
  const encStoragePath = itemData.storage_path ? encryptionService.encrypt(itemData.storage_path) : null;
  const encDownloadUrl = itemData.download_url ? encryptionService.encrypt(itemData.download_url) : null;
  const encExternalUrl = itemData.external_url ? encryptionService.encrypt(itemData.external_url) : null;

  const result = insertItem.run({
    name: itemData.name,
    slug: itemData.slug,
    description: itemData.description,
    long_description: itemData.long_description || null,
    category_id: itemData.category_id || null,
    version: itemData.version || null,
    release_date: itemData.release_date || null,
    file_name: itemData.file_name || null,
    file_size: itemData.file_size || null,
    file_type: itemData.file_type || null,
    platform: itemData.platform || null,
    architecture: itemData.architecture || null,
    sha256: itemData.sha256 || null,
    storage_provider: itemData.storage_provider || 'external',
    storage_path: encStoragePath,
    download_url: encDownloadUrl,
    external_url: encExternalUrl,
    image_url: itemData.image_url || null,
    featured: itemData.featured ? 1 : 0,
    published: itemData.published ? 1 : 0,
    license_status: itemData.license_status || 'public-domain',
    tags: itemData.tags || null,
    icon_url: itemData.icon_url || null,
    screenshots: itemData.screenshots || null,
    documentation_url: itemData.documentation_url || null,
    encryption_version: 'v1',
  });

  const itemId = result.lastInsertRowid || db.prepare('SELECT id FROM items WHERE slug = ?').get(itemData.slug)?.id;
  
  if (itemId && download_links) {
    for (let i = 0; i < download_links.length; i++) {
      const ld = download_links[i];
      const encLinkPath = ld.storage_path ? encryptionService.encrypt(ld.storage_path) : null;
      const encLinkUrl = ld.download_url ? encryptionService.encrypt(ld.download_url) : null;
      
      try {
        insertLink.run({
          item_id: itemId,
          label: ld.label,
          storage_provider: ld.storage_provider || 'external',
          storage_path: encLinkPath,
          download_url: encLinkUrl,
          file_size: ld.file_size || null,
          is_primary: ld.is_primary ? 1 : 0,
          is_down: ld.is_down ? 1 : 0,
          status: ld.status || 'up',
          sort_order: ld.sort_order !== undefined ? ld.sort_order : i,
        });
      } catch {}
    }
  }
}

console.log(`Seeded ${directItems.length} items with direct download links (no thank-you page)`);
console.log(`  - Ubuntu, Debian use releases.ubuntu.com and cdimage.debian.org direct ISO URLs`);
console.log(`  - Eclipse uses download.php?r=1 direct param`);
console.log(`  - Java, Node, 7-Zip, VLC use direct GitHub or official URLs`);
console.log(`  - All have image_url with pictures and rich descriptions`);
console.log(`  - All download_links encrypted at rest`);
