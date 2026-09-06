import libopenmptPromise from './libopenmpt.worklet.js'
import { applyRenderParam as applyParam, applyRenderConfig as applyConfig } from './openmpt-params.js'

// openmpt's "interactive" extension is a struct of 16 function pointers in
// WASM32 (4 bytes each). Layout (index → byte offset):
//   10 → 40  set_channel_mute_status (used for the mute UI)
const INTERACTIVE_STRUCT_SIZE = 64;
const SET_CHANNEL_MUTE_STATUS_OFFSET = 40;

// Target rate at which the worklet emits 'pos' messages to the main thread.
// process() runs at sampleRate / 128 (~344 Hz @ 44.1kHz), but the UI only
// consumes at requestAnimationFrame cadence (~60 Hz). Throttling here cuts
// IPC volume by ~5–6× and removes the matching per-message allocations on
// both threads. Audio rendering itself is untouched — every quantum is still
// rendered every quantum; we just batch the *status* reporting.
const EMIT_HZ = 60;

// vars
let libopenmpt;

// init
libopenmptPromise()
	.then(res => {
		libopenmpt = res;
		if (!libopenmpt.stackSave)
			return;

		// set libopenmpt version to display later
		let stack = libopenmpt.stackSave();
		libopenmpt.version = libopenmpt.UTF8ToString(libopenmpt._openmpt_get_string(asciiToStack('library_version')));
		libopenmpt.build = libopenmpt.UTF8ToString(libopenmpt._openmpt_get_string(asciiToStack('build')));
		libopenmpt.stackRestore(stack);
	})
	.catch(e => console.error(e))

//
// Helpers
//
function asciiToStack(str) {
	const stackStr = libopenmpt.stackAlloc(str.length + 1);			// DrS: needed to export in emscripten
	writeAsciiToMemory(str, stackStr);					// no longer in Emscripten, see below
	return stackStr;
}
function writeAsciiToMemory(str, buffer, dontAddNull) { for (let i = 0; i < str.length; ++i) { libopenmpt.HEAP8[buffer++ >> 0] = str.charCodeAt(i) } if (!dontAddNull) libopenmpt.HEAP8[buffer >> 0] = 0 }


//
// Processor
//
class MPT extends AudioWorkletProcessor {
	constructor() {
		super()
		this.port.onmessage = this.handleMessage_.bind(this)
		this.paused = false
		this.config = {
			repeatCount: -1,		// -1 = play endless, 0 = play once, do not repeat
			stereoSeparation: 100,	// percents
			interpolationFilter: 0,	// https://lib.openmpt.org/doc/group__openmpt__module__render__param.html
		}
		this.channels = 0
		this.buffer = []

		// Throttling state. framesPerEmit is the number of audio frames we
		// accumulate between status messages — derived from sampleRate so the
		// emit rate stays at ~EMIT_HZ regardless of the device sample rate.
		this.framesSinceEmit = 0;
		this.framesPerEmit = Math.max(1, Math.round(sampleRate / EMIT_HZ));

		// Per-channel VU buffer, packed as [ch0L, ch0R, ch1L, ch1R, …]. Allocated
		// once per song load (channels known) and reused on every emit, so we
		// don't churn through tiny {left, right} objects at ~60 Hz × N channels.
		this.chVolBuffer = null;

		// Mirror of the main thread's mute state. Updated in the 'mute' handler
		// so we can skip libopenmpt VU queries for channels we know are silent.
		this.muteSet = new Set();
	}

