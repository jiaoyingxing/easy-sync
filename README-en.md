# EasySync

Language: English | [简体中文](README.md)

**Two-way OneDrive sync for Obsidian. Conflicts don't get silently resolved. Works on mobile. Notes and settings each get their own sync toggle.**

EasySync is published in the Obsidian community plugin store. It has been running reliably across desktop and mobile through thousands of syncs, with 140 automated tests covering the core sync paths. Incremental syncs finish in about two seconds — you won't notice it's there until there's a conflict that needs you.

---

## ⚡ What makes it different

**It doesn't slow down Obsidian.** In our measurements, cold-start overhead is about 30 milliseconds. You won't feel it when you open Obsidian.

**It doesn't trust timestamps. It trusts content.** Most sync plugins compare file modification times — and get it wrong when clocks drift. EasySync computes a SHA-256 hash of each file and compares content, not time. Restore an old file. Edit on devices with different timezones. Your system clock jumps. None of that tricks it. EasySync almost never overwrites your notes by mistake.

**It won't pick a winner for you.** If you edited the same note on two devices, EasySync won't silently discard one side. Markdown and other text files get a side-by-side per-line diff so you can see exactly what changed. PDFs, images, and other binary files show the size and timestamp of both sides so you can compare and pick — automatic text merging on the roadmap.

**Problems stay visible.** Failed files, unresolved conflicts, files skipped for being too large — they all stay listed in the sidebar. Not a quick notice that disappears in three seconds.

**You decide what syncs.** Notes and attachments are the baseline. Editor settings, appearance, themes, hotkeys, core plugins, community plugin code, and plugin data — each one has its own toggle. No "all or nothing."

**It protects your data quietly.** Before uploading, it re-hashes the file to make sure nothing changed mid-flight. Before overwriting a local file from the cloud, it double-checks. Before deleting anything remotely, it asks you. You don't see any of this happening — but it runs every round.

---

## 🚀 Start in 2 minutes

1. Install **EasySync** from Obsidian Community Plugins
2. Open settings, sign in with your Microsoft account
3. Tap **Sync now**

The first sync scans your vault and builds a cloud baseline. Large vaults may take a while.

