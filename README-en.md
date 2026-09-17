# EasySync

<p align="center">
  <a href="https://github.com/jiaoyingxing/easy-sync/releases">
    <img alt="Release downloads" src="https://img.shields.io/github/downloads/jiaoyingxing/easy-sync/total.svg?style=flat-square&label=Release%20downloads" />
  </a>
  <a href="https://github.com/jiaoyingxing/easy-sync/releases">
    <img alt="Latest release" src="https://img.shields.io/github/v/release/jiaoyingxing/easy-sync?style=flat-square&label=Latest%20release" />
  </a>
  <a href="./README.md">
    <img alt="CN 中文版" src="https://img.shields.io/badge/CN-%E4%B8%AD%E6%96%87%E7%89%88-d32f2f?style=flat-square" />
  </a>
  <a href="./README-en.md">
    <img alt="EN English" src="https://img.shields.io/badge/EN-English-2f6fed?style=flat-square" />
  </a>
</p>

I built EasySync so that anyone can solve their Obsidian sync problem with ease: initial setup takes only 2 minutes. If you're still using Remotely Save with OneDrive, give EasySync a try.

EasySync is a next-generation two-way sync plugin built on OneDrive — sign in with your OneDrive account, and your vault stays in sync across computers, phones, and tablets. Conflicts stay under your control, mobile runs smoothly, and notes and settings each have their own sync switches. Supports Windows, macOS, Linux, iOS, and Android.

| Feature | Details |
| --- | --- |
| 🔍 Judges by content, not by time | Every file gets a SHA-256 content fingerprint, and only real content changes count — old files copied back, edits made on another device, or system clock jumps can't fool it, so your notes are almost never overwritten by mistake. |
| ⚖️ Conflicts are yours to decide | When the same note was edited on two devices, EasySync never picks one and overwrites the other: both versions are shown side by side with the differences highlighted, and you decide which to keep. |
| 👀 The whole picture at a glance | Failed items, conflicts waiting for you, and files skipped for being too large are all listed in the sidebar — not just a notice that disappears in a few seconds. |
| 🎛️ You choose what syncs | Notes and attachments sync by default; editor settings, appearance, themes, hotkeys, core plugins, community plugins, and plugin data each have their own switch. |
| 🛡️ Quietly protecting your data | Hashes are recomputed before upload to confirm nothing changed along the way; downloads are verified before replacing local files; after an interruption, syncing resumes from completed progress; remote deletions never touch your local files by default — they are handed to you for confirmation first. |
| ☁️ Your data stays in your own OneDrive | Connects directly to Microsoft's official APIs with no third-party relay server; no telemetry, no ads, and the source code is published on GitHub. |

## Table of contents

