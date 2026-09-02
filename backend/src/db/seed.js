import { getDb } from './index.js';
import { DEFAULT_CATEGORIES } from './schema.js';
import { config } from '../config.js';
import { encryptionService } from '../services/encryptionService.js';
import { seedCatalog } from './seed-catalog.js';
import { seedModern } from './seed-modern.js';

const db = getDb();

console.log('Seeding database with encrypted storage...');

// Seed categories
const insertCat = db.prepare(`
  INSERT OR IGNORE INTO categories (name, slug, description, icon, color, sort_order)
  VALUES (@name, @slug, @description, @icon, @color, @sort_order)
`);

for (let i = 0; i < DEFAULT_CATEGORIES.length; i++) {
  const cat = DEFAULT_CATEGORIES[i];
  insertCat.run({ ...cat, sort_order: i });
}
console.log(`Seeded ${DEFAULT_CATEGORIES.length} categories`);

// Seed admin user with encrypted email and peppered password
const existingAdmin = db.prepare('SELECT id FROM users WHERE username = ?').get(config.security.adminUsername);
if (!existingAdmin) {
  const encryptedEmail = encryptionService.encrypt(config.security.adminEmail);
  const emailHash = encryptionService.hashEmail(config.security.adminEmail);
  const hash = await encryptionService.hashPasswordWithPepper(config.security.adminPassword);
  db.prepare(`
    INSERT INTO users (username, email, email_hash, password_hash, role, encryption_version)
    VALUES (?, ?, ?, ?, 'admin', 'v1')
  `).run(config.security.adminUsername, encryptedEmail, emailHash, hash);
  console.log(`Created admin user: ${config.security.adminUsername} with encrypted email and peppered password`);
  console.log(`  - Email encrypted: ${encryptedEmail.slice(0,30)}...`);
  console.log(`  - Email hash: ${emailHash.slice(0,20)}...`);
  console.log(`  - Password hash: ${hash.slice(0,30)}... (pepper_v1 + bcrypt)`);
} else {
  console.log('Admin user already exists, checking encryption...');
  // Upgrade existing admin to encrypted if needed
  const admin = db.prepare('SELECT * FROM users WHERE username = ?').get(config.security.adminUsername);
  if (admin && !admin.email.startsWith('enc_v1:')) {
    console.log('Upgrading admin email to encrypted...');
    const encEmail = encryptionService.encrypt(admin.email);
    const emailHash = encryptionService.hashEmail(config.security.adminEmail);
    db.prepare('UPDATE users SET email = ?, email_hash = ?, encryption_version = ? WHERE id = ?').run(encEmail, emailHash, 'v1', admin.id);
  }
  if (admin && !admin.password_hash.startsWith('pepper_v1:')) {
    console.log('Upgrading admin password to peppered...');
    const newHash = await encryptionService.hashPasswordWithPepper(config.security.adminPassword);
    db.prepare('UPDATE users SET password_hash = ?, encryption_version = ? WHERE id = ?').run(newHash, 'v1', admin.id);
  }
}

