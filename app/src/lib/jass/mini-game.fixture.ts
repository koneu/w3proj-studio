// A tiny stand-in for the game's script API, written by hand for the tests: only what the generator
// and the checker's tests use. Real common.j and Blizzard.j can't go into the repository; the check
// against those runs locally (scripts/script-check).

import { emptyEnv, envFrom, type JassEnv } from "./check";

const COMMON = `
type agent extends handle
type event extends agent
type player extends agent
type widget extends agent
type unit extends widget
type destructable extends widget
type item extends widget
type trigger extends agent
type triggeraction extends handle
type triggercondition extends agent
type boolexpr extends agent
type conditionfunc extends boolexpr
type rect extends agent
type region extends agent
type sound extends agent
type timer extends agent
type group extends agent
type force extends agent
type dialog extends agent
type camerasetup extends handle
type weathereffect extends handle
type playercolor extends handle
type racepreference extends handle
type mapcontrol extends handle
type placement extends handle
type startlocprio extends handle
type camerafield extends handle
type unitstate extends handle
type playerstate extends handle
type alliancetype extends handle
type itemtype extends handle
type unitevent extends handle
type eventid extends handle
type playerunitevent extends eventid
type limitop extends eventid
type camerafieldalias extends handle

globals
    constant integer PLAYER_NEUTRAL_AGGRESSIVE = 24
    constant integer PLAYER_NEUTRAL_PASSIVE = 27
    constant racepreference RACE_PREF_HUMAN = null
    constant racepreference RACE_PREF_ORC = null
    constant racepreference RACE_PREF_UNDEAD = null
    constant racepreference RACE_PREF_NIGHTELF = null
    constant racepreference RACE_PREF_DEMON = null
    constant racepreference RACE_PREF_RANDOM = null
    constant racepreference RACE_PREF_USER_SELECTABLE = null
    constant mapcontrol MAP_CONTROL_USER = null
    constant mapcontrol MAP_CONTROL_COMPUTER = null
    constant mapcontrol MAP_CONTROL_NEUTRAL = null
    constant mapcontrol MAP_CONTROL_RESCUABLE = null
    constant placement MAP_PLACEMENT_USE_MAP_SETTINGS = null
    constant placement MAP_PLACEMENT_TEAMS_TOGETHER = null
    constant startlocprio MAP_LOC_PRIO_LOW = null
    constant startlocprio MAP_LOC_PRIO_HIGH = null
    constant alliancetype ALLIANCE_RESCUABLE = null
    constant playerstate PLAYER_STATE_ALLIED_VICTORY = null
    constant unitstate UNIT_STATE_LIFE = null
    constant unitstate UNIT_STATE_MANA = null
    constant unitevent EVENT_UNIT_DEATH = null
    constant unitevent EVENT_UNIT_CHANGE_OWNER = null
    constant itemtype ITEM_TYPE_ANY = null
    constant itemtype ITEM_TYPE_PERMANENT = null
    constant itemtype ITEM_TYPE_CHARGED = null
    constant itemtype ITEM_TYPE_POWERUP = null
    constant itemtype ITEM_TYPE_ARTIFACT = null
    constant itemtype ITEM_TYPE_PURCHASABLE = null
    constant itemtype ITEM_TYPE_CAMPAIGN = null
    constant itemtype ITEM_TYPE_MISCELLANEOUS = null
    constant camerafield CAMERA_FIELD_ZOFFSET = null
    constant camerafield CAMERA_FIELD_ROTATION = null
    constant camerafield CAMERA_FIELD_ANGLE_OF_ATTACK = null
    constant camerafield CAMERA_FIELD_TARGET_DISTANCE = null
    constant camerafield CAMERA_FIELD_ROLL = null
    constant camerafield CAMERA_FIELD_FIELD_OF_VIEW = null
    constant camerafield CAMERA_FIELD_FARZ = null
    constant camerafield CAMERA_FIELD_NEARZ = null
    constant camerafield CAMERA_FIELD_LOCAL_PITCH = null
    constant camerafield CAMERA_FIELD_LOCAL_YAW = null
    constant camerafield CAMERA_FIELD_LOCAL_ROLL = null
    constant camerafield CAMERA_FIELD_DEPTH_OF_FIELD_DISTANCE = null
    constant camerafield CAMERA_FIELD_DEPTH_OF_FIELD_SCALE = null
    constant camerafield CAMERA_FIELD_ZABSOLUTE = null
    constant camerafieldalias CAMERA_MARGIN_LEFT = null
    constant camerafieldalias CAMERA_MARGIN_RIGHT = null
    constant camerafieldalias CAMERA_MARGIN_TOP = null
    constant camerafieldalias CAMERA_MARGIN_BOTTOM = null
endglobals

native Player takes integer number returns player
native ConvertPlayerColor takes integer i returns playercolor
native I2S takes integer i returns string
native SetPlayerStartLocation takes player whichPlayer, integer startLocIndex returns nothing
native ForcePlayerStartLocation takes player whichPlayer, integer startLocIndex returns nothing
native SetPlayerColor takes player whichPlayer, playercolor color returns nothing
native SetPlayerRacePreference takes player whichPlayer, racepreference whichRacePreference returns nothing
native SetPlayerRaceSkin takes player whichPlayer, racepreference whichRacePreference returns nothing
native SetPlayerRaceSelectable takes player whichPlayer, boolean value returns nothing
native SetPlayerController takes player whichPlayer, mapcontrol controlType returns nothing
native SetPlayerAlliance takes player sourcePlayer, player otherPlayer, alliancetype whichAllianceSetting, boolean value returns nothing
native SetPlayerTeam takes player whichPlayer, integer whichTeam returns nothing
native SetPlayerState takes player whichPlayer, playerstate whichPlayerState, integer value returns nothing
native SetStartLocPrioCount takes integer whichStartLoc, integer prioSlotCount returns nothing
native SetStartLocPrio takes integer whichStartLoc, integer prioSlotIndex, integer otherStartLocIndex, startlocprio priority returns nothing
native SetEnemyStartLocPrioCount takes integer whichStartLoc, integer prioSlotCount returns nothing
native SetEnemyStartLocPrio takes integer whichStartLoc, integer prioSlotIndex, integer otherStartLocIndex, startlocprio priority returns nothing
native SetCameraBounds takes real x1, real y1, real x2, real y2, real x3, real y3, real x4, real y4 returns nothing
native GetCameraMargin takes camerafieldalias whichMargin returns real
native SetDayNightModels takes string terrainDNCFile, string unitDNCFile returns nothing
native SetTerrainFogEx takes integer style, real zstart, real zend, real density, real red, real green, real blue returns nothing
native SetTerrainFogExV takes integer style, real zstart, real zend, real density, real height, real falloff, real linearStart, real linearEnd, real red, real green, real blue returns nothing
native BlzSetTerrainFogMaxLinearDensity takes real density returns nothing
native BlzSetTerrainFogDrawOverSky takes boolean flag returns nothing
native SetWaterBaseColor takes integer red, integer green, integer blue, integer alpha returns nothing
native SetHDWaterParamsEx takes integer a, integer b, integer c, boolean d, real e, real f, real g, real h, real i, real j, real k, real l returns nothing
native Rect takes real minx, real miny, real maxx, real maxy returns rect
native AddWeatherEffect takes rect where, integer effectID returns weathereffect
native EnableWeatherEffect takes weathereffect whichEffect, boolean enable returns nothing
native NewSoundEnvironment takes string environmentName returns nothing
native SetAmbientDaySound takes string inLabel returns nothing
native SetAmbientNightSound takes string inLabel returns nothing
native SetMapMusic takes string musicName, boolean random, integer index returns nothing
native SetMapName takes string name returns nothing
native SetMapDescription takes string description returns nothing
native SetPlayers takes integer playercount returns nothing
native SetTeams takes integer teamcount returns nothing
native SetGamePlacement takes placement whichPlacementType returns nothing
native DefineStartLocation takes integer whichStartLoc, real x, real y returns nothing
native CreateTrigger takes nothing returns trigger
native DestroyTrigger takes trigger whichTrigger returns nothing
native GetTriggeringTrigger takes nothing returns trigger
native TriggerAddAction takes trigger whichTrigger, code actionFunc returns triggeraction
native TriggerAddCondition takes trigger whichTrigger, boolexpr condition returns triggercondition
native Condition takes code func returns conditionfunc
native DisableTrigger takes trigger whichTrigger returns nothing
native TriggerSleepAction takes real timeout returns nothing
native TriggerRegisterUnitEvent takes trigger whichTrigger, unit whichUnit, unitevent whichEvent returns event
native TriggerRegisterDeathEvent takes trigger whichTrigger, widget whichWidget returns event
native TriggerRegisterTimerEvent takes trigger whichTrigger, real timeout, boolean periodic returns event
native BlzCreateUnitWithSkin takes player id, integer unitid, real x, real y, real face, integer skinId returns unit
native CreateBlightedGoldmine takes player id, real x, real y, real face returns unit
native SetResourceAmount takes unit whichUnit, integer amount returns nothing
native SetUnitAcquireRange takes unit whichUnit, real newAcquireRange returns nothing
native SetHeroLevel takes unit whichHero, integer level, boolean showEyeCandy returns nothing
native GetUnitState takes unit whichUnit, unitstate whichUnitState returns real
native SetUnitState takes unit whichUnit, unitstate whichUnitState, real newVal returns nothing
native SelectHeroSkill takes unit whichHero, integer abilcode returns nothing
native IssueImmediateOrder takes unit whichUnit, string order returns boolean
native UnitAddItemToSlotById takes unit whichUnit, integer itemId, integer itemSlot returns boolean
native WaygateSetDestination takes unit waygate, real x, real y returns nothing
native WaygateActivate takes unit waygate, boolean activate returns nothing
native SetUnitColor takes unit whichUnit, playercolor whichColor returns nothing
native KillUnit takes unit whichUnit returns nothing
native GetTriggerUnit takes nothing returns unit
native IsUnitHidden takes unit whichUnit returns boolean
native GetChangingUnit takes nothing returns unit
native GetChangingUnitPrevOwner takes nothing returns player
native UnitDropItem takes unit inUnit, integer inItemID returns item
native WidgetDropItem takes widget inWidget, integer inItemID returns item
native BlzCreateItemWithSkin takes integer itemid, real x, real y, integer skinId returns item
native SetItemColor takes item whichItem, playercolor whichColor returns nothing
native BlzSetItemColor takes item whichItem, playercolor whichColor returns nothing
native ChooseRandomItem takes integer level returns integer
native ChooseRandomItemEx takes itemtype whichType, integer level returns integer
native GetDestructableLife takes destructable d returns real
native SetDestructableLife takes destructable d, real life returns nothing
native SetDestructableVertexColor takes destructable d, integer r, integer g, integer b, integer a returns nothing
native BlzCreateDestructableWithSkin takes integer objectid, real x, real y, real face, real scale, integer variation, integer skinId returns destructable
native BlzCreateDeadDestructableWithSkin takes integer objectid, real x, real y, real face, real scale, integer variation, integer skinId returns destructable
native BlzCreateDestructableZWithSkin takes integer objectid, real x, real y, real z, real face, real scale, integer variation, integer skinId returns destructable
native BlzCreateDeadDestructableZWithSkin takes integer objectid, real x, real y, real z, real face, real scale, integer variation, integer skinId returns destructable
native BlzCreateDestructableWithSkinPitchRoll takes integer objectid, real x, real y, real face, real pitch, real roll, real scale, integer variation, integer skinId returns destructable
native BlzCreateDestructableWithSkinPitchRollColor takes integer objectid, real x, real y, real face, real pitch, real roll, real scale, integer variation, integer skinId, playercolor c returns destructable
native BlzCreateDeadDestructableWithSkinPitchRoll takes integer objectid, real x, real y, real face, real pitch, real roll, real scale, integer variation, integer skinId returns destructable
native BlzCreateDeadDestructableWithSkinPitchRollColor takes integer objectid, real x, real y, real face, real pitch, real roll, real scale, integer variation, integer skinId, playercolor c returns destructable
native BlzCreateDestructableZWithSkinPitchRoll takes integer objectid, real x, real y, real z, real face, real pitch, real roll, real scale, integer variation, integer skinId returns destructable
native BlzCreateDestructableZWithSkinPitchRollColor takes integer objectid, real x, real y, real z, real face, real pitch, real roll, real scale, integer variation, integer skinId, playercolor c returns destructable
native BlzCreateDeadDestructableZWithSkinPitchRoll takes integer objectid, real x, real y, real z, real face, real pitch, real roll, real scale, integer variation, integer skinId returns destructable
native BlzCreateDeadDestructableZWithSkinPitchRollColor takes integer objectid, real x, real y, real z, real face, real pitch, real roll, real scale, integer variation, integer skinId, playercolor c returns destructable
native SetPlayerTechResearched takes player whichPlayer, integer techid, integer setToLevel returns nothing
native SetPlayerTechMaxAllowed takes player whichPlayer, integer techid, integer maximum returns nothing
native SetPlayerAbilityAvailable takes player whichPlayer, integer abilid, boolean avail returns nothing
native CreateSound takes string fileName, boolean looping, boolean is3D, boolean stopwhenoutofrange, integer fadeInRate, integer fadeOutRate, string eaxSetting returns sound
native SetSoundParamsFromLabel takes sound soundHandle, string soundLabel returns nothing
native SetSoundFacialAnimationLabel takes sound soundHandle, string animationLabel returns boolean
native SetSoundFacialAnimationGroupLabel takes sound soundHandle, string groupLabel returns boolean
native SetSoundFacialAnimationSetFilepath takes sound soundHandle, string animationSetFilepath returns boolean
native SetDialogueSpeakerNameKey takes sound soundHandle, string speakerName returns boolean
native SetDialogueTextKey takes sound soundHandle, string dialogueText returns boolean
native SetSoundDuration takes sound soundHandle, integer duration returns nothing
native SetSoundChannel takes sound soundHandle, integer channel returns nothing
native SetSoundVolume takes sound soundHandle, integer volume returns nothing
native SetSoundPitch takes sound soundHandle, real pitch returns nothing
native SetSoundDistances takes sound soundHandle, real minDist, real maxDist returns nothing
native SetSoundDistanceCutoff takes sound soundHandle, real cutoff returns nothing
native SetSoundConeAngles takes sound soundHandle, real inside, real outside, integer outsideVolume returns nothing
native SetSoundConeOrientation takes sound soundHandle, real x, real y, real z returns nothing
native SetSoundPosition takes sound soundHandle, real x, real y, real z returns nothing
native RegisterStackedSound takes sound soundHandle, boolean byPosition, real rectwidth, real rectheight returns nothing
native CreateCameraSetup takes nothing returns camerasetup
native CameraSetupSetField takes camerasetup whichSetup, camerafield whichField, real value, real duration returns nothing
native CameraSetupSetDestPosition takes camerasetup whichSetup, real x, real y, real duration returns nothing
native BlzCameraSetupSetCameraType takes camerasetup whichSetup, integer cameraType returns nothing
native CreateTimer takes nothing returns timer
native TimerStart takes timer whichTimer, real timeout, boolean periodic, code handlerFunc returns nothing
native CreateGroup takes nothing returns group
native CreateForce takes nothing returns force
native DialogCreate takes nothing returns dialog
native GetRectCenterX takes rect whichRect returns real
native GetRectCenterY takes rect whichRect returns real
`;

