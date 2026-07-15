# EasySync

Language: English | [简体中文](README-zh.md)

EasySync is a minimal two-way OneDrive sync plugin for Obsidian.

It is built for users who want:

- One plugin that works on desktop and mobile
- Conservative conflict handling instead of silent overwrites
- Optional sync for editor, appearance, theme, and plugin settings
- A visible sync state and a clear place to handle problems

EasySync is not a real-time collaboration system. Its goal is simple and safe cross-device sync with as little setup as possible.

## Requirements

- Obsidian `1.11.4` or newer
- A Microsoft account with OneDrive

## Quick start

1. Install and enable **EasySync**
2. Open the plugin settings and sign in with Microsoft
3. Choose whether to sync vault content only, or also selected Obsidian/plugin settings
4. Run **Sync now** from the settings page, ribbon icon, or sync sidebar
5. If a file needs attention, open the sync sidebar and handle the pending item there

## What it syncs

- Markdown notes and attachments in your vault
- Optional Obsidian settings such as editor, appearance, themes, hotkeys, and plugin settings
- Optional community plugin code and plugin data

## Why it is conservative

EasySync prefers safety over aggression:

- If both sides changed the same file, it does not silently overwrite one side
- If a file was deleted remotely, local deletion still requires confirmation
- If a file cannot be synced safely, other files can continue while the problem stays visible in the sync sidebar

## Current limitations

- It is not a CRDT or multi-user live collaboration plugin
- Some cross-device rename or move cases are still handled conservatively
- Large files on slow mobile networks can take a long time
- Text auto-merge exists, but it is still intentionally conservative

## OneDrive and privacy

- EasySync signs in with Microsoft OAuth
- Sync data is stored in the plugin's OneDrive App Folder area
- The plugin currently requests `Files.ReadWrite.AppFolder` and `Files.Read`
- It only talks to Microsoft OneDrive endpoints needed for sign-in and sync
- It does not collect telemetry or upload analytics
- Diagnostic logs stay local unless you choose to sync or export them yourself

## Mobile support

EasySync is designed for both desktop and mobile Obsidian.

It uses Obsidian-compatible APIs where possible, and current development keeps mobile compatibility as a first-class requirement. Large media files on mobile may still be slower than on desktop, especially on unstable networks.

## Installation

After approval, install EasySync from Obsidian Community Plugins.

Before that, you can install it manually from GitHub Releases:

1. Download `main.js`, `manifest.json`, and `styles.css`
2. Put them in:

```text
<vault>/.obsidian/plugins/easy-sync/
```

3. Enable **EasySync** in Obsidian Community Plugins

## Source availability

EasySync is source-available for inspection and review, but it is not released under an open-source license.

The current reviewable implementation is kept in [`src/`](src), with automated tests in [`tests/`](tests).

See [LICENSE](LICENSE) for details.
