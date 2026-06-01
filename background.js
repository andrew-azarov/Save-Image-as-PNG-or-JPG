chrome.runtime.onInstalled.addListener(() =>
{
    chrome.contextMenus.create({
        id: "save-as-png",
        title: "Save image as PNG",
        contexts: ["image"]
    });
    chrome.contextMenus.create({
        id: "save-as-jpg",
        title: "Save image as JPG",
        contexts: ["image"]
    });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) =>
{
    if (info.menuItemId !== "save-as-png" && info.menuItemId !== "save-as-jpg")
    {
        return;
    }

    const format = info.menuItemId === "save-as-png" ? "png" : "jpeg";
    const srcUrl = info.srcUrl;

    if (!srcUrl)
    {
        showErrorNotification("No image URL found.");
        return;
    }

    await processAndDownloadImage(srcUrl, format, tab?.id ?? null);
});

/**
 * Handles fetching, verification, conversion, and downloading of the image.
 */
async function processAndDownloadImage(url, format, tabId)
{
    try
    {
        let blob;

        if (url.startsWith("blob:"))
        {
            if (!tabId)
            {
                throw new Error("Cannot retrieve blob image outside of an active tab context.");
            }
            blob = await fetchBlobFromTab(url, tabId);
        } else
        {
            const response = await fetch(url);

            if (!response.ok)
            {
                throw new Error(`Could not fetch image. HTTP ${response.status}`);
            }

            blob = await response.blob();
        }

        const mimeType = blob.type || "";

        const isSvg =
            mimeType === "image/svg+xml" ||
            url.toLowerCase().startsWith("data:image/svg+xml") ||
            url.toLowerCase().split("?")[0].split("#")[0].endsWith(".svg");

        if (!mimeType.startsWith("image/") && !isSvg)
        {
            showErrorNotification(`The resource is not a valid image. (MIME type: ${mimeType || "unknown"})`);
            return;
        }

        const originalFilename = getFilenameFromUrl(url, mimeType);
        const extension = format === "jpeg" ? "jpg" : "png";
        const targetFilename = changeExtension(originalFilename, extension);

        const backgroundColor = await getClosestBackgroundColorFromTab(tabId);

        let dataUrl;

        if (isSvg)
        {
            dataUrl = await renderSvgToDataUrl(blob, format, tabId, backgroundColor);
        } else
        {
            dataUrl = await renderRasterToDataUrl(blob, format, backgroundColor);
        }

        // 5. Trigger native Chrome download dialog
        chrome.downloads.download({
            url: dataUrl,
            filename: targetFilename,
            saveAs: true
        });
    } catch (error)
    {
        console.error("Error saving image:", error);
        showErrorNotification(`Failed to save image: ${error.message}`);
    }
}

