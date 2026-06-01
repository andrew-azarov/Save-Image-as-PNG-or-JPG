const MENU_IDS = Object.freeze({
    PNG: "save-as-png",
    JPG: "save-as-jpg"
});

const DEFAULT_BACKGROUND_COLOR = "#FFFFFF";
const MAX_BLOB_SIZE_BYTES = 25 * 1024 * 1024;
const MAX_CANVAS_PIXELS = 64 * 1000 * 1000;
const FETCH_TIMEOUT_MS = 15000;
const SVG_RENDER_TIMEOUT_MS = 10000;
const JPEG_QUALITY = 0.92;

chrome.runtime.onInstalled.addListener(() =>
{
    registerContextMenus();
});

function registerContextMenus()
{
    chrome.contextMenus.removeAll(() =>
    {
        chrome.contextMenus.create({
            id: MENU_IDS.PNG,
            title: "Save image as PNG",
            contexts: ["image"]
        });

        chrome.contextMenus.create({
            id: MENU_IDS.JPG,
            title: "Save image as JPG",
            contexts: ["image"]
        });
    });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) =>
{
    try
    {
        await handleContextMenuClick(info, tab);
    } catch (error)
    {
        console.error("Image conversion failed:", error);
        showErrorNotification(`Failed to save image: ${getSafeErrorMessage(error)}`);
    }
});

async function handleContextMenuClick(info, tab)
{
    if (info.menuItemId !== MENU_IDS.PNG && info.menuItemId !== MENU_IDS.JPG)
    {
        return;
    }

    const format = info.menuItemId === MENU_IDS.PNG ? "png" : "jpeg";
    const srcUrl = info.srcUrl;
    const tabId = tab?.id ?? null;

    if (!srcUrl)
    {
        throw new Error("No image URL found.");
    }

    await processAndDownloadImage(srcUrl, format, tabId);
}

async function processAndDownloadImage(url, format, tabId)
{
    if (!isAllowedImageUrl(url))
    {
        throw new Error("This image URL type is not supported.");
    }

    const blob = url.startsWith("blob:")
        ? await fetchBlobFromTab(url, tabId)
        : await fetchWithTimeout(url);

    validateBlobSize(blob);

    const mimeType = normalizeMimeType(blob.type);
    const isSvg = isSvgImage(url, mimeType);

    if (!mimeType.startsWith("image/") && !isSvg)
    {
        throw new Error(`The resource is not a valid image. MIME type: ${mimeType || "unknown"}.`);
    }

    const extension = format === "jpeg" ? "jpg" : "png";
    const targetFilename = buildTargetFilename(url, extension);
    const backgroundColor = await getClosestBackgroundColorFromTab(tabId);

    const dataUrl = isSvg
        ? await renderSvgToDataUrl(blob, format, tabId, backgroundColor)
        : await renderRasterToDataUrl(blob, format, backgroundColor);

    await downloadDataUrl(dataUrl, targetFilename);
}

function isAllowedImageUrl(url)
{
    if (typeof url !== "string")
    {
        return false;
    }

    if (/^data:image\//i.test(url))
    {
        return true;
    }

    if (url.startsWith("blob:"))
    {
        return true;
    }

    try
    {
        const parsedUrl = new URL(url);
        return parsedUrl.protocol === "http:" || parsedUrl.protocol === "https:";
    } catch
    {
        return false;
    }
}

function normalizeMimeType(mimeType)
{
    return String(mimeType || "").toLowerCase().split(";")[0].trim();
}

function isSvgImage(url, mimeType)
{
    const normalizedUrl = String(url || "").toLowerCase();
    const pathOnly = normalizedUrl.split("?")[0].split("#")[0];

    return (
        mimeType === "image/svg+xml" ||
        normalizedUrl.startsWith("data:image/svg+xml") ||
        pathOnly.endsWith(".svg")
    );
}

async function fetchWithTimeout(url, timeoutMs = FETCH_TIMEOUT_MS)
{
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try
    {
        const response = await fetch(url, {
            signal: controller.signal,
            credentials: "omit",
            cache: "no-store"
        });

        if (!response.ok)
        {
            throw new Error("Image request failed.");
        }

        const blob = await response.blob();
        validateBlobSize(blob);

        return blob;
    } catch (error)
    {
        if (error?.name === "AbortError")
        {
            throw new Error("Image request timed out.");
        }

        throw error;
    } finally
    {
        clearTimeout(timeoutId);
    }
}

function validateBlobSize(blob)
{
    if (!blob || typeof blob.size !== "number")
    {
        throw new Error("Invalid image data.");
    }

    if (blob.size > MAX_BLOB_SIZE_BYTES)
    {
        throw new Error("Image is too large to convert safely.");
    }
}

function assertSafeCanvasSize(width, height)
{
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0)
    {
        throw new Error("Invalid image dimensions.");
    }

    if (width * height > MAX_CANVAS_PIXELS)
    {
        throw new Error("Image is too large to convert safely.");
    }
}