	process(inputList, outputList, parameters) {
		if (!this.modulePtr || !this.leftPtr || !this.rightPtr || this.paused)
			return true;	//silence

		const left = outputList[0][0];
		const right = outputList[0][1];

		const actualFramesPerChunk = libopenmpt._openmpt_module_read_float_stereo(this.modulePtr, sampleRate, left.length, this.leftPtr, this.rightPtr)
		if (actualFramesPerChunk == 0) {
			// modulePtr will be 0 on openmpt: error: openmpt_module_read_float_stereo: ERROR: module * not valid or other openmpt error
			const error = !this.modulePtr
			if (error) {
				this.port.postMessage({ cmd: 'err', val: 'Process' })
			} else {
				this.port.postMessage({ cmd: 'end' })
			}
			return true
		}

		left.set(libopenmpt.HEAPF32.subarray(this.leftPtr / 4, this.leftPtr / 4 + actualFramesPerChunk));
		right.set(libopenmpt.HEAPF32.subarray(this.rightPtr / 4, this.rightPtr / 4 + actualFramesPerChunk));

		// Audio is rendered every quantum; status messages are throttled so we
		// don't post ~6× faster than the UI can consume. Carrying the overshoot
		// forward (rather than zeroing) keeps the long-run emit rate at exactly
		// EMIT_HZ regardless of how the quantum size and threshold align.
		this.framesSinceEmit += actualFramesPerChunk;
		if (this.framesSinceEmit < this.framesPerEmit) return true;
		this.framesSinceEmit -= this.framesPerEmit;

		// Fill the packed VU buffer in place. Muted channels short-circuit to
		// 0 without crossing the WASM boundary — libopenmpt would also report
		// 0 for them, but skipping the call saves 2 cross-boundary trips per
		// muted channel per emit.
		const buf = this.chVolBuffer;
		if (buf) {
			for (let i = 0; i < this.channels; i++) {
				if (this.muteSet.has(i)) {
					buf[2 * i] = 0;
					buf[2 * i + 1] = 0;
				} else {
					buf[2 * i]     = libopenmpt._openmpt_module_get_current_channel_vu_left(this.modulePtr, i);
					buf[2 * i + 1] = libopenmpt._openmpt_module_get_current_channel_vu_right(this.modulePtr, i);
				}
			}
		}

		this.port.postMessage({
			cmd: 'pos',
			pos:     libopenmpt._openmpt_module_get_position_seconds(this.modulePtr),
			order:   libopenmpt._openmpt_module_get_current_order(this.modulePtr),
			pattern: libopenmpt._openmpt_module_get_current_pattern(this.modulePtr),
			row:     libopenmpt._openmpt_module_get_current_row(this.modulePtr),
			bpm:     Math.floor(libopenmpt._openmpt_module_get_current_estimated_bpm(this.modulePtr)),
			// Structured-clone copies the typed array; we keep mutating `buf`
			// next tick. No transferable / no per-emit allocation.
			chVol: buf,
		});

		return true // def. needed for Chrome
	}

	// Set one playback parameter, remember it in config, and apply it to the
	// loaded module (if any). Key list: openmpt-params.js#applyRenderParam.
	applyRenderParam(key, value) {
		this.config[key] = value;
		if (!this.modulePtr) return;
		applyParam(libopenmpt, this.modulePtr, key, value);
	}

	applyRenderConfig() {
		if (!this.modulePtr) return;
		applyConfig(libopenmpt, this.modulePtr, this.config);
	}

	handleMessage_(msg) {
		const v = msg.data.val;
		switch (msg.data.cmd) {
			case 'config':
				this.config = v;
				break
			case 'load':
				this.load(v);
				break
			case 'play':
				this.play();
				break
			case 'pause':
				this.paused = true;
				break
			case 'unpause':
				this.paused = false;
				break
			case 'togglePause':
				this.paused = !this.paused;
				break
			case 'stop':
				this.stop();
				break
			case 'setPattern':
				if (!libopenmpt.stackSave || !this.modulePtr) return
				libopenmpt._openmpt_module_set_position_order_row(this.modulePtr, v, 0);
				break
			case 'meta':
				this.meta();
				break
			case 'repeatCount':
				this.applyRenderParam('repeatCount', v);
				break
			case 'setPitch':
				this.applyRenderParam('pitchFactor', v);
				break
			case 'setTempo':
				this.applyRenderParam('tempoFactor', v);
				break
			case 'render':
				// v = { key, value } — see applyRenderParam for the key list.
				// Stored in config so every future load() inherits it; applied
				// immediately when a module is loaded. All of these are live in
				// libopenmpt: they take effect on the next rendered quantum.
				this.applyRenderParam(v.key, v.value);
				break
			case 'selectSubsong':
				if (!this.modulePtr) return
				libopenmpt._openmpt_module_select_subsong(this.modulePtr, v);
				//this.meta()
				break
			case 'setPos':
				if (!this.modulePtr) return
				libopenmpt._openmpt_module_set_position_seconds(this.modulePtr, v);
				break
			case 'setOrderRow':
				if (!this.modulePtr) return
				libopenmpt._openmpt_module_set_position_order_row(this.modulePtr, v.o, v.r);
				break
			case 'mute':
				// v = { channel, muted } — the main thread is the source of
				// truth (UI state lives there), so we just apply it. The
				// function pointer was resolved once on load. We also mirror
				// the state in muteSet so process() can skip VU queries for
				// channels it knows are silent.
				if (!this.modulePtrExt || !this.setChannelMuteStatus) return;
				this.setChannelMuteStatus(this.modulePtrExt, v.channel, v.muted ? 1 : 0);
				if (v.muted) this.muteSet.add(v.channel);
				else this.muteSet.delete(v.channel);
				break;
			default:
				console.log('Received unknown message', msg.data);
		}
	} // handleMessage_