async function renderRasterToDataUrl(blob, format, backgroundColor = "#FFFFFF")
{
    const imageBitmap = await createImageBitmap(blob);

    const canvas = new OffscreenCanvas(imageBitmap.width, imageBitmap.height);
    const ctx = canvas.getContext("2d");

    if (format === "jpeg")
    {
        ctx.fillStyle = backgroundColor || "#FFFFFF";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    ctx.drawImage(imageBitmap, 0, 0);

    const targetMimeType = `image/${format}`;
    const outputBlob = await canvas.convertToBlob({ type: targetMimeType });

    return await blobToDataURL(outputBlob);
}
async function getClosestBackgroundColorFromTab(tabId)
{
    if (!tabId)
    {
        return "#FFFFFF";
    }

    try
    {
        const response = await chrome.tabs.sendMessage(tabId, {
            type: "GET_LAST_RIGHT_CLICKED_IMAGE_CONTEXT"
        });

        if (!response || !response.ok)
        {
            console.warn(
                "Could not detect exact right-clicked image background:",
                response?.error
            );
            return "#FFFFFF";
        }

        return response.backgroundColor || "#FFFFFF";
    } catch (error)
    {
        console.warn("Could not contact content script:", error);
        return "#FFFFFF";
    }
}
async function renderSvgToDataUrl(blob, format, tabId, backgroundColor = "#FFFFFF")
{
    if (!tabId)
    {
        throw new Error("SVG conversion requires an active tab.");
    }

    const svgDataUrl = await blobToDataURL(blob);

    const result = await chrome.scripting.executeScript({
        target: { tabId },
        func: async (svgUrl, outputFormat, bgColor) =>
        {
            function loadImage(src)
            {
                return new Promise((resolve, reject) =>
                {
                    const img = new Image();

                    img.onload = () => resolve(img);
                    img.onerror = () => reject(new Error("Could not load SVG image."));

                    img.src = src;
                });
            }

            const img = await loadImage(svgUrl);

            const width = img.naturalWidth || 1024;
            const height = img.naturalHeight || 1024;

            const canvas = document.createElement("canvas");
            canvas.width = width;
            canvas.height = height;

            const ctx = canvas.getContext("2d");

            if (outputFormat === "jpeg")
            {
                ctx.fillStyle = bgColor || "#FFFFFF";
                ctx.fillRect(0, 0, width, height);
            }

            ctx.drawImage(img, 0, 0, width, height);

            return canvas.toDataURL(`image/${outputFormat}`, 0.92);
        },
        args: [svgDataUrl, format, backgroundColor]
    });

    const dataUrl = result[0]?.result;

    if (!dataUrl)
    {
        throw new Error("SVG conversion failed.");
    }

    return dataUrl;
}
/**
 * Executes a function in the web page's context to safely retrieve blob: URLs.
 */
async function fetchBlobFromTab(blobUrl, tabId)
{
    try
    {
        const result = await chrome.scripting.executeScript({
            target: { tabId: tabId },
            func: async (url) =>
            {
                try
                {
                    const res = await fetch(url);
                    const b = await res.blob();
                    return new Promise((resolve, reject) =>
                    {
                        const reader = new FileReader();
                        reader.onloadend = () => resolve({ dataUrl: reader.result, type: b.type });
                        reader.onerror = reject;
                        reader.readAsDataURL(b);
                    });
                } catch (e)
                {
                    return { error: e.message };
                }
            },
            args: [blobUrl]
        });

        const response = result[0]?.result;
        if (!response || response.error)
        {
            throw new Error(response?.error || "Unable to read blob data.");
        }

        const fetched = await fetch(response.dataUrl);
        return await fetched.blob();
    } catch (err)
    {
        throw new Error(`This website restricts context script execution. (${err.message})`);
    }
}

/**
 * Extracts a candidate filename from a URL or sets a fallback.
 */
function getFilenameFromUrl(url, mimeType)
{
    let filename = "image";
    try
    {
        if (url.startsWith("data:"))
        {
            return "downloaded_image";
        }
        const parsedUrl = new URL(url);
        const pathname = parsedUrl.pathname;
        const parts = pathname.split("/");
        const lastPart = parts[parts.length - 1];
        if (lastPart && lastPart.trim() !== "")
        {
            filename = decodeURIComponent(lastPart);
        }
    } catch (e) { }

    filename = filename.split("?")[0].split("#")[0];
    if (!filename || filename.trim() === "")
    {
        filename = "image";
    }
    return filename;
}

/**
 * Changes or appends a file extension.
 */
function changeExtension(filename, newExtension)
{
    const dotIndex = filename.lastIndexOf(".");
    if (dotIndex !== -1)
    {
        return filename.substring(0, dotIndex) + "." + newExtension;
    }
    return filename + "." + newExtension;
}

/**
 * Converts a Blob object to a base64 Data URL.
 */
function blobToDataURL(blob)
{
    return new Promise((resolve, reject) =>
    {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}

/**
 * Triggers a native system notification on error using a 1x1 transparent PNG icon placeholder.
 */
function showErrorNotification(message)
{
    chrome.notifications.create({
        type: "basic",
        iconUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
        title: "Image Converter Error",
        message: message,
        priority: 1
    });
}