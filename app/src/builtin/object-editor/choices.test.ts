import assert from "node:assert/strict";
import { test } from "node:test";
import type { FieldMeta, KindData } from "../../lib/objects/metadata";
import { musicChoices, orderChoices, splatChoices } from "./choices";

test("ground textures: the table's codes with what they are, by name", () => {
  const rows: Record<string, string>[] = [{ Name: "INIT", comment: "INIT" }, { Name: "OMED", comment: "OrcMedium" }, { Name: "HSMA", comment: "HumanSmall" }, { Name: "EMDA" }, { Name: "", comment: "x" }];
  assert.deepEqual(splatChoices(rows), [{ value: "EMDA", label: "EMDA" }, { value: "HSMA", label: "HumanSmall (HSMA)" }, { value: "OMED", label: "OrcMedium (OMED)" }]);
});

test("order strings: what the game's abilities use, each with its users", () => {
  const order = { id: "aord", type: "orderString", repeat: 0 } as FieldMeta, off = { id: "aorf", type: "orderString", repeat: 0 } as FieldMeta;
  const name = { id: "anam", type: "string", repeat: 0 } as FieldMeta;
  const data: Record<string, Record<string, string>> = {
    AHtc: { aord: "thunderclap", anam: "x" }, AHdr: { aord: "drain", aorf: "" }, ANdr: { aord: "drain" }, ACdr: { aord: "drain" }, Adef: { aord: "defend", aorf: "undefend" }, Apas: { aord: "_" },
  };
  const kd = {
    baseIds: Object.keys(data), names: new Map([["AHtc", "Thunder Clap"], ["AHdr", "Siphon Mana"], ["ANdr", "Drain Life"], ["Adef", "Defend"]]),
    fieldsFor: () => [order, off, name], levels: () => 1, defaultValue: (id: string, f: FieldMeta) => data[id][f.id],
  } as unknown as KindData;
  assert.deepEqual(orderChoices(kd), [
    { value: "defend", label: "defend · Defend" },
    { value: "drain", label: "drain · Siphon Mana and 2 more" },
    { value: "thunderclap", label: "thunderclap · Thunder Clap" },
    { value: "undefend", label: "undefend · Defend" },
  ]);
});

test("music: the labels of the game's music table, with their files", () => {
  const rows: Record<string, string>[] = [{ SoundName: "_" }, { SoundName: "OrcDefeat", FileNames: "Sound/Music/mp3Music/OrcDefeat.flac" }, { SoundName: "Chat", FileNames: "a/Human3.flac,a/Orc1.flac" }, { SoundName: "Empty", FileNames: "_" }];
  assert.deepEqual(musicChoices(rows), [{ value: "Chat", label: "Chat · 2 files" }, { value: "OrcDefeat", label: "OrcDefeat · OrcDefeat.flac" }]);
});