	load(buffer) {

		this.delete();
		this.buffer = buffer;

		const maxFramesPerChunk = 128	// thats what worklet is using
		const byteArray = new Int8Array(this.buffer)
		const ptrToFile = libopenmpt._malloc(byteArray.byteLength)
		libopenmpt.HEAPU8.set(byteArray, ptrToFile)

		// Create via the *extended* API so we get access to the interactive
		// interface (per-channel mute, etc.). The ext handle wraps a normal
		// module pointer that the rest of this worklet uses for rendering,
		// position queries and so on. Destroying the ext also destroys the
		// inner module — never call _openmpt_module_destroy on it directly.
		this.modulePtrExt = libopenmpt._openmpt_module_ext_create_from_memory(
			ptrToFile, byteArray.byteLength,
			0, 0,	// logfunc, loguser
			0, 0,	// errfunc, erruser
			0, 0,	// error*, error_message*
			0,		// ctls
		);
		// libopenmpt copies the data internally; safe to free the source buffer now.
		libopenmpt._free(ptrToFile);

		if (this.modulePtrExt === 0) {
			this.modulePtr = 0;
			this.port.postMessage({ cmd: 'err', val: 'ptr' });
			return;
		}
		this.modulePtr = libopenmpt._openmpt_module_ext_get_module(this.modulePtrExt);

		this.setupInteractive();

		this.leftPtr = libopenmpt._malloc(4 * maxFramesPerChunk);	// 4x = float
		this.rightPtr = libopenmpt._malloc(4 * maxFramesPerChunk);

		// set config options on module (render params + ctls)
		this.applyRenderConfig();

		this.paused = true;

		// post back tracks metadata — this populates this.channels via getSong().
		this.meta();

		// Now that channel count is known, allocate the packed VU buffer and
		// reset throttling + mute state so the next process() emits fresh.
		this.chVolBuffer = this.channels > 0 ? new Float32Array(this.channels * 2) : null;
		this.muteSet.clear();
		this.framesSinceEmit = 0;
	}

	// Resolve the "interactive" interface once per load and cache the function
	// pointer for set_channel_mute_status. The pointer is a callable WASM
	// thunk fetched from the function table, so subsequent mute clicks are a
	// direct call with no per-call lookup.
	setupInteractive() {
		this.setChannelMuteStatus = null;
		if (!libopenmpt.stackSave || !libopenmpt.wasmTable) return;

		this.interactivePtr = libopenmpt._malloc(INTERACTIVE_STRUCT_SIZE);

		const stack = libopenmpt.stackSave();
		const idStr = asciiToStack('interactive');
		const ok = libopenmpt._openmpt_module_ext_get_interface(
			this.modulePtrExt, idStr, this.interactivePtr, INTERACTIVE_STRUCT_SIZE,
		);
		libopenmpt.stackRestore(stack);

		if (!ok) {
			libopenmpt._free(this.interactivePtr);
			this.interactivePtr = 0;
			console.warn('openmpt: "interactive" interface unavailable; channel mute disabled');
			return;
		}

		const muteIdx = libopenmpt.HEAP32[(this.interactivePtr + SET_CHANNEL_MUTE_STATUS_OFFSET) >> 2];
		this.setChannelMuteStatus = libopenmpt.wasmTable.get(muteIdx);
	}

	play() {
		if (!this.buffer)
			return;

		this.paused = false;
	}

	stop() {
		if (!this.modulePtr)
			return;

		this.paused = true;
		libopenmpt._openmpt_module_set_position_seconds(this.modulePtr, 0);
	}

	delete() {
		if (!this.modulePtrExt && !this.modulePtr) return;

		// Destroying the ext also destroys the inner module — only one call.
		if (this.modulePtrExt) {
			libopenmpt._openmpt_module_ext_destroy(this.modulePtrExt);
			this.modulePtrExt = 0;
		}
		this.modulePtr = 0;

		if (this.interactivePtr) {
			libopenmpt._free(this.interactivePtr);
			this.interactivePtr = 0;
		}
		this.setChannelMuteStatus = null;

		if (this.leftPtr) {
			libopenmpt._free(this.leftPtr);
			this.leftPtr = 0;
		}
		if (this.rightPtr) {
			libopenmpt._free(this.rightPtr);
			this.rightPtr = 0;
		}
		this.channels = 0;
		this.chVolBuffer = null;
		this.muteSet.clear();
		this.framesSinceEmit = 0;
	}

	meta() {
		this.port.postMessage({ cmd: 'meta', meta: this.getMeta() });
	}

