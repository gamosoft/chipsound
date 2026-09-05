// Encode worker (classic, not a module, so encoders can be added later with
// importScripts). Takes planar float PCM from render-worker.js and produces
// the final file bytes.
//
// in:  { cmd: 'encode', format, sampleRate, left: Float32Array, right: Float32Array }
//      format ∈ 'wav16' | 'wav32f'
// out: { cmd: 'progress', done, total }   (frames)
//      { cmd: 'done', bytes: ArrayBuffer, mime, ext }
//      { cmd: 'error', message }

'use strict';

self.onmessage = async ({ data }) => {
	if (data.cmd !== 'encode') return;
	try {
		const out = await encode(data);
		self.postMessage({ cmd: 'done', ...out }, [out.bytes]);
	} catch (e) {
		self.postMessage({ cmd: 'error', message: String(e?.message || e) });
	}
};

async function encode({ format, sampleRate, left, right }) {
	const frames = left.length;
	const progress = (done) => self.postMessage({ cmd: 'progress', done, total: frames });
	switch (format) {
		case 'wav16':  return { bytes: encodeWav(left, right, sampleRate, 16), mime: 'audio/wav', ext: 'wav' };
		case 'wav32f': return { bytes: encodeWav(left, right, sampleRate, 32), mime: 'audio/wav', ext: 'wav' };
		default:
			throw new Error(`unknown format ${format}`);
	}
}

function clamp1(x) { return x < -1 ? -1 : x > 1 ? 1 : x; }
function toInt(x, max) { x = clamp1(x); return Math.round(x < 0 ? x * (max + 1) : x * max); }

function concat(chunks) {
	let n = 0;
	for (const c of chunks) n += c.byteLength;
	const out = new Uint8Array(n);
	let off = 0;
	for (const c of chunks) { out.set(c, off); off += c.byteLength; }
	return out.buffer;
}

// ---------- WAV ----------

function encodeWav(left, right, sampleRate, bitDepth) {
	const frames = left.length;
	const isFloat = bitDepth === 32;
	const bytesPerSample = isFloat ? 4 : 2;
	const blockAlign = 2 * bytesPerSample;
	const dataBytes = frames * blockAlign;
	const out = new ArrayBuffer(44 + dataBytes);
	const v = new DataView(out);
	const str = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };

	str(0, 'RIFF'); v.setUint32(4, 36 + dataBytes, true); str(8, 'WAVE');
	str(12, 'fmt '); v.setUint32(16, 16, true);
	v.setUint16(20, isFloat ? 3 : 1, true);
	v.setUint16(22, 2, true);
	v.setUint32(24, sampleRate, true);
	v.setUint32(28, sampleRate * blockAlign, true);
	v.setUint16(32, blockAlign, true);
	v.setUint16(34, bytesPerSample * 8, true);
	str(36, 'data'); v.setUint32(40, dataBytes, true);

	if (isFloat) {
		const f = new Float32Array(out, 44, frames * 2);
		for (let i = 0, k = 0; k < frames; k++) { f[i++] = left[k]; f[i++] = right[k]; }
	} else {
		const s = new Int16Array(out, 44, frames * 2);
		for (let i = 0, k = 0; k < frames; k++) { s[i++] = toInt(left[k], 32767); s[i++] = toInt(right[k], 32767); }
	}
	return out;
}
