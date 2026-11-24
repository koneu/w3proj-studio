//! Huffman and ADPCM sectors on real maps (corpus tier). The mpq crate's own tests feed those decoders made-up
//! data: that proves they survive bad input, not that they decode sound. The writer never makes such sectors, so
//! only maps saved by Blizzard's tools have them. This test finds every file of the corpus (W3PROJ_CORPUS, default
//! `smoketest_maps` next to the main checkout; campaigns' chapter maps too) stored with Huffman (0x01) or ADPCM
//! mono (0x40) / stereo (0x80) sectors, reads it through `mpq::Archive` and checks the result against what doesn't
//! come from those decoders: the block's declared size, the WAV's own RIFF header (in the first sector, which
//! Blizzard's tools store with zlib, so a wrong sound decode can't make it agree with itself), the channel count
//! the ADPCM mask claims, and the samples themselves (a wrongly decoded ADPCM sector jumps at its edges, drifts
//! into clipping or turns into noise). The decoded bytes' hashes are pinned in `mpq_sound_sectors.tsv`, so any
//! change of a decoder's output shows.
//!
//! The corpus of 2026-11-24 has only 0x41 (Huffman, then ADPCM mono): 17 sounds of The Invasion of Kalimdor
//! Reworked, in both of its campaign files. No file uses Huffman alone or ADPCM stereo, so those stay unproven.
//!
//! Without the corpus it says so and passes; with `W3PROJ_REQUIRE_CORPUS=1` (the gate's `rustcorpus`) it fails.

mod common;

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use mpq::{crypto, flags, Archive, BlockEntry};

const HUFFMAN: u8 = 0x01;
const ADPCM_MONO: u8 = 0x40;
const ADPCM_STEREO: u8 = 0x80;
const SOUND: u8 = HUFFMAN | ADPCM_MONO | ADPCM_STEREO;

const BASELINE: &str = include_str!("mpq_sound_sectors.tsv");

fn corpus() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("W3PROJ_CORPUS") {
        return Some(PathBuf::from(p)).filter(|p| p.is_dir());
    }
    // The main checkout holds smoketest_maps; a worktree lies inside it (.worktrees/<name>), so walking up finds it.
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .map(|d| d.join("smoketest_maps"))
        .find(|p| p.is_dir())
}

fn is_map(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    n.ends_with(".w3x") || n.ends_with(".w3m") || n.ends_with(".w3n")
}

fn archives(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    let mut entries: Vec<PathBuf> = rd.flatten().map(|e| e.path()).collect();
    entries.sort();
    for p in entries {
        if p.is_dir() {
            archives(&p, out);
        } else if is_map(&p.to_string_lossy()) {
            out.push(p);
        }
    }
}

fn u16_at(d: &[u8], o: usize) -> u16 {
    u16::from_le_bytes([d[o], d[o + 1]])
}
fn u32_at(d: &[u8], o: usize) -> u32 {
    u32::from_le_bytes(d[o..o + 4].try_into().unwrap())
}

/// Where each sector of a block starts in the archive file and its compression mask (0 for a sector stored
/// whole). Read from the raw bytes, apart from `Archive::read_block`, so the test knows which decoders a file
/// really goes through.
fn sectors(data: &[u8], offset: usize, sector: usize, b: &BlockEntry, name: &str) -> Vec<(usize, u8)> {
    if b.flags & flags::COMPRESS == 0 || b.file_size == 0 {
        return Vec::new();
    }
    let start = offset + b.file_pos as usize;
    let Some(raw) = data.get(start..start + b.compressed_size as usize) else { return Vec::new() };
    let key = (b.flags & flags::ENCRYPTED != 0)
        .then(|| crypto::file_key(name, b.file_pos, b.file_size, b.flags & flags::FIX_KEY != 0));
    // Decrypting needs whole words; a sector's first word holds its mask byte.
    let mask_of = |sect: &[u8], k: Option<u32>| -> u8 {
        let mut head = sect[..4.min(sect.len())].to_vec();
        if let (Some(k), 4) = (k, head.len()) {
            crypto::decrypt_bytes(&mut head, k);
        }
        head.first().copied().unwrap_or(0)
    };
    let file_size = b.file_size as usize;
    if b.flags & flags::SINGLE_UNIT != 0 {
        return vec![(start, if raw.len() < file_size { mask_of(raw, key) } else { 0 })];
    }
    let n = file_size.div_ceil(sector);
    if raw.len() < (n + 1) * 4 {
        return Vec::new();
    }
    let mut table: Vec<u32> = (0..=n).map(|i| u32_at(raw, i * 4)).collect();
    if let Some(k) = key {
        crypto::decrypt(&mut table, k.wrapping_sub(1));
    }
    (0..n)
        .map(|i| {
            let sect = raw.get(table[i] as usize..table[i + 1] as usize).unwrap_or(&[]);
            let expected = sector.min(file_size - i * sector);
            let mask = if sect.len() < expected { mask_of(sect, key.map(|k| k.wrapping_add(i as u32))) } else { 0 };
            (start + table[i] as usize, mask)
        })
        .collect()
}

