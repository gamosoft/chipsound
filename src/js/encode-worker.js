// Encode worker (classic, not a module, so libflac.js can be pulled in with
// importScripts). Takes planar float PCM from render-worker.js and produces
// the final file bytes. Opus uses the browser's WebCodecs AudioEncoder and a
// small Ogg muxer below; no library needed.
//
// libflac.js is not bundled: it is fetched from jsDelivr the first time a
// FLAC export runs (pinned version, ~240 KB), so the repo carries no
// binaries and users who never export FLAC never download it.
//
// in:  { cmd: 'encode', format, sampleRate, left: Float32Array, right: Float32Array }
//      format ∈ 'wav16' | 'wav32f' | 'flac16' | 'flac24' | 'opus-160' | 'opus-96' | 'opus-64'
// out: { cmd: 'progress', done, total }   (frames)
//      { cmd: 'done', bytes: ArrayBuffer, mime, ext }
//      { cmd: 'error', message }

'use strict';

const FLAC_CDN = 'https://cdn.jsdelivr.net/npm/libflacjs@5.6.0/dist/';
let flacLoaded = false;

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
		case 'flac16': return { bytes: await encodeFlac(left, right, sampleRate, 16, progress), mime: 'audio/flac', ext: 'flac' };
		case 'flac24': return { bytes: await encodeFlac(left, right, sampleRate, 24, progress), mime: 'audio/flac', ext: 'flac' };
		case 'opus-160':
		case 'opus-96':
		case 'opus-64':
			return { bytes: await encodeOpus(left, right, sampleRate, Number(format.slice(5)) * 1000, progress), mime: 'audio/ogg', ext: 'opus' };
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

// ---------- FLAC (libflac.js) ----------

function loadFlac() {
	if (flacLoaded) return Promise.resolve();
	self.FLAC_SCRIPT_LOCATION = FLAC_CDN;              // where libflac looks for its .wasm
	try {
		importScripts(FLAC_CDN + 'libflac.min.wasm.js');
	} catch (e) {
		throw new Error('could not download the FLAC encoder from jsDelivr (offline, or a content blocker?)');
	}
	flacLoaded = true;
	if (Flac.isReady()) return Promise.resolve();
	return new Promise((resolve, reject) => {
		Flac.onready = () => resolve();
		setTimeout(() => reject(new Error('libflac did not initialise')), 15000);
	});
}

async function encodeFlac(left, right, sampleRate, bps, progress) {
	await loadFlac();
	const frames = left.length;
	const max = bps === 24 ? 8388607 : 32767;
	const COMPRESSION = 5;
	const encoder = Flac.create_libflac_encoder(sampleRate, 2, bps, COMPRESSION, frames, false);
	if (!encoder) throw new Error('could not create FLAC encoder');

	const chunks = [];
	const status = Flac.init_encoder_stream(encoder, (data /* Uint8Array */) => { chunks.push(data.slice()); });
	if (status !== 0) { Flac.FLAC__stream_encoder_delete(encoder); throw new Error(`FLAC init failed (${status})`); }

	const BLOCK = 4096 * 4;
	const buf = new Int32Array(BLOCK * 2);
	for (let pos = 0; pos < frames; pos += BLOCK) {
		const n = Math.min(BLOCK, frames - pos);
		for (let k = 0, i = 0; k < n; k++) {
			buf[i++] = toInt(left[pos + k], max);
			buf[i++] = toInt(right[pos + k], max);
		}
		const ok = Flac.FLAC__stream_encoder_process_interleaved(encoder, n === BLOCK ? buf : buf.subarray(0, n * 2), n);
		if (!ok) {
			const state = Flac.FLAC__stream_encoder_get_state(encoder);
			Flac.FLAC__stream_encoder_delete(encoder);
			throw new Error(`FLAC encode failed (state ${state})`);
		}
		progress(pos + n);
	}
	Flac.FLAC__stream_encoder_finish(encoder);
	Flac.FLAC__stream_encoder_delete(encoder);
	return concat(chunks);
}

