// offscreen.js (Major Revision for Vosk)

// Comment out or remove old SpeechRecognition related code if no longer primary
// const recognition = new (window.SpeechRecognition || window.webkitSpeechRecognition)();
// ... recognition event handlers ...
// let sttActive = false; // Vosk will have its own state management

let useAudioChunkProcessing = false; // This flag remains relevant
let voskModel = null;
let voskRecognizer = null;
let voskReady = false;
const VOSK_MODEL_URL = chrome.runtime.getURL('models/vosk-model-small-en-us/');
const VOSK_SCRIPT_URL = chrome.runtime.getURL('lib/vosk-browser/vosk.js');

// Function to initialize Vosk
async function initializeVosk() {
    if (voskReady) return;

    try {
        // Dynamically import Vosk script if it's not globally available
        // Adjust if Vosk script needs to be loaded differently (e.g. if it defines a global Vosk object)
        if (typeof Vosk === 'undefined') {
            await import(VOSK_SCRIPT_URL); // Assumes vosk.js is an ES module or UMD that sets up a global
        }
        if (typeof Vosk === 'undefined' && typeof self.Vosk === 'undefined') {
             console.error("Offscreen: Vosk script loaded but Vosk object not found.");
             throw new Error("Vosk object not found after loading script.");
        }
        const VoskInternal = typeof Vosk !== 'undefined' ? Vosk : self.Vosk;


        console.log("Offscreen: Initializing Vosk model from:", VOSK_MODEL_URL);
        // Vosk.createModel might require the URL to the directory, not individual files.
        // The Vosk-Browser API might differ slightly, this is a common pattern.
        voskModel = await VoskInternal.createModel(VOSK_MODEL_URL);
        console.log("Offscreen: Vosk model loaded.");

        // The sample rate the model expects (typically 16000 for small English model)
        // The AudioContext in background.js is likely 44100Hz or 48000Hz.
        // We MUST resample. Vosk recognizer constructor takes sampleRate.
        // For now, we assume audio chunks are at the recognizer's expected sample rate.
        // Proper resampling needs to be added in audio-processor.js or here.
        const modelSampleRate = 16000; // This should be known from the model
                                     // Or potentially available from voskModel properties after load.

        voskRecognizer = new voskModel.KaldiRecognizer(modelSampleRate); // Or VoskInternal.KaldiRecognizer if static
        console.log("Offscreen: Vosk recognizer created. Sample rate:", modelSampleRate);

        voskRecognizer.on("result", (message) => {
            const result = message.result;
            console.log("Offscreen Vosk STT (final):", result.text);
            chrome.runtime.sendMessage({
                action: "sttResult",
                type: "final",
                text: result.text
            }).catch(e => console.warn("Offscreen: Error sending final STT result", e));
        });
        voskRecognizer.on("partialresult", (message) => {
            const partial = message.result.partial;
            // console.log("Offscreen Vosk STT (interim):", partial); // Can be very noisy
            if (partial && partial.length > 3) { // Only send if reasonably long
                 chrome.runtime.sendMessage({
                    action: "sttResult",
                    type: "interim",
                    text: partial
                }).catch(e => console.warn("Offscreen: Error sending interim STT result", e));
            }
        });

        voskReady = true;
        console.log("Offscreen: Vosk is ready.");

    } catch (error) {
        console.error("Offscreen: Error initializing Vosk:", error);
        voskReady = false;
        // Notify background script of failure
        chrome.runtime.sendMessage({ action: "sttError", error: "Vosk initialization failed: " + error.message })
            .catch(e => console.warn("Offscreen: Error sending STT init error", e));
    }
}