/// A file stored with Huffman or ADPCM sectors.
#[derive(Clone)]
struct Found {
    archive: String,
    name: String,
    encrypted: bool,
    /// Where each sector starts in the archive's bytes, and its mask.
    sectors: Vec<(usize, u8)>,
    sector_size: usize,
    file_size: usize,
    decoded: Result<Vec<u8>, String>,
}

impl Found {
    fn masks(&self) -> Vec<u8> {
        let mut m: Vec<u8> = self.sectors.iter().map(|s| s.1).filter(|&m| m != 0).collect();
        m.sort_unstable();
        m.dedup();
        m
    }
}

/// Every file of an archive (and of the chapter maps inside it) stored with Huffman or ADPCM sectors. Files the
/// listfile doesn't name are looked at too, unless encrypted (that needs the name), under their slot number.
fn scan(label: &str, data: &[u8], found: &mut Vec<Found>) {
    let Ok(a) = Archive::from_bytes(data.to_vec()) else { return };
    let offset = a.prefix().len();
    let sector_size = a.sector_size();
    let list = a.read("(listfile)").map(|l| String::from_utf8_lossy(&l).into_owned()).unwrap_or_default();
    let mut named = HashSet::new();
    let mut chapters = Vec::new();
    // Only a file with sound sectors is decoded (through `Archive::read_block`, what the product reads with).
    let mut add = |name: String, b: &BlockEntry, key_name: Option<&str>| {
        let s = sectors(data, offset, sector_size, b, key_name.unwrap_or(""));
        if s.iter().any(|s| s.1 & SOUND != 0) {
            found.push(Found {
                archive: label.to_string(),
                name,
                encrypted: b.flags & flags::ENCRYPTED != 0,
                sectors: s,
                sector_size,
                file_size: b.file_size as usize,
                decoded: a.read_block(b, key_name).map_err(|e| e.to_string()),
            });
        }
    };
    for name in list.lines().map(str::trim).filter(|l| !l.is_empty()) {
        let Some(slot) = a.find(name) else { continue };
        if !named.insert(slot.slot) {
            continue;
        }
        add(name.to_string(), &slot.block, Some(name));
        if is_map(name) {
            chapters.push(name.to_string());
        }
    }
    for slot in a.slots() {
        if !named.contains(&slot.slot) && slot.block.flags & flags::ENCRYPTED == 0 {
            add(format!("(slot {})", slot.slot), &slot.block, None);
        }
    }
    for name in chapters {
        if let Ok(inner) = a.read(&name) {
            scan(&format!("{label} > {name}"), &inner, found);
        }
    }
}

/// What a decoded sound looks like, for the sanity checks.
#[derive(Debug)]
struct Sound {
    /// Clipped samples (at either end of the 16-bit range), per million.
    clipped_ppm: u64,
    /// Mean step between neighbouring samples of a channel over their mean size, in percent: speech and effects
    /// stay well below the ~140 of white noise.
    roughness_pct: u64,
    /// The largest step across a sector edge over the largest of the steps around it (at least 256), in percent:
    /// each ADPCM sector starts again from a sample stored whole, so a sector decoded wrongly jumps there.
    edge_pct: u64,
}