	getSong() {
		if (!libopenmpt.UTF8ToString || !this.modulePtr)
			return false;

		// https://lib.openmpt.org/doc/
		const numSubsongs = libopenmpt._openmpt_module_get_num_subsongs(this.modulePtr);
		let song = {
			channels: 0,
			instruments: [],
			samples: [],
			orders: [],
			patterns: [],
			numSubsongs,
			subsongNames: this.getSubsongNames(numSubsongs),
			//tempo: libopenmpt._openmpt_module_get_current_tempo(this.modulePtr)
			bpm: Math.floor(libopenmpt._openmpt_module_get_current_estimated_bpm(this.modulePtr))
		}
		// channels
		const chNum = libopenmpt._openmpt_module_get_num_channels(this.modulePtr);
		this.channels = chNum;
		song.channels = chNum;
		// instruments
		for (let i = 0, e = libopenmpt._openmpt_module_get_num_instruments(this.modulePtr); i < e; i++) {
			song.instruments.push(libopenmpt.UTF8ToString(libopenmpt._openmpt_module_get_instrument_name(this.modulePtr, i)));
		}
		// samples
		for (let i = 0, e = libopenmpt._openmpt_module_get_num_samples(this.modulePtr); i < e; i++) {
			song.samples.push(libopenmpt.UTF8ToString(libopenmpt._openmpt_module_get_sample_name(this.modulePtr, i)));
		}
		// orders
		for (let i = 0, e = libopenmpt._openmpt_module_get_num_orders(this.modulePtr); i < e; i++) {
			song.orders.push(libopenmpt._openmpt_module_get_order_pattern(this.modulePtr, i));
		}
		// patterns
		for (let patIdx = 0, patNum = libopenmpt._openmpt_module_get_num_patterns(this.modulePtr); patIdx < patNum; patIdx++) {
			const pattern = [];
			// rows
			for (let rowIdx = 0, rowNum = libopenmpt._openmpt_module_get_pattern_num_rows(this.modulePtr, patIdx); rowIdx < rowNum; rowIdx++) {
				const row = [];
				// channels
				for (let chIdx = 0; chIdx < chNum; chIdx++) {
					const channel = [];
					for (let comIdx = 0; comIdx < 6; comIdx++) {
						/* commands
						OPENMPT_MODULE_COMMAND_NOTE = 0
						OPENMPT_MODULE_COMMAND_INSTRUMENT = 1
						OPENMPT_MODULE_COMMAND_VOLUMEEFFECT = 2
						OPENMPT_MODULE_COMMAND_EFFECT = 3
						OPENMPT_MODULE_COMMAND_VOLUME = 4
						OPENMPT_MODULE_COMMAND_PARAMETER = 5
						*/
						channel.push(libopenmpt._openmpt_module_get_pattern_row_channel_command(this.modulePtr, patIdx, rowIdx, chIdx, comIdx));
					}
					row.push(channel);
				}
				pattern.push(row);
			}
			song.patterns.push(pattern);
		}

		song.totalOrders = song.orders.length;
		song.totalPatterns = song.patterns.length;

		return song;
	}

	getMeta() {
		if (!libopenmpt.UTF8ToString || !this.modulePtr)
			return false;

		const data = {};
		const keys = libopenmpt.UTF8ToString(libopenmpt._openmpt_module_get_metadata_keys(this.modulePtr)).split(';');
		for (let i = 0; i < keys.length; i++) {
			const keyNameBuffer = libopenmpt._malloc(keys[i].length + 1);
			writeAsciiToMemory(keys[i], keyNameBuffer);
			data[keys[i]] = libopenmpt.UTF8ToString(libopenmpt._openmpt_module_get_metadata(this.modulePtr, keyNameBuffer));
			libopenmpt._free(keyNameBuffer);
		}
		data.song = this.getSong();
		// data.songs = this.getSongs();
		data.libopenmptVersion = libopenmpt.version;
		data.libopenmptBuild = libopenmpt.build;
		return data;
	}

	// Returns ["Subsong 1", "subsong title", …] for the loaded module. Each
	// entry is the module's own subsong name when present, or a synthesised
	// "Subsong N" otherwise. Used by both the metadata payload (UI subsong
	// picker) and the legacy getSongs() shape.
	getSubsongNames(count) {
		if (!libopenmpt.UTF8ToString || !this.modulePtr) return [];
		const n = count ?? libopenmpt._openmpt_module_get_num_subsongs(this.modulePtr);
		const names = [];
		for (let i = 0; i < n; i++) {
			const namePtr = libopenmpt._openmpt_module_get_subsong_name(this.modulePtr, i);
			const name = libopenmpt.UTF8ToString(namePtr);
			names.push(name && name !== '' ? name : `Subsong ${i + 1}`);
			libopenmpt._openmpt_free_string(namePtr);
		}
		return names;
	}

	getSongs() { return this.getSubsongNames(); }
}


registerProcessor('libopenmpt-processor', MPT);