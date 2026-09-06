// Shared libopenmpt glue used by both the audio worklet (live playback) and
// the render worker (offline WAV export), so the two always agree on what a
// "playback parameter" means. `lib` is the instantiated Emscripten module.

export const OPENMPT_MODULE_RENDER_MASTERGAIN_MILLIBEL = 1;
export const OPENMPT_MODULE_RENDER_STEREOSEPARATION_PERCENT = 2;
export const OPENMPT_MODULE_RENDER_INTERPOLATIONFILTER_LENGTH = 3;
export const OPENMPT_MODULE_RENDER_VOLUMERAMPING_STRENGTH = 4;

// openmpt's "interactive" extension is a struct of 16 function pointers in
// WASM32 (4 bytes each). Index 10 (byte 40) is set_channel_mute_status.
export const INTERACTIVE_STRUCT_SIZE = 64;
export const SET_CHANNEL_MUTE_STATUS_OFFSET = 40;

export const RENDER_KEYS = [
	'repeatCount', 'stereoSeparation', 'interpolationFilter', 'volumeRamping',
	'masterGain', 'amigaResampler', 'tempoFactor', 'pitchFactor',
];

// Emscripten no longer exports writeAsciiToMemory; write the bytes ourselves.
export function asciiToStack(lib, str) {
	const ptr = lib.stackAlloc(str.length + 1);
	for (let i = 0; i < str.length; i++) lib.HEAP8[ptr + i] = str.charCodeAt(i);
	lib.HEAP8[ptr + str.length] = 0;
	return ptr;
}

// ctl_set with error reporting. Must be called inside stackSave/stackRestore
// by the caller, or use ctlSet() below which wraps it.
export function ctlSet(lib, modulePtr, name, value) {
	if (!lib.stackSave) return false;
	const stack = lib.stackSave();
	const ok = lib._openmpt_module_ctl_set(modulePtr, asciiToStack(lib, name), asciiToStack(lib, String(value)));
	if (!ok) {
		const err = lib.UTF8ToString(lib._openmpt_module_error_get_last_message(modulePtr));
		lib._openmpt_module_error_clear(modulePtr);
		console.warn(`libopenmpt ctl_set ${name}=${value} failed: ${err}`);
	}
	lib.stackRestore(stack);
	return Boolean(ok);
}

// Apply one playback parameter to a loaded module. Keys:
//   stereoSeparation    0..200 %      render param (100 = default, 200 = full pan)
//   interpolationFilter 0/1/2/4/8     render param (0 = internal default)
//   volumeRamping       -1..10        render param (-1 = default, 0 = off)
//   masterGain          millibel      render param (0 = unity)
//   amigaResampler      'off'|'auto'|'a500'|'a1200'|'unfiltered'   ctl
//   tempoFactor         0.5..2        ctl play.tempo_factor
//   pitchFactor         0.5..2        ctl play.pitch_factor
//   repeatCount         -1 = forever, 0 = once, n = n extra loops
export function applyRenderParam(lib, m, key, value) {
	switch (key) {
		case 'stereoSeparation':
			lib._openmpt_module_set_render_param(m, OPENMPT_MODULE_RENDER_STEREOSEPARATION_PERCENT, value);
			break;
		case 'interpolationFilter':
			lib._openmpt_module_set_render_param(m, OPENMPT_MODULE_RENDER_INTERPOLATIONFILTER_LENGTH, value);
			break;
		case 'volumeRamping':
			lib._openmpt_module_set_render_param(m, OPENMPT_MODULE_RENDER_VOLUMERAMPING_STRENGTH, value);
			break;
		case 'masterGain':
			lib._openmpt_module_set_render_param(m, OPENMPT_MODULE_RENDER_MASTERGAIN_MILLIBEL, value);
			break;
		case 'amigaResampler':
			if (value === 'off') {
				ctlSet(lib, m, 'render.resampler.emulate_amiga', 0);
			} else {
				ctlSet(lib, m, 'render.resampler.emulate_amiga', 1);
				ctlSet(lib, m, 'render.resampler.emulate_amiga_type', value);
			}
			break;
		case 'tempoFactor':
			ctlSet(lib, m, 'play.tempo_factor', value);
			break;
		case 'pitchFactor':
			ctlSet(lib, m, 'play.pitch_factor', value);
			break;
		case 'repeatCount':
			lib._openmpt_module_set_repeat_count(m, value);
			break;
		default:
			console.log('Unknown render param', key);
	}
}

export function applyRenderConfig(lib, m, config) {
	for (const key of RENDER_KEYS) {
		if (config[key] !== undefined) applyRenderParam(lib, m, key, config[key]);
	}
}

// Resolve set_channel_mute_status from the ext module's interactive
// interface. Returns { fn, ptr } — free `ptr` with lib._free when done —
// or null when the interface is unavailable.
export function getInteractiveMute(lib, modulePtrExt) {
	if (!lib.stackSave || !lib.wasmTable) return null;
	const ptr = lib._malloc(INTERACTIVE_STRUCT_SIZE);
	const stack = lib.stackSave();
	const ok = lib._openmpt_module_ext_get_interface(modulePtrExt, asciiToStack(lib, 'interactive'), ptr, INTERACTIVE_STRUCT_SIZE);
	lib.stackRestore(stack);
	if (!ok) {
		lib._free(ptr);
		return null;
	}
	const idx = lib.HEAP32[(ptr + SET_CHANNEL_MUTE_STATUS_OFFSET) >> 2];
	return { fn: lib.wasmTable.get(idx), ptr };
}
