import assert from "node:assert/strict";
import { test } from "node:test";
import { describeCamera, emptyCameras, removeCamera, setCamera } from "./tools";

test("set_camera makes a camera at a target, with the editor's defaults and the Reforged layout", () => {
  const doc = emptyCameras();
  const r = setCamera(doc, { name: " Intro ", target: [512, -256], distance: 2000 }, null);
  assert.equal(r.created, true);
  assert.deepEqual(describeCamera(doc.cameras[0]), { name: "Intro", target: [512, -256], zOffset: 0, rotation: 90, angleOfAttack: 304, distance: 2000, roll: 0, fieldOfView: 70, farZ: 50000, nearZ: 16 });
  assert.deepEqual([doc.cameras[0].localPitch, doc.cameras[0].trailer, doc.cameras[0].dofDistance, doc.cameras[0].posAbsoluteZ], [0, 0, 0, 0]);
  // A classic file takes the Reforged layout once it has cameras, as the Cameras tab's save does.
  const classic = { version: 0, cameras: [] };
  setCamera(classic, { name: "A", target: [0, 0] }, null);
  assert.equal(classic.version, 3);
  assert.throws(() => setCamera(doc, { name: "Other", distance: 5 }, null), /no camera "Other": to make it, give target. Cameras: Intro/);
  assert.throws(() => setCamera(doc, { target: [0, 0] }, null), /needs a name/);
});

test("set_camera changes the camera of that name (whatever its case), and says when nothing changed", () => {
  const doc = emptyCameras();
  setCamera(doc, { name: "Intro", target: [0, 0] }, null);
  const r = setCamera(doc, { name: "intro", rotation: 180, fieldOfView: 90 }, null);
  assert.deepEqual([r.created, r.changed, doc.cameras.length, doc.cameras[0].rotation, doc.cameras[0].fieldOfView, doc.cameras[0].name], [false, true, 1, 180, 90, "Intro"]);
  assert.equal(setCamera(doc, { name: "Intro", rotation: 180 }, null).changed, false);
});

test("a value the Cameras tab refuses is refused, and nothing changes", () => {
  const doc = emptyCameras();
  setCamera(doc, { name: "A", target: [0, 0] }, null);
  const before = JSON.stringify(doc);
  assert.throws(() => setCamera(doc, { name: "A", fieldOfView: 150 }, null), /Not changed: Field of view must be from 5 to 120/);
  assert.throws(() => setCamera(doc, { name: "A", distance: 300, nearZ: 60000 }, null), /Near clipping must be from 0 to 9500/);
  assert.throws(() => setCamera(doc, { name: "A", farZ: 200, nearZ: 300 }, null), /clipping/);
  assert.throws(() => setCamera(doc, { name: "A", rotation: "90" }, null), /rotation must be a number/);
  assert.throws(() => setCamera(doc, { name: "B", target: [0, 0], distance: 0 }, null), /Not made: Distance to the target must be from 0.5 to 100000/);
  assert.throws(() => setCamera(doc, { name: "A", target: [0] }, null), /target must be \[x, y\]/);
  assert.equal(JSON.stringify(doc), before);
  // Far and near given together are checked as they end up, whichever order they come in.
  setCamera(doc, { name: "A", nearZ: 300, farZ: 400 }, null);
  assert.deepEqual([doc.cameras[0].nearZ, doc.cameras[0].farZ], [300, 400]);
  setCamera(doc, { name: "A", farZ: 150, nearZ: 100 }, null);
  assert.deepEqual([doc.cameras[0].nearZ, doc.cameras[0].farZ], [100, 150]);
});

test("a target past the camera bounds lands on the bound while they are enforced, and the answer says so", () => {
  const doc = emptyCameras();
  // Camera bounds as war3map.w3i has them: four corners, x and y each.
  const bounds = [-1000, -1000, 1000, 1000, -1000, 1000, 1000, -1000];
  const r = setCamera(doc, { name: "A", target: [5000, 0] }, bounds);
  assert.deepEqual([r.moved, doc.cameras[0].targetX], [[1000, 0], 1000]);
  assert.equal(setCamera(doc, { name: "B", target: [5000, 0] }, null).moved, undefined);
});

test("a free camera keeps its place here; remove_camera takes a camera away by name", () => {
  const doc = emptyCameras();
  setCamera(doc, { name: "Free", target: [0, 0] }, null);
  doc.cameras[0].trailer = 1;
  assert.throws(() => setCamera(doc, { name: "Free", rotation: 10 }, null), /free camera/);
  assert.equal(setCamera(doc, { name: "Free", fieldOfView: 60 }, null).changed, true);
  assert.equal(describeCamera(doc.cameras[0]).free, true);
  assert.throws(() => removeCamera(doc, "Nope"), /no camera "Nope". Cameras: Free/);
  assert.equal(removeCamera(doc, "free").name, "Free");
  assert.equal(doc.cameras.length, 0);
});