/// Checks a decoded WAV against its own RIFF header and the mask's channel count; returns its sample figures.
fn check_wav(f: &Found, wav: &[u8]) -> Result<Sound, String> {
    if wav.len() < 12 || &wav[..4] != b"RIFF" || &wav[8..12] != b"WAVE" {
        return Err("no RIFF/WAVE header".into());
    }
    if u32_at(wav, 4) as usize + 8 != wav.len() {
        return Err(format!("RIFF says {} bytes, the file has {}", u32_at(wav, 4) as usize + 8, wav.len()));
    }
    let (mut fmt, mut body) = (None, None);
    let mut at = 12;
    while at + 8 <= wav.len() {
        let (id, len) = (&wav[at..at + 4], u32_at(wav, at + 4) as usize);
        let start = at + 8;
        let end = start.checked_add(len).filter(|&e| e <= wav.len()).ok_or("a chunk runs past the end")?;
        match id {
            b"fmt " => fmt = Some(&wav[start..end]),
            b"data" => body = Some(start..end),
            _ => {}
        }
        at = end + (len & 1);
    }
    let fmt = fmt.ok_or("no fmt chunk")?;
    let body = body.ok_or("no data chunk")?;
    if fmt.len() < 16 {
        return Err("short fmt chunk".into());
    }
    let (tag, channels, rate) = (u16_at(fmt, 0), u16_at(fmt, 2), u32_at(fmt, 4));
    let (byte_rate, align, bits) = (u32_at(fmt, 8), u16_at(fmt, 12), u16_at(fmt, 14));
    if tag != 1 || bits != 16 {
        return Err(format!("format {tag}, {bits} bits: ADPCM sectors hold 16-bit PCM"));
    }
    if align != channels * 2 || byte_rate != rate * u32::from(align) || !(4000..=96000).contains(&rate) {
        return Err(format!("inconsistent fmt: {channels} ch, {rate} Hz, {byte_rate} B/s, align {align}"));
    }
    let masks = f.masks();
    let want = if masks.iter().any(|m| m & ADPCM_STEREO != 0) {
        Some(2)
    } else if masks.iter().any(|m| m & ADPCM_MONO != 0) {
        Some(1)
    } else {
        None
    };
    if want.is_some_and(|w| w != channels) {
        return Err(format!("{channels} channels, but the sectors are ADPCM for {}", want.unwrap()));
    }
    // ADPCM sectors are where samples come from: an ADPCM sector holding the header would hold no samples.
    let sound_sectors: Vec<usize> =
        f.sectors.iter().enumerate().filter(|(_, s)| s.1 & (ADPCM_MONO | ADPCM_STEREO) != 0).map(|(i, _)| i).collect();
    if sound_sectors.first().is_some_and(|&i| i * f.sector_size < body.start) {
        return Err("an ADPCM sector holds the header".into());
    }

    let ch = usize::from(channels);
    let samples: Vec<i32> = wav[body.clone()].chunks_exact(2).map(|c| i32::from(i16::from_le_bytes([c[0], c[1]]))).collect();
    let frames = samples.len() / ch;
    let clipped = samples.iter().filter(|&&s| s >= 32767 || s <= -32768).count() as u64;
    // step(c, k): the step into frame k of channel c.
    let step = |c: usize, k: usize| (samples[k * ch + c] - samples[(k - 1) * ch + c]).unsigned_abs() as u64;
    let (mut size_sum, mut step_sum) = (0u64, 0u64);
    for c in 0..ch {
        for k in 0..frames {
            size_sum += u64::from(samples[k * ch + c].unsigned_abs());
            if k > 0 {
                step_sum += step(c, k);
            }
        }
    }
    // Sector edges as frame numbers (a sector size is a whole number of frames, and so is the header's end).
    const NEAR: usize = 32;
    let mut edge_pct = 0;
    for b in sound_sectors.iter().map(|&i| i * f.sector_size).filter(|&b| b > body.start) {
        let k = (b - body.start) / (2 * ch);
        if k <= NEAR || k + NEAR >= frames {
            continue;
        }
        for c in 0..ch {
            let near = (k - NEAR..k).chain(k + 1..=k + NEAR).map(|j| step(c, j)).max().unwrap_or(0);
            edge_pct = edge_pct.max(step(c, k) * 100 / near.max(256));
        }
    }
    Ok(Sound {
        clipped_ppm: clipped * 1_000_000 / samples.len().max(1) as u64,
        roughness_pct: step_sum * 100 / size_sum.max(1),
        edge_pct,
    })
}

