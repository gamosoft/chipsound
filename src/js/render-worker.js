// Offline WAV renderer. Runs a second libopenmpt instance in a dedicated
// worker so exporting never touches the audio thread — playback keeps going.
//
// Output is planar float PCM; encode-worker.js turns it into WAV.
//
// in:  { cmd: 'render', buffer, config, mutes, subsong, sampleRate, loops, maxSeconds }
// out: { cmd: 'progress', seconds, total }  ~4×/s of rendered audio
//      { cmd: 'done', left: Float32Array, right: Float32Array, seconds, truncated }
//      { cmd: 'error', message }
// Cancel = terminate the worker from the main thread.

import libopenmptPromise from './libopenmpt.worklet.js';
import { applyRenderConfig, getInteractiveMute } from './openmpt-params.js';

const CHUNK = 4096;

self.onmessage = async ({ data }) => {
	if (data.cmd !== 'render') return;
	try {
		const out = await render(data);
		self.postMessage({ cmd: 'done', ...out }, [out.left.buffer, out.right.buffer]);
	} catch (e) {
		self.postMessage({ cmd: 'error', message: String(e?.message || e) });
	}
};

async function render({ buffer, config, mutes = [], subsong = -1, sampleRate = 48000, loops = 0, maxSeconds = 1800 }) {
	const lib = await libopenmptPromise();

	const bytes = new Int8Array(buffer);
	const filePtr = lib._malloc(bytes.byteLength);
	lib.HEAPU8.set(bytes, filePtr);
	const modExt = lib._openmpt_module_ext_create_from_memory(filePtr, bytes.byteLength, 0, 0, 0, 0, 0, 0, 0);
	lib._free(filePtr);
	if (!modExt) throw new Error('libopenmpt could not parse the module');
	const mod = lib._openmpt_module_ext_get_module(modExt);

	// Same settings as live playback, but the loop count is the export's own.
	applyRenderConfig(lib, mod, { ...config, repeatCount: loops });
	if (subsong >= 0) lib._openmpt_module_select_subsong(mod, subsong);

	const mute = getInteractiveMute(lib, modExt);
	if (mute) for (const ch of mutes) mute.fn(modExt, ch, 1);

	const duration = lib._openmpt_module_get_duration_seconds(mod);
	const total = Number.isFinite(duration) && duration > 0 ? duration * (loops + 1) : 0;

	const leftPtr = lib._malloc(4 * CHUNK);
	const rightPtr = lib._malloc(4 * CHUNK);
	const chunksL = [], chunksR = [];
	let frames = 0;
	let truncated = false;
	let nextReport = 0;
	const maxFrames = maxSeconds * sampleRate;

	for (;;) {
		const n = lib._openmpt_module_read_float_stereo(mod, sampleRate, CHUNK, leftPtr, rightPtr);
		if (n <= 0) break;
		chunksL.push(new Float32Array(lib.HEAPF32.buffer, leftPtr, n).slice());
		chunksR.push(new Float32Array(lib.HEAPF32.buffer, rightPtr, n).slice());
		frames += n;
		if (frames >= nextReport) {
			self.postMessage({ cmd: 'progress', seconds: frames / sampleRate, total });
			nextReport = frames + sampleRate / 4;
		}
		if (frames >= maxFrames) { truncated = true; break; }
	}

	lib._free(leftPtr);
	lib._free(rightPtr);
	if (mute) lib._free(mute.ptr);
	lib._openmpt_module_ext_destroy(modExt);

	return { left: join(chunksL, frames), right: join(chunksR, frames), seconds: frames / sampleRate, truncated };
}

function join(chunks, frames) {
	const out = new Float32Array(frames);
	let off = 0;
	for (const c of chunks) { out.set(c, off); off += c.length; }
	return out;
}
