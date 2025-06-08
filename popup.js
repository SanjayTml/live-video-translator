// popup.js
document.addEventListener('DOMContentLoaded', () => {
    const startStopBtn = document.getElementById('startStopBtn');
    const translateLangSelect = document.getElementById('translateLang');
    const transcribedTextarea = document.getElementById('transcribedText');
    const translatedTextarea = document.getElementById('translatedText');
    const statusDiv = document.getElementById('status');

    // Function to update button text and style
    function updateButton(isTranscribing) {
        if (isTranscribing) {
            startStopBtn.textContent = 'Stop Transcription';
            startStopBtn.classList.add('recording');
            statusDiv.textContent = 'Status: Transcribing...';
        } else {
            startStopBtn.textContent = 'Start Transcription';
            startStopBtn.classList.remove('recording');
            statusDiv.textContent = 'Status: Idle';
        }
    }

    // Load initial state of the button (e.g. if transcription is already running)
    // This requires communication with the background script or persistent storage.
    // For now, we'll assume it's not transcribing on popup open.
    // A more robust solution would query the background script's state.
    updateButton(false); // Assume not transcribing initially


    startStopBtn.addEventListener('click', () => {
        // Send a message to the background script to start or stop.
        // The background script will manage the actual state.
        chrome.runtime.sendMessage({ action: "startStopTranscription" }, (response) => {
            if (chrome.runtime.lastError) {
                console.error("Error sending message:", chrome.runtime.lastError.message);
                statusDiv.textContent = `Error: ${chrome.runtime.lastError.message}`;
                return;
            }
            if (response && response.success) {
                // The background script's actual state determines the button's next state.
                // For now, we'll toggle based on current text, but ideally,
                // background script would send its new state back.
                if (startStopBtn.textContent.includes('Start')) {
                     updateButton(true); // Visually update to "Stop"
                } else {
                     updateButton(false); // Visually update to "Start"
                }
                // More accurately, the background script should send its new state:
                // if (response.isTranscribing) { updateButton(true); } else { updateButton(false); }
                // This will be refined when STT is integrated.
                statusDiv.textContent = `Status: ${response.status}`;

            } else if (response) {
                console.error("Failed to toggle transcription:", response.error);
                statusDiv.textContent = `Error: ${response.error || 'Unknown error'}`;
            } else {
                console.error("No response from background script.");
                statusDiv.textContent = "Error: No response from background script.";
            }
        });
    });

    translateLangSelect.addEventListener('change', () => {
        const selectedLang = translateLangSelect.value;
        // Store the selected language (e.g., using chrome.storage.local)
        chrome.storage.local.set({ targetLanguage: selectedLang }, () => {
            console.log('Target language saved:', selectedLang);
            statusDiv.textContent = `Target language set to: ${translateLangSelect.options[translateLangSelect.selectedIndex].text}`;
        });
        // TODO: If transcription is active, potentially notify background script
        // to change translation language immediately.
    });

    // Load stored language preference on popup open
    chrome.storage.local.get(['targetLanguage'], (result) => {
        if (result.targetLanguage) {
            translateLangSelect.value = result.targetLanguage;
        }
    });

    // Listener for messages from the background script (e.g., new transcription/translation)
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.action === "updateDisplay") {
            if (request.transcribedText) {
                transcribedTextarea.value = request.transcribedText;
            }
            if (request.translatedText) {
                translatedTextarea.value = request.translatedText;
            }
            if (request.statusUpdate) {
                statusDiv.textContent = `Status: ${request.statusUpdate}`;
            }
        }
        // Example: Listen for state changes from background to update button accurately
        if (request.action === "transcriptionStateChanged") {
            updateButton(request.isTranscribing);
            if (request.statusMessage) {
                 statusDiv.textContent = `Status: ${request.statusMessage}`;
            }
        }
    });

    // Request current transcription status from background script when popup opens
    // to correctly set the button state.
    // This part is a bit tricky because the background script might not be active
    // when the popup opens if event-driven (Manifest V3).
    // A more robust way: background script could store its state in chrome.storage.local
    // and popup reads from there, or background sends a message when it starts/stops.

    // For now, the `startStopTranscription` response will handle the immediate feedback.
    // True robust state synchronization will be part of later refinement.
    console.log("Popup script loaded.");
});
