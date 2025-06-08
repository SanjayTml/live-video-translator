// content.js

let subtitleContainer = null;
let lastTextReceived = null;
let displayTimeout = null;

function createSubtitleContainer() {
    if (document.getElementById('live-audio-translator-subtitle-container')) {
        return document.getElementById('live-audio-translator-subtitle-container');
    }

    const container = document.createElement('div');
    container.id = 'live-audio-translator-subtitle-container';
    // Basic Styling - this should be made more robust
    container.style.position = 'fixed';
    container.style.bottom = '20px';
    container.style.left = '50%';
    container.style.transform = 'translateX(-50%)';
    container.style.backgroundColor = 'rgba(0, 0, 0, 0.7)';
    container.style.color = 'white';
    container.style.padding = '10px 20px';
    container.style.borderRadius = '8px';
    container.style.zIndex = '2147483647'; // Max z-index
    container.style.fontSize = '18px';
    container.style.fontFamily = 'sans-serif';
    container.style.textAlign = 'center';
    container.style.maxWidth = '80%';
    container.style.pointerEvents = 'none'; // Allow clicks to pass through
    container.style.visibility = 'hidden'; // Initially hidden

    document.body.appendChild(container);
    return container;
}

function displaySubtitle(text, duration = 5000) { // Show for 5 seconds by default
    if (!subtitleContainer) {
        subtitleContainer = createSubtitleContainer();
    }

    if (text && text.trim() !== "") {
        subtitleContainer.textContent = text;
        subtitleContainer.style.visibility = 'visible';
        lastTextReceived = text;

        // Clear previous timeout if new text arrives
        if (displayTimeout) {
            clearTimeout(displayTimeout);
        }

        // Hide after duration if it's still the same text
        displayTimeout = setTimeout(() => {
            if (subtitleContainer && subtitleContainer.textContent === text) {
                subtitleContainer.style.visibility = 'hidden';
            }
        }, duration);
    } else {
        // If empty text is received, hide immediately
        if (subtitleContainer) {
            subtitleContainer.style.visibility = 'hidden';
        }
        if (displayTimeout) {
            clearTimeout(displayTimeout);
        }
    }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "displaySubtitle") {
        let textToDisplay = "";
        if (request.translatedText) {
            textToDisplay = request.translatedText;
        } else if (request.transcribedText) {
            textToDisplay = request.transcribedText; // Fallback to transcribed if no translation
        }

        console.log("Content script received subtitle:", textToDisplay);
        displaySubtitle(textToDisplay, request.duration);
        sendResponse({ success: true });
    } else if (request.action === "hideSubtitle") {
        if (subtitleContainer) {
            subtitleContainer.style.visibility = 'hidden';
        }
        if (displayTimeout) {
            clearTimeout(displayTimeout);
        }
        sendResponse({ success: true });
    }
});

// Initialize container on load (optional, can be created on first message)
// subtitleContainer = createSubtitleContainer();
console.log("Live Audio Translator content script loaded.");

// TODO: Add a setting to enable/disable subtitles from popup.
// TODO: Allow user to customize subtitle appearance (position, size, color).