// Seed sample items if none exist - with encrypted sensitive fields
const itemCount = db.prepare('SELECT COUNT(*) as c FROM items').get().c;
if (itemCount === 0) {
  const catMap = {};
  for (const c of db.prepare('SELECT id, slug FROM categories').all()) {
    catMap[c.slug] = c.id;
  }

  const sampleItems = [
    {
      name: 'Ubuntu 24.04 LTS',
      slug: 'ubuntu-24-04-lts',
      description: 'Ubuntu 24.04 LTS Noble Numbat - Latest long-term support release',
      long_description: 'Ubuntu 24.04 LTS (Noble Numbat) is the latest long-term support release of Ubuntu. Includes GNOME 46, Linux kernel 6.8, and 5 years of support. Ideal for desktops, servers, and development.',
      category_id: catMap['operating-systems'],
      version: '24.04',
      release_date: '2024-04-25',
      file_name: 'ubuntu-24.04-desktop-amd64.iso',
      file_size: 4718592000,
      file_type: 'iso',
      platform: 'linux',
      architecture: 'x64',
      sha256: 'a4a2d9c8e8f6b7a5c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0',
      storage_provider: 'gdrive',
      storage_path: '1Ubuntu2404ExampleFileId',
      download_url: '',
      featured: 1,
      published: 1,
      license_status: 'public-domain',
      tags: JSON.stringify(['ubuntu', 'linux', 'lts', 'desktop']),
      icon_url: '',
      screenshots: JSON.stringify([]),
    },
    {
      name: 'Windows 11 24H2',
      slug: 'windows-11-24h2',
      description: 'Windows 11 Version 24H2 - Latest feature update',
      long_description: 'Windows 11 24H2 includes AI enhancements, improved File Explorer, and performance optimizations. Requires TPM 2.0 and Secure Boot.',
      category_id: catMap['operating-systems'],
      version: '24H2',
      release_date: '2024-10-01',
      file_name: 'Win11_24H2_English_x64.iso',
      file_size: 6657199309,
      file_type: 'iso',
      platform: 'windows',
      architecture: 'x64',
      sha256: 'b5c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0a4a2d9c8e8f6b7a5',
      storage_provider: 'onedrive',
      storage_path: '/ISOs/Windows11_24H2.iso',
      download_url: '',
      featured: 1,
      published: 1,
      license_status: 'proprietary',
      license_notes: 'Requires valid Windows license. For evaluation and recovery purposes.',
      tags: JSON.stringify(['windows', 'microsoft', '24h2']),
      icon_url: '',
      screenshots: JSON.stringify([]),
    },
    {
      name: 'Visual Studio Code',
      slug: 'vscode-1-92',
      description: 'Lightweight but powerful source code editor',
      long_description: 'VS Code is a free, open-source code editor with built-in Git, debugging, and extensions marketplace. Available for Windows, macOS, and Linux.',
      category_id: catMap['development'],
      version: '1.92.0',
      release_date: '2024-08-01',
      file_name: 'VSCodeSetup-x64-1.92.0.exe',
      file_size: 98123456,
      file_type: 'exe',
      platform: 'windows',
      architecture: 'x64',
      sha256: 'c1d0e9f8a7b6c5d4e3f2a1b0a4a2d9c8e8f6b7a5c3d2e1f0a9b8c7d6e5f4a3b2',
      storage_provider: 'gdrive',
      storage_path: '1VSCodeExampleId',
      download_url: '',
      featured: 1,
      published: 1,
      license_status: 'public-domain',
      tags: JSON.stringify(['vscode', 'editor', 'microsoft', 'development']),
      icon_url: '',
      screenshots: JSON.stringify([]),
    },
    {
      name: 'Debian 12.6',
      slug: 'debian-12-6',
      description: 'Debian Bookworm - Stable universal operating system',
      long_description: 'Debian 12.6 is a stable release with over 59000 packages. Known for stability and security. Perfect for servers and desktops.',
      category_id: catMap['isos'],
      version: '12.6',
      release_date: '2024-06-29',
      file_name: 'debian-12.6.0-amd64-netinst.iso',
      file_size: 658505728,
      file_type: 'iso',
      platform: 'linux',
      architecture: 'x64',
      sha256: 'd4e3f2a1b0a4a2d9c8e8f6b7a5c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5',
      storage_provider: 'gdrive',
      storage_path: '1Debian126Example',
      download_url: '',
      featured: 0,
      published: 1,
      license_status: 'public-domain',
      tags: JSON.stringify(['debian', 'linux', 'bookworm']),
      icon_url: '',
      screenshots: JSON.stringify([]),
    },
    {
      name: '7-Zip 24.07',
      slug: '7zip-24-07',
      description: 'File archiver with high compression ratio',
      long_description: '7-Zip is a free and open-source file archiver with high compression ratio. Supports 7z, ZIP, RAR, and many other formats.',
      category_id: catMap['utilities'],
      version: '24.07',
      release_date: '2024-06-19',
      file_name: '7z2407-x64.exe',
      file_size: 1572864,
      file_type: 'exe',
      platform: 'windows',
      architecture: 'x64',
      sha256: 'e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0a4a2d9c8e8f6b7a5c3d2e1f0a9b8c7d6',
      storage_provider: 'local',
      storage_path: '7z2407-x64.exe',
      download_url: 'https://www.7-zip.org/a/7z2407-x64.exe',
      featured: 0,
      published: 1,
      license_status: 'public-domain',
      tags: JSON.stringify(['archiver', 'compression', 'utility']),
      icon_url: '',
      screenshots: JSON.stringify([]),
    },
    {
      name: 'Python 3.12.4',
      slug: 'python-3-12-4',
      description: 'Python programming language - latest stable',
      long_description: 'Python 3.12 includes performance improvements, new type system features, and enhanced error messages.',
      category_id: catMap['development'],
      version: '3.12.4',
      release_date: '2024-06-06',
      file_name: 'python-3.12.4-amd64.exe',
      file_size: 24883200,
      file_type: 'exe',
      platform: 'windows',
      architecture: 'x64',
      sha256: 'f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0a4a2d9c8e8f6b7a5c3d2e1f0a9b8c7d6e5',
      storage_provider: 'external',
      storage_path: '',
      download_url: 'https://www.python.org/ftp/python/3.12.4/python-3.12.4-amd64.exe',
      featured: 1,
      published: 1,
      license_status: 'public-domain',
      tags: JSON.stringify(['python', 'programming', 'interpreter']),
      icon_url: '',
      screenshots: JSON.stringify([]),
    },
    {
      name: 'Arch Linux 2024.08',
      slug: 'arch-linux-2024-08',
      description: 'Lightweight and flexible Linux distribution',
      long_description: 'Arch Linux is an independently developed, x86-64 general-purpose GNU/Linux distribution that strives to provide the latest stable versions of most software.',
      category_id: catMap['operating-systems'],
      version: '2024.08.01',
      release_date: '2024-08-01',
      file_name: 'archlinux-2024.08.01-x86_64.iso',
      file_size: 1180000000,
      file_type: 'iso',
      platform: 'linux',
      architecture: 'x64',
      sha256: 'a3b2c1d0e9f8a7b6c5d4e3f2a1b0a4a2d9c8e8f6b7a5c3d2e1f0a9b8c7d6e5f4',
      storage_provider: 'gdrive',
      storage_path: '1ArchLinux202408',
      download_url: '',
      featured: 0,
      published: 1,
      license_status: 'public-domain',
      tags: JSON.stringify(['arch', 'linux', 'rolling']),
      icon_url: '',
      screenshots: JSON.stringify([]),
    },
    {
      name: 'Git Documentation Bundle',
      slug: 'git-docs-bundle',
      description: 'Complete Git documentation and cheat sheets',
      long_description: 'Comprehensive Git documentation including Pro Git book, cheat sheets, and workflow guides.',
      category_id: catMap['documentation'],
      version: '2.45',
      release_date: '2024-06-15',
      file_name: 'git-documentation-2.45.zip',
      file_size: 15600000,
      file_type: 'zip',
      platform: 'cross-platform',
      architecture: 'universal',
      sha256: 'b2c1d0e9f8a7b6c5d4e3f2a1b0a4a2d9c8e8f6b7a5c3d2e1f0a9b8c7d6e5f4a3',
      storage_provider: 'local',
      storage_path: 'git-docs.zip',
      download_url: '',
      featured: 0,
      published: 1,
      license_status: 'public-domain',
      tags: JSON.stringify(['git', 'documentation', 'vcs']),
      icon_url: '',
      screenshots: JSON.stringify([]),
    },
  ];

  const insertItem = db.prepare(`
    INSERT INTO items (
      name, slug, description, long_description, category_id, version, release_date,
      file_name, file_size, file_type, platform, architecture, sha256,
      storage_provider, storage_path, download_url, featured, published,
      license_status, license_notes, tags, icon_url, screenshots, encryption_version
    ) VALUES (
      @name, @slug, @description, @long_description, @category_id, @version, @release_date,
      @file_name, @file_size, @file_type, @platform, @architecture, @sha256,
      @storage_provider, @storage_path, @download_url, @featured, @published,
      @license_status, @license_notes, @tags, @icon_url, @screenshots, @encryption_version
    )
  `);

  for (const item of sampleItems) {
    if (!('license_notes' in item)) item.license_notes = null;
    
    // Encrypt sensitive fields
    const encStoragePath = item.storage_path ? encryptionService.encrypt(item.storage_path) : null;
    const encDownloadUrl = item.download_url ? encryptionService.encrypt(item.download_url) : null;
    const encLicenseNotes = item.license_notes ? encryptionService.encrypt(item.license_notes) : null;

    insertItem.run({
      ...item,
      storage_path: encStoragePath,
      download_url: encDownloadUrl,
      license_notes: encLicenseNotes,
      encryption_version: 'v1',
    });
  }
  console.log(`Seeded ${sampleItems.length} sample items with encrypted sensitive fields`);
  console.log(`  - storage_path encrypted with AES-256-GCM`);
  console.log(`  - download_url encrypted with AES-256-GCM`);
  console.log(`  - license_notes encrypted`);

  // Seed FAQ
  const faqSamples = [
    {
      question: 'Which Ubuntu ISO should I download for an Intel PC?',
      answer: 'For Intel/AMD 64-bit PCs, download the x64 (amd64) version. Ubuntu 24.04 LTS is recommended for most users. Check the Operating Systems category and filter by x64 architecture.',
      category: 'os-selection'
    },
    {
      question: 'What is the difference between x86 and x64?',
      answer: 'x86 refers to 32-bit architecture, x64 (also called amd64 or x86_64) is 64-bit and supports more RAM and better performance. Most modern PCs use x64. ARM64 is for ARM-based devices like Apple Silicon or Raspberry Pi.',
      category: 'architecture'
    },
    {
      question: 'How do I verify file integrity?',
      answer: 'Use the SHA-256 checksum provided on each item page. On Windows use certutil -hashfile, on Linux/macOS use sha256sum. Compare the result with the checksum shown.',
      category: 'verification'
    },
  ];

  const insertFaq = db.prepare(`INSERT INTO faq_entries (question, answer, category) VALUES (@question, @answer, @category)`);
  for (const faq of faqSamples) {
    insertFaq.run(faq);
  }
  console.log(`Seeded ${faqSamples.length} FAQ entries`);
}

// Full software catalog (2000+ items across Windows and Linux, sorted into folders)
const added = seedCatalog(db);
console.log(`Catalog: +${added} new items (${db.prepare('SELECT COUNT(*) c FROM items').get().c} total)`);

// Modern wave: AI tooling, current editors/toolchains, release archives
const addedModern = seedModern(db);
console.log(`Modern catalog: +${addedModern} new items (${db.prepare('SELECT COUNT(*) c FROM items').get().c} total)`);

console.log('Seeding completed with encryption.');