// ---------- Opus (WebCodecs AudioEncoder → Ogg) ----------
//
// The encoder wants 48 kHz; render.js pins the rate for Opus, but resample
// linearly here as a safety net so any input still produces a valid file.

const OPUS_RATE = 48000;
const OPUS_FRAME_US = 20000;

async function encodeOpus(left, right, sampleRate, bitrate, progress) {
	if (typeof AudioEncoder === 'undefined') throw new Error('this browser has no WebCodecs AudioEncoder (Opus export needs Chrome 94+ or Firefox 130+)');
	if (sampleRate !== OPUS_RATE) { left = resample(left, sampleRate, OPUS_RATE); right = resample(right, sampleRate, OPUS_RATE); }
	const frames = left.length;
	const config = { codec: 'opus', sampleRate: OPUS_RATE, numberOfChannels: 2, bitrate, opus: { frameDuration: OPUS_FRAME_US } };
	const support = await AudioEncoder.isConfigSupported(config);
	if (!support.supported) throw new Error('Opus is not supported by this browser\'s AudioEncoder');

	const packets = [];       // { data: Uint8Array, samples }
	let opusHead = null;
	let encodeError = null;
	const encoder = new AudioEncoder({
		output: (chunk, meta) => {
			if (!opusHead && meta?.decoderConfig?.description) {
				const d = meta.decoderConfig.description;
				opusHead = new Uint8Array(d instanceof ArrayBuffer ? d : d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength));
			}
			const data = new Uint8Array(chunk.byteLength);
			chunk.copyTo(data);
			const samples = chunk.duration ? Math.round(chunk.duration * OPUS_RATE / 1e6) : opusPacketSamples(data);
			packets.push({ data, samples });
		},
		error: e => { encodeError = e; },
	});
	encoder.configure(config);

	// Feed in 20 ms frames of planar f32 (the encoder's native frame size).
	const FRAME = OPUS_RATE * OPUS_FRAME_US / 1e6;      // 960
	const planar = new Float32Array(FRAME * 2);
	for (let pos = 0; pos < frames; pos += FRAME) {
		if (encodeError) throw encodeError;
		const n = Math.min(FRAME, frames - pos);
		planar.fill(0);
		planar.set(left.subarray(pos, pos + n), 0);
		planar.set(right.subarray(pos, pos + n), FRAME);
		const ad = new AudioData({ format: 'f32-planar', sampleRate: OPUS_RATE, numberOfFrames: FRAME, numberOfChannels: 2, timestamp: Math.round(pos * 1e6 / OPUS_RATE), data: planar });
		encoder.encode(ad);
		ad.close();
		if (encoder.encodeQueueSize > 32) await new Promise(r => setTimeout(r, 0));
		if ((pos / FRAME) % 50 === 0) progress(pos + n);
	}
	await encoder.flush();
	encoder.close();
	if (encodeError) throw encodeError;
	progress(frames);

	const preSkip = opusHead ? (opusHead[10] | (opusHead[11] << 8)) : 312;
	if (!opusHead) opusHead = makeOpusHead(2, preSkip, sampleRate);
	return muxOgg(opusHead, packets, preSkip, frames);
}

function resample(src, from, to) {
	const outLen = Math.round(src.length * to / from);
	const out = new Float32Array(outLen);
	const ratio = from / to;
	for (let i = 0; i < outLen; i++) {
		const x = i * ratio, i0 = Math.floor(x), i1 = Math.min(i0 + 1, src.length - 1), t = x - i0;
		out[i] = src[i0] * (1 - t) + src[i1] * t;
	}
	return out;
}

// Samples per packet from the Opus TOC byte (RFC 6716 §3.1), used only when
// the chunk carries no duration.
function opusPacketSamples(pkt) {
	const toc = pkt[0];
	const config = toc >> 3;
	const code = toc & 3;
	let frameSamples;
	if (config < 12) frameSamples = [480, 960, 1920, 2880][config & 3];          // SILK
	else if (config < 16) frameSamples = [480, 960][config & 1];                  // Hybrid
	else frameSamples = [120, 240, 480, 960][config & 3];                          // CELT
	const count = code === 0 ? 1 : code === 3 ? (pkt[1] & 0x3f) : 2;
	return frameSamples * count;
}

