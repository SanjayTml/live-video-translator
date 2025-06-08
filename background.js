// background.js

// background.js (Additions/Modifications)

// At the top with other global state:
let offscreenDocumentPath = 'offscreen.html';
let sttPort = null; // For future direct communication if needed, for now using runtime.sendMessage

// Argos Translate globals
let argosModel_en_es = null;
let argosLoadingPromise_en_es = null;
const ARGOS_LIB_PATH = chrome.runtime.getURL('lib/argos-translate/'); // Path to WASM etc.
const ARGOS_MODEL_EN_ES_URL = chrome.runtime.getURL('models/argos-translate-models/en_es.argosmodel');

// Global state
let isTranscribing = false;
let audioStream = null;
let currentTabId = null;

let audioContext = null;
let workletNode = null;
let mediaStreamSource = null;
let isUsingWorkletPipeline = false; // Flag to control STT method

// Helper function to manage the offscreen document
async function ensureOffscreenDocument() {
    const existingContexts = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT'],
        documentUrls: [chrome.runtime.getURL(offscreenDocumentPath)]
    });

    if (existingContexts.length > 0) {
        console.log("Offscreen document already exists.");
        return;
    }

    console.log("Creating offscreen document.");
    await chrome.offscreen.createDocument({
        url: offscreenDocumentPath,
        reasons: ['USER_MEDIA'],
        justification: 'Required for speech-to-text processing.',
    });
}

// Modify startTranscription to initiate STT in offscreen document
async function startTranscription(sendResponseToPopup) {
    if (isTranscribing) {
        sendResponseToPopup({ success: false, error: "Transcription already in progress." });
        return;
    }

    isTranscribing = true;
    isUsingWorkletPipeline = false; // Reset flag

    await ensureOffscreenDocument(); // Existing function

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (!tabs || tabs.length === 0) {
            // ... (error handling as before) ...
            isTranscribing = false; sendResponseToPopup({ success: false, error: "No active tab found." }); return;
        }
        currentTabId = tabs[0].id;
        const currentUrl = tabs[0].url;
        const restrictedPrefixes = ['chrome://', 'https://chrome.google.com/', 'about:'];

        if (restrictedPrefixes.some(prefix => currentUrl.startsWith(prefix))) {
            console.error("Cannot capture audio on restricted page:", currentUrl);
            sendResponseToPopup({ success: false, error: "Cannot capture audio on this page." });
            isTranscribing = false;
            return;
        }

        chrome.tabCapture.capture({ audio: true, video: false }, async (stream) => {
            if (chrome.runtime.lastError || !stream) {
                // ... (error handling as before, including notifying popup) ...
                isTranscribing = false; sendResponseToPopup({ success: false, error: chrome.runtime.lastError?.message || "Failed to capture tab." }); return;
            }

            console.log("Audio capture started for tab:", currentTabId);
            audioStream = stream; // Keep the original stream reference for stopping
            isUsingWorkletPipeline = true; // Enable new pipeline

            try {
                audioContext = new AudioContext();
                // Ensure AudioContext is resumed (it often starts suspended)
                if (audioContext.state === 'suspended') {
                    await audioContext.resume();
                }

                await audioContext.audioWorklet.addModule(chrome.runtime.getURL('audio-processor.js'));
                mediaStreamSource = audioContext.createMediaStreamSource(stream);
                workletNode = new AudioWorkletNode(audioContext, 'audio-chunk-processor');

                workletNode.port.onmessage = (event) => {
                    if (event.data.action === "audioData" && event.data.buffer) {
                        // Forward this audio data to offscreen.js
                        chrome.runtime.sendMessage({
                            action: "processAudioChunk",
                            audioBuffer: event.data.buffer
                        }).catch(e => console.warn("Error sending audio chunk to offscreen.js:", e.message));
                    }
                };

                mediaStreamSource.connect(workletNode).connect(audioContext.destination); // Connect to destination to keep graph alive

                // Tell offscreen.js to use the new pipeline (and not start SpeechRecognition)
                chrome.runtime.sendMessage({ action: "switchToAudioChunkProcessing" })
                    .then(() => {
                        sendResponseToPopup({ success: true, status: "Transcription started (using audio worklet)." });
                        chrome.runtime.sendMessage({ action: "transcriptionStateChanged", isTranscribing: true, statusMessage: "Transcribing (Worklet)..." })
                            .catch(e => console.warn("Could not send state update to popup", e));
                    })
                    .catch(e => {
                         console.error("Failed to switch offscreen to chunk processing:", e);
                         // Fallback or error
                         stopTranscriptionInternal("Worklet setup failed");
                         sendResponseToPopup({ success: false, error: "Failed to initialize STT pipeline." });
                    });

            } catch (error) {
                console.error("Error setting up AudioWorklet pipeline:", error);
                stopTranscriptionInternal("AudioWorklet setup error");
                sendResponseToPopup({ success: false, error: "AudioWorklet setup error: " + error.message });
                isUsingWorkletPipeline = false;
                return;
            }

            // Handle stream inactivity (original logic)
            stream.oninactive = () => {
                console.log("Audio stream became inactive.");
                if (isTranscribing) {
                    stopTranscriptionInternal("Stream inactive");
                }
            };
        });
    });
}

