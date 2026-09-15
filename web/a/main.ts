// Variant A's client. The variant is not built yet; what runs now is the shared
// sound control, so it is in place (and testable on staging) before any game
// event is mapped onto the shared cues. When the variant is written, its events
// call audio.play(<cue>) through a thin mapping here, never their own synthesis.

import { sharedAudio } from '../../audio/index.ts';
import { mountAudioControl } from '../../audio/control.ts';

const audio = sharedAudio();
mountAudioControl(audio);

// For browser checks: read state, and wrap play() to see which cues fire.
(globalThis as unknown as { clade: object }).clade = { audio };
