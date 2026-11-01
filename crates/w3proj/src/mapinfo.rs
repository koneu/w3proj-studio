//! Map info (`war3map.w3i`) ⇄ JSON, format versions 25 (TFT) to 39 (3.0).
//!
//! ```text
//! u32 version
//! u32 saves, u32 editor version, [v27+] u32 game version ×4
//! cstring name, author, description, suggested players
//! f32 camera bounds ×8, u32 camera complements ×4, u32 playable width, height
//! u32 flags, u8 tileset
//! i32 loading screen, [v39] u32 crest race, cstring model, text, title, subtitle
//! u32 game data set, cstring prologue path, text, title, subtitle
//! u32 fog style, f32 start, end, density, u8[4] colour
//! [v39] i32 terrain fog style, i32 over sky, f32 linear start, end, max opacity, height
//! id weather, cstring sound environment, u8 light environment, u8[4] water tint
//! [v28] u32 script type   [v31] u32 supported modes, u32 game data version
//! [v32] i32 zoom default, max   [v33] i32 zoom min   [v39] i32 water settings ×10
//! players: u32 n, {u32 id, controller, race, [v39, editor 6128+] hud skin,
//!                  u32 fixed start, cstring name, f32 x, y, u32 ally low, high,
//!                  [v31] u32 enemy low, high}
//! forces: u32 n, {u32 flags, u32 players, cstring name}
//! upgrade availability: u32 n, {u32 players, id, u32 level, u32 availability}
//! tech availability: u32 n, {u32 players, id}
//! random unit tables: u32 n, {u32 number, cstring name, u32 positions, i32 types[positions],
//!                             u32 lines, {u32 chance, id[positions]}}
//! random item tables: u32 n, {u32 number, cstring name, u32 sets, {u32 items, {u32 chance, id}}}
//! ```
//! Versions 32–39 follow War3Net/wc3libs; the round-trip check in the codec
//! registry keeps any file this does not reproduce byte-exactly as raw.

use serde::{Deserialize, Serialize};

use crate::objdata::Id;
use crate::{Error, Result};

