import assert from "node:assert/strict";
import { test } from "node:test";
import { weatherName } from "./weather";

const strings = new Map([["WESTRING_WEATHER_RAIN", "Rain (&Heavy)"]]);

test("the game's name, without its hotkey mark", () => {
  assert.equal(weatherName("WESTRING_WEATHER_RAIN", "RAhr", strings), "Rain (Heavy)");
  assert.equal(weatherName("westring_weather_rain", "RAhr", strings), "Rain (Heavy)");
});

test("splashes the game has no name for take their rain's name", () => {
  assert.equal(weatherName("WESTRING_WEATHER_RAINSPLASH", "RAhs", strings), "Rain (Heavy) – splash");
});

test("never a raw key: the id instead", () => {
  assert.equal(weatherName("WESTRING_WEATHER_OTHER", "XXxx", strings), "XXxx");
  assert.equal(weatherName(undefined, "XXxx", strings), "XXxx");
  assert.equal(weatherName("Plain name", "XXxx", strings), "Plain name");
});