async function renderRasterToDataUrl(blob, format, backgroundColor = DEFAULT_BACKGROUND_COLOR)
{
    const imageBitmap = await createImageBitmap(blob);

    try
    {
        assertSafeCanvasSize(imageBitmap.width, imageBitmap.height);

        const canvas = new OffscreenCanvas(imageBitmap.width, imageBitmap.height);
        const ctx = canvas.getContext("2d");

        if (!ctx)
        {
            throw new Error("Could not create canvas context.");
        }

        if (format === "jpeg")
        {
            ctx.fillStyle = backgroundColor || DEFAULT_BACKGROUND_COLOR;
            ctx.fillRect(0, 0, canvas.width, canvas.height);
        }

        ctx.drawImage(imageBitmap, 0, 0);

        const outputBlob = await canvas.convertToBlob({
            type: `image/${format}`,
            quality: format === "jpeg" ? JPEG_QUALITY : undefined
        });

        validateBlobSize(outputBlob);

        return await blobToDataURL(outputBlob);
    } finally
    {
        imageBitmap.close();
    }
}

async function renderSvgToDataUrl(blob, format, tabId, backgroundColor = DEFAULT_BACKGROUND_COLOR)
{
    if (!tabId)
    {
        throw new Error("SVG conversion requires an active tab.");
    }

    const svgDataUrl = await blobToDataURL(blob);

    const result = await chrome.scripting.executeScript({
        target: { tabId },
        func: async (svgUrl, outputFormat, bgColor, maxPixels, renderTimeoutMs, jpegQuality) =>
        {
            function assertSafeCanvasSizeInPage(width, height)
            {
                if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0)
                {
                    throw new Error("Invalid SVG dimensions.");
                }

                if (width * height > maxPixels)
                {
                    throw new Error("SVG is too large to convert safely.");
                }
            }

            function loadImage(src)
            {
                return new Promise((resolve, reject) =>
                {
                    const img = new Image();
                    const timeoutId = setTimeout(() =>
                    {
                        img.src = "";
                        reject(new Error("SVG rendering timed out."));
                    }, renderTimeoutMs);

                    img.onload = () =>
                    {
                        clearTimeout(timeoutId);
                        resolve(img);
                    };

                    img.onerror = () =>
                    {
                        clearTimeout(timeoutId);
                        reject(new Error("Could not load SVG image."));
                    };

                    img.src = src;
                });
            }

            const img = await loadImage(svgUrl);
            const width = img.naturalWidth || 1024;
            const height = img.naturalHeight || 1024;

            assertSafeCanvasSizeInPage(width, height);

            const canvas = document.createElement("canvas");
            canvas.width = width;
            canvas.height = height;

            const ctx = canvas.getContext("2d");

            if (!ctx)
            {
                throw new Error("Could not create canvas context.");
            }

            if (outputFormat === "jpeg")
            {
                ctx.fillStyle = bgColor || "#FFFFFF";
                ctx.fillRect(0, 0, width, height);
            }

            ctx.drawImage(img, 0, 0, width, height);

            return canvas.toDataURL(`image/${outputFormat}`, jpegQuality);
        },
        args: [
            svgDataUrl,
            format,
            backgroundColor,
            MAX_CANVAS_PIXELS,
            SVG_RENDER_TIMEOUT_MS,
            JPEG_QUALITY
        ]
    });

    const dataUrl = result[0]?.result;

    if (!dataUrl)
    {
        throw new Error("SVG conversion failed.");
    }

    return dataUrl;
}

async function fetchBlobFromTab(blobUrl, tabId)
{
    if (!tabId)
    {
        throw new Error("Cannot retrieve blob image outside of an active tab context.");
    }

    try
    {
        const result = await chrome.scripting.executeScript({
            target: { tabId },
            func: async (url, maxBlobSizeBytes, timeoutMs) =>
            {
                function validateBlobSizeInPage(blob)
                {
                    if (!blob || typeof blob.size !== "number")
                    {
                        throw new Error("Invalid blob data.");
                    }

                    if (blob.size > maxBlobSizeBytes)
                    {
                        throw new Error("Image is too large to convert safely.");
                    }
                }

                function blobToDataURLInPage(blob)
                {
                    return new Promise((resolve, reject) =>
                    {
                        const reader = new FileReader();
                        reader.onloadend = () => resolve(reader.result);
                        reader.onerror = () => reject(new Error("Could not read blob data."));
                        reader.readAsDataURL(blob);
                    });
                }

                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

                try
                {
                    const response = await fetch(url, { signal: controller.signal });

                    if (!response.ok)
                    {
                        throw new Error("Blob image request failed.");
                    }

                    const blob = await response.blob();
                    validateBlobSizeInPage(blob);

                    return {
                        ok: true,
                        dataUrl: await blobToDataURLInPage(blob),
                        type: blob.type || ""
                    };
                } catch (error)
                {
                    return {
                        ok: false,
                        error: error?.name === "AbortError" ? "Blob image request timed out." : error.message
                    };
                } finally
                {
                    clearTimeout(timeoutId);
                }
            },
            args: [blobUrl, MAX_BLOB_SIZE_BYTES, FETCH_TIMEOUT_MS]
        });

        const response = result[0]?.result;

        if (!response || !response.ok)
        {
            throw new Error(response?.error || "Unable to read blob data.");
        }

        const blob = await fetchWithTimeout(response.dataUrl);
        validateBlobSize(blob);

        return blob;
    } catch (error)
    {
        throw new Error(`This website restricts context script execution. (${error.message})`);
    }
}

