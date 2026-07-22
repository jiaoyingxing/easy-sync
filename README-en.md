# EasySync

<p align="center">
  <a href="https://github.com/jiaoyingxing/easy-sync/releases">
    <img alt="Latest release" src="https://img.shields.io/github/v/release/jiaoyingxing/easy-sync?style=flat-square&label=Latest%20release" />
  </a>
  <a href="./README.md">
    <img alt="中文" src="https://img.shields.io/badge/中文-README-d32f2f?style=flat-square" />
  </a>
  <a href="./README-en.md">
    <img alt="English" src="https://img.shields.io/badge/English-README-2f6fed?style=flat-square" />
  </a>
</p>

Two-way Obsidian vault sync across computers, phones, and tablets using your own OneDrive.

EasySync syncs notes and attachments by default. Obsidian settings, themes, and plugins are optional. It handles an operation automatically only when it can prove that it is safe; otherwise, it leaves a conflict for you to decide.

Supports Windows, macOS, Linux, iOS, and Android.

## Install and set up your first sync

### 1. Install the plugin

In Obsidian, open:

**Settings → Community plugins → Browse → Search for EasySync → Install and enable**

EasySync requires Obsidian `1.11.4` or later.

For manual installation, download `main.js`, `manifest.json`, and `styles.css` from [GitHub Releases](https://github.com/jiaoyingxing/easy-sync/releases), then place them in:

```text
<your-vault>/.obsidian/plugins/easy-sync/
```

Enable EasySync in Obsidian afterward.

### 2. Prepare the local vault

> [!IMPORTANT]
> When using EasySync, do not place the same Obsidian vault inside a folder already managed by OneDrive, iCloud Drive, Dropbox, Syncthing, or another sync tool.

If EasySync and another sync tool both modify the same files, you may get conflict copies, duplicate uploads, restored deletions, or incorrect sync decisions.

Recommended setup:

- Keep the Obsidian vault in a normal local folder.
- Let EasySync be the only tool managing cross-device sync for that vault.
- Keep an independent backup of important vaults before the first sync.

### 3. Sign in to OneDrive

Open:

**Obsidian Settings → EasySync → Log in with OneDrive**

Complete Microsoft sign-in in your browser, then return to Obsidian.

### 4. Use the same vault name on every device

EasySync uses the vault name to identify its cloud sync space.

For example, if the vault on your computer is named:

```text
My Notes
```

Create or open a vault named “My Notes” on your phone as well. A different name is treated as a separate sync space.

### 5. Run the first sync

Start with the device that has the most complete copy of your vault. Select **Sync now**, wait for the upload to finish, and then sync the other devices.

If a new device has no content yet:

1. Create an empty vault with the same name.
2. Install EasySync and sign in.
3. Select **Sync now**.
4. Wait for the cloud files to finish downloading.

The first sync scans the vault, hashes its files, and establishes a shared baseline. Large vaults or slower networks will take longer than later syncs.

## Recommended settings

Basic sync needs no extra configuration: notes and attachments in the vault are included by default.

Enable other options only when you need them:

| Setting | Recommendation |
| --- | --- |
| More settings | Enable only the editor, appearance, theme, hotkey, or plugin content that should match across devices |
| Community plugins | Syncs plugin code and the enabled list; plugin `data.json` files require the separate “Community plugin data” option |
| EasySync self-sync | Off by default; enable it only if EasySync updates should propagate to other devices |
| Auto sync | Runs at the configured interval; when disabled, **Sync now** remains available |
| Merge non-overlapping text changes | On by default; conflicts remain manual whenever safety cannot be proven |
| Apply remote deletions locally | Off by default; consider enabling it only after you understand the deletion rules |
| Diagnostic logging | Leave it off for normal use; enable it when investigating a problem and generating a diagnostic report |

Settings apply to the current vault only and do not automatically change other vaults.

## Where the cloud files are stored

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

## What EasySync does

- Two-way sync for Markdown, images, audio, PDFs, and other vault files.
- The same sync model on desktop and mobile.
- Content hashes for change detection instead of relying only on timestamps.
- Automatic merging of non-overlapping text edits that share a trusted baseline.
- Per-line diffs for text conflicts that cannot be handled safely.
- File size and modification time for binary conflicts such as images and PDFs.
- Persistent sidebar status for progress, conflicts, and pending decisions.
- Queueing and progress for handling several conflicts or decisions in sequence.
- Batch confirmation for remote deletions.
- Chunked uploads for large files.
- Recovery copies before a download overwrites a local file.
- One-click local Markdown diagnostic reports.

## How conflicts are handled

EasySync records the last successfully synced content and evaluates local and remote changes against that shared baseline.

It can handle cases such as these automatically:

- Only one side changed.
- Both sides have identical content.
- Both sides edited the same text file in non-overlapping locations.
- The remote file was deleted, the local file has not changed since the baseline, and you authorized the corresponding action.

Cases like these normally require your decision:

- Both sides changed the same line or overlapping content.
- No trustworthy shared version is available.
- A binary file such as an image, PDF, or archive changed on both sides.
- An Obsidian-managed configuration file conflicts.
- A file changed again after the sync plan was created.
- The account, vault scope, or remote version has changed.

EasySync does not overwrite one side merely because a file appears to be newer.

## Data and privacy

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

## Usage boundaries

EasySync is a cross-device file sync tool, not a real-time collaboration service.

Keep these limits in mind:

- Do not edit the same file on several devices at the same time.
- Do not let EasySync and another sync tool manage the same local vault.
- A move or rename may currently appear on another device as “one new file + one file pending deletion.”
- The first sync, large batches of small files, and large transfers need more time.
- Automatic handling runs only when all safety conditions are satisfied; otherwise, the operation stops or becomes a manual decision.
- Sync is not a substitute for an independent backup. Back up important data regularly.

If a file is deleted from OneDrive, you may also be able to recover it from the OneDrive recycle bin according to your account policy.

## Troubleshooting

Start by generating a **Diagnostic report** from EasySync settings.

When reporting an issue, include:

- EasySync version.
- Obsidian version.
- Operating system or mobile device type.
- The steps immediately before and after the issue.
- A redacted EasySync diagnostic report.

Report issues through [GitHub Issues](https://github.com/jiaoyingxing/easy-sync/issues).

## License

EasySync is source-available: the source is published for review and learning, but it is not distributed under an open-source license.

See [LICENSE](LICENSE) for the full terms.
