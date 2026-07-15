# EasySync

**Two-way OneDrive sync for Obsidian. Conflicts don't get silently resolved. Works on mobile. Notes and settings each get their own sync toggle.**

EasySync has been running reliably across desktop and mobile through thousands of syncs. Incremental syncs finish in about two seconds — you won't notice it's there until there's a conflict that needs you.

---

## What makes it different

**It doesn't slow down Obsidian.** In our measurements, cold-start overhead is about 30 milliseconds. You won't feel it when you open Obsidian.

**It doesn't trust timestamps. It trusts content.** Most sync plugins compare file modification times — and get it wrong when clocks drift. EasySync computes a SHA-256 hash of each file and compares content, not time. Restore an old file. Edit on devices with different timezones. Your system clock jumps. None of that tricks it. EasySync almost never overwrites your notes by mistake.

**It won't pick a winner for you.** If you edited the same note on two devices, EasySync won't silently discard one side. It shows both versions side by side, highlights the differences, and lets you decide.

**Problems stay visible.** Failed files, unresolved conflicts, files skipped for being too large — they all stay listed in the sidebar. Not a quick notice that disappears in three seconds.

**You decide what syncs.** Notes and attachments are the baseline. Editor settings, appearance, themes, hotkeys, core plugins, community plugin code, and plugin data — each one has its own toggle. No "all or nothing."

**It protects your data quietly.** Before uploading, it re-hashes the file to make sure nothing changed mid-flight. Before overwriting a local file from the cloud, it double-checks. Before deleting anything remotely, it asks you. You don't see any of this happening — but it runs every round.

---

## Start in 2 minutes

1. If EasySync is already approved, install it from Obsidian Community Plugins. Otherwise, use the manual install steps below.
2. Open settings, sign in with your Microsoft account
3. Tap **Sync now**

The first sync scans your vault and builds a cloud baseline. Large vaults may take a while. After that, daily syncs finish in seconds.

> Before the plugin is approved in the community directory, download `main.js`, `manifest.json`, and `styles.css` from [GitHub Releases](https://github.com/jiaoyingxing/easy-sync/releases) and place them in `<vault>/.obsidian/plugins/easy-sync/`. Then enable it in settings.

---

## Where your data lives and who can see it

EasySync stores your data inside your own OneDrive App Folder — an isolated space OneDrive reserves for applications. EasySync can't see your other files. Other apps can't see EasySync's data.

It asks Microsoft for the minimum permissions needed: `Files.ReadWrite.AppFolder` (its own App Folder only) and `Files.Read` (basic file metadata). It does not request full drive access.

EasySync talks only to Microsoft's login and OneDrive endpoints. No third-party servers. No telemetry. No analytics. Diagnostic logs stay on your machine unless you choose to export or sync them.

The source code is open for review in `src/`. Automated tests cover the core sync paths — currently 136 cases.

---

## Features

| Capability | Description |
|------|------|
| Two-way sync | Notes, images, audio, PDFs — everything in your vault |
| Settings sync | Editor, appearance, themes, hotkeys, core plugins — each independently toggleable |
| Community plugin sync | Plugin code and plugin data controlled separately |
| Conflict resolution | Side-by-side diff view with per-line highlighting; keep local, keep remote |
| Text auto-merge | If you edit the top of a note and another device edits the bottom, those non-overlapping changes merge automatically |
| Large files | Uploads over 50 MB use chunked upload; downloads use the safest path available in the current runtime |
| Safety guards | Re-hash before upload, verify before local overwrite, confirm before remote delete, pause and ask if a round changes over half your files |
| Desktop | Windows / macOS / Linux |
| Mobile | iOS / Android — same codebase as desktop |
| Diagnostic reports | One-click export to Markdown with file sizes, durations, and error details |
| i18n Chinese / English | Follows your Obsidian language setting |

### What we don't do yet

| Scenario | Status |
|------|------|
| Multiple people editing the same file at once | EasySync is not a real-time collaboration tool. Don't edit the same file simultaneously on different devices. |
| Move or rename a file on one device, have another device automatically recognize it | Currently the other device sees "one new file + one file pending deletion." Automatic rename/move tracking is planned. |

---

## How it compares

| | EasySync | Obsidian Sync | Remotely Save |
|---|---|---|---|
| Storage | Your own OneDrive | Obsidian servers | OneDrive / S3 / Dropbox |
| Price | Free (OneDrive account needed) | $5/month | Free |
| Sync method | SHA-256 content hashing | — | Modification timestamps |
| Cold start | ~30ms | — | — |
| Daily sync speed | ~2s | — | Depends on file count |
| Conflict handling | Git-style per-line diff | Version history + merge | Pick one side |
| Settings sync | 8 independent toggles | Yes | No |
| Mobile | Full support | Full support | Full support |
| Large file chunking | Yes | Yes | No |
| Source | Public, reviewable | Closed | Open-source (Apache 2.0) |

---

## Install

**Community Plugins (under review):** Obsidian Settings → Community Plugins → Search **EasySync** → Install → Enable

**Manual install:** Download the latest from [GitHub Releases](https://github.com/jiaoyingxing/easy-sync/releases) and extract to `<vault>/.obsidian/plugins/easy-sync/`

**Requirements:** Obsidian `1.11.4` or later. A personal Microsoft account.

---

## License

EasySync is source-available — the code is open for review and learning, but it is not released under an open-source license. See [LICENSE](LICENSE) for details.
