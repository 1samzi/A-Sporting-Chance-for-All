(() => {
  const startAudioButton = document.getElementById('start-audio');
  const midiInput = document.getElementById('midi-file');
  const playButton = document.getElementById('play-midi');
  const stopButton = document.getElementById('stop-midi');
  const status = document.getElementById('midi-status');
  const waveformSelect = document.getElementById('waveform');
  const attackControl = document.getElementById('attack');
  const releaseControl = document.getElementById('release');
  const volumeControl = document.getElementById('volume');

  let audioContext;
  let masterGain;
  let midiData = null;
  let activeVoices = new Map();
  let scheduledTimeouts = [];

  const setStatus = (text) => {
    status.textContent = text;
  };

  const ensureAudio = async () => {
    if (!audioContext) {
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
      masterGain = audioContext.createGain();
      masterGain.gain.value = Number(volumeControl.value);
      masterGain.connect(audioContext.destination);
    }

    if (audioContext.state === 'suspended') {
      await audioContext.resume();
    }
  };

  const readUint32 = (view, offset) => view.getUint32(offset, false);
  const readUint16 = (view, offset) => view.getUint16(offset, false);

  const readVarLen = (view, offsetObj) => {
    let value = 0;
    while (true) {
      const byte = view.getUint8(offsetObj.offset++);
      value = (value << 7) | (byte & 0x7f);
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };

  const parseMidi = (arrayBuffer) => {
    const view = new DataView(arrayBuffer);
    let offset = 0;

    const readChunkHeader = () => {
      const id = String.fromCharCode(
        view.getUint8(offset),
        view.getUint8(offset + 1),
        view.getUint8(offset + 2),
        view.getUint8(offset + 3)
      );
      const length = readUint32(view, offset + 4);
      offset += 8;
      return { id, length };
    };

    const header = readChunkHeader();
    if (header.id !== 'MThd') {
      throw new Error('Invalid MIDI file: missing MThd header.');
    }

    const format = readUint16(view, offset);
    const trackCount = readUint16(view, offset + 2);
    const division = readUint16(view, offset + 4);
    offset += header.length;

    if ((division & 0x8000) !== 0) {
      throw new Error('SMPTE time format MIDI files are not supported.');
    }

    const ticksPerQuarter = division;
    const allEvents = [];

    for (let t = 0; t < trackCount; t++) {
      const chunk = readChunkHeader();
      if (chunk.id !== 'MTrk') {
        throw new Error('Invalid MIDI file: track chunk missing.');
      }

      const trackEnd = offset + chunk.length;
      let absoluteTicks = 0;
      let runningStatus = null;

      while (offset < trackEnd) {
        const offsetObj = { offset };
        const delta = readVarLen(view, offsetObj);
        offset = offsetObj.offset;
        absoluteTicks += delta;

        let statusByte = view.getUint8(offset++);
        if (statusByte < 0x80) {
          if (runningStatus === null) {
            throw new Error('Invalid running status in MIDI track.');
          }
          offset--;
          statusByte = runningStatus;
        } else {
          runningStatus = statusByte;
        }

        if (statusByte === 0xff) {
          const metaType = view.getUint8(offset++);
          const lenObj = { offset };
          const length = readVarLen(view, lenObj);
          offset = lenObj.offset;

          if (metaType === 0x51 && length === 3) {
            const tempo =
              (view.getUint8(offset) << 16) |
              (view.getUint8(offset + 1) << 8) |
              view.getUint8(offset + 2);
            allEvents.push({ type: 'tempo', ticks: absoluteTicks, tempo });
          }
          offset += length;
          continue;
        }

        if (statusByte === 0xf0 || statusByte === 0xf7) {
          const lenObj = { offset };
          const length = readVarLen(view, lenObj);
          offset = lenObj.offset + length;
          continue;
        }

        const command = statusByte & 0xf0;
        const channel = statusByte & 0x0f;

        const data1 = view.getUint8(offset++);
        let data2 = null;
        if (command !== 0xc0 && command !== 0xd0) {
          data2 = view.getUint8(offset++);
        }

        if (command === 0x90 && data2 > 0) {
          allEvents.push({
            type: 'noteon',
            ticks: absoluteTicks,
            channel,
            note: data1,
            velocity: data2
          });
        } else if (command === 0x80 || (command === 0x90 && data2 === 0)) {
          allEvents.push({
            type: 'noteoff',
            ticks: absoluteTicks,
            channel,
            note: data1,
            velocity: data2 || 0
          });
        }
      }
    }

    allEvents.sort((a, b) => a.ticks - b.ticks);

    return { format, ticksPerQuarter, events: allEvents };
  };

  const ticksToSeconds = (events, ticksPerQuarter) => {
    const tempoEvents = events.filter((event) => event.type === 'tempo');
    const segments = [];

    let currentTempo = 500000;
    let lastTick = 0;
    let elapsed = 0;

    for (const tempoEvent of tempoEvents) {
      const deltaTicks = tempoEvent.ticks - lastTick;
      elapsed += (deltaTicks * currentTempo) / (ticksPerQuarter * 1000000);
      segments.push({ startTick: lastTick, startSeconds: elapsed - (deltaTicks * currentTempo) / (ticksPerQuarter * 1000000), tempo: currentTempo });
      lastTick = tempoEvent.ticks;
      currentTempo = tempoEvent.tempo;
    }

    segments.push({ startTick: lastTick, startSeconds: elapsed, tempo: currentTempo });

    const convert = (ticks) => {
      let segment = segments[0];
      for (const candidate of segments) {
        if (candidate.startTick <= ticks) {
          segment = candidate;
        } else {
          break;
        }
      }
      const deltaTicks = ticks - segment.startTick;
      return segment.startSeconds + (deltaTicks * segment.tempo) / (ticksPerQuarter * 1000000);
    };

    return events
      .filter((event) => event.type === 'noteon' || event.type === 'noteoff')
      .map((event) => ({ ...event, seconds: convert(event.ticks) }));
  };

  const midiNoteToFrequency = (note) => 440 * Math.pow(2, (note - 69) / 12);

  const noteKey = (channel, note) => `${channel}:${note}`;

  const triggerNoteOn = (eventTime, note, velocity, channel) => {
    const frequency = midiNoteToFrequency(note);
    const oscillator = audioContext.createOscillator();
    oscillator.type = waveformSelect.value;
    oscillator.frequency.setValueAtTime(frequency, eventTime);

    const gain = audioContext.createGain();
    const maxGain = (velocity / 127) * 0.8;
    const attack = Number(attackControl.value);
    gain.gain.setValueAtTime(0, eventTime);
    gain.gain.linearRampToValueAtTime(maxGain, eventTime + attack);

    oscillator.connect(gain);
    gain.connect(masterGain);

    oscillator.start(eventTime);
    activeVoices.set(noteKey(channel, note), { oscillator, gain });
  };

  const triggerNoteOff = (eventTime, note, channel) => {
    const voice = activeVoices.get(noteKey(channel, note));
    if (!voice) return;

    const release = Number(releaseControl.value);
    const nowValue = voice.gain.gain.value;
    voice.gain.gain.cancelScheduledValues(eventTime);
    voice.gain.gain.setValueAtTime(nowValue, eventTime);
    voice.gain.gain.linearRampToValueAtTime(0.0001, eventTime + release);
    voice.oscillator.stop(eventTime + release + 0.02);

    activeVoices.delete(noteKey(channel, note));
  };

  const stopPlayback = () => {
    scheduledTimeouts.forEach((timeoutId) => window.clearTimeout(timeoutId));
    scheduledTimeouts = [];

    const now = audioContext ? audioContext.currentTime : 0;
    for (const [key, voice] of activeVoices.entries()) {
      voice.gain.gain.cancelScheduledValues(now);
      voice.gain.gain.setValueAtTime(0, now);
      voice.oscillator.stop(now + 0.01);
      activeVoices.delete(key);
    }
  };

  const playMidi = async () => {
    if (!midiData) {
      setStatus('Please upload a MIDI file first.');
      return;
    }

    await ensureAudio();
    stopPlayback();

    const timedEvents = ticksToSeconds(midiData.events, midiData.ticksPerQuarter);
    const start = audioContext.currentTime + 0.05;

    timedEvents.forEach((event) => {
      const eventTime = start + event.seconds;
      if (event.type === 'noteon') {
        triggerNoteOn(eventTime, event.note, event.velocity, event.channel);
      } else {
        triggerNoteOff(eventTime, event.note, event.channel);
      }
    });

    const endSeconds = timedEvents.length ? timedEvents[timedEvents.length - 1].seconds : 0;
    const completionId = window.setTimeout(() => {
      setStatus('Playback complete.');
    }, Math.ceil((endSeconds + Number(releaseControl.value) + 0.2) * 1000));
    scheduledTimeouts.push(completionId);

    setStatus('Playing MIDI...');
  };

  startAudioButton.addEventListener('click', async () => {
    await ensureAudio();
    setStatus('Audio engine ready. Upload a MIDI file.');
  });

  midiInput.addEventListener('change', async (event) => {
    const [file] = event.target.files;
    if (!file) return;

    try {
      const arrayBuffer = await file.arrayBuffer();
      midiData = parseMidi(arrayBuffer);
      setStatus(`Loaded ${file.name} (${midiData.events.length} events).`);
    } catch (error) {
      midiData = null;
      setStatus(`Could not parse MIDI file: ${error.message}`);
    }
  });

  playButton.addEventListener('click', () => {
    playMidi();
  });

  stopButton.addEventListener('click', () => {
    stopPlayback();
    setStatus('Playback stopped.');
  });

  volumeControl.addEventListener('input', () => {
    if (masterGain) {
      masterGain.gain.setValueAtTime(Number(volumeControl.value), audioContext.currentTime);
    }
  });
})();
