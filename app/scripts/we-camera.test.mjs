// we-camera.mjs: looks, the terrain's centre, the camera objects we-drive adds for --look, and Studio's camera for
// the World Editor's view (the fit recorded in TESTING.md).

import test from "node:test";
import assert from "node:assert/strict";
import { studioLighting, WE_FIXED_HOUR } from "./we-camera.mjs";
import { addLookCameras, fartherPark, lookName, PARK_NAMES, parkingLooks, parseLook, resolveLook, studioCamera, terrainCentre, terrainHead, WE_OPENING } from "./we-camera.mjs";

test("parseLook: the target, then distance, angle of attack, field of view and rotation; the rest the opening camera's", () => {
  assert.deepEqual(parseLook("100,-200"), { center: false, x: 100, y: -200, ...WE_OPENING });
  assert.deepEqual(parseLook("1,2,2500,300,60,45"), { center: false, x: 1, y: 2, distance: 2500, aoa: 300, fov: 60, rotation: 45 });
  assert.deepEqual(parseLook("center"), { center: true, x: null, y: null, ...WE_OPENING });
  assert.equal(parseLook("centre,1800").distance, 1800);
  assert.equal(parseLook("1,2,,,,0").rotation, 0, "an empty value keeps the default");
  assert.equal(parseLook("1,2,,,,0").distance, 3000);
  for (const bad of ["1", "x,2", "1,2,3,4,5,6,7", "1,2,0", "1,2,-5", "middle"]) assert.throws(() => parseLook(bad), Error, bad);
});

test("the terrain's centre is offset + (corners - 1) * 64, from war3map.w3e.txt's head", () => {
  const head = terrainHead("W3E version 11\ntileset L\ncorners 5 3\noffset -128 -64\n\n[height]\n");
  assert.deepEqual(head, { width: 5, height: 3, offsetX: -128, offsetY: -64 });
  assert.deepEqual(terrainCentre(head), [128, 64]);
  assert.deepEqual(terrainCentre({ width: 97, height: 129, offsetX: -3328, offsetY: -4352 }), [-3328 + 96 * 64, -4352 + 128 * 64]);
  assert.throws(() => terrainHead("W3E version 11\n"), /corners and offset/);
  const look = resolveLook(parseLook("center,2000"), head);
  assert.equal(look.x, 128);
  assert.equal(look.y, 64);
  assert.equal(look.distance, 2000);
});

test("studioCamera: the opening view at the centre is TESTING.md's fitted camera", () => {
  // TESTING.md: x=CX, y=CY-298, distance=2738, pitch=57.2, yaw=-90, fov=41.06.
  assert.deepEqual(studioCamera(resolveLook(parseLook("center"), { width: 5, height: 3, offsetX: -128, offsetY: -64 })),
    { x: 128, y: 64 - 298, distance: 2738, pitch: 57.2, yaw: -90, fov: 41.06 });
  // Scaled with the distance: target y - 0.0993 d, distance 0.9127 d.
  const c = studioCamera(parseLook("1000,500,1500"));
  assert.deepEqual([c.x, c.y, c.distance], [1000, 500 - 149, 1369]);
});

test("studioCamera turns the fit with the rotation, and refuses an angle or field of view that wasn't fitted", () => {
  // Rotation 0 looks east: the target moves west, towards the eye, and the eye is west (yaw 180).
  const east = studioCamera(parseLook("0,0,3000,304,70,0"));
  assert.deepEqual([east.x, east.y, east.yaw], [-298, 0, -180]);
  const south = studioCamera(parseLook("0,0,3000,304,70,270"));
  assert.deepEqual([south.x, south.y, south.yaw], [0, 298, 90]);
  assert.throws(() => studioCamera(parseLook("0,0,3000,300")), /only angle of attack 304/);
  assert.throws(() => studioCamera(parseLook("0,0,3000,304,60")), /field of view 70/);
  assert.throws(() => studioCamera(parseLook("center")), /no target/);
});

test("addLookCameras puts the looks first, in the file's version, and keeps the map's cameras after them", () => {
  const theirs = { targetX: 5, targetY: 6, zOffset: 0, rotation: 90, angleOfAttack: 304, distance: 1650, roll: 0, fieldOfView: 70, farZ: 5000, nearZ: 100, name: "Intro" };
  const v0 = { format: "w3proj.cameras/1", version: 0, localAngles: false, cameras: [theirs] };
  const looks = [parseLook("1,2"), parseLook("3,4,2000")];
  const out = addLookCameras(v0, looks);
  assert.deepEqual(out.cameras.map((c) => c.name), [lookName(0), lookName(1), "Intro"]);
  assert.equal(v0.cameras.length, 1, "the given document isn't changed");
  assert.deepEqual(Object.keys(out.cameras[0]), ["targetX", "targetY", "zOffset", "rotation", "angleOfAttack", "distance", "roll", "fieldOfView", "farZ", "nearZ", "name"]);
  assert.equal(out.cameras[1].distance, 2000);
  const local = addLookCameras({ ...v0, localAngles: true }, looks).cameras[0];
  assert.equal(local.localPitch, 0);
  assert.equal(local.unknown, undefined);
  const v3 = addLookCameras(null, looks);
  assert.equal(v3.version, 3);
  assert.equal(v3.format, "w3proj.cameras/1");
  assert.deepEqual(v3.cameras[0].unknown, [0, 0, 0]);
  assert.equal(v3.cameras[0].trailer, 0);
  assert.throws(() => addLookCameras({ version: 0 }, looks), /no cameras list/);
  assert.ok(lookName(0) < lookName(1) && lookName(9) < lookName(10), "the names sort in row order");
  const parks = parkingLooks({ width: 5, height: 3, offsetX: -128, offsetY: -64 });
  const withParks = addLookCameras(v0, looks, parks);
  assert.deepEqual(withParks.cameras.map((c) => c.name), [lookName(0), lookName(1), ...PARK_NAMES, "Intro"]);
  assert.ok(lookName(15) < PARK_NAMES[0] && PARK_NAMES[0] < PARK_NAMES[1], "the parking cameras sort after the looks");
});

test("studioLighting pairs the editor's comparison states with Studio's lighting settings", () => {
  assert.deepEqual(studioLighting("game"), { "terrain.gameView": true, "terrain.lighting.enabled": true, "terrain.lighting.hour": WE_FIXED_HOUR });
  assert.deepEqual(studioLighting("lit"), { "terrain.gameView": false, "terrain.lighting.enabled": true, "terrain.lighting.hour": WE_FIXED_HOUR });
  assert.equal(WE_FIXED_HOUR, 6);
  assert.deepEqual(studioLighting("unlit"), { "terrain.gameView": false, "terrain.lighting.enabled": false });
  assert.throws(() => studioLighting("dusk"), /game, lit or unlit/);
});

test("parkingLooks: opposite corners of the terrain; fartherPark picks the one away from the look", () => {
  const parks = parkingLooks({ width: 65, height: 33, offsetX: -4096, offsetY: -2048 });
  assert.deepEqual(parks.map((p) => [p.x, p.y]), [[-4096, -2048], [4096, 2048]]);
  assert.equal(fartherPark({ x: -3000, y: -1000 }, parks), 1);
  assert.equal(fartherPark({ x: 3000, y: 1000 }, parks), 0);
});
