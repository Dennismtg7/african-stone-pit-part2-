export const musicTracks = [
  { id: 'savanna', name: 'Savanna Dawn' },
  { id: 'chain', name: 'Chain Rush' },
  { id: 'moonlit', name: 'Moonlit Pit' },
  { id: 'off', name: 'Music off' }
];

const notes = [220, 261.63, 293.66, 329.63, 392, 440, 523.25, 587.33, 659.25, 783.99];
const tracks = {
  savanna: { bpm: 78, root: 1, melody: [0, -1, 2, -1, 4, -1, 2, -1, 3, -1, 1, -1, 2, -1, -1, -1], kick: [0, 10], snare: [8] },
  chain: { bpm: 112, root: 1, melody: [5, 4, 2, 4, 5, -1, 7, 5, 4, 2, 0, 2, 4, -1, 2, 0], kick: [0, 3, 8, 11], snare: [4, 12, 14] },
  moonlit: { bpm: 64, root: 0.75, melody: [0, -1, -1, 2, -1, -1, 4, -1, 3, -1, -1, 1, -1, -1, -1, -1], kick: [0], snare: [10] }
};

let context;
let master;
let musicBus;
let effectsBus;
let timer;
let step = 0;
let nextTime = 0;
let selectedTrack = 'savanna';
let muted = false;

function ensureAudio() {
  if (context) return;
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) throw new Error('Audio playback is not supported by this browser.');

  context = new AudioContextClass();
  master = context.createGain();
  musicBus = context.createGain();
  effectsBus = context.createGain();
  master.gain.value = muted ? 0 : 0.65;
  musicBus.gain.value = 0.7;
  effectsBus.gain.value = 1;
  musicBus.connect(master);
  effectsBus.connect(master);
  master.connect(context.destination);
}

function pluck(frequency, time, volume, duration, destination) {
  const tone = context.createOscillator();
  const toneGain = context.createGain();
  const overtone = context.createOscillator();
  const overtoneGain = context.createGain();

  tone.type = 'triangle';
  tone.frequency.value = frequency;
  toneGain.gain.setValueAtTime(0, time);
  toneGain.gain.linearRampToValueAtTime(volume, time + 0.01);
  toneGain.gain.exponentialRampToValueAtTime(0.001, time + duration);
  overtone.type = 'sine';
  overtone.frequency.value = frequency * 4.01;
  overtoneGain.gain.setValueAtTime(volume * 0.4, time);
  overtoneGain.gain.exponentialRampToValueAtTime(0.001, time + 0.12);

  tone.connect(toneGain);
  toneGain.connect(destination);
  overtone.connect(overtoneGain);
  overtoneGain.connect(destination);
  tone.start(time);
  tone.stop(time + duration);
  overtone.start(time);
  overtone.stop(time + 0.15);
}

function drum(time, low, volume, destination) {
  const tone = context.createOscillator();
  const gain = context.createGain();
  tone.frequency.setValueAtTime(low ? 150 : 260, time);
  tone.frequency.exponentialRampToValueAtTime(low ? 55 : 140, time + 0.12);
  gain.gain.setValueAtTime(volume * 0.5, time);
  gain.gain.exponentialRampToValueAtTime(0.001, time + (low ? 0.3 : 0.12));
  tone.connect(gain);
  gain.connect(destination);
  tone.start(time);
  tone.stop(time + 0.35);

  if (!low) {
    const length = Math.floor(context.sampleRate * 0.1);
    const buffer = context.createBuffer(1, length, context.sampleRate);
    const samples = buffer.getChannelData(0);
    for (let index = 0; index < length; index++) samples[index] = (Math.random() * 2 - 1) * (1 - index / length);
    const noise = context.createBufferSource();
    const filter = context.createBiquadFilter();
    const noiseGain = context.createGain();
    noise.buffer = buffer;
    filter.type = 'highpass';
    filter.frequency.value = 1800;
    noiseGain.gain.value = volume * 0.35;
    noise.connect(filter);
    filter.connect(noiseGain);
    noiseGain.connect(destination);
    noise.start(time);
  }
}

function pad(time, duration, root) {
  [110 * root, 164.8 * root].forEach(frequency => {
    const tone = context.createOscillator();
    const gain = context.createGain();
    tone.frequency.value = frequency;
    gain.gain.setValueAtTime(0, time);
    gain.gain.linearRampToValueAtTime(0.05, time + duration / 2);
    gain.gain.linearRampToValueAtTime(0, time + duration);
    tone.connect(gain);
    gain.connect(musicBus);
    tone.start(time);
    tone.stop(time + duration);
  });
}

function scheduleMusic() {
  if (!context || !tracks[selectedTrack]) return;
  const track = tracks[selectedTrack];
  const interval = 60 / track.bpm / 2;
  while (nextTime < context.currentTime + 0.25) {
    const beat = step % 16;
    const note = track.melody[beat];
    if (note >= 0) pluck(notes[note] * track.root, nextTime, beat % 4 ? 0.09 : 0.14, 0.9, musicBus);
    if (track.kick.includes(beat)) drum(nextTime, true, 0.45, musicBus);
    if (track.snare.includes(beat)) drum(nextTime, false, 0.35, musicBus);
    if (beat === 0) pad(nextTime, interval * 16, track.root);
    nextTime += interval;
    step++;
  }
}

function restartMusic() {
  clearInterval(timer);
  timer = undefined;
  if (!context || !tracks[selectedTrack] || context.state !== 'running') return;
  step = 0;
  nextTime = context.currentTime + 0.1;
  scheduleMusic();
  timer = setInterval(scheduleMusic, 80);
}

export async function startAudio(trackId, enabled) {
  ensureAudio();
  selectedTrack = Object.prototype.hasOwnProperty.call(tracks, trackId) ? trackId : (trackId === 'off' ? 'off' : selectedTrack);
  muted = !enabled;
  master.gain.setTargetAtTime(muted ? 0 : 0.65, context.currentTime, 0.025);
  if (context.state === 'suspended') await context.resume();
  restartMusic();
}

export function stopMusic() {
  clearInterval(timer);
  timer = undefined;
}

export function playGameSound(type, sequence = 0) {
  if (!context || muted || context.state !== 'running') return;
  const time = context.currentTime;
  if (type === 'sow') {
    pluck(notes[5 + sequence % 5], time, 0.2, 0.45, effectsBus);
  } else if (type === 'chain') {
    pluck(notes[2], time, 0.22, 0.4, effectsBus);
    pluck(notes[4], time + 0.07, 0.22, 0.4, effectsBus);
  } else if (type === 'capture') {
    drum(time, true, 0.9, effectsBus);
    [0, 2, 4].forEach((note, index) => pluck(notes[note], time + index * 0.06, 0.22, 1, effectsBus));
  } else if (type === 'win') {
    [0, 2, 4, 5, 7, 9].forEach((note, index) => pluck(notes[note], time + index * 0.12, 0.25, 1.2, effectsBus));
  }
}