const BLIZZARD = `
globals
    constant real bj_PI = 3.14159
    constant real bj_WAIT_FOR_COND_MIN_INTERVAL = 0.1
    integer bj_forLoopAIndex = 0
    integer bj_forLoopBIndex = 0
    integer bj_forLoopAIndexEnd = 0
    integer bj_forLoopBIndexEnd = 0
    widget bj_lastDyingWidget = null
endglobals

function DoNothing takes nothing returns nothing
endfunction
function BJDebugMsg takes string msg returns nothing
endfunction
function RMaxBJ takes real a, real b returns real
    return a
endfunction
function InitBlizzard takes nothing returns nothing
endfunction
function InitGenericPlayerSlots takes nothing returns nothing
endfunction
function SetPlayerSlotAvailable takes player whichPlayer, mapcontrol control returns nothing
endfunction
function SetPlayerAllianceStateAllyBJ takes player a, player b, boolean flag returns nothing
endfunction
function SetPlayerAllianceStateVisionBJ takes player a, player b, boolean flag returns nothing
endfunction
function SetPlayerAllianceStateControlBJ takes player a, player b, boolean flag returns nothing
endfunction
function SetPlayerAllianceStateFullControlBJ takes player a, player b, boolean flag returns nothing
endfunction
function ConditionalTriggerExecute takes trigger t returns nothing
endfunction
function SaveDyingWidget takes nothing returns nothing
endfunction
function RandomDistReset takes nothing returns nothing
endfunction
function RandomDistAddItem takes integer inID, integer inChance returns nothing
endfunction
function RandomDistChoose takes nothing returns integer
    return 0
endfunction
function GetBooleanAnd takes boolean a, boolean b returns boolean
    return a and b
endfunction
function GetBooleanOr takes boolean a, boolean b returns boolean
    return a or b
endfunction
function CreateBlightedGoldmineBJ takes nothing returns nothing
endfunction
`;

/** The stand-in for common.j and Blizzard.j, as the app builds its own from the real ones. */
export function miniGameEnv(): JassEnv {
  return envFrom([BLIZZARD], envFrom([COMMON], emptyEnv()));
}
