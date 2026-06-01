let lastRightClickedImageElement = null;

document.addEventListener(
    "contextmenu",
    (event) =>
    {
        const target = event.target;

        if (!target || !target.closest)
        {
            lastRightClickedImageElement = null;
            return;
        }

        // Supports normal images, SVG images, and inline SVGs.
        lastRightClickedImageElement = target.closest("img, svg, image");
    },
    true
);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) =>
{
    if (message.type !== "GET_LAST_RIGHT_CLICKED_IMAGE_CONTEXT")
    {
        return;
    }

    try
    {
        if (!lastRightClickedImageElement)
        {
            sendResponse({
                ok: false,
                error: "No right-clicked image element found."
            });
            return;
        }

        const backgroundColor = getClosestParentBackgroundColor(
            lastRightClickedImageElement
        );

        sendResponse({
            ok: true,
            backgroundColor
        });
    } catch (error)
    {
        sendResponse({
            ok: false,
            error: error.message
        });
    }
});

function getClosestParentBackgroundColor(element)
{
    let current = element.parentElement;

    while (current && current !== document.documentElement)
    {
        const style = window.getComputedStyle(current);
        const bgColor = style.backgroundColor;

        if (isUsableBackgroundColor(bgColor))
        {
            return bgColor;
        }

        current = current.parentElement;
    }

    const bodyColor = window.getComputedStyle(document.body).backgroundColor;

    if (isUsableBackgroundColor(bodyColor))
    {
        return bodyColor;
    }

    return "#FFFFFF";
}

function isUsableBackgroundColor(color)
{
    if (!color) return false;
    if (color === "transparent") return false;
    if (color === "rgba(0, 0, 0, 0)") return false;
    if (color === "rgb(0 0 0 / 0)") return false;

    return true;
}