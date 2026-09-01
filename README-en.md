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

<p align="center">
  <strong>Language:</strong> <a href="./README.md"><strong>简体中文</strong></a> · <strong>English</strong>
</p>

EasySync keeps your Obsidian vault in sync across computers, phones, and tablets.

- Safe and controlled: one-sided changes, identical content, and non-overlapping text edits can be handled automatically; other conflicts remain your decision.

- Clear throughout: sync status, progress, history, and items needing attention stay visible in a dedicated sidebar.

- Flexible scope: editor settings, appearance, themes, snippets, hotkeys, bookmarks, core plugins, and community plugins can be controlled separately, with per-plugin selection for community plugins.

- Supports Windows, macOS, Linux, iOS, and Android. The first sync establishes a shared baseline; later syncs primarily check incremental changes, and large files use chunked uploads.

## 👋 Contact

- Product discussion: search **Jiao Yingxing** on Xiaohongshu 🔍
- Having trouble? Generate a **Diagnostic report** from EasySync settings and include the complete report when reporting an issue. Report issues through [GitHub Issues](https://github.com/jiaoyingxing/easy-sync/issues).

## 1. Install and set up your first sync

### 1.1 Install the plugin

In Obsidian, open:

**Settings → Community plugins → Browse → Search for EasySync → Install and enable**

EasySync requires Obsidian `1.11.4` or later.

For manual installation, download `main.js`, `manifest.json`, and `styles.css` from [GitHub Releases](https://github.com/jiaoyingxing/easy-sync/releases), then place them in:

```text
<your-vault>/.obsidian/plugins/easy-sync/
```

Enable EasySync in Obsidian afterward.

### 1.2 Prepare the local vault

Do not place your Obsidian vault folder directly inside a cloud-sync directory such as OneDrive or iCloud. EasySync itself is a sync tool: if two sync programs modify the same files at the same time, you risk serious conflicts and data chaos. Keep the vault in a normal local folder, managed by EasySync alone.

Recommended setup:

- Keep the Obsidian vault in a normal local folder.
- Let EasySync be the only tool managing cross-device sync for that vault.
- Keep an independent backup of important vaults before the first sync.

Use the same vault name on every device: EasySync identifies the cloud sync space by the vault name. For example, if the vault on your computer is named:

```text
My Notes
```

Create or open a vault named “My Notes” on your phone as well. A different name is treated as a separate sync space.

### 1.3 Sign in to OneDrive

Open:

**Obsidian Settings → EasySync → Log in with OneDrive**

Sign-in opens your system browser for Microsoft authorization; on mobile, return to Obsidian when prompted after authorization.

### 1.4 Run the first sync

Start with the device that has the most complete copy of your vault and select **Sync now**. EasySync shows the sync plan first; until you confirm it, notes, attachments, and other pending sync files are not uploaded, overwritten, moved, or deleted. Confirm the plan, wait for the sync to finish, and then sync the other devices.

If a new device has no content yet:

1. Create an empty vault with the same name.
2. Install EasySync and sign in.
3. Select **Sync now**.
4. Wait for the cloud files to finish downloading.

If the cloud already contains EasySync state for a vault with the same name, a new device will be asked to join the existing sync state. An upgrade from an older version may also show a sync-method upgrade. Update EasySync on the other devices first, then follow the on-screen confirmation.

The first sync scans the vault, hashes its files, and establishes a shared baseline. Large vaults or slower networks will take longer than later syncs.

## 2. Migration

If you already use another sync method, follow the steps below to move to EasySync. Keep the old vault and an independent backup until the migration is complete, and do not let two sync tools manage the same local vault. Files already placed in EasySync's cloud directory with exactly the same paths and contents as the local copies will only establish a shared baseline during the first sync and will not be uploaded again. If the plan contains an unexpected number of uploads, downloads, or conflicts, cancel it and check the vault name, directory structure, sync scope, and encryption settings.

### 2.1 Migrating from the OneDrive app

If the vault is stored directly inside a OneDrive-synced folder, first make sure OneDrive has finished syncing and every file is fully downloaded rather than a cloud-only placeholder. Close Obsidian, pause OneDrive, copy the entire vault to a normal local folder outside OneDrive, and open that local copy in Obsidian.

Install and enable EasySync, sign in to the OneDrive account that contains the old vault, but do not start syncing yet. In OneDrive on the web, copy everything inside the old vault root directly into `Apps/EasySync/vaults/<your-vault-name>/files/`. Do not add another vault-name folder under `files`. Start the first sync, verify the result, and only then decide what to do with the old vault in the OneDrive-synced folder.

### 2.2 Migrating from Remotely Save

Finish one last sync, confirm that it succeeded, and disable Remotely Save on every device. If remote encryption is off, use OneDrive on the web to copy the vault contents from `Apps/remotely-save/<your-vault-name>/` into `Apps/EasySync/vaults/<your-vault-name>/files/`. Copy the vault contents directly, without adding another vault-name folder or copying Remotely Save control files.

If you configured a custom remote directory, use that actual directory instead. If remote encryption is enabled, first restore the complete unencrypted vault locally with Remotely Save, then let EasySync perform the initial upload.

### 2.3 Migrating from iCloud on iOS

Do not turn off iCloud first. In the Files app, make sure `iCloud Drive/Obsidian/<your-vault-name>/` is fully downloaded; use **Keep Downloaded** for items that remain cloud-only. Create a local Obsidian vault with the same name and with iCloud storage disabled. Close Obsidian, then copy everything inside the old vault root into `On My iPhone/Obsidian/<your-vault-name>/` or `On My iPad/Obsidian/<your-vault-name>/`.

Reopen Obsidian and verify that the notes, attachments, and folders are complete before installing EasySync and running the first sync. iCloud and the OneDrive storage used by EasySync are separate cloud services, so this migration still requires one initial upload. Keep the original iCloud vault until that upload and a second stable sync have completed before deciding whether to remove it.

## 3. Recommended settings

Basic sync needs no extra configuration: notes and attachments in the vault are included by default.

Enable other options only when you need them:

| Setting | Recommendation |
| --- | --- |
| Sync exclusions | Apply only to the current device; excluded folders are neither uploaded nor downloaded, and existing files are not deleted merely because of the exclusion |
| Sync scope | Editor settings, appearance, themes and snippets, hotkeys, bookmarks, and core plugins can be controlled separately |
| Community plugins | Plugin files can be selected individually; each device keeps its own enabled state in Obsidian. Each plugin's `data.json` is controlled separately by “Community plugin data” |
| Community plugin data | Each plugin's `data.json` can be selected separately; this feature is still experimental, so back up plugin settings on every device first |
| EasySync self-sync | Off by default; enable it only if EasySync updates should propagate to other devices |
| Auto sync | Scheduled sync and sync-after-change can be configured separately; **Sync now** remains available when both are off |
| Automatic handling | Merging non-overlapping text edits is on by default; applying remote deletions locally is off by default, and uncertain cases remain conflicts or pending decisions |
| Diagnostic logging | Leave it off for normal use; enable it when investigating a problem and generating a diagnostic report |
| Notification popups | All by default; can be set to “Important only” or “Off”; critical alerts such as sign-in expiration are always shown |

Settings are stored in the plugin data of the current device and take effect per device (for example, sync exclusions and notification popup levels); they do not automatically change other devices or vaults.

## 4. Data and permissions in OneDrive

### 4.1 Where the cloud files are stored

EasySync stores each vault separately inside its OneDrive app folder:

```text
Apps/EasySync/vaults/<vault-name>/files/<your-file-path>
```

For example:

```text
Apps/EasySync/vaults/My Notes/files/Projects/Plan.md
```

The `files` directory contains the vault files included in sync. You can browse these cloud copies from OneDrive on the web or in its apps.

The sibling `.easy-sync` directory stores sync state. Do not manually edit, move, or delete its contents.

> These are cloud copies managed by EasySync. Their presence in OneDrive does not mean that your local Obsidian vault should be moved into a OneDrive-synced folder.

### 4.2 How data is transferred

Synced files remain in your own OneDrive account. EasySync connects directly to Microsoft sign-in and Microsoft Graph without a third-party relay server.

The current Microsoft permissions include:

- `Files.ReadWrite.AppFolder`: read and write EasySync’s OneDrive app folder.
- `Files.Read`: read and download files.
- Basic identity and offline access: identify the active account and maintain sign-in.

EasySync limits its sync paths to its own app folder:

```text
Apps/EasySync/
```

The plugin contains no telemetry, advertising, or behavioral analytics. Diagnostic logs stay in the local plugin directory by default. A diagnostic report is written to the vault only when you explicitly generate one.

The source is published on GitHub for review.

### 4.3 Recycle Bin and backup boundary

If a file is deleted from OneDrive, you may be able to recover it from the OneDrive Recycle Bin according to your account policy. Neither the Recycle Bin nor sync history replaces an independent backup; keep important content in a location that is not managed by EasySync or another sync tool.

## 5. Core capabilities

- **Notes and attachments:** two-way sync for Markdown, images, audio, PDFs, and other vault files, using content hashes rather than timestamps alone.
- **Files and folders:** sync creation, renaming, moving, and deletion. When content is unchanged and identity can be confirmed, other devices only adjust the name or location instead of transferring the file again.
- **First sync and device onboarding:** preview the sync plan before the first run, join existing EasySync state for a same-named vault on a new device, and move supported older EasySync state forward through a reviewed upgrade plan.
- **Automatic handling and conflicts:** automatically handle one-sided changes, identical content, and non-overlapping text edits. Other text conflicts include per-line diffs, while binary conflicts show information from both sides for your decision.
- **Interruption recovery:** retain recovery records for unfinished uploads, downloads, deletions, and state commits. After Obsidian closes, the network drops, a request times out, or a response is lost, EasySync checks the current result before continuing or asking for attention.
- **Obsidian settings and plugins:** optionally sync editor settings, appearance, themes, snippets, hotkeys, bookmarks, core plugins, and community plugins, with separate management for community plugin files, enabled state, and data.
- **Status and diagnostics:** show the plan, progress, history, conflicts, and pending decisions in the sidebar, handle several decisions in sequence, and generate a diagnostic report when needed.
- **Large vaults and large files:** establish a shared baseline once, check incremental changes afterward, use chunked uploads for large files, and verify mobile downloads before replacing local files.

## 6. Sync scope

### 6.1 Included by default

- Normal files and folders in the vault — notes, images, audio, PDFs, attachments — sync in both directions by default.
- Everything else in Obsidian is not synced unless you enable the corresponding option under **Sync scope** in settings.

### 6.2 Obsidian configuration included (whitelist)

When the corresponding option is enabled, these objects under `.obsidian` are synced:

- Editor settings (`app.json`)
- Appearance settings (`appearance.json`)
- Themes (`themes/`) and snippets (`snippets/`)
- Hotkeys (`hotkeys.json`)
- Core plugin enable states (`core-plugins.json`)
- Bookmarks (`bookmarks.json`)
- Community plugins: the three plugin files (`main.js`, `manifest.json`, `styles.css`) of plugins participating in sync on this device; plugin data (`data.json`) requires a separate opt-in under **Community plugin data** (experimental)
- EasySync itself: with **EasySync self-sync** enabled, the plugin files propagate to other devices

Community plugin enable state is not part of the sync scope: each device can enable or disable plugins independently.

Note: even with automatic merging of non-overlapping text edits enabled, files under `.obsidian` are never merged automatically — conflicts there always require you to choose the local or the remote side.

### 6.3 Not included

- Any file under `.obsidian` outside the whitelist: other files a plugin generates inside its plugin folder (configs, caches, session records), and other files in the config directory. For example, some plugins create working files under `.obsidian`; those stay on the device where they were created.
- Hidden dot-folders (such as `.git` and `.trash`) do not participate in normal sync by default; `.trash/`, `.DS_Store`, and `Thumbs.db` are excluded by default.
- EasySync's own state, caches, logs, and recovery copies never sync.
- **Sync exclusions** remove an already-synced folder from this device only: no local or cloud files are deleted, and other devices are unaffected.

> Keep content you want to share across devices in a normal visible folder.

## 7. How conflicts are handled

EasySync records the last successfully synced content and evaluates local and remote changes against that shared baseline.

It can handle cases such as these automatically:

- Only one side changed.
- Both sides have identical content.
- Both sides edited the same text file in non-overlapping locations.
- A file or folder was only renamed or moved, its content is unchanged, and its identity can be confirmed.
- The remote file was deleted, the local file has not changed since the baseline, and you authorized the corresponding action.

Cases like these normally require your decision or another review:

- Both sides changed the same line or overlapping content.
- No trustworthy shared version is available.
- A binary file such as an image, PDF, or archive changed on both sides.
- An Obsidian-managed configuration file conflicts.
- A file was renamed or moved while its content also changed, the target is occupied, or the original identity cannot be determined uniquely.
- A file changed again after the sync plan was created, or the account, vault scope, or remote version has changed.

EasySync does not overwrite one side merely because a file appears to be newer.

## 8. Usage boundaries

EasySync is a cross-device file sync tool, not a real-time collaboration service.

Keep these limits in mind:

- Do not edit the same file on several devices at the same time.
- Do not let EasySync and another sync tool manage the same local vault.
- A straightforward file or folder rename or move can be synced by identity. A simultaneous content edit, occupied target, or ambiguous identity may require a manual decision.
- Community plugin selections apply per device. Disabling or uninstalling a plugin on one device does not automatically delete its cloud files or affect other devices.
- Community plugin data remains experimental and may replace settings on another device; keep a backup before enabling it.
- The first sync, large batches of small files, and large transfers need more time.
- Automatic handling runs only when all safety conditions are satisfied; otherwise, the operation stops or becomes a manual decision.
- Sync is not a substitute for an independent backup. Back up important data regularly.

## 9. License

EasySync is open source under the [MIT License](LICENSE).
