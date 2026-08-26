# NovelAI Prompt Gallery

[English](README.md) | [简体中文](README.zh-CN.md)

A local image-based prompt library for the NovelAI image generation page. The extension adds a gallery panel to NovelAI so you can organize and reuse artist prompts and character tags through visual references.

It runs as an unpacked Microsoft Edge extension. No build step or companion application is required, and your images and prompts remain in a local folder selected by you.

> This is an independent project and is not affiliated with or endorsed by NovelAI.

## Features

- Two libraries: **Artist Prompts** and **Characters**.
- Enable one or more artist cards as a managed prompt prefix; the most recently clicked artist is placed at the very beginning.
- Active artist images turn grayscale and can be clicked again to disable and remove only their corresponding prompt.
- Click a character card to copy its tags to the clipboard without changing the card color.
- Enlarge any saved image, then zoom with the mouse wheel and pan by dragging.
- Top-of-page notifications show newest first with a yellow countdown bar and disappear within five seconds.
- Import local files or drag the current/history images directly from NovelAI.
- A web image is imported only when dropped inside the extension panel; drops elsewhere remain handled by NovelAI.
- Preserve original image bytes and existing PNG/WebP metadata without re-encoding.
- Verify imported files with SHA-256 before and after writing.
- Favorite, reorder, rename, recategorize, edit, and delete saved items.
- Compact and expanded gallery layouts.
- Minimize the panel to a tiny draggable icon and freely reposition the normal panel.
- Persist the normal-panel and minimized-icon positions across reloads and browser restarts.
- English interface by default, with instant English/Simplified Chinese switching from extension settings.
- Lazy image loading, limited concurrency, and an LRU cache for larger libraries.

## Requirements