> You can also install manually from [GitHub Releases](https://github.com/jiaoyingxing/easy-sync/releases): download `main.js`, `manifest.json`, and `styles.css` and place them in `<vault>/.obsidian/plugins/easy-sync/`. Then enable it in settings.

---

## 🔒 Privacy & data security

### Where your data lives

EasySync stores your data inside your own OneDrive **App Folder** — an isolated space OneDrive reserves for each application. EasySync can't see your other files. Other apps can't see EasySync's data. All files travel through Microsoft's encrypted transport; there's no middle hop.

### What EasySync asks OneDrive for

It asks Microsoft for the minimum permissions possible:

- `Files.ReadWrite.AppFolder`: its own App Folder only — cannot access other OneDrive locations
- `Files.Read`: basic file metadata, used to check nothing is missing during sync

It does not request full drive access, nor access to your email, contacts, or other Microsoft services.

### Does data leave OneDrive?

**No.** EasySync talks only to Microsoft's login and OneDrive endpoints. No third-party servers, no intermediaries. Every note travels from Obsidian to OneDrive with only you and Microsoft in the loop.

### Does it collect my usage data?

**No.** No telemetry. No analytics. No user profiling. Diagnostic logs are purely local — you can delete them or export them to read yourself. They record sync durations, file sizes, and error causes. Unless you choose to sync them to another device, they never leave your computer.

### Can I inspect the code?

**Yes.** The source code is public on GitHub for anyone to review. Automated tests cover the core sync paths — currently **140** cases. Every change passes the full suite before release.

### OneDrive has your back too

Choosing OneDrive isn't just about being free — it's an extra layer of protection:

**Directly visible.** Open OneDrive on the web or mobile app, go to `Apps` → `EasySync` → your vault name, and you can see and browse all your synced notes. OneDrive is the relay, and also your real-time cloud backup.

**Recycle bin safety net.** Accidentally delete something in Obsidian, sync pushes the deletion to the cloud — OneDrive's recycle bin still keeps it for a while. Personal Microsoft accounts retain deleted files for 30 days by default, and you can restore them anytime. That's OneDrive's built-in mechanism, giving your notes a zero-config safety net.

---

## 📖 Tutorial

### Step 1: Get a Microsoft account

EasySync runs on OneDrive, so you need a personal Microsoft account. If you already have an Outlook email, just sign in with that. If not:

1. Go to [outlook.com](https://outlook.com) and click "Create free account"
2. Pick an email address you like (e.g. `yourname@outlook.com`) and set a password
3. Complete the verification — your account is ready
4. Open EasySync settings in Obsidian and sign in

About 3 minutes. No phone number, no payment, no technical background required.

### Step 2: Use the same vault name on all devices

The key to cross-device sync: your Obsidian vault name must be **exactly the same** on every device. EasySync uses the vault name to tell "which vault is this" — two vaults with different names are treated as two independent sync spaces.

- If you already have a vault called "My Notes", create the new vault on your phone with the same name
- If you haven't started yet, pick a name first and use it everywhere
- Vault names are case-sensitive — "my vault" and "My Vault" are seen as two different vaults

### Step 3: First sync

The first sync does a full reconciliation — scanning all your local files and building the cloud baseline. A few tips:

- **Sync the most complete device first.** If your computer has a thousand files and your phone is empty, sync the computer first — it pushes everything to the cloud. Then open your phone and it pulls from the cloud.
- **Both devices already have content? That's fine.** EasySync will figure it out: files that are identical on both sides are skipped; files only on one side get synced; files edited on both sides are flagged as conflicts for you to resolve.
- **The first sync takes patience.** Every file needs scanning, hashing, and transferring — the more files, the longer it takes. A few hundred markdown files may take a few minutes; a few thousand may take ten minutes or more. After that, daily syncs only process what changed and finish in seconds.

---

## 📋 Features

| Capability | Description |
|------|------|
| Two-way sync | Notes, images, audio, PDFs — everything in your vault |
| Settings sync | Editor, appearance, themes, hotkeys, core plugins — each independently toggleable |
| Community plugin sync | Plugin code and plugin data controlled separately |
| Conflict resolution | Per-line diff for md and text files; PDFs/images show size & timestamp, manual pick |
| Text auto-merge | Non-overlapping changes (you edit the top, another device edits the bottom) merge automatically |
| Recovery copies | Before overwriting a local file from the cloud, a `.easy-sync-recovery` backup is saved first |
| Large files | Over 50 MB auto chunked upload; downloads choose the optimal path for the current runtime |
| Safety guards | Re-hash before upload, backup before overwrite, confirm before remote delete, pause if a round changes over half your files, auto-block on account switch |
| Desktop | Windows / macOS / Linux |
| Mobile | iOS / Android |
| Diagnostic reports | One-click export to Markdown with file sizes, durations, and error details |
| i18n Chinese / English | Follows your Obsidian language setting |

### What we don't do yet

| Scenario | Status |
|------|------|
| Multiple people editing the same file at once | EasySync is not a real-time collaboration tool. Don't edit the same file simultaneously on different devices. |
| Move or rename a file on one device, have another device automatically recognize it | Currently the other device sees "one new file + one file pending deletion." Automatic rename/move tracking is planned. |

---

## ⚖️ How it compares

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

## 📦 Install

**Community Plugins:** Obsidian Settings → Community Plugins → Search **EasySync** → Install → Enable

**Manual install:** Download the latest from [GitHub Releases](https://github.com/jiaoyingxing/easy-sync/releases) and extract to `<vault>/.obsidian/plugins/easy-sync/`

**Requirements:** Obsidian `1.11.4` or later. A personal Microsoft account.

---

## 📄 License

EasySync is source-available — the code is open for review and learning, but it is not released under an open-source license. See [LICENSE](LICENSE) for details.
