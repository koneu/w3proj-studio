// Length of a sound file in milliseconds, from its header: FLAC (STREAMINFO:
// sample rate and total samples) and WAV (fmt and data chunks). The World
// Editor writes it into the map script (SetSoundDuration). Other formats: null.

export function soundDurationMs(buf: Uint8Array): number | null {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const tag = (o: number) => String.fromCharCode(buf[o], buf[o + 1], buf[o + 2], buf[o + 3]);
  if (buf.length >= 42 && tag(0) === "fLaC") {
    // STREAMINFO is the first metadata block: rate (20 bits) at byte 18, total samples (36 bits) after.
    const p = 8;
    const rate = (buf[p + 10] << 12) | (buf[p + 11] << 4) | (buf[p + 12] >> 4);
    const samples = (buf[p + 13] & 0x0f) * 2 ** 32 + dv.getUint32(p + 14);
    return rate ? Math.floor((samples * 1000) / rate) : null;
  }
  if (buf.length >= 12 && tag(0) === "RIFF" && tag(8) === "WAVE") {
    let byteRate = 0;
    for (let o = 12; o + 8 <= buf.length;) {
      const id = tag(o), size = dv.getUint32(o + 4, true);
      if (id === "fmt ") byteRate = dv.getUint32(o + 16, true);
      else if (id === "data") return byteRate ? Math.floor((size * 1000) / byteRate) : null;
      o += 8 + size + (size & 1);
    }
  }
  if (buf.length >= 58 && tag(0) === "OggS") {
    // Vorbis identification header: sample rate at byte 12 of the packet; the last
    // page's granule position is the total sample count.
    const rate = dv.getUint32(28 + 12, true);
    for (let o = buf.length - 14; o >= 0; o--) {
      if (buf[o] === 0x4f && tag(o) === "OggS") {
        const samples = dv.getUint32(o + 6, true) + dv.getUint32(o + 10, true) * 2 ** 32;
        return rate ? Math.floor((samples * 1000) / rate) : null;
      }
    }
    return null;
  }
  return mp3DurationMs(buf);
}

const MP3_BITRATES = [
  [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320], // MPEG-1 layer III
  [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160], // MPEG-2/2.5 layer III
];
const MP3_RATES = [[44100, 48000, 32000], [22050, 24000, 16000], [11025, 12000, 8000]];

/** MP3 (layer III): counts the frames, so variable bitrates come out right. */
function mp3DurationMs(buf: Uint8Array): number | null {
  let o = 0;
  // Skip an ID3v2 tag.
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) {
    o = 10 + ((buf[6] & 0x7f) << 21 | (buf[7] & 0x7f) << 14 | (buf[8] & 0x7f) << 7 | (buf[9] & 0x7f));
  }
  let samples = 0, rate = 0;
  while (o + 4 <= buf.length) {
    if (buf[o] !== 0xff || (buf[o + 1] & 0xe0) !== 0xe0) { if (samples) break; o++; continue; }
    const version = (buf[o + 1] >> 3) & 3; // 3 MPEG-1, 2 MPEG-2, 0 MPEG-2.5
    const layer = (buf[o + 1] >> 1) & 3; // 1 = layer III
    const bitrateIdx = buf[o + 2] >> 4, rateIdx = (buf[o + 2] >> 2) & 3, padding = (buf[o + 2] >> 1) & 1;
    if (version === 1 || layer !== 1 || bitrateIdx === 0 || bitrateIdx === 15 || rateIdx === 3) { if (samples) break; o++; continue; }
    const mpeg1 = version === 3;
    rate = MP3_RATES[mpeg1 ? 0 : version === 2 ? 1 : 2][rateIdx];
    const perFrame = mpeg1 ? 1152 : 576;
    const size = Math.floor(((perFrame / 8) * MP3_BITRATES[mpeg1 ? 0 : 1][bitrateIdx] * 1000) / rate) + padding;
    samples += perFrame;
    o += size;
  }
  return samples && rate ? Math.floor((samples * 1000) / rate) : null;
}