- Microsoft Edge on Windows.
- Access to the [NovelAI](https://novelai.net/) image generation page.
- Either a release package or a Git checkout of this repository.
- A local folder in which the gallery data can be stored.

## Installation

This project is installed through Edge's **Load unpacked** feature. Choose either the release package or Git method below.

> **A ZIP file cannot be selected directly.** Despite the name “Load unpacked,” Edge requires an extracted directory whose root directly contains `manifest.json`.

### Option A: install from Releases (recommended)

1. Open the [Releases page](https://github.com/waw1w1/novelai-artist-library-extension/releases).
2. Open the newest release and download the asset named similar to:

   ```text
   novelai-prompt-gallery-v0.1.0-edge.zip
   ```

3. Right-click the downloaded ZIP and select **Extract All**.
4. Open the extracted directory and confirm that `manifest.json` is directly inside it.
5. Use that extracted directory when Edge asks you to select the unpacked extension.

The release package contains only the files required by the extension. Its archive root is already arranged for **Load unpacked**.

### Option B: install with Git clone

Run:

```powershell
git clone https://github.com/waw1w1/novelai-artist-library-extension.git
cd novelai-artist-library-extension
```

The extension is now in the `extension` subdirectory. Use that `extension` directory when Edge asks you to select the unpacked extension.

### Load the prepared directory in Edge

1. Open the following address in Edge:

   ```text
   edge://extensions/
   ```

2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select the correct directory:

   - Releases installation: select the extracted directory containing `manifest.json`.
   - Git installation: select `novelai-artist-library-extension/extension`.

   > Select the directory itself—not the ZIP, repository root, or `manifest.json` file.

5. Confirm that **NovelAI Prompt Gallery** appears in the extension list.
6. Open or refresh:

   ```text
   https://novelai.net/image
   ```

7. The gallery panel should appear in the lower-right corner of the page.

If the panel does not appear, click **Reload** for the extension on `edge://extensions/`, then refresh NovelAI.

## First-time setup

The extension needs a user-approved local folder for images and the library manifest.

1. Click the gear button in the gallery panel. You can also click the extension icon in the Edge toolbar.
2. Use the **Language** selector at the top of Settings to switch between English and Simplified Chinese. The change is applied immediately to all open gallery panels and is remembered across browser restarts.
3. Click **Select data directory** on the settings page.
4. Select a folder in the Windows folder picker.

Create a separate folder such as `NovelAI-Gallery`. A Git checkout may also use its ignored `data` folder. Do not select the `extension` folder.

5. Allow read/write access when Edge asks for permission.
6. Wait until the settings page reports that the folder is writable.
7. Return to NovelAI and refresh the page if necessary.

Edge requires the folder selection and permission to be confirmed by the user. The extension cannot silently acquire access from an absolute filesystem path.

## Data layout

The selected directory contains:

```text
Selected folder/
├─ library.json   # Prompts, categories, favorites, ordering, and UI state
└─ images/        # Original image files
```

Back up the entire folder to preserve the library. To move the library to another computer, copy the folder and select it again from the extension settings page. Uninstalling the extension does not intentionally delete this folder.

## Importing images

### From your computer

1. Click the `＋` button in the panel.
2. Select one or more images.
3. Choose **Artist Prompt** or **Character** for each image.
4. Review the name and saved prompt.
5. Click **Save**.

You can also drag files from Windows File Explorer directly into the panel.

### From the NovelAI page

Drag either of these directly into the extension panel:

- the current generated image in the center;
- an image from the history area.

The extension intercepts the drop only while the pointer is inside the panel. Dropping on the NovelAI canvas, history, or another page area continues to use NovelAI's normal behavior.

For web images, the extension retrieves the original image response instead of recreating it through Canvas. If an image URL has expired, authentication is no longer valid, or the browser blocks access, the panel displays an error. Saving the image locally and importing the file is the fallback.

## Saving prompts

The import editor can show:

- the current main NovelAI prompt;
- the current character prompts;
- a prompt extracted from image metadata;
- a short SHA-256 digest.

Prompt sources follow a strict priority order:

1. If the image contains recognizable **NovelAI metadata**, the saved prompt is taken from the image metadata. The current webpage prompt is not used.
2. Only when recognizable NovelAI metadata is absent does the extension use the current NovelAI page prompt as a fallback source.

If NovelAI metadata is present but does not contain a recognizable positive prompt, the extension leaves the saved prompt empty for manual review instead of silently mixing in the current webpage prompt. The editor always labels the active source as either **Image metadata** or **Current page fallback**.

The `【Main Prompt】` and `【Character 1】`-style labels in the snapshot are display headings only; they are never saved as executable prompt text.

When **Fill below** is used:

- **Artist Prompt:** only the current main prompt is inserted.
- **Character** with exactly one character prompt: only that character prompt is inserted.
- **Character** with multiple character prompts: nothing is merged automatically; select and copy the required character section manually.

The value in the saved prompt field is what will be used when the card is clicked later.

## Using the gallery

### Artist prompts

Open the **Artist Prompt** tab and click a card to enable it. The saved artist prompt is added to the beginning of the visible NovelAI main prompt, the card image turns grayscale, and an **Artist prompt enabled** notification appears.

More than one artist card can be active at the same time. Active prompts are ordered from top to bottom in click order, with the most recently enabled artist at the very top. Click any grayscale card again to disable it: that card returns to full color and only its corresponding artist prompt is removed.

The extension tracks the active artist prompts as a managed prefix at the beginning of the main prompt. You may freely edit the normal prompt text after this prefix, character prompts, negative prompts, and other NovelAI settings without changing the grayscale state. If any part of the managed artist prefix itself is edited, all active artist cards return to full color, an **Artist prompt changed** notification appears, and the cards can be enabled again. The extension preserves the user's edited text rather than overwriting it.

### Characters

Open the **Character** tab and click a card. Its saved tags are copied to the system clipboard, ready to paste into the appropriate NovelAI character prompt field.

Character cards never turn grayscale when clicked. A **Character tags copied** notification confirms a successful copy.

### Enlarging images

Click the magnifying-glass button immediately to the right of a card's heart button to open the full-screen image viewer. Use the mouse wheel to zoom, hold the left mouse button and drag to pan, or double-click to reset the view. Close the viewer with the `×` button or the `Esc` key.

### Notifications

Action notifications appear at the top of the webpage. Each notification includes a yellow progress bar that shrinks from full to empty and disappears within five seconds. When actions happen quickly, the newest notification is placed at the top and older notifications remain below it.

### Favorites and ordering

- Click the heart button to favorite or unfavorite an item.
- Favorite and normal items are sorted separately.
- Drag a card within its own section to reorder it.
- Cross-section ordering is intentionally rejected.

### Editing

Click the pencil button on a card to edit its category, display name, or saved prompt. Editing changes only `library.json`; it does not modify or re-encode the image.

### Deleting

Click the red `×` button on a card to open a confirmation dialog. Confirming removes the item from `library.json`, its ordering entries, and the corresponding original file in `images/`.

Deletion cannot be undone through the extension. Back up the data directory if the image may be needed later.

### Dragging an image back to NovelAI

Drag a gallery card out of the panel and drop it on NovelAI to pass the saved original file directly to NovelAI's current image input. The extension uses the original `File` bytes without Canvas rendering, downloading, or re-encoding, so any metadata originally present in that file remains intact and can be imported by NovelAI.

Dropping the card inside the panel still reorders it within its current favorite or normal section. Dropping it outside the panel switches to the NovelAI import action and does not change gallery ordering.

### Minimizing and moving the panel

- Click the `−` button immediately to the left of the expand button to collapse the gallery into a small `✦` icon.
- Click the small icon to restore the panel.
- Drag the small icon directly to move it.
- Drag the normal panel by an empty area of its header to move it.
- The expanded large panel is fixed in the center and cannot be dragged.
- The normal-panel and small-icon positions are saved separately in `library.json` and survive page reloads and browser restarts.

To restore the default lower-right position, open the extension settings and click **Reset panel position**. This also returns the gallery to the normal, non-expanded state.

## Panel controls

| Control | Action |
| --- | --- |
| `＋` | Import images from the computer |
| Gear | Open data directory settings |
| `−` | Collapse the panel into a small floating icon |
| Expand icon | Switch between compact and expanded layouts |
| Heart | Favorite or unfavorite a card |
| Magnifying glass | Open the image viewer with wheel zoom and drag-to-pan |
| Pencil | Edit category, name, or prompt |
| Red `×` | Permanently delete the item and its local image |

## Images and metadata

- Supported formats: PNG, JPEG, WebP, GIF, and AVIF.
- Maximum size per image: 32 MiB.
- Images are stored without thumbnail re-encoding.
- SHA-256 is verified after each image write.
- Existing metadata is preserved because the original file bytes are retained.
- Recognizable NovelAI metadata has priority over the live webpage prompt during import.
- Screenshots, clipboard images, and converted files may not contain the original generation metadata; the extension cannot recreate metadata that is not present in the source file.
- Abnormally large metadata is marked as too large to parse, while the original image can still be preserved.

## Updating

For a Releases installation, download the new package and extract it over the same extension directory, then click **Reload** in Edge. Keeping the same directory avoids unnecessarily changing the unpacked extension identity. If you load the update from a different directory instead, Edge may treat it as a new unpacked extension and ask you to select the data directory again; the existing gallery files are not deleted.

For a Git installation, update the checkout:

```powershell
cd novelai-artist-library-extension
git pull
```

After updating the files:

1. Open `edge://extensions/`.
2. Find **NovelAI Prompt Gallery**.
3. Click **Reload**.
4. Refresh any open NovelAI pages.

Updating the extension code does not delete the selected data directory.

## Troubleshooting

### The panel is missing

- Confirm that the current URL is `https://novelai.net/image` or one of its subpaths.
- Confirm that the extension is enabled.
- Reload the extension and refresh NovelAI.
- Approve any Edge prompt requesting access to the NovelAI site.
- If the panel or minimized icon was moved to an inconvenient location, use **Reset panel position** in the extension settings.

### The data directory needs authorization

Edge may suspend directory access after a browser restart, folder move, or permission change. Open the settings page and click **Reauthorize**. If the folder was moved or deleted, select the new location.

### Dragging a NovelAI image into the panel does nothing

- Make sure the pointer is inside the panel and that the import overlay appears.
- Allow the full-resolution history image to finish loading before dragging it.
- Confirm that the NovelAI login is still valid.
- Reload the extension and refresh NovelAI.
- If the web image URL has expired, save the image locally and import it with `＋`.

### An artist prompt is not inserted

- Confirm that you are on the image generation page.
- Return to the main Prompt tab and try again.
- Open the card editor and confirm that a saved prompt exists.
- Reload the page if NovelAI has recently changed its interface.

### Character tags are not copied

Keep the page in the foreground and allow clipboard access in Edge. The saved tags can also be copied manually from the card editor.

### Can `library.json` be edited manually?

It is not recommended while the extension is running. Invalid JSON, duplicate IDs, or broken ordering data can make the library unreadable. Back up the directory and close related NovelAI pages before making manual changes.

## Privacy and permissions

- Images and prompts are stored in the local folder selected by the user.
- The content script is loaded only on NovelAI pages.
- Access to NovelAI subdomains is used to retrieve web images dropped into the panel.
- Clipboard write permission is used to copy character tags.
- The extension has no cloud synchronization feature and does not intentionally upload the local gallery to an additional service.

## Development and tests

The production extension is located in `extension/` and does not require a build step.

Run the regression tests from the project root:

```powershell
npm test
```

The tests cover manifest data, ordering, original byte preservation, metadata parsing, request validation, and drag-and-drop boundaries.

## Project scope

The extension focuses on:

1. using images as visual indexes for prompts;
2. retaining local originals and their existing metadata;
3. quickly inserting artist prompts or copying character tags.

It is not intended to replace NovelAI Prompt Chunks, account synchronization, or the built-in image history.