- [1. Quick start](#1-quick-start)
- [2. Data and privacy](#2-data-and-privacy)
- [3. Configuration and sync scope](#3-configuration-and-sync-scope)
- [4. How conflicts are handled](#4-how-conflicts-are-handled)
- [5. Migrating from other sync methods](#5-migrating-from-other-sync-methods)
- [6. Usage boundaries](#6-usage-boundaries)
- [7. FAQ](#7-faq)
- [8. License and support](#8-license-and-support)

## 1. Quick start

### 1.1 Install the plugin

In Obsidian, open:

**Settings → Community plugins → Browse → Search for EasySync → Install and enable**

EasySync requires Obsidian `1.11.4` or later.

For manual installation, download `main.js`, `manifest.json`, and `styles.css` from [GitHub Releases](https://github.com/jiaoyingxing/easy-sync/releases) and place them in:

```text
<your-vault>/.obsidian/plugins/easy-sync/
```

Then enable EasySync in Obsidian.

### 1.2 Prepare your vault

- Keep an independent backup of important vaults before you start;
- Keep the vault in a normal local folder, and let EasySync be the only tool managing its sync;
- Do not put the vault on OneDrive, iCloud, or other cloud-sync storage, and do not run another sync plugin or tool on it — they will conflict with each other.

Use the same vault name on every device: EasySync identifies the sync space by the vault name, and a different name is a different sync space.

### 1.3 Sign in to OneDrive

Open:

**Obsidian Settings → EasySync → Log in with OneDrive**

Sign-in opens your system browser for Microsoft authorization; on mobile, return to Obsidian when prompted after authorization.

### 1.4 Run the first sync

Start on the device with the most complete copy and select **Sync now**: EasySync shows the sync plan first, and nothing is uploaded, overwritten, moved, or deleted until you confirm it. Confirm the plan, wait for this round to finish, and then sync your other devices.

If a new device has no content yet:

1. Create an empty vault with the same name.
2. Install EasySync and sign in.
3. Select **Sync now**.
4. Wait for the cloud files to finish downloading.

If the cloud already contains EasySync state for a vault with the same name, the new device will be asked to join it; an upgrade from an older version may show a sync-method upgrade first — update EasySync on your other devices, then follow the on-screen confirmation.

The first sync scans every file, computes fingerprints, and establishes a shared baseline, so it takes noticeably longer than later syncs on large vaults or slow networks. After that, syncs mainly check incremental changes, large files use chunked uploads, and mobile downloads are verified before replacing local files.

## 2. Data and privacy

### 2.1 Where your cloud files live

EasySync stores each vault separately inside its OneDrive app folder:

```text
Apps/EasySync/vaults/<vault-name>/files/<your-file-path>
```

For example:

```text
Apps/EasySync/vaults/My Notes/files/Projects/Plan.md
```

The `files` directory contains the vault files included in sync, and you can browse them from OneDrive on the web or in its apps. The sibling `.easy-sync` directory stores sync state — do not manually edit, move, or delete anything inside it.

### 2.2 How data is transferred

Synced files stay in your own OneDrive account. EasySync connects directly to Microsoft sign-in and Microsoft Graph with no third-party relay, and its sync paths are limited to the app folder `Apps/EasySync/`.

The current Microsoft permissions are:

- `Files.ReadWrite.AppFolder`: read and write EasySync's OneDrive app folder;
- `Files.Read`: read and download files;
- Basic identity and offline access: identify the active account and maintain sign-in.

No telemetry, ads, or behavioral analytics; diagnostic logs stay in the local plugin directory, and a diagnostic report is written to the vault only when you explicitly generate one. The source is published on GitHub for review.

### 2.3 Recycle Bin and backup boundary

If a cloud file is deleted, you may be able to restore it from the OneDrive Recycle Bin according to your account policy. But neither the Recycle Bin nor sync history replaces an independent backup — keep important content backed up regularly, in a place no sync tool manages.

## 3. Configuration and sync scope

- Normal files and folders in the vault — notes, images, audio, PDFs, attachments — sync in both directions by default, with no extra configuration;
- Everything else in Obsidian is not synced unless you enable it under **Sync scope** in settings.

Other options can be enabled as needed:

| Setting | Recommendation |
| --- | --- |
| Sync exclusions | Apply only to the current device; excluded folders are neither uploaded nor downloaded, and existing files are not deleted merely because of the exclusion |
| Sync scope | Editor settings, appearance, themes and snippets, hotkeys, bookmarks, and core plugins can be controlled separately |
| Community plugins | Plugin files can be selected individually; each plugin's `data.json` is controlled separately by **Community plugin data** |
| Community plugin data | Each plugin's `data.json` can be selected separately; this feature is still experimental, so back up plugin settings on every device before enabling it |
| EasySync self-sync | Off by default; enable it only if EasySync updates should propagate to other devices |
| Auto sync | Scheduled sync and sync-after-change can be configured separately; **Sync now** remains available when both are off |
| Automatic handling | Merging non-overlapping text edits is on by default; applying remote deletions locally is off by default, and uncertain cases become conflicts or pending decisions |
| Diagnostic logging | Leave it off for normal use; enable it when investigating a problem and generating a diagnostic report |
| Notification popups | All by default; can be set to "Important only" or "Off"; critical alerts such as sign-in expiration are always shown |

Settings are stored in the plugin data of the current device and take effect per device (for example, sync exclusions and notification levels); they do not automatically change other devices or vaults.

### 3.1 Obsidian configuration included (whitelist)

When the corresponding option is enabled, these objects under `.obsidian` are synced:

- Editor settings (`app.json`)
- Appearance settings (`appearance.json`)
- Themes (`themes/`) and snippets (`snippets/`)
- Hotkeys (`hotkeys.json`)
- Core plugin enable states (`core-plugins.json`)
- Bookmarks (`bookmarks.json`)
- Community plugins: the three plugin files (`main.js`, `manifest.json`, `styles.css`) of plugins participating in sync on this device; plugin data (`data.json`) requires a separate opt-in under **Community plugin data** (experimental)
- EasySync itself: with **EasySync self-sync** enabled, the plugin files propagate to other devices

Community plugin **enable state is not part of the sync scope**: each device can enable or disable plugins independently.

Note: even with automatic merging of non-overlapping text edits enabled, files under `.obsidian` are never merged automatically — conflicts there always require you to choose the local or the remote side.

### 3.2 What is not synced

- Everything under `.obsidian` outside the whitelist — configs, caches, and session files that plugins generate inside their own plugin folders, plus other files at the root of the config directory — stays on the device where it was created;
- Hidden dot-folders (such as `.git` and `.trash`) do not participate in normal sync; `.trash/`, `.DS_Store`, and `Thumbs.db` are excluded by default;
- EasySync's own state, caches, logs, and recovery copies never sync;
- **Sync exclusions** remove an already-synced folder from this device only: nothing is deleted locally or in the cloud, and other devices are unaffected.

> Keep content you want to share across devices in a normal visible folder.

## 4. How conflicts are handled

EasySync records the last successfully synced content of every file as a baseline and uses content hashes to compare what changed locally and remotely.

It can handle these automatically:

- Only one side changed;
- Both sides have identical content;
- Both sides edited the same text file in non-overlapping locations;
- A file or folder was only renamed or moved, its content is unchanged, and its identity can be confirmed;
- The remote file was deleted, the local file has not changed since the baseline, and you authorized the corresponding action.

These normally require your decision or another review:

- Both sides changed the same line or overlapping content;
- No trustworthy shared version is available;
- A binary file such as an image, PDF, or archive changed on both sides;
- An Obsidian-managed configuration file conflicts;
- A file was renamed or moved while its content also changed, the target is occupied, or the original identity cannot be determined uniquely;
- A file changed again after the sync plan was created, or the account, vault scope, or remote version has changed.

EasySync does not overwrite one side merely because a file "looks newer".

## 5. Migrating from other sync methods

If you already sync another way, follow the steps below. Remember three things while migrating: keep the original vault and an independent backup; do not let two sync tools manage the same local vault; and if the first sync plan shows an unexpected number of uploads, downloads, or conflicts, cancel it and re-check the vault name, directory structure, sync scope, and encryption settings before starting over. Files already placed in EasySync's cloud directory with exactly the same paths and contents as the local copies only establish a shared baseline during the first sync and are not uploaded again.

### 5.1 From the OneDrive app

If the vault sits directly inside a OneDrive-synced folder: make sure OneDrive has finished syncing and every file is fully downloaded rather than a cloud-only placeholder; close Obsidian, pause OneDrive, copy the entire vault to a normal local folder outside OneDrive, and open that copy in Obsidian.

Install and enable EasySync, sign in to the OneDrive account that holds the old vault, but do not start syncing yet. In OneDrive on the web, copy everything inside the old vault root into `Apps/EasySync/vaults/<your-vault-name>/files/` — directly into `files`, without adding another vault-name folder. Then start the first sync; once the result checks out, deal with the old vault in the OneDrive folder.

### 5.2 From Remotely Save

Finish one last sync, confirm that it succeeded, and disable Remotely Save on every device.

If remote encryption is off, use OneDrive on the web to copy the vault contents from `Apps/remotely-save/<your-vault-name>/` into `Apps/EasySync/vaults/<your-vault-name>/files/` — copy the vault contents directly, without adding another vault-name folder, and without Remotely Save's control files. If you used a custom remote directory, use that actual directory instead.

If remote encryption is on, first restore the complete unencrypted vault locally with Remotely Save, then let EasySync perform the initial upload.

### 5.3 From iCloud on iOS

Do not turn off iCloud first. In the Files app, make sure `iCloud Drive/Obsidian/<your-vault-name>/` is fully downloaded; use **Keep Downloaded** for items that remain cloud-only. Then create a local Obsidian vault with the same name and iCloud storage disabled, close Obsidian, and copy everything inside the old vault root into `On My iPhone/Obsidian/<your-vault-name>/` or `On My iPad/Obsidian/<your-vault-name>/`.

Reopen Obsidian and verify that notes, attachments, and folders are complete before installing EasySync and running the first sync. iCloud and the OneDrive storage used by EasySync are separate clouds, so one initial upload is still required; keep the original iCloud vault until that upload and a second stable sync have completed before deciding whether to remove it.

## 6. Usage boundaries

EasySync is a cross-device file sync tool, not a real-time collaboration service.

- Do not edit the same file on several devices at the same time;
- Do not let EasySync and another sync tool manage the same local vault;
- Sync is not a substitute for an independent backup — back up important data regularly.

## 7. FAQ

### 7.1 Can I sync multiple vaults?

Yes. There is no limit on the number of vaults; only your OneDrive storage matters. Devices signed in to the same account with the same vault name share one sync space; a different vault name is a different sync space.

### 7.2 Is my data safe? Is there end-to-end encryption?

EasySync does not provide end-to-end encryption: the cloud copies are plain files stored in your own OneDrive, where you can view them at any time (see section 2).

Data safety rests on three things: files stay in your own OneDrive account, with a direct connection to Microsoft and no third-party server; sensitive operations such as deletion have confirmation and protection mechanisms, and mistakenly deleted files can be restored from the OneDrive Recycle Bin according to your account policy; OneDrive account security — sign-in protection and optional two-step verification — protects these files too, so enabling two-step verification on your Microsoft account is recommended.

If you need end-to-end encryption where even the cloud provider cannot read the content, EasySync does not offer it today.

### 7.3 Why no WebDAV, S3, Google Drive, or other backends?

EasySync currently supports OneDrive only. Incremental checking, chunked uploads, and change detection are built on mechanisms that OneDrive's official API provides — they cannot be added by swapping in a different server address. If you are coming from another sync setup, section 5 covers migration paths from a OneDrive folder, Remotely Save, and iCloud.

### 7.4 Is EasySync free?

Yes. EasySync is open source under the [MIT License](LICENSE), and all features are free to use.

## 8. License and support

EasySync is open source under the [MIT License](LICENSE).

- Having trouble? Generate a **Diagnostic report** from EasySync settings and include the complete report when you file an issue at [GitHub Issues](https://github.com/jiaoyingxing/easy-sync/issues).
- Product discussion: search for **焦应行** on Xiaohongshu 🔍