/// The limits a real sound stays inside. The corpus's sounds of 2026-11-24: no clipped sample, roughness 7 to 37,
/// edge steps at most 125 % of their neighbours; the controls' wrong decodes: 10369 ppm clipped, roughness 126,
/// an edge at 846 %.
fn sane(s: &Sound) -> Result<(), String> {
    if s.clipped_ppm > 1000 {
        return Err(format!("{} ppm of the samples are clipped", s.clipped_ppm));
    }
    if s.roughness_pct > 70 {
        return Err(format!("roughness {} %: noise, not sound", s.roughness_pct));
    }
    if s.edge_pct > 300 {
        return Err(format!("a step across a sector edge is {} % of the steps around it", s.edge_pct));
    }
    Ok(())
}

/// Everything a found file must pass: decoded, the declared size, a WAV consistent with itself and its sectors,
/// and samples that look like sound.
fn check(f: &Found) -> Result<Vec<u8>, String> {
    let wav = f.decoded.clone().map_err(|e| format!("not decoded: {e}"))?;
    if wav.len() != f.file_size {
        return Err(format!("decoded {} bytes, the block declares {}", wav.len(), f.file_size));
    }
    if !f.name.to_ascii_lowercase().ends_with(".wav") {
        return Err("not a .wav: this test knows only how to check sounds; teach it this kind".into());
    }
    let sound = check_wav(f, &wav)?;
    sane(&sound)?;
    Ok(wav)
}

/// FNV-1a, 64 bits: enough to pin a decoder's output, without a crate for it.
fn fnv(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf2_9ce4_8422_2325, |h, &b| (h ^ u64::from(b)).wrapping_mul(0x0100_0000_01b3))
}

fn baseline_line(f: &Found, wav: &[u8]) -> String {
    let masks: Vec<String> = f.masks().iter().map(|m| format!("{m:02x}")).collect();
    format!("{}\t{}\t{}\t{}\t{:016x}", f.archive, f.name, masks.join(","), f.file_size, fnv(wav))
}

/// What the corpus holds for this test, scanned once for both tests.
struct Sounds {
    /// The files with sound sectors.
    found: Vec<Found>,
    /// The top-level archives (relative to the corpus) that were there to look into.
    present: HashSet<String>,
    /// The bytes of the top-level archives that hold such files.
    sources: Vec<(String, Vec<u8>)>,
}

fn corpus_sounds() -> Option<&'static Sounds> {
    static SOUNDS: OnceLock<Option<Sounds>> = OnceLock::new();
    let sounds = SOUNDS.get_or_init(|| {
        let dir = corpus()?;
        let mut maps = Vec::new();
        archives(&dir, &mut maps);
        let mut s = Sounds { found: Vec::new(), present: HashSet::new(), sources: Vec::new() };
        for m in &maps {
            let rel = m.strip_prefix(&dir).unwrap_or(m).to_string_lossy().replace('\\', "/");
            let Ok(data) = std::fs::read(m) else { continue };
            let before = s.found.len();
            scan(&rel, &data, &mut s.found);
            if s.found.len() > before {
                s.sources.push((rel.clone(), data));
            }
            s.present.insert(rel);
        }
        Some(s)
    });
    if sounds.is_none() {
        common::skip_or_fail("the map corpus is missing (W3PROJ_CORPUS, or smoketest_maps next to the main checkout)");
    }
    sounds.as_ref()
}

#[test]
fn huffman_and_adpcm_sectors_of_real_maps_decode_to_sound() {
    let Some(Sounds { found, present, .. }) = corpus_sounds() else { return };
    let mut failures = Vec::new();
    let mut lines = Vec::new();
    for f in found {
        match check(f) {
            Ok(wav) => lines.push(baseline_line(f, &wav)),
            Err(e) => failures.push(format!("{} > {}: {e}", f.archive, f.name)),
        }
    }
    let got: HashSet<&str> = lines.iter().map(String::as_str).collect();
    let mut missing_archives = HashSet::new();
    for want in BASELINE.lines().filter(|l| !l.trim().is_empty() && !l.starts_with('#')) {
        let archive = want.split('\t').next().unwrap_or("").split(" > ").next().unwrap_or("");
        if !present.contains(archive) {
            missing_archives.insert(archive.to_string());
        } else if !got.contains(want) {
            failures.push(format!("baseline line not reproduced: {want}"));
        }
    }
    let wanted: HashSet<&str> = BASELINE.lines().collect();
    for l in &lines {
        if !wanted.contains(l.as_str()) {
            failures.push(format!("not in the baseline: {l}"));
        }
    }
    assert!(
        failures.is_empty(),
        "{} problem(s):\n{}\n\nwhat this corpus gives (for mpq_sound_sectors.tsv, after checking that a change is intended):\n{}",
        failures.len(),
        failures.join("\n"),
        lines.join("\n")
    );
    for a in &missing_archives {
        common::skip_or_fail(&format!("the baseline's map {a} is not in the corpus"));
    }
    let masks: HashSet<u8> = found.iter().flat_map(Found::masks).filter(|m| m & SOUND != 0).collect();
    println!("{} files with sound sectors checked; masks {masks:02x?}", found.len());
}

