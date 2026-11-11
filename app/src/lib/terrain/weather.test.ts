import assert from "node:assert/strict";
import { test } from "node:test";
import { weatherName } from "./weather";

const strings = new Map([["WESTRING_WEATHER_RAIN", "Rain (&Heavy)"]]);

test("the game's name, without its hotkey mark", () => {
  assert.equal(weatherName("WESTRING_WEATHER_RAIN", "RAhr", strings), "Rain (Heavy)");
  assert.equal(weatherName("westring_weather_rain", "RAhr", strings), "Rain (Heavy)");
});

test("the game's own splash names, as the World Editor shows them", () => {
  const game = new Map([
    ["WESTRING_WEATHER_LORDAERONHEAVYRAIN", "Lordaeron Rain (Heavy)"],
    ["WESTRING_WEATHER_LORDAERONHEAVYRAINSPLASH", "Lordaeron Rain (Heavy, Splash)"],
  ]);
  assert.equal(weatherName("WESTRING_WEATHER_LORDAERONHEAVYRAINSPLASH", "RLhs", game), "Lordaeron Rain (Heavy, Splash)");
});

test("splashes the strings have no name for take their rain's name, the way the game names its splashes", () => {
  assert.equal(weatherName("WESTRING_WEATHER_RAINSPLASH", "RAhs", strings), "Rain (Heavy, Splash)");
  const plain = new Map([["WESTRING_WEATHER_DRIZZLE", "Drizzle"]]);
  assert.equal(weatherName("WESTRING_WEATHER_DRIZZLESPLASH", "DRsp", plain), "Drizzle (Splash)");
});

test("a name that names another string is followed (WESTRING_A=WESTRING_B)", () => {
  const chained = new Map([...strings, ["WESTRING_WEATHER_SNOW", "WESTRING_WEATHER_SNOWHEAVY"], ["WESTRING_WEATHER_SNOWHEAVY", "&Snow (Heavy)"]]);
  assert.equal(weatherName("WESTRING_WEATHER_SNOW", "SNhs", chained), "Snow (Heavy)");
  assert.equal(weatherName("WESTRING_WEATHER_SNOWSPLASH", "SNsp", chained), "Snow (Heavy, Splash)");
});

test("never a raw key: the id instead", () => {
  assert.equal(weatherName("WESTRING_WEATHER_OTHER", "XXxx", strings), "XXxx");
  assert.equal(weatherName(undefined, "XXxx", strings), "XXxx");
  assert.equal(weatherName("Plain name", "XXxx", strings), "Plain name");
});