pub const FORMAT: &str = "w3proj.mapinfo/1";

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MapInfo {
    pub format: String,
    pub version: u32,
    pub saves: u32,
    pub editor_version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub game_version: Option<[u32; 4]>,
    pub name: String,
    pub author: String,
    pub description: String,
    pub suggested_players: String,
    pub camera_bounds: [f32; 8],
    pub camera_complements: [u32; 4],
    pub playable_width: u32,
    pub playable_height: u32,
    pub flags: u32,
    /// Tileset letter, e.g. "L" (Lordaeron Summer).
    pub tileset: String,
    pub loading_screen: LoadingScreen,
    pub game_data_set: u32,
    pub prologue: Prologue,
    pub fog: Fog,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terrain_fog: Option<TerrainFog>,
    pub weather: Id,
    pub sound_environment: String,
    pub light_environment: String,
    pub water_tint: [u8; 4],
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub script_type: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supported_modes: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub game_data_version: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub camera_zoom: Option<CameraZoom>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub water: Option<Water>,
    /// v39: whether player records carry a HUD skin (editor builds 6128+).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub player_hud_skins: Option<bool>,
    pub players: Vec<Player>,
    pub forces: Vec<Force>,
    pub upgrades: Vec<UpgradeAvailability>,
    pub techs: Vec<TechAvailability>,
    pub unit_tables: Vec<UnitTable>,
    pub item_tables: Vec<ItemTable>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LoadingScreen {
    /// -1 = none / custom model.
    pub number: i32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub crest_race: Option<u32>,
    pub model: String,
    pub text: String,
    pub title: String,
    pub subtitle: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Prologue {
    pub path: String,
    pub text: String,
    pub title: String,
    pub subtitle: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Fog {
    pub style: u32,
    pub start: f32,
    pub end: f32,
    pub density: f32,
    pub color: [u8; 4],
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TerrainFog {
    pub style: i32,
    pub over_sky: i32,
    pub linear_start: f32,
    pub linear_end: f32,
    pub max_opacity: f32,
    pub height: f32,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct CameraZoom {
    pub default: i32,
    pub max: i32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min: Option<i32>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Water {
    pub min_opacity: i32,
    pub max_opacity: i32,
    pub reflectivity: i32,
    pub emissivity: i32,
    pub edge_softness: i32,
    pub waves_vertex_displacement: i32,
    pub waves_normal_map_strength: i32,
    pub override_color: i32,
    pub environment_map_reflectivity: i32,
    pub unknown: i32,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Player {
    pub id: u32,
    /// 1 human, 2 computer, 3 neutral, 4 rescuable.
    pub controller: u32,
    /// 0 selectable, 1 human, 2 orc, 3 undead, 4 night elf.
    pub race: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hud_skin: Option<u32>,
    pub fixed_start: u32,
    pub name: String,
    pub start: [f32; 2],
    pub ally_low: u32,
    pub ally_high: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enemy_low: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enemy_high: Option<u32>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Force {
    pub flags: u32,
    /// Bit mask of member players.
    pub players: u32,
    pub name: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct UpgradeAvailability {
    pub players: u32,
    pub id: Id,
    pub level: u32,
    pub availability: u32,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct TechAvailability {
    pub players: u32,
    pub id: Id,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct UnitTable {
    pub number: u32,
    pub name: String,
    pub positions: Vec<i32>,
    pub lines: Vec<UnitTableLine>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct UnitTableLine {
    pub chance: u32,
    pub ids: Vec<Id>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct ItemTable {
    pub number: u32,
    pub name: String,
    pub sets: Vec<Vec<ItemChance>>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct ItemChance {
    pub chance: u32,
    pub id: Id,
}

struct Reader<'a> {
    d: &'a [u8],
    p: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8]> {
        let s = self
            .d
            .get(self.p..self.p + n)
            .ok_or_else(|| Error::Format("unexpected end of map info".into()))?;
        self.p += n;
        Ok(s)
    }
    fn u8(&mut self) -> Result<u8> {
        Ok(self.take(1)?[0])
    }
    fn u32(&mut self) -> Result<u32> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }
    fn i32(&mut self) -> Result<i32> {
        Ok(self.u32()? as i32)
    }
    fn f32(&mut self) -> Result<f32> {
        let f = f32::from_bits(self.u32()?);
        if !f.is_finite() {
            return Err(Error::Format("non-finite float in map info".into()));
        }
        Ok(f)
    }
    fn rgba(&mut self) -> Result<[u8; 4]> {
        Ok(self.take(4)?.try_into().unwrap())
    }
    fn id(&mut self) -> Result<Id> {
        Ok(Id(self.take(4)?.try_into().unwrap()))
    }
    fn count(&mut self) -> Result<usize> {
        let n = self.u32()? as usize;
        // A misparse would otherwise allocate gigabytes.
        if n > 100_000 {
            return Err(Error::Format(format!("implausible count {n} in map info")));
        }
        Ok(n)
    }
    fn cstr(&mut self) -> Result<String> {
        let rest = &self.d[self.p..];
        let n = rest
            .iter()
            .position(|&b| b == 0)
            .ok_or_else(|| Error::Format("unterminated string in map info".into()))?;
        let s = std::str::from_utf8(&rest[..n])
            .map_err(|_| Error::Format("map info string is not UTF-8".into()))?
            .to_string();
        self.p += n + 1;
        Ok(s)
    }
    fn char(&mut self) -> Result<String> {
        let b = self.u8()?;
        if b == 0 {
            return Ok(String::new());
        }
        if !b.is_ascii_graphic() {
            return Err(Error::Format(format!("unexpected character byte {b}")));
        }
        Ok((b as char).to_string())
    }
}

/// Editor builds from 6128 on write a HUD skin per player in v39 files.
fn hud_skins_expected(editor_version: u32) -> bool {
    editor_version >= 6128
}

pub fn decode(bytes: &[u8]) -> Result<MapInfo> {
    let version = u32::from_le_bytes(
        bytes
            .get(..4)
            .ok_or_else(|| Error::Format("map info too short".into()))?
            .try_into()
            .unwrap(),
    );
    if !(25..=39).contains(&version) {
        return Err(Error::Format(format!("unsupported map info version {version}")));
    }
    if version < 39 {
        return decode_with(bytes, false);
    }
    // v39 HUD skins: the editor version says which variant is expected; the
    // other one is tried if the bytes don't fit it exactly.
    let editor = bytes.get(8..12).map(|b| u32::from_le_bytes(b.try_into().unwrap())).unwrap_or(0);
    let first = hud_skins_expected(editor);
    decode_with(bytes, first).or_else(|_| decode_with(bytes, !first))
}

fn decode_with(bytes: &[u8], hud_skins: bool) -> Result<MapInfo> {
    let mut r = Reader { d: bytes, p: 0 };
    let version = r.u32()?;
    let v = version;
    let saves = r.u32()?;
    let editor_version = r.u32()?;
    let game_version = if v >= 27 { Some([r.u32()?, r.u32()?, r.u32()?, r.u32()?]) } else { None };
    let name = r.cstr()?;
    let author = r.cstr()?;
    let description = r.cstr()?;
    let suggested_players = r.cstr()?;
    let mut camera_bounds = [0f32; 8];
    for b in camera_bounds.iter_mut() {
        *b = r.f32()?;
    }
    let camera_complements = [r.u32()?, r.u32()?, r.u32()?, r.u32()?];
    let playable_width = r.u32()?;
    let playable_height = r.u32()?;
    let flags = r.u32()?;
    let tileset = r.char()?;
    let loading_screen = LoadingScreen {
        number: r.i32()?,
        crest_race: if v >= 39 { Some(r.u32()?) } else { None },
        model: r.cstr()?,
        text: r.cstr()?,
        title: r.cstr()?,
        subtitle: r.cstr()?,
    };
    let game_data_set = r.u32()?;
    let prologue = Prologue { path: r.cstr()?, text: r.cstr()?, title: r.cstr()?, subtitle: r.cstr()? };
    let fog = Fog { style: r.u32()?, start: r.f32()?, end: r.f32()?, density: r.f32()?, color: r.rgba()? };
    let terrain_fog = if v >= 39 {
        Some(TerrainFog {
            style: r.i32()?,
            over_sky: r.i32()?,
            linear_start: r.f32()?,
            linear_end: r.f32()?,
            max_opacity: r.f32()?,
            height: r.f32()?,
        })
    } else {
        None
    };
    let weather = r.id()?;
    let sound_environment = r.cstr()?;
    let light_environment = r.char()?;
    let water_tint = r.rgba()?;
    let script_type = if v >= 28 { Some(r.u32()?) } else { None };
    let (supported_modes, game_data_version) = if v >= 31 { (Some(r.u32()?), Some(r.u32()?)) } else { (None, None) };
    let camera_zoom = if v >= 32 {
        Some(CameraZoom { default: r.i32()?, max: r.i32()?, min: if v >= 33 { Some(r.i32()?) } else { None } })
    } else {
        None
    };
    let water = if v >= 39 {
        Some(Water {
            min_opacity: r.i32()?,
            max_opacity: r.i32()?,
            reflectivity: r.i32()?,
            emissivity: r.i32()?,
            edge_softness: r.i32()?,
            waves_vertex_displacement: r.i32()?,
            waves_normal_map_strength: r.i32()?,
            override_color: r.i32()?,
            environment_map_reflectivity: r.i32()?,
            unknown: r.i32()?,
        })
    } else {
        None
    };

    let mut players = Vec::new();
    for _ in 0..r.count()? {
        players.push(Player {
            id: r.u32()?,
            controller: r.u32()?,
            race: r.u32()?,
            hud_skin: if v >= 39 && hud_skins { Some(r.u32()?) } else { None },
            fixed_start: r.u32()?,
            name: r.cstr()?,
            start: [r.f32()?, r.f32()?],
            ally_low: r.u32()?,
            ally_high: r.u32()?,
            enemy_low: if v >= 31 { Some(r.u32()?) } else { None },
            enemy_high: if v >= 31 { Some(r.u32()?) } else { None },
        });
    }
    let mut forces = Vec::new();
    for _ in 0..r.count()? {
        forces.push(Force { flags: r.u32()?, players: r.u32()?, name: r.cstr()? });
    }
    let mut upgrades = Vec::new();
    for _ in 0..r.count()? {
        upgrades.push(UpgradeAvailability { players: r.u32()?, id: r.id()?, level: r.u32()?, availability: r.u32()? });
    }
    let mut techs = Vec::new();
    for _ in 0..r.count()? {
        techs.push(TechAvailability { players: r.u32()?, id: r.id()? });
    }
    let mut unit_tables = Vec::new();
    for _ in 0..r.count()? {
        let number = r.u32()?;
        let name = r.cstr()?;
        let n = r.count()?;
        let positions = (0..n).map(|_| r.i32()).collect::<Result<Vec<_>>>()?;
        let mut lines = Vec::new();
        for _ in 0..r.count()? {
            let chance = r.u32()?;
            let ids = (0..n).map(|_| r.id()).collect::<Result<Vec<_>>>()?;
            lines.push(UnitTableLine { chance, ids });
        }
        unit_tables.push(UnitTable { number, name, positions, lines });
    }
    let mut item_tables = Vec::new();
    for _ in 0..r.count()? {
        let number = r.u32()?;
        let name = r.cstr()?;
        let mut sets = Vec::new();
        for _ in 0..r.count()? {
            let mut set = Vec::new();
            for _ in 0..r.count()? {
                set.push(ItemChance { chance: r.u32()?, id: r.id()? });
            }
            sets.push(set);
        }
        item_tables.push(ItemTable { number, name, sets });
    }
    if r.p != bytes.len() {
        return Err(Error::Format(format!("{} trailing bytes after map info", bytes.len() - r.p)));
    }
    Ok(MapInfo {
        format: FORMAT.into(),
        version,
        saves,
        editor_version,
        game_version,
        name,
        author,
        description,
        suggested_players,
        camera_bounds,
        camera_complements,
        playable_width,
        playable_height,
        flags,
        tileset,
        loading_screen,
        game_data_set,
        prologue,
        fog,
        terrain_fog,
        weather,
        sound_environment,
        light_environment,
        water_tint,
        script_type,
        supported_modes,
        game_data_version,
        camera_zoom,
        water,
        player_hud_skins: (v >= 39).then_some(hud_skins),
        players,
        forces,
        upgrades,
        techs,
        unit_tables,
        item_tables,
    })
}

struct Writer(Vec<u8>);

impl Writer {
    fn u32(&mut self, v: u32) {
        self.0.extend(v.to_le_bytes());
    }
    fn i32(&mut self, v: i32) {
        self.0.extend(v.to_le_bytes());
    }
    fn f32(&mut self, v: f32) {
        self.0.extend(v.to_bits().to_le_bytes());
    }
    fn bytes(&mut self, b: &[u8]) {
        self.0.extend_from_slice(b);
    }
    fn cstr(&mut self, s: &str) {
        self.0.extend(s.as_bytes());
        self.0.push(0);
    }
    fn char(&mut self, s: &str) -> Result<()> {
        match s.as_bytes() {
            [] => self.0.push(0),
            [b] => self.0.push(*b),
            _ => return Err(Error::Format(format!("expected a single character, got {s:?}"))),
        }
        Ok(())
    }
    fn len(&mut self, n: usize) {
        self.u32(n as u32);
    }
}

/// Fields required by the declared version must be present.
fn need<T: Copy>(v: Option<T>, what: &str, version: u32) -> Result<T> {
    v.ok_or_else(|| Error::Format(format!("map info version {version} requires {what}")))
}

pub fn encode(m: &MapInfo) -> Result<Vec<u8>> {
    let v = m.version;
    if !(25..=39).contains(&v) {
        return Err(Error::Format(format!("unsupported map info version {v}")));
    }
    let hud = v >= 39 && m.player_hud_skins.unwrap_or(true);
    let mut w = Writer(Vec::with_capacity(1024));
    w.u32(v);
    w.u32(m.saves);
    w.u32(m.editor_version);
    if v >= 27 {
        for x in need(m.game_version, "gameVersion", v)? {
            w.u32(x);
        }
    }
    for s in [&m.name, &m.author, &m.description, &m.suggested_players] {
        w.cstr(s);
    }
    for b in m.camera_bounds {
        w.f32(b);
    }
    for c in m.camera_complements {
        w.u32(c);
    }
    w.u32(m.playable_width);
    w.u32(m.playable_height);
    w.u32(m.flags);
    w.char(&m.tileset)?;
    let ls = &m.loading_screen;
    w.i32(ls.number);
    if v >= 39 {
        w.u32(need(ls.crest_race, "loadingScreen.crestRace", v)?);
    }
    for s in [&ls.model, &ls.text, &ls.title, &ls.subtitle] {
        w.cstr(s);
    }
    w.u32(m.game_data_set);
    let pr = &m.prologue;
    for s in [&pr.path, &pr.text, &pr.title, &pr.subtitle] {
        w.cstr(s);
    }
    w.u32(m.fog.style);
    w.f32(m.fog.start);
    w.f32(m.fog.end);
    w.f32(m.fog.density);
    w.bytes(&m.fog.color);
    if v >= 39 {
        let tf = m.terrain_fog.as_ref().ok_or_else(|| Error::Format("version 39 requires terrainFog".into()))?;
        w.i32(tf.style);
        w.i32(tf.over_sky);
        w.f32(tf.linear_start);
        w.f32(tf.linear_end);
        w.f32(tf.max_opacity);
        w.f32(tf.height);
    }
    w.bytes(&m.weather.0);
    w.cstr(&m.sound_environment);
    w.char(&m.light_environment)?;
    w.bytes(&m.water_tint);
    if v >= 28 {
        w.u32(need(m.script_type, "scriptType", v)?);
    }
    if v >= 31 {
        w.u32(need(m.supported_modes, "supportedModes", v)?);
        w.u32(need(m.game_data_version, "gameDataVersion", v)?);
    }
    if v >= 32 {
        let z = m.camera_zoom.as_ref().ok_or_else(|| Error::Format(format!("version {v} requires cameraZoom")))?;
        w.i32(z.default);
        w.i32(z.max);
        if v >= 33 {
            w.i32(need(z.min, "cameraZoom.min", v)?);
        }
    }
    if v >= 39 {
        let wa = m.water.as_ref().ok_or_else(|| Error::Format("version 39 requires water".into()))?;
        for x in [
            wa.min_opacity,
            wa.max_opacity,
            wa.reflectivity,
            wa.emissivity,
            wa.edge_softness,
            wa.waves_vertex_displacement,
            wa.waves_normal_map_strength,
            wa.override_color,
            wa.environment_map_reflectivity,
            wa.unknown,
        ] {
            w.i32(x);
        }
    }
    w.len(m.players.len());
    for p in &m.players {
        w.u32(p.id);
        w.u32(p.controller);
        w.u32(p.race);
        if hud {
            w.u32(p.hud_skin.unwrap_or(0));
        }
        w.u32(p.fixed_start);
        w.cstr(&p.name);
        w.f32(p.start[0]);
        w.f32(p.start[1]);
        w.u32(p.ally_low);
        w.u32(p.ally_high);
        if v >= 31 {
            w.u32(p.enemy_low.unwrap_or(0));
            w.u32(p.enemy_high.unwrap_or(0));
        }
    }
    w.len(m.forces.len());
    for f in &m.forces {
        w.u32(f.flags);
        w.u32(f.players);
        w.cstr(&f.name);
    }
    w.len(m.upgrades.len());
    for u in &m.upgrades {
        w.u32(u.players);
        w.bytes(&u.id.0);
        w.u32(u.level);
        w.u32(u.availability);
    }
    w.len(m.techs.len());
    for t in &m.techs {
        w.u32(t.players);
        w.bytes(&t.id.0);
    }
    w.len(m.unit_tables.len());
    for t in &m.unit_tables {
        w.u32(t.number);
        w.cstr(&t.name);
        w.len(t.positions.len());
        for p in &t.positions {
            w.i32(*p);
        }
        w.len(t.lines.len());
        for l in &t.lines {
            if l.ids.len() != t.positions.len() {
                return Err(Error::Format(format!("unit table {:?}: each line needs {} ids", t.name, t.positions.len())));
            }
            w.u32(l.chance);
            for id in &l.ids {
                w.bytes(&id.0);
            }
        }
    }
    w.len(m.item_tables.len());
    for t in &m.item_tables {
        w.u32(t.number);
        w.cstr(&t.name);
        w.len(t.sets.len());
        for set in &t.sets {
            w.len(set.len());
            for c in set {
                w.u32(c.chance);
                w.bytes(&c.id.0);
            }
        }
    }
    Ok(w.0)
}

pub fn to_json(bytes: &[u8]) -> Result<Vec<u8>> {
    let info = decode(bytes)?;
    let mut out = serde_json::to_vec_pretty(&info).map_err(|e| Error::Format(e.to_string()))?;
    out.push(b'\n');
    Ok(out)
}

pub fn from_json(json: &[u8]) -> Result<Vec<u8>> {
    let info: MapInfo = serde_json::from_slice(json).map_err(|e| Error::Format(format!("invalid map info JSON: {e}")))?;
    encode(&info)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(version: u32) -> MapInfo {
        let v39 = version >= 39;
        MapInfo {
            format: FORMAT.into(),
            version,
            saves: 7,
            editor_version: 7003,
            game_version: (version >= 27).then_some([3, 0, 1, 24371]),
            name: "TRIGSTR_001".into(),
            author: "me".into(),
            description: "desc".into(),
            suggested_players: "1v1".into(),
            camera_bounds: [-1.5, 2.0, 3.25, 4.0, 5.0, 6.0, 7.0, 8.0],
            camera_complements: [6, 6, 4, 8],
            playable_width: 116,
            playable_height: 84,
            flags: 0x8c14,
            tileset: "L".into(),
            loading_screen: LoadingScreen {
                number: -1,
                crest_race: v39.then_some(1),
                model: "".into(),
                text: "t".into(),
                title: "".into(),
                subtitle: "".into(),
            },
            game_data_set: 0,
            prologue: Prologue { path: "".into(), text: "".into(), title: "".into(), subtitle: "".into() },
            fog: Fog { style: 0, start: 3000.0, end: 5000.0, density: 0.5, color: [255, 255, 255, 255] },
            terrain_fog: v39.then(|| TerrainFog { style: 0, over_sky: 1, linear_start: 1000.0, linear_end: 8000.0, max_opacity: 1.0, height: 0.0 }),
            weather: Id(*b"RAhr"),
            sound_environment: "Default".into(),
            light_environment: "".into(),
            water_tint: [255, 255, 255, 255],
            script_type: (version >= 28).then_some(1),
            supported_modes: (version >= 31).then_some(3),
            game_data_version: (version >= 31).then_some(1),
            camera_zoom: (version >= 32).then(|| CameraZoom { default: 1650, max: 3000, min: (version >= 33).then_some(500) }),
            water: v39.then(|| Water {
                min_opacity: 0,
                max_opacity: 100,
                reflectivity: 10,
                emissivity: 0,
                edge_softness: 10,
                waves_vertex_displacement: 20,
                waves_normal_map_strength: 100,
                override_color: 0,
                environment_map_reflectivity: 100,
                unknown: -1,
            }),
            player_hud_skins: v39.then_some(true),
            players: vec![Player {
                id: 0,
                controller: 1,
                race: 1,
                hud_skin: v39.then_some(64),
                fixed_start: 1,
                name: "Player 1".into(),
                start: [-1024.0, 512.5],
                ally_low: 0,
                ally_high: 0,
                enemy_low: (version >= 31).then_some(0),
                enemy_high: (version >= 31).then_some(0),
            }],
            forces: vec![Force { flags: 0, players: 1, name: "Force 1".into() }],
            upgrades: vec![UpgradeAvailability { players: 1, id: Id(*b"Rhme"), level: 0, availability: 2 }],
            techs: vec![TechAvailability { players: 1, id: Id(*b"hfoo") }],
            unit_tables: vec![UnitTable {
                number: 0,
                name: "Group".into(),
                positions: vec![0, 1],
                lines: vec![UnitTableLine { chance: 100, ids: vec![Id(*b"hfoo"), Id(*b"hkni")] }],
            }],
            item_tables: vec![ItemTable { number: 0, name: "Items".into(), sets: vec![vec![ItemChance { chance: 100, id: Id(*b"ratc") }]] }],
        }
    }

    #[test]
    fn roundtrip_all_versions() {
        for v in [25, 28, 31, 32, 33, 39] {
            let info = sample(v);
            let bin = encode(&info).unwrap();
            assert_eq!(decode(&bin).unwrap(), info, "v{v}");
            let json = to_json(&bin).unwrap();
            assert_eq!(from_json(&json).unwrap(), bin, "v{v} via JSON");
        }
    }

    #[test]
    fn v39_without_hud_skins() {
        let mut info = sample(39);
        info.editor_version = 6127;
        info.player_hud_skins = Some(false);
        info.players[0].hud_skin = None;
        let bin = encode(&info).unwrap();
        assert_eq!(decode(&bin).unwrap(), info);
    }
}