// Resampler function (basic example - replace with a proper library if quality is poor)
// Source: https://github.com/GreatAppLab/raw-audio-resampler/blob/master/javascript/resampler.js (MIT License)
// This is a placeholder for a more robust solution.
function resampleBuffer(inputBuffer, inputSampleRate, outputSampleRate) {
    if (inputSampleRate === outputSampleRate) {
        return inputBuffer;
    }
    const sampleRateRatio = inputSampleRate / outputSampleRate;
    const outputLength = Math.round(inputBuffer.length / sampleRateRatio);
    const outputBuffer = new Float32Array(outputLength);
    for (let i = 0; i < outputLength; i++) {
        const theoreticalIndex = i * sampleRateRatio;
        const index1 = Math.floor(theoreticalIndex);
        const index2 = Math.min(index1 + 1, inputBuffer.length - 1); // Ensure within bounds
        const dec = theoreticalIndex - index1;
        outputBuffer[i] = inputBuffer[index1] + (inputBuffer[index2] - inputBuffer[index1]) * dec;
    }
    return outputBuffer;
}


chrome.runtime.onMessage.addListener(async (request, sender, sendResponse) => {
    if (request.action === 'switchToAudioChunkProcessing') {
        console.log("Offscreen: Switching to audio chunk processing with Vosk.");
        useAudioChunkProcessing = true;
        await initializeVosk(); // Initialize Vosk when switching
        sendResponse({ success: voskReady, error: voskReady ? null : "Vosk failed to initialize" });
        return true; // Keep channel open for async initializeVosk
    } else if (request.action === 'processAudioChunk') {
        if (!useAudioChunkProcessing || !voskReady || !voskRecognizer) {
            // console.warn("Offscreen: Received audio chunk but Vosk not ready or not in chunk mode.");
            sendResponse({ success: false, error: "Vosk not ready or not in chunk mode." });
            return false;
        }

        // The audioBuffer is Float32Array from AudioWorklet.
        // AudioWorklet sample rate is likely audioContext.sampleRate (e.g. 48000 or 44100)
        // Vosk model (small-en-us) expects 16000 Hz.
        // We need to know the input sample rate. For now, assume it's from a standard AudioContext.
        const audioContextSampleRate = 48000; // TODO: Get this dynamically from background if possible, or fix.
        const modelSampleRate = 16000; // Vosk small English model

        let audioBuffer = request.audioBuffer; // This is Float32Array

        // Resample if necessary
        if (audioContextSampleRate !== modelSampleRate) {
            audioBuffer = resampleBuffer(audioBuffer, audioContextSampleRate, modelSampleRate);
        }

        // Vosk typically expects PCM16, not Float32. Convert.
        const pcm16Buffer = new Int16Array(audioBuffer.length);
        for (let i = 0; i < audioBuffer.length; i++) {
            pcm16Buffer[i] = Math.max(-32768, Math.min(32767, Math.floor(audioBuffer[i] * 32767)));
        }

        voskRecognizer.acceptWaveform(pcm16Buffer); // Feed PCM data
        sendResponse({ success: true });
        return false; // Synchronous after acceptWaveform (results are event-based)

    } else if (request.action === 'stopSTT' || request.action === 'startSTT') { // Legacy/cleanup
        if (useAudioChunkProcessing) {
            console.log("Offscreen: Vosk pipeline active, legacy start/stopSTT ignored or handled by background.js.");
            if (request.action === 'stopSTT' && voskRecognizer) {
                // Finalize any pending recognition
                // voskRecognizer.finalizeResult(); // Check Vosk API if needed for clean stop
            }
            sendResponse({ success: true, message: "Vosk active." });
        } else {
            // Fallback to old SpeechRecognition if ever used (should be phased out)
            console.warn("Offscreen: Legacy STT command received while Vosk is intended pipeline.");
            sendResponse({ success: false, error: "Legacy STT not supported when worklet pipeline is primary." });
        }
        return false;
    }
    // Default: return false for synchronous handlers or if sendResponse is not used.
    // Ensure any new async paths return true.
});

console.log("Offscreen STT script updated for Vosk integration.");

// Cleanup Vosk when offscreen document closes (experimental, might not always fire reliably)
// self.addEventListener('beforeunload', () => {
//     if (voskRecognizer) {
//         voskRecognizer.remove(); // Clean up recognizer
//         voskRecognizer = null;
//     }
//     if (voskModel) {
//         voskModel.remove(); // Clean up model
//         voskModel = null;
//     }
//     console.log("Offscreen: Vosk resources released (attempted).");
// });
