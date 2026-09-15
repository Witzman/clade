// The sound control every variant shows: one tap to mute, and a small panel
// for volume and the music switch. Shared, so it sits in the same place with
// the same behaviour in every variant and muting is not a variable between
// them.
//
//   import { sharedAudio } from '../../audio/index.ts';
//   import { mountAudioControl } from '../../audio/control.ts';
//   mountAudioControl(sharedAudio());
//
// The control only calls the module's setters; the module owns persistence.
// Browser-only (DOM), so it is not exported from index.ts, which node tests load.

import type { SharedAudio } from './index.ts';

export interface AudioControl {
  readonly element: HTMLElement;
  /** Re-read the module's state into the control. */
  refresh(): void;
  dispose(): void;
}

const CSS = `
.clade-audio { position: fixed; z-index: 1000;
  top: max(8px, env(safe-area-inset-top)); right: max(8px, env(safe-area-inset-right));
  display: flex; flex-direction: column; align-items: flex-end; gap: 6px;
  font: 14px/1.3 system-ui, -apple-system, sans-serif; color: #e6e8eb; }
.clade-audio .row { display: flex; gap: 6px; }
.clade-audio button { width: 44px; height: 44px; padding: 0; display: grid; place-items: center;
  border: 1px solid rgba(230,232,235,.28); border-radius: 8px; background: rgba(11,13,16,.72);
  color: inherit; cursor: pointer; touch-action: manipulation; -webkit-tap-highlight-color: transparent; }
.clade-audio button:focus-visible { outline: 2px solid #3fb950; outline-offset: 2px; }
.clade-audio button[aria-pressed="true"].mute { color: #f0883e; border-color: rgba(240,136,62,.6); }
.clade-audio svg { width: 22px; height: 22px; fill: none; stroke: currentColor; stroke-width: 2;
  stroke-linecap: round; stroke-linejoin: round; }
.clade-audio .panel { display: grid; gap: 8px; padding: 10px 12px; min-width: 200px;
  border: 1px solid rgba(230,232,235,.28); border-radius: 8px; background: rgba(11,13,16,.92); }
.clade-audio .panel[hidden] { display: none; }
.clade-audio label { display: flex; align-items: center; justify-content: space-between; gap: 10px;
  min-height: 44px; }
.clade-audio input[type=range] { width: 120px; height: 44px; margin: 0; accent-color: #3fb950; }
.clade-audio input[type=checkbox] { width: 22px; height: 22px; margin: 0; accent-color: #3fb950; }
`;

const SPEAKER = '<path d="M11 5 6 9H3v6h3l5 4z"/>';
const ICON_ON = `<svg viewBox="0 0 24 24" aria-hidden="true">${SPEAKER}<path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/></svg>`;
const ICON_OFF = `<svg viewBox="0 0 24 24" aria-hidden="true">${SPEAKER}<path d="m16 9 6 6M22 9l-6 6"/></svg>`;
const ICON_MORE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/></svg>';

/** A level preview while dragging the slider, at most this often. */
const PREVIEW_MS = 150;

export function mountAudioControl(audio: SharedAudio, parent: HTMLElement = document.body): AudioControl {
  if (!document.getElementById('clade-audio-style')) {
    const style = document.createElement('style');
    style.id = 'clade-audio-style';
    style.textContent = CSS;
    document.head.append(style);
  }

  const root = document.createElement('div');
  root.className = 'clade-audio';
  root.innerHTML = `
    <div class="row">
      <button type="button" class="more" aria-expanded="false" aria-controls="clade-audio-panel" aria-label="Sound settings">${ICON_MORE}</button>
      <button type="button" class="mute" aria-pressed="false"></button>
    </div>
    <div class="panel" id="clade-audio-panel" hidden>
      <label>Volume <input type="range" class="volume" min="0" max="1" step="0.05"></label>
      <label>Music <input type="checkbox" class="music"></label>
    </div>`;
  parent.append(root);

  const q = <T extends HTMLElement>(sel: string) => root.querySelector(sel) as T;
  const mute = q<HTMLButtonElement>('.mute');
  const more = q<HTMLButtonElement>('.more');
  const panel = q<HTMLDivElement>('.panel');
  const volume = q<HTMLInputElement>('.volume');
  const music = q<HTMLInputElement>('.music');

  function refresh(): void {
    const s = audio.state;
    mute.setAttribute('aria-pressed', String(s.muted));
    mute.setAttribute('aria-label', s.muted ? 'Unmute sound' : 'Mute sound');
    mute.title = s.muted ? 'Sound off' : 'Sound on';
    mute.innerHTML = s.muted ? ICON_OFF : ICON_ON;
    volume.value = String(s.volume);
    volume.disabled = s.muted;
    music.checked = s.musicOn;
    music.disabled = s.muted;
  }

  const setOpen = (open: boolean) => {
    panel.hidden = !open;
    more.setAttribute('aria-expanded', String(open));
  };

  let lastPreview = 0;
  const onMute = () => {
    const muted = !audio.state.muted;
    audio.setMuted(muted);
    if (!muted) audio.play('tap'); // hear that sound is back, at the current level
    refresh();
  };
  const onMore = () => setOpen(panel.hidden !== false);
  const onVolume = () => {
    audio.setVolume(Number(volume.value));
    const now = performance.now();
    if (now - lastPreview >= PREVIEW_MS) { lastPreview = now; audio.play('tap'); }
  };
  const onMusic = () => { audio.setMusicOn(music.checked); refresh(); };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !panel.hidden) { setOpen(false); more.focus(); } };
  const onOutside = (e: Event) => { if (!panel.hidden && !root.contains(e.target as Node)) setOpen(false); };

  mute.addEventListener('click', onMute);
  more.addEventListener('click', onMore);
  volume.addEventListener('input', onVolume);
  music.addEventListener('change', onMusic);
  root.addEventListener('keydown', onKey);
  document.addEventListener('pointerdown', onOutside);
  refresh();

  return {
    element: root,
    refresh,
    dispose() {
      document.removeEventListener('pointerdown', onOutside);
      root.remove();
    },
  };
}