async function getClosestBackgroundColorFromTab(tabId)
{
    if (!tabId)
    {
        return DEFAULT_BACKGROUND_COLOR;
    }

    try
    {
        const response = await chrome.tabs.sendMessage(tabId, {
            type: "GET_LAST_RIGHT_CLICKED_IMAGE_CONTEXT"
        });

        if (!response || !response.ok)
        {
            console.warn("Could not detect exact right-clicked image background:", response?.error);
            return DEFAULT_BACKGROUND_COLOR;
        }

        return response.backgroundColor || DEFAULT_BACKGROUND_COLOR;
    } catch (error)
    {
        console.warn("Could not contact content script:", error);
        return DEFAULT_BACKGROUND_COLOR;
    }
}

function buildTargetFilename(url, extension)
{
    const originalFilename = getFilenameFromUrl(url);
    const changedFilename = changeExtension(originalFilename, extension);
    return sanitizeFilename(changedFilename, `image.${extension}`);
}

function getFilenameFromUrl(url)
{
    if (String(url).startsWith("data:"))
    {
        return "downloaded_image";
    }

    try
    {
        const parsedUrl = new URL(url);
        const lastPart = parsedUrl.pathname.split("/").filter(Boolean).pop();

        if (!lastPart)
        {
            return "image";
        }

        try
        {
            return decodeURIComponent(lastPart);
        } catch
        {
            return lastPart;
        }
    } catch
    {
        return "image";
    }
}

function changeExtension(filename, newExtension)
{
    const cleanExtension = String(newExtension || "").replace(/^\./, "") || "png";
    const dotIndex = filename.lastIndexOf(".");

    if (dotIndex > 0)
    {
        return `${filename.substring(0, dotIndex)}.${cleanExtension}`;
    }

    return `${filename}.${cleanExtension}`;
}

function sanitizeFilename(filename, fallback = "image")
{
    const fallbackName = fallback || "image";

    let safe = String(filename || fallbackName)
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
        .replace(/\s+/g, " ")
        .replace(/^\.+/, "")
        .trim();

    if (!safe)
    {
        safe = fallbackName;
    }

    const reservedNames = new Set([
        "CON", "PRN", "AUX", "NUL",
        "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
        "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9"
    ]);

    const baseName = safe.split(".")[0].toUpperCase();

    if (reservedNames.has(baseName))
    {
        safe = `_${safe}`;
    }

    if (safe.length > 180)
    {
        const extensionMatch = safe.match(/\.[^.]{1,12}$/);
        const extension = extensionMatch ? extensionMatch[0] : "";
        safe = `${safe.slice(0, 180 - extension.length)}${extension}`;
    }

    return safe || fallbackName;
}

function blobToDataURL(blob)
{
    return new Promise((resolve, reject) =>
    {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.onerror = () => reject(new Error("Could not read image data."));
        reader.readAsDataURL(blob);
    });
}

function downloadDataUrl(dataUrl, filename)
{
    return new Promise((resolve, reject) =>
    {
        chrome.downloads.download(
            {
                url: dataUrl,
                filename,
                saveAs: true,
                conflictAction: "uniquify"
            },
            (downloadId) =>
            {
                if (chrome.runtime.lastError)
                {
                    reject(new Error("Download failed."));
                    return;
                }

                resolve(downloadId);
            }
        );
    });
}

function getSafeErrorMessage(error)
{
    const message = error?.message || "Unknown error.";
    return String(message).replace(/\bhttps?:\/\/\S+/gi, "[url]").slice(0, 240);
}

function showErrorNotification(message)
{
    chrome.notifications.create(
        {
            type: "basic",
            iconUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
            title: "Image Converter Error",
            message: getSafeErrorMessage({ message }),
            priority: 1
        },
        () =>
        {
            if (chrome.runtime.lastError)
            {
                console.warn("Could not show notification:", chrome.runtime.lastError.message);
            }
        }
    );
}
