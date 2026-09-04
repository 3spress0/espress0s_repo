# espress0's repo

A lightweight, self-hosted software catalogue for applications, operating systems, ISOs, tools, drivers, documents, and other downloadable resources.

Built with **Fastify**, **SQLite + FTS5**, and **React**. The application stores catalogue metadata and external download links rather than acting as a file mirror.

## What it does

espress0's repo gives you a searchable catalogue with:

* Software, ISO, tool, driver, document, and archive entries
* Fast full-text search powered by SQLite FTS5
* Categories, folders, tags, platforms, architectures, and versions
* Markdown descriptions and cover images
* Multiple download/mirror links per item
* Checksums and file metadata
* Version history with diffs and restore
* Personal favourites, private by default and shareable per file
* Public account profiles showing what someone chose to share
* Link-health monitoring
* Admin management and bulk operations
* Backup, restore, import, and export
* Optional AI-assisted metadata and description generation
* Dark and light themes

The application is designed to run on small machines, including old PCs, Raspberry Pis, and small virtual machines. It uses a single Node.js application and SQLite database rather than requiring a large service stack.

## Quick start

Requirements:

* Node.js 20+
* npm

Clone the repository:

```bash
git clone https://github.com/3spress0/espress0s_repo.git
cd espress0s_repo
```

Run the setup wizard:

```bash
./espress0 setup
```

The wizard configures the application, database, administrator account, optional AI integration, and runtime settings.

Start the application:

```bash
./espress0 serve
```

Check its status:

```bash
./espress0 status
```

## The `espress0` CLI

The repository uses `./espress0` as the main command-line entry point.

| Command             | Purpose                               |
| ------------------- | ------------------------------------- |
| `./espress0 setup`  | Initial setup                         |
| `./espress0 config` | Change configuration                  |
| `./espress0 dev`    | Development mode                      |
| `./espress0 serve`  | Run the application in the background |
| `./espress0 update` | Update the installation               |
| `./espress0 deploy` | Deploy to an Ubuntu server            |
| `./espress0 backup` | Create backups                        |
| `./espress0 db`     | Database utilities                    |
| `./espress0 ai`     | AI configuration/utilities            |
| `./espress0 scan`   | Security scanning                     |
| `./espress0 test`   | Run tests                             |
| `./espress0 status` | Show application status               |

Run:

```bash
./espress0 help
```

for the complete command list.

## Catalogue

Each catalogue entry can contain information such as:

* Name and version
* Stable slug
* Category and folder
* Description
* Release date
* File name and size
* Platform and architecture
* Tags
* Checksums
* License information
* External download links
* Related versions
* Icon and banner URLs

The catalogue is intended to describe software and resources, not to become a general-purpose file-hosting service.

## Search

Search uses **SQLite FTS5** for fast full-text queries.

Catalogue entries can be filtered and sorted by metadata such as category, folder, tags, platform, architecture, date, size, downloads, and views.

## Link health

External download and mirror links can be checked automatically.

The health system supports:

* Per-link status
* Manual checks
* Periodic checks
* Redirect handling
* Timeout handling
* SSRF protection
* Administrative "mark down" controls

Health checks run separately from normal catalogue browsing so an unavailable external server does not unnecessarily block the application.

## Accounts and favourites

### Two-factor authentication

Any account can add a TOTP second factor from **Account → Security**: scan the QR code with an authenticator app (Aegis, 1Password, Google Authenticator, …), confirm one code, and save the ten single-use recovery codes that are shown once. From then on the login form asks for a code after the password. Turning it off again needs the password *and* a current code.

Admins can make it mandatory for admin accounts with **Site Settings → Require two-factor auth for admins**: an admin who has not enrolled can only reach their Account page until they do. Codes accept ±30 s of clock drift and a code is never accepted twice. Secrets are encrypted at rest; recovery codes are stored hashed.

Every signed-in account can star a file from its page. Favourites are **private by default**: starring is a personal bookmark, not a publication.

Sharing is a second, deliberate step, and it can be taken two ways:

* per file — flip a single favourite to *Shared* in **Account → Favourites**
* by default — tick *New favourites start shared* so future stars begin public

Turning the default off never un-shares anything you already published; each favourite keeps the setting you gave it.

Anything shared shows on a public profile at `/u/username`, which anyone can open without logging in. It lists the account's avatar, bio, role, join date and shared files — and nothing else:

* no email address is ever returned by the profile endpoint
* only favourites flagged shared by their owner appear
* drafts never appear, so a shared favourite is not a back door into an unpublished file
* only card-level data is returned, so no mirror URL or storage path leaves with it

Admins can open any account's public profile straight from **Admin → Users**.

The API:

| Method   | Route                                | Purpose                                  |
| -------- | ------------------------------------ | ---------------------------------------- |
| `GET`    | `/api/favorites`                     | Your own list, private and shared         |
| `POST`   | `/api/favorites`                     | Star a file (`item_id` or `slug`)         |
| `PATCH`  | `/api/favorites/:itemId`             | Share or unshare one favourite            |
| `DELETE` | `/api/favorites/:itemId`             | Unstar                                    |
| `GET`    | `/api/users/:username`               | Public profile                            |
| `GET`    | `/api/users/:username/favorites`     | The favourites that account shared        |

Favourites belong to the database rather than the catalogue, so a full snapshot restore rolls them back with everything else, while a catalogue-only rollback keeps them — an undo after a bad bulk edit does not cost everyone their stars.

## Import and export

The catalogue supports backup and metadata import/export workflows.

Imports support:

* Dry-run validation
* Upsert by slug
* Existing-entry updates
* Validation errors and warnings
* Safe processing of untrusted input

Backups can be used to restore catalogue data when necessary.

## Administration

The admin interface provides management for:

* Catalogue entries
* Categories
* Folders
* Users
* Settings
* Storage configuration
* Monitoring
* AI configuration

Version history is available for catalogue pages, including snapshots, diffs, and restore operations.

### Roles

Every account has one of three roles, set from **Admin → Users**:

| Role | Can |
| --- | --- |
| `viewer` | Sign in, download, favourite, edit their own profile. The default for new registrations. |
| `editor` | Everything a viewer can, plus: create and edit file pages and their mirrors, categories and folders, upload images, use the AI drafting helpers, see drafts. Editors open `/admin/items` and see only the content areas. |
| `admin` | Everything: delete, bulk edits, users, settings, storage, backups, imports, monitoring. |

On the API, the requirement is visible per route in `/api/docs` ("Requires role: editor or admin"). Requests without a session get `401`; a signed-in account below the required role gets `403` with `requiredRole` in the body.

## AI

AI is optional.

The application can use:

* Google Gemini
* OpenAI-compatible APIs
* The `tgpt` command-line client
* No AI provider at all

The AI layer is designed as an optional service. Without an AI provider, the catalogue continues to work and deterministic metadata/template fallbacks can still be used.

Example Gemini configuration:

```env
AI_PROVIDER=gemini
AI_API_KEY=your_api_key
AI_MODEL=your_model
```

For more AI configuration options, see `SETUP.md`.

## Deployment

### Ubuntu server

The repository includes a deployment script that can configure:

* Node.js
* Dependencies
* SQLite/database migrations
* systemd
* nginx
* HTTPS with Let's Encrypt

Example:

```bash
sudo ./espress0 deploy \
  --repo https://github.com/3spress0/espress0s_repo.git \
  --domain repo.example.com \
  --https
```

The deployment keeps the application behind nginx while the Node.js application runs locally.

### Docker

Docker Compose configuration is also included:

```bash
docker compose up -d --build
```

See `SETUP.md` and `DEPLOYMENT.md` for detailed deployment instructions.

## Running in the background

For machines accessed through SSH, the built-in tmux runner keeps the application alive after disconnecting:

```bash
./espress0 serve
```

Useful commands:

```bash
./espress0 serve status
./espress0 serve logs
./espress0 serve stop
```

You can also attach directly to the tmux session:

```bash
tmux attach -t espress0
```

The repository also includes an automatic updater that fetches new commits, builds them off to the side, runs migrations, restarts the application, and rolls back a failed update — including the database, which is snapshotted before forward-only migrations run.

The updater will not deploy over an application it cannot restart. It detects the supervisor (systemd unit for this checkout, or a tmux session) before touching anything, and aborts if it finds none, because swapping files under a still-running process leaves the code on disk and the code in memory on different commits. It confirms success by reading the commit that `/api/health` reports — captured when the process started — so an old process cannot pass the check just because the files changed. Use `--no-restart` for a deliberate offline, file-only deploy.

## Project structure

```text
backend/
  src/
    routes/
    services/
    db/

frontend/
  src/
    pages/
    components/
    themes/

scripts/
systemd/
```

The backend contains the Fastify API, services, database logic, search, AI integration, storage handling, versioning, and link-health functionality.

The frontend contains the React application, public catalogue pages, administration interface, components, and themes.

## Security

Security is a core part of the project.

The application includes protections such as:

* HTTP-only SameSite cookies
* CSRF protection
* Rate limiting
* bcrypt password hashing with pepper
* Encrypted sensitive data
* Content Security Policy via Helmet
* SSRF protection for outbound requests
* Input validation
* Authentication and authorization controls

See `SECURITY-AUDIT.md` for the project's security documentation.

## Documentation

| File                | Description                          |
| ------------------- | ------------------------------------ |
| `README.md`         | Project overview and quick start     |
| `SETUP.md`          | Local installation and configuration |
| `DEPLOYMENT.md`     | Server deployment                    |
| `CATALOG.md`        | Catalogue/import/export format       |
| `THEME.md`          | Themes and visual configuration      |
| `SECURITY-AUDIT.md` | Security documentation               |
| `/api/docs`         | Live OpenAPI reference (`/api/docs/json`, `/api/docs/yaml`) |

## Storage model

The application does not need to host every file itself.

Supported storage/link types include:

* Google Drive
* OneDrive
* GitHub release assets
* Direct external URLs

The application stores the relevant metadata and resolves the configured external download destination when a user downloads an item.

## Contributing

Contributions are welcome.

Before submitting changes:

```bash
./espress0 test
```

and verify that the application still builds correctly.

For larger changes, keep the existing architecture and avoid introducing unnecessary services or dependencies.

## License

See the repository's licensing and legal documentation for the applicable terms.

Catalogue entries may link to third-party software. A catalogue entry or external link does not grant redistribution rights. Always respect the original software's license and distribution terms.
