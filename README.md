[![AI-DECLARATION: copilot](https://img.shields.io/badge/䷼%20AI--DECLARATION-copilot-fee2e2?labelColor=fee2e2)](https://ai-declaration.md)

# Image Converter Saver

A lightweight Chrome extension that adds right-click menu actions for saving images as **PNG** or **JPG**. It supports common raster images and SVG images, and when converting transparent images to JPG, it can use the closest visible parent `background-color` from the page instead of always filling transparency with white.

## Features

- Save images as **PNG** from the right-click context menu
- Save images as **JPG** from the right-click context menu
- Convert raster images such as PNG, JPG, WebP, and GIF still frames
- Convert SVG images to PNG or JPG
- Preserve transparency when saving as PNG
- Fill transparency when saving as JPG
- Use the closest parent `background-color` for JPG background fill
- Fall back to white when no usable background color is found
- Supports normal image URLs, `data:` URLs, and many `blob:` image URLs
- Uses Chrome's native download dialog

## How It Works

The extension adds two context menu options when you right-click an image:

- **Save image as PNG**
- **Save image as JPG**

When one of these options is selected, the extension fetches the source image, decodes it, draws it to a canvas, converts it to the requested format, and starts a download.

For JPG output, transparent pixels need a solid background because JPG does not support transparency. The extension detects the actual image element that was right-clicked, walks upward through its parent elements, and uses the first non-transparent CSS `background-color` it finds. If no usable background color is found, it uses white.

## Project Structure

```text
.
├── manifest.json
├── background.js
├── content.js
└── README.md
```

## Installation for Development

1. Clone or download this repository.
2. Open Chrome and go to:

   ```text
   chrome://extensions
   ```

3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select the extension folder.
6. Open or reload a webpage with images.
7. Right-click an image and choose one of the save options.

## Required Manifest Permissions

The extension needs these permissions:

```json
{
  "permissions": [
    "contextMenus",
    "downloads",
    "notifications",
    "scripting",
    "activeTab"
  ],
  "host_permissions": [
    "<all_urls>"
  ]
}
```

### Why These Permissions Are Needed

| Permission | Purpose |
|---|---|
| `contextMenus` | Adds the right-click save options |
| `downloads` | Starts the converted image download |
| `notifications` | Shows error messages when conversion fails |
| `scripting` | Reads page-side image context and handles some SVG/blob cases |
| `activeTab` | Allows interaction with the current tab after user action |
| `<all_urls>` | Allows fetching images from different websites |

## Example Manifest

```json
{
  "manifest_version": 3,
  "name": "Image Converter Saver",
  "version": "1.0.0",
  "description": "Save images as PNG or JPG from the right-click menu, with SVG support and smart JPG background fill.",
  "permissions": [
    "contextMenus",
    "downloads",
    "notifications",
    "scripting",
    "activeTab"
  ],
  "host_permissions": [
    "<all_urls>"
  ],
  "background": {
    "service_worker": "background.js"
  },
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["content.js"],
      "run_at": "document_start",
      "all_frames": true
    }
  ]
}
```

## Usage

1. Navigate to a webpage with an image.
2. Right-click the image.
3. Choose either:
   - **Save image as PNG**
   - **Save image as JPG**
4. Choose where to save the converted file.

## JPG Background Behavior

When saving as JPG, transparency is filled using this order:

1. The closest parent element with a real CSS `background-color`
2. The page body background color
3. White, as a final fallback

Transparent or fully invisible background colors are ignored.

## SVG Support

SVG files are handled separately from raster images. Instead of relying only on `createImageBitmap`, the extension loads the SVG into an image element, draws it to a canvas, and exports the canvas as PNG or JPG.

This supports typical SVG usage such as:

```html
<img src="logo.svg">
```

and:

```html
<img src="data:image/svg+xml,...">
```

## Known Limitations

Some pages and images may still fail because of browser security restrictions.

Examples include:

- Chrome internal pages such as `chrome://...`
- Chrome Web Store pages
- Pages that block extension script injection
- SVGs that reference external resources in restricted ways
- Images that require authentication or special request headers
- Very large images that exceed browser canvas limits

For animated images, the saved result may be a still frame rather than an animation.

## Debugging

To inspect errors:

1. Open:

   ```text
   chrome://extensions
   ```

2. Enable **Developer mode**.
3. Find this extension.
4. Click the **service worker** link.
5. Retry the image conversion.
6. Check the console for error messages.

Common errors may include:

```text
Failed to fetch
Missing host permission
Cannot access contents of the page
Could not load SVG image
The resource is not a valid image
```

## Privacy

This extension does not collect analytics, does not track browsing history, and does not send converted images to a remote server.

Images are fetched by the browser, converted locally, and saved using Chrome's downloads API.

## Development Notes

The main logic lives in `background.js`:

- Creates context menu items
- Fetches image data
- Converts images through canvas
- Starts downloads
- Shows error notifications

The page-side helper logic lives in `content.js`:

- Records the exact image element that was right-clicked
- Finds the closest usable parent background color
- Sends that color back to the background service worker

## Contributing

Contributions are welcome. Useful improvements could include:

- Better inline SVG support
- Optional output quality setting for JPG
- Custom default background color
- Filename cleanup improvements
- Batch image saving
- Options page for user preferences

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.