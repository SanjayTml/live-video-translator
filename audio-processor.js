// audio-processor.js
class AudioChunkProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();
        // options.processorOptions.bufferSize can be used if needed
        this.port.onmessage = (event) => {
            // Handle messages from background.js if necessary (e.g., to stop)
            if (event.data === 'stop') {
                // Potentially clean up or set a flag
            }
        };
    }

    process(inputs, outputs, parameters) {
        // inputs[0] is an array of channels.
        // inputs[0][0] is the Float32Array for the first channel.
        const inputChannelData = inputs[0][0];

        if (!inputChannelData || inputChannelData.length === 0) {
            return true; // Keep processor alive
        }

        // Send a copy of the audio data (mono) to the main thread (background.js)
        // To avoid transferring large objects too frequently, consider downsampling or buffering here,
        // but for now, send directly.
        // The data is cloned when sent via postMessage.
        this.port.postMessage({
            action: "audioData",
            buffer: inputChannelData.slice(0) // Send a copy
        });

        return true; // Keep processor alive
    }
}

registerProcessor('audio-chunk-processor', AudioChunkProcessor);