// Modify stopTranscriptionInternal
function stopTranscriptionInternal(reason = "User requested") {
    console.log(`Stopping transcription. Reason: ${reason}`);
    if (isUsingWorkletPipeline) {
        if (workletNode) {
            workletNode.port.postMessage('stop'); // Tell worklet to stop (optional)
            workletNode.disconnect();
            workletNode = null;
        }
        if (mediaStreamSource) {
            mediaStreamSource.disconnect();
            mediaStreamSource = null;
        }
        if (audioContext && audioContext.state !== 'closed') {
            audioContext.close().then(() => console.log("AudioContext closed."));
            audioContext = null;
        }
        isUsingWorkletPipeline = false;
    } else {
        // Old STT stopping logic (telling offscreen.js to stop SpeechRecognition)
        chrome.runtime.sendMessage({ action: "stopSTT" }).catch(e => console.warn("Failed to send stopSTT to offscreen", e));
    }

    if (audioStream) { // This is the original MediaStream from tabCapture
        audioStream.getTracks().forEach(track => track.stop());
        audioStream = null;
    }

    isTranscribing = false;
    // ... (rest of stopTranscriptionInternal: notify popup, hide subtitles) ...
    chrome.runtime.sendMessage({
        action: "transcriptionStateChanged",
        isTranscribing: false,
        statusMessage: `Idle. ${reason}`
    }).catch(e => console.warn("Could not send state update to popup", e));

    // Hide subtitles in content script
    if (currentTabId) {
        chrome.tabs.sendMessage(currentTabId, { action: "hideSubtitle" })
            .catch(e => console.warn(`Failed to send hideSubtitle to content script on tab ${currentTabId}: ${e.message}`));
    }
    // currentTabId is reset by the original stopTranscription caller or tab events
}

// Helper function to send subtitle data to content script
function sendSubtitleToContentScript(tabId, data) {
    // data should be an object like { transcribedText: "...", translatedText: "...", duration: 5000 }
    chrome.tabs.sendMessage(tabId, { action: "displaySubtitle", ...data })
        .then(response => {
            if (chrome.runtime.lastError) {
                // This error often means the content script isn't injected or ready on that tab/page
                // (e.g., chrome:// pages, file:// URLs without access, or extension pages themselves)
                console.warn(`Could not send subtitle to tab ${tabId}: ${chrome.runtime.lastError.message}. Content script might not be active or accessible.`);
            } else if (response && response.success) {
                // console.log(`Subtitle sent to content script on tab ${tabId}`);
            } else {
                // console.warn(`Content script on tab ${tabId} may not have handled subtitle message correctly.`);
            }
        })
        .catch(error => {
             // This catch is for promise rejection, often due to the tab not being available
             console.warn(`Error sending message to content script on tab ${tabId}: ${error.message}`);
        });
}

// Helper to initialize and load the Argos Translate En->Es model
async function initializeAndLoadArgosEnEsModel() {
    if (argosModel_en_es) {
        return argosModel_en_es;
    }
    if (argosLoadingPromise_en_es) {
        return argosLoadingPromise_en_es;
    }

    argosLoadingPromise_en_es = (async () => {
        try {
            // Dynamically import the Argos Translate script
            // Assumes argos_translate.js defines 'self.argosTranslate' or similar global
            importScripts(chrome.runtime.getURL('lib/argos-translate/argos_translate.js'));

            if (!self.argosTranslate || typeof self.argosTranslate.setLibPath !== 'function') {
                throw new Error("Argos Translate library not loaded correctly.");
            }

            // Set the path for WASM file if needed by the library
            self.argosTranslate.setLibPath(ARGOS_LIB_PATH);

            console.log("Background: Loading Argos Translate En->Es model from:", ARGOS_MODEL_EN_ES_URL);
            // The actual Argos JS API might differ for loading models.
            // This assumes loadModel takes fromCode, toCode, and a URL to the .argosmodel file.
            argosModel_en_es = await self.argosTranslate.loadModel("en", "es", ARGOS_MODEL_EN_ES_URL);
            console.log("Background: Argos Translate En->Es model loaded successfully.");
            return argosModel_en_es;
        } catch (error) {
            console.error("Background: Failed to load Argos Translate En->Es model:", error);
            argosModel_en_es = null; // Ensure it's null on failure
            throw error; // Re-throw to be caught by caller
        } finally {
            argosLoadingPromise_en_es = null; // Clear promise once settled
        }
    })();
    return argosLoadingPromise_en_es;
}

