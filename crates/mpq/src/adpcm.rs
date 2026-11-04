//! Storm's ADPCM decoder (compression masks 0x40 mono, 0x80 stereo): 16-bit PCM sounds of older
//! maps, stored as one byte per sample and usually Huffman-coded on top.
//!
//! Stream: a zero byte, the bit shift (compression level), one initial 16-bit sample per channel,
//! then one byte per sample, channels taking turns. A sample byte holds the step bits (0x01–0x20,
//! added as step >> 0 … step >> 5 on top of step >> shift) and the sign (0x40). Bytes with 0x80
//! set are commands: 0x80 repeats the last sample and lowers the step index by 1, 0x81 raises it
//! by 8, 0x82 does nothing, anything else lowers it by 8; 0x81 and the "anything else" commands
//! don't use up the channel's turn.

const INITIAL_STEP_INDEX: usize = 0x2C;
const MAX_STEP_INDEX: usize = 0x58;

/// Step index change per sample byte (its low 5 bits).
const NEXT_STEP: [i32; 32] = [
    -1, 0, -1, 4, -1, 2, -1, 6, -1, 1, -1, 5, -1, 3, -1, 7, -1, 1, -1, 5, -1, 3, -1, 7, -1, 2, -1, 4, -1, 6, -1, 8,
];

/// The IMA ADPCM step sizes.
const STEP_SIZE: [i32; 89] = [
    7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130,
    143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282,
    1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630,
    9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767,
];

fn decode_sample(predicted: i32, encoded: u8, step: i32, shift: u8) -> i32 {
    let mut difference = step >> shift;
    for k in 0..6 {
        if encoded & (1 << k) != 0 {
            difference += step >> k;
        }
    }
    if encoded & 0x40 != 0 {
        (predicted - difference).max(-32768)
    } else {
        (predicted + difference).min(32767)
    }
}

/// Decodes `data` for `channels` (1 or 2) into at most `max` bytes of little-endian 16-bit PCM.
pub(crate) fn decompress(data: &[u8], max: usize, channels: usize) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(max);
    let mut input = data.iter().copied();
    input.next()?;
    let shift = input.next()?.min(31);
    let mut predicted = [0i32; 2];
    let mut step_index = [INITIAL_STEP_INDEX; 2];
    for p in predicted.iter_mut().take(channels) {
        let sample = i16::from_le_bytes([input.next()?, input.next()?]);
        *p = sample as i32;
        out.extend_from_slice(&sample.to_le_bytes());
    }
    let mut channel = channels - 1;
    for encoded in input {
        if out.len() >= max {
            break;
        }
        channel = (channel + 1) % channels;
        if encoded & 0x80 != 0 {
            match encoded & 0x7F {
                0 => {
                    step_index[channel] = step_index[channel].saturating_sub(1);
                    out.extend_from_slice(&(predicted[channel] as i16).to_le_bytes());
                }
                1 => {
                    step_index[channel] = (step_index[channel] + 8).min(MAX_STEP_INDEX);
                    channel = (channel + 1) % channels;
                }
                2 => {}
                _ => {
                    step_index[channel] = step_index[channel].saturating_sub(8);
                    channel = (channel + 1) % channels;
                }
            }
        } else {
            let step = STEP_SIZE[step_index[channel]];
            predicted[channel] = decode_sample(predicted[channel], encoded, step, shift);
            out.extend_from_slice(&(predicted[channel] as i16).to_le_bytes());
            let next = step_index[channel] as i32 + NEXT_STEP[(encoded & 0x1F) as usize];
            step_index[channel] = next.clamp(0, MAX_STEP_INDEX as i32) as usize;
        }
    }
    out.truncate(max);
    Some(out)
}