/// The checks above can fail: the same real sectors read with a wrong mask (ADPCM stereo instead of mono, or
/// without the Huffman layer) must be refused by the decoder or by the checks, never pass them.
#[test]
fn a_wrongly_decoded_real_sound_is_caught() {
    let Some(Sounds { found, sources, .. }) = corpus_sounds() else { return };
    // A top-level, unencrypted file: its mask bytes can be patched in the archive's bytes.
    let Some(f) = found.iter().find(|f| !f.archive.contains(" > ") && !f.encrypted && check(f).is_ok()) else {
        common::skip_or_fail("no unencrypted sound with Huffman/ADPCM sectors in a top-level map of the corpus");
        return;
    };
    let data = &sources.iter().find(|s| s.0 == f.archive).unwrap().1;
    let mut caught = 0;
    for (from, to) in [(0x41u8, 0x81u8), (0x41, 0x40), (0x40, 0x80), (0x80, 0x40), (0x81, 0x41), (0x01, 0x00)] {
        let mut patched = data.clone();
        let mut hit = false;
        for &(at, mask) in &f.sectors {
            if mask == from {
                patched[at] = to;
                hit = true;
            }
        }
        if !hit {
            continue;
        }
        let a = Archive::from_bytes(patched).unwrap();
        let wrong = Found { decoded: a.read(&f.name).map_err(|e| e.to_string()), ..f.clone() };
        let verdict = check(&wrong);
        assert!(verdict.is_err(), "{}: mask {from:#04x} read as {to:#04x} passed every check", f.name);
        println!("{from:#04x} as {to:#04x}: {}", verdict.unwrap_err());
        caught += 1;
    }
    assert!(caught >= 2, "only {caught} wrong masks could be tried on {}", f.name);

    // The size check refuses those before the sound checks see them; these are the errors a decoder that gets
    // the sizes right could still make, applied to the real decode of the same file.
    let wav = check(f).unwrap();
    let body_start = wav.windows(4).position(|w| w == b"data").unwrap() + 8;
    let adpcm: Vec<usize> = f.sectors.iter().enumerate().filter(|(_, s)| s.1 & ADPCM_MONO != 0).map(|(i, _)| i).collect();
    assert!(adpcm.len() >= 3, "{}: too few ADPCM sectors for the controls", f.name);
    let middle = adpcm[adpcm.len() / 2];
    let range = |i: usize| (i * f.sector_size).max(body_start)..((i + 1) * f.sector_size).min(wav.len());
    let samples = |w: &mut Vec<u8>, r: std::ops::Range<usize>, op: &dyn Fn(i16) -> i16| {
        for c in w[r].chunks_exact_mut(2) {
            c.copy_from_slice(&op(i16::from_le_bytes([c[0], c[1]])).to_le_bytes());
        }
    };
    type Wrong<'a> = Box<dyn Fn(&mut Vec<u8>) + 'a>;
    let wrongs: [(&str, Wrong); 4] = [
        ("one sector's samples offset (a wrong start sample)", Box::new(|w| samples(w, range(middle), &|s| s.saturating_add(12000)))),
        ("samples byte-swapped", Box::new(|w| adpcm.iter().for_each(|&i| samples(w, range(i), &i16::swap_bytes)))),
        ("a step size that runs away", Box::new(|w| samples(w, range(middle), &|s| s.saturating_mul(64)))),
        ("one byte short", Box::new(|w| { w.pop(); })),
    ];
    for (what, wrong) in wrongs {
        let mut w = wav.clone();
        wrong(&mut w);
        let verdict = check(&Found { decoded: Ok(w), ..f.clone() });
        assert!(verdict.is_err(), "{}: {what} passed every check", f.name);
        println!("{what}: {}", verdict.unwrap_err());
    }
}