function makeOpusHead(channels, preSkip, inputRate) {
	const b = new Uint8Array(19);
	const v = new DataView(b.buffer);
	b.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64]);   // "OpusHead"
	b[8] = 1; b[9] = channels;
	v.setUint16(10, preSkip, true);
	v.setUint32(12, inputRate, true);
	v.setInt16(16, 0, true);   // output gain
	b[18] = 0;                 // channel mapping family
	return b;
}

function makeOpusTags() {
	const vendor = new TextEncoder().encode('Chipsound (WebCodecs)');
	const b = new Uint8Array(8 + 4 + vendor.length + 4);
	const v = new DataView(b.buffer);
	b.set([0x4f, 0x70, 0x75, 0x73, 0x54, 0x61, 0x67, 0x73]);   // "OpusTags"
	v.setUint32(8, vendor.length, true);
	b.set(vendor, 12);
	v.setUint32(12 + vendor.length, 0, true);                    // no comments
	return b;
}

const CRC_TABLE = (() => {
	const t = new Uint32Array(256);
	for (let i = 0; i < 256; i++) {
		let r = i << 24;
		for (let j = 0; j < 8; j++) r = (r & 0x80000000) ? ((r << 1) ^ 0x04c11db7) : (r << 1);
		t[i] = r >>> 0;
	}
	return t;
})();
function oggCrc(bytes) {
	let crc = 0;
	for (let i = 0; i < bytes.length; i++) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ bytes[i]) & 0xff]) >>> 0;
	return crc;
}

// One Ogg page holding `packets` (each a Uint8Array). RFC 3533.
function oggPage(packets, granule, serial, seq, flags) {
	const lacing = [];
	for (const p of packets) {
		let n = p.length;
		while (n >= 255) { lacing.push(255); n -= 255; }
		lacing.push(n);
	}
	if (lacing.length > 255) throw new Error('too many segments for one Ogg page');
	const body = packets.reduce((a, p) => a + p.length, 0);
	const page = new Uint8Array(27 + lacing.length + body);
	const v = new DataView(page.buffer);
	page.set([0x4f, 0x67, 0x67, 0x53]);                          // "OggS"
	page[4] = 0; page[5] = flags;
	v.setBigUint64(6, BigInt(granule), true);
	v.setUint32(14, serial, true);
	v.setUint32(18, seq, true);
	v.setUint32(22, 0, true);                                    // CRC placeholder
	page[26] = lacing.length;
	page.set(lacing, 27);
	let off = 27 + lacing.length;
	for (const p of packets) { page.set(p, off); off += p.length; }
	v.setUint32(22, oggCrc(page), true);
	return page;
}

function muxOgg(opusHead, packets, preSkip, totalFrames) {
	const serial = (Math.random() * 0xffffffff) >>> 0;
	const pages = [];
	let seq = 0;
	pages.push(oggPage([opusHead], 0, serial, seq++, 0x02));    // BOS
	pages.push(oggPage([makeOpusTags()], 0, serial, seq++, 0));
	// Audio: ~50 packets (1 s) per page; final page carries EOS and the exact
	// end granule so decoders trim the encoder's padding.
	const endGranule = preSkip + totalFrames;
	let granule = preSkip;
	let batch = [], batchSegments = 0;
	for (let i = 0; i < packets.length; i++) {
		const p = packets[i];
		const segs = Math.floor(p.data.length / 255) + 1;
		if (batch.length && (batch.length >= 50 || batchSegments + segs > 255)) {
			pages.push(oggPage(batch, granule, serial, seq++, 0));
			batch = []; batchSegments = 0;
		}
		batch.push(p.data); batchSegments += segs;
		granule += p.samples;
	}
	pages.push(oggPage(batch, Math.min(granule, endGranule), serial, seq++, 0x04));   // EOS
	return concat(pages);
}