// Attempt to preload the model when the extension starts (optional)
initializeAndLoadArgosEnEsModel().catch(err => {
    console.warn("Background: Pre-loading Argos En-Es model failed on startup. Will try again on demand.", err.message);
});


// Modify the translateText function
async function translateText(text, targetLang) {
    if (!text || !targetLang) {
        return null;
    }
    const sourceLang = 'en'; // Assuming STT is always English for now

    // OFFLINE: English to Spanish using Argos Translate
    if (sourceLang === 'en' && targetLang === 'es') {
        try {
            const model = await initializeAndLoadArgosEnEsModel();
            if (model) {
                console.log(`Background: Translating (offline En->Es) "${text}"`);
                const translated = await self.argosTranslate.translate(model, text); // Or model.translate(text)
                console.log("Background: Offline translation successful (En->Es):", translated);
                return translated;
            } else {
                throw new Error("Argos En->Es model not available.");
            }
        } catch (error) {
            console.error(`Background: Offline translation En->Es failed for "${text}":`, error);
            // Fallback to online or return error (for this step, let's return an error message)
            return `Offline En->Es translation error: ${error.message}. Try other languages for online.`;
        }
    }

    // ONLINE FALLBACK (MyMemory API - existing logic)
    console.warn(`Background: No offline model for ${sourceLang}->${targetLang}. Using online MyMemory API.`);
    const langPair = `${sourceLang}|${targetLang}`;
    const apiUrl = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${langPair}`;

    try {
        console.log(`Background: Translating (online) "${text}" from ${sourceLang} to ${targetLang}`);
        const response = await fetch(apiUrl);
        // ... (rest of MyMemory API handling as before) ...
        if (!response.ok) {
            console.error("Translation API request failed:", response.status, response.statusText);
            return `Error: API request failed (${response.status})`;
        }
        const data = await response.json();
        if (data.responseStatus !== 200) { /* ... error ... */ return `Error: Translation failed - ${data.responseDetails}`; }
        if (data.responseData && data.responseData.translatedText) {
            console.log("Background: Online translation successful:", data.responseData.translatedText);
            return data.responseData.translatedText;
        } else { /* ... error ... */ return "Error: Unexpected API response."; }

    } catch (error) {
        console.error("Error during online translation fetch:", error);
        return `Error: Could not connect to online translation service. ${error.message}`;
    }
}


// Original stopTranscription now calls the internal version and handles popup response
function stopTranscription(sendResponseToPopup) {
    if (!isTranscribing && !audioStream) { // Check if not already stopped
        sendResponseToPopup({ success: true, status: "Transcription already stopped." });
        return;
    }
    stopTranscriptionInternal("User requested");
    if (currentTabId !== null) {
        console.log("Audio capture stopped for tab:", currentTabId);
    }
    currentTabId = null;
    console.log("Transcription stopped.");
    sendResponseToPopup({ success: true, status: "Transcription stopped" });
}


// Modify the main message listener in background.js
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "startStopTranscription") {
        // Check current state (more reliably than popup)
        // Querying isTranscribing directly
        if (!isTranscribing) {
            startTranscription(sendResponse).catch(e => { // Catch async errors from startTranscription
                console.error("Error in startTranscription flow:", e);
                sendResponse({ success: false, error: e.message || "Unknown error starting transcription." });
                isTranscribing = false; // Ensure state is reset
                chrome.runtime.sendMessage({ action: "transcriptionStateChanged", isTranscribing: false, statusMessage: "Error starting" })
                    .catch(err => console.warn("Could not send state update to popup", err));
            });
        } else {
            stopTranscription(sendResponse);
        }
        return true; // Keep channel open for async response from start/stopTranscription
    }
    // New: Listen for STT results from offscreen.js
    else if (request.action === "sttResult") {
        // console.log("Background: Received STT result:", request.text, "(type:", request.type, ")");

        const isFinal = request.type === "final" && request.text.trim();
        const textContent = request.text.trim();

        // Send to popup (existing logic)
        chrome.runtime.sendMessage({
            action: "updateDisplay",
            transcribedText: textContent,
            statusUpdate: isFinal ? "Final transcript. Translating..." : "Interim transcript..."
        }).catch(e => console.warn("Could not send STT result to popup", e));

        // Also send to content script (if currentTabId is set)
        if (currentTabId && textContent) {
            if (isFinal) {
                // For final results, translation will follow.
                // We can send the transcribed text first, then the translated one.
                sendSubtitleToContentScript(currentTabId, { transcribedText: textContent, duration: 3000 }); // Show transcription briefly
            } else {
                // For interim results, send immediately for quick display
                sendSubtitleToContentScript(currentTabId, { transcribedText: textContent, duration: 3000 });
            }
        }

        if (isFinal) {
            const finalText = textContent;
            chrome.storage.local.get(['targetLanguage'], async (result) => {
                const targetLang = result.targetLanguage || 'es';
                const translatedText = await translateText(finalText, targetLang);

                if (translatedText) {
                    // Send translation to popup
                    chrome.runtime.sendMessage({
                        action: "updateDisplay",
                        translatedText: translatedText,
                        statusUpdate: `Translated to ${targetLang.toUpperCase()}`
                    }).catch(e => console.warn("Could not send translation to popup", e));

                    // Send translation to content script
                    if (currentTabId) {
                        sendSubtitleToContentScript(currentTabId, { translatedText: translatedText, duration: 7000 }); // Show translation longer
                    }
                } else {
                     chrome.runtime.sendMessage({
                        action: "updateDisplay",
                        statusUpdate: "Translation failed."
                    }).catch(e => console.warn("Could not send translation failure status to popup", e));
                     // Optionally, inform content script translation failed or hide subtitle
                     if (currentTabId) {
                        // sendSubtitleToContentScript(currentTabId, { transcribedText: finalText, translatedText: "Translation failed.", duration: 5000 });
                        // Or send a hide message if preferred
                         chrome.tabs.sendMessage(currentTabId, { action: "hideSubtitle" }).catch(e => console.warn("Failed to send hideSubtitle to content script", e));
                     }
                }
            });
        }
        sendResponse({ success: true });
        return true;
    }
    // New: Listen for STT errors from offscreen.js
    else if (request.action === "sttError") {
        console.error("Background: Received STT error:", request.error);
        chrome.runtime.sendMessage({
            action: "updateDisplay",
            statusUpdate: `STT Error: ${request.error}`
        }).catch(e => console.warn("Could not send STT error to popup", e));
        // Potentially stop transcription or attempt recovery
        stopTranscriptionInternal(`STT Error: ${request.error}`);
        sendResponse({ success: true });
        return false;
    }
    // New: Listen for STT ended event from offscreen.js
    else if (request.action === "sttEnded") {
        console.log("Background: STT engine in offscreen document has ended.");
        // If transcription was supposed to be active, this might be an unexpected stop.
        if (isTranscribing) {
            console.warn("Background: STT ended unexpectedly. Attempting to restart or clean up.");
            // Decide on recovery strategy, e.g., try to restart STT or fully stop.
            // For now, let's fully stop to avoid loops.
            stopTranscriptionInternal("STT engine stopped unexpectedly");
        }
        sendResponse({ success: true });
        return false;
    }
    // Return false for synchronous message handlers or if sendResponse is not used.
    // Let's ensure other paths are not broken:
    if (request.action === "startStopTranscription") return true; // Already handled above, but good for clarity
    // sttResult is handled above and returns true.
    if (request.action === "sttError" || request.action === "sttEnded") return false;


    return false; // Default for any unhandled messages or synchronous ones
});

// Optional: Listen for tab updates to stop transcription if the tab is closed or navigates away
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tabId === currentTabId && isTranscribing && (changeInfo.status === 'loading' || changeInfo.url)) {
    console.log(`Tracked tab ${tabId} updated. Stopping transcription.`);
    stopTranscriptionInternal("Tab updated"); // Use internal version
    currentTabId = null; // Reset tabId here as stopTranscriptionInternal doesn't do it.
  }
});

chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  if (tabId === currentTabId && isTranscribing) {
    console.log(`Tracked tab ${tabId} removed. Stopping transcription.`);
    stopTranscriptionInternal("Tab removed"); // Use internal version
    currentTabId = null; // Reset tabId here
  }
});

// Ensure offscreen document is created when service worker starts, if needed for other reasons
// or to prepare for immediate use. For STT, it's created on-demand by startTranscription.
// (Optional: chrome.runtime.onStartup.addListener(ensureOffscreenDocument);)

console.log("Background script updated for Argos Translate (En->Es offline) and MyMemory fallback.");
