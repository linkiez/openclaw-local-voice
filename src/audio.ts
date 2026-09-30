const WAKE_PREFIXES = [
  ["openclaw"],
  ["open", "claw"],
  ["open", "clau"],
  ["open", "cloud"],
  ["oping", "clau"],
  ["oping", "cloud"],
] as const;
const PORTUGUESE_CONFIRMATION_PREFIXES = [
  ["openclaw"],
  ["open", "claw"],
  ["oping", "clau"],
  ["oping", "cloud"],
] as const;

function normalizeTokens(text: string): string[] {
  return (
    text
      .normalize("NFKD")
      .toLowerCase()
      .replace(/\p{M}/gu, "")
      .match(/[a-z0-9]+/g) ?? []
  );
}

/**
 * Checks whether an English transcription directly matches the wake phrase.
 *
 * @param text - Transcribed wake audio.
 * @returns Whether the transcription starts with "OpenClaw" or "Open claw".
 */
export function isDirectEnglishWake(text: string): boolean {
  const tokens = normalizeTokens(text);
  return tokens[0] === "openclaw" || (tokens[0] === "open" && tokens[1] === "claw");
}

/**
 * Checks whether an English transcription resembles a supported wake phrase.
 *
 * @param text - Transcribed wake audio.
 * @returns Whether direct or ambiguous "Open cloud" wording was recognized.
 */
export function isEnglishWakeCandidate(text: string): boolean {
  const tokens = normalizeTokens(text);
  return (
    isDirectEnglishWake(text) ||
    (tokens[0] === "open" && tokens[1] === "cloud")
  );
}

/**
 * Checks Portuguese recognition candidates for supported wake phrase variants.
 *
 * @param text - Portuguese transcription of wake audio.
 * @returns Whether the transcription starts with a recognized wake phrase.
 */
export function isPortugueseWakeConfirmation(text: string): boolean {
  const tokens = normalizeTokens(text);
  return PORTUGUESE_CONFIRMATION_PREFIXES.some((prefix) =>
    prefix.every((token, index) => tokens[index] === token),
  );
}

/**
 * Removes a supported wake prefix while preserving the user's command text.
 *
 * @param text - Transcription that may contain a wake prefix.
 * @returns The remaining command, trimmed of leading punctuation.
 */
export function stripWakePrefix(text: string): string {
  const matches = [...text.matchAll(/[^\W_]+/gu)];
  const tokens = matches.map((match) => normalizeTokens(match[0])[0] ?? "");

  for (const prefix of WAKE_PREFIXES) {
    if (prefix.every((token, index) => tokens[index] === token)) {
      const finalMatch = matches[prefix.length - 1];
      if (!finalMatch || finalMatch.index === undefined) {
        return text.trim();
      }
      const end = finalMatch.index + finalMatch[0].length;
      return text.slice(end).replace(/^[\s,.;:!?—-]+/, "").trim();
    }
  }

  return text.trim();
}

/**
 * Converts little-endian signed PCM16 audio into normalized float samples.
 *
 * @param pcm - Mono 16-bit PCM data.
 * @param gain - Linear amplification applied before clipping.
 * @returns A float audio array with values between -1 and 1.
 * @throws {Error} If the frame length or gain is invalid.
 */
export function pcm16ToFloat32(pcm: Buffer, gain: number): Float32Array {
  if (pcm.length % 2 !== 0) {
    throw new Error("PCM audio must have an even number of bytes");
  }
  if (!Number.isFinite(gain) || gain <= 0) {
    throw new Error("Audio gain must be a positive number");
  }

  const samples = new Float32Array(pcm.length / 2);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = (pcm.readInt16LE(index * 2) / 32_768) * gain;
    samples[index] = Math.max(-1, Math.min(1, sample));
  }
  return samples;
}

/**
 * Converts normalized float samples into little-endian signed PCM16.
 *
 * @param samples - Mono float samples.
 * @returns The clipped PCM16 representation.
 * @throws {Error} If an audio sample is not finite.
 */
export function audioToPcm16(samples: Float32Array): Buffer {
  const pcm = Buffer.alloc(samples.length * 2);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index];
    if (sample === undefined || !Number.isFinite(sample)) {
      throw new Error("Audio samples must be finite numbers");
    }
    const clipped = Math.max(-1, Math.min(1, sample));
    pcm.writeInt16LE(Math.trunc(clipped * 32_767), index * 2);
  }
  return pcm;
}

/**
 * Adds a standard mono PCM16 WAV header to raw samples.
 *
 * @param pcm - Little-endian signed PCM16 audio.
 * @param sampleRate - Audio sample rate in hertz.
 * @returns A RIFF/WAVE buffer containing the PCM samples.
 * @throws {Error} If the sample rate or PCM frame is invalid.
 */
export function pcm16ToWav(pcm: Buffer, sampleRate: number): Buffer {
  if (pcm.length % 2 !== 0) {
    throw new Error("PCM audio must have an even number of bytes");
  }
  if (
    !Number.isInteger(sampleRate) ||
    sampleRate <= 0 ||
    sampleRate > 192_000
  ) {
    throw new Error("WAV sample rate must be between 1 and 192,000 Hz");
  }

  const wav = Buffer.alloc(44 + pcm.length);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + pcm.length, 4);
  wav.write("WAVE", 8);
  wav.write("fmt ", 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(pcm.length, 40);
  pcm.copy(wav, 44);
  return wav;
}

/**
 * Removes markup and long code blocks from assistant text before speech.
 *
 * @param text - Assistant reply.
 * @returns Plain text limited to 1,400 characters.
 */
export function spokenText(text: string): string {
  return text
    .replace(/```.*?```/gs, " bloco de código omitido ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "link")
    .replace(/[`*_#>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1_400);
}
