// Helper functions a Lua map's script has when its triggers were saved with "Better Triggers" (a third-party trigger
// editor: the game's TriggerData.txt has no frame functions with a BT suffix, 3.0.1): `array2DLua` and the frame
// wrappers ending in BT, after InitGlobals. Fires Over Eversong (smoketest_maps) is such a map: without them its script
// would lose 35 functions to a regeneration (trigger-folders stage 0). Written as that map's script has them, so a
// map that has them keeps them; nothing else gets them (the World Editor doesn't write them).

/** The frame events in the order of an attach string's digits (FrameAttachEvents), with the name each handler has. */
const EVENTS: [string, string][] = [
  ["Click", "CONTROL_CLICK"], ["MouseEnter", "MOUSE_ENTER"], ["MouseLeave", "MOUSE_LEAVE"], ["MouseUp", "MOUSE_UP"],
  ["MouseDown", "MOUSE_DOWN"], ["MouseWheel", "MOUSE_WHEEL"], ["MouseDoubleClick", "MOUSE_DOUBLECLICK"],
  ["CheckboxChecked", "CHECKBOX_CHECKED"], ["CheckboxUnChecked", "CHECKBOX_UNCHECKED"], ["EditboxTextChanged", "EDITBOX_TEXT_CHANGED"],
  ["EditboxEnter", "EDITBOX_ENTER"], ["PopupMenuItemChanged", "POPUPMENU_ITEM_CHANGED"], ["SpriteAnimUpdate", "SPRITE_ANIM_UPDATE"],
  ["SliderValueChanged", "SLIDER_VALUE_CHANGED"], ["DialogCancel", "DIALOG_CANCEL"], ["DialogAccept", "DIALOG_ACCEPT"],
];

/** Whether a Lua script has the Better Triggers helpers (so the one made in its place keeps them). */
export function hasBetterTriggersHelpers(script: string): boolean {
  return /^function (?:array2DLua|FrameAttachEvents)\b/m.test(script);
}

/** The helpers' Lua, line by line (no line ends). */
export function betterTriggersHelpers(): string[] {
  const fn = (head: string, ...body: string[]) => [`function ${head}`, ...body.map((b) => `    ${b}`), "end", ""];
  const lines = [
    "function array2DLua(size1, size2, initialValue)",
    "    local array2D = {}",
    "    for i = 0, size1 do",
    "        array2D[i] = {}",
    "",
    "        for j = 0, size2 do",
    "            array2D[i][j] = initialValue",
    "        end",
    "    end",
    "    return array2D",
    "end",
    "-----------------------------------------------------------------------------",
    "-- ",
    "--   Better Triggers Functions",
    "-- ",
    "-----------------------------------------------------------------------------",
    ...fn("TriggerRegisterGenericFrameEventBT(trig, frameEvent, opcode, varName)", "TriggerRegisterVariableEvent(trig, varName, opcode, frameEvent)"),
    ...fn("GetLastCreatedFrameBT()", "return bt_lastCreatedFrame"),
    ...["Frame", "FramePlayer", "FrameEvent", "FrameValue", "FrameText"].flatMap((k) => fn(`GetTrigger${k}BT()`, `return bt_trigger${k}`)),
    ...fn("BlzFrameSetPointBT(frame, x, y, point, relative, relativePoint)", "BlzFrameSetPoint(frame, point, relative, relativePoint, x, y)"),
    ...fn("BlzFrameSetAbsPointBT(frame, x, y, point)", "BlzFrameSetAbsPoint(frame, point, x, y)"),
    ...fn("BlzFrameSetEnableBT(enabled, frame)", "BlzFrameSetEnable(frame, enabled)"),
    ...fn("BlzFrameSetVisibleBT(show, frame)", "BlzFrameSetVisible(frame, show)"),
    ...EVENTS.flatMap(([name, event], n) => fn(`TriggerAddFrame${name}BT()`,
      "bt_triggerFrame = BlzGetTriggerFrame()", "bt_triggerFramePlayer = GetTriggerPlayer()", "bt_triggerFrameValue = BlzGetTriggerFrameValue()",
      "bt_triggerFrameText = BlzGetTriggerFrameText()", `bt_triggerFrameEvent = FRAMEEVENT_${event}`, `globals.bt_genericFrameEvent = ${n + 1}.0`,
      "globals.bt_genericFrameEvent = 0.0")),
    "function FrameAttachEvents(attachEvents)",
    "    local events = {}",
    "    local trig",
    "",
    "    if(StringLength(attachEvents) ~= 16) then",
    "        BJDebugMsg(\"Frame Error: 'BlzCreateFrameBT' received invalid event string.\")",
    "        return",
    "    end",
    "",
    "    if(bt_lastCreatedFrame == nil) then",
    "        BJDebugMsg(\"Frame Error: 'Last Created Frame' was null.\")",
    "        return",
    "    end",
    "",
    "    for i=0,15 do",
    "        events[i] = S2I(SubString(attachEvents, i, i + 1))",
    "    end",
    "",
    ...EVENTS.flatMap(([name, event], n) => [
      `    if(events[${n}] > 0) then`,
      "        trig = CreateTrigger()",
      `        BlzTriggerRegisterFrameEvent(trig, bt_lastCreatedFrame, FRAMEEVENT_${event})`,
      `        TriggerAddAction(trig, TriggerAddFrame${name}BT)`,
      "    end",
    ]),
    "end",
    "",
    ...fn("BlzCreateFrameBT(name, owner, priority, createContext, attachEvents)", "bt_lastCreatedFrame = BlzCreateFrame(name, owner, priority, createContext)", "FrameAttachEvents(attachEvents)"),
    ...fn("BlzCreateSimpleFrameBT(name, owner, createContext, attachEvents)", "bt_lastCreatedFrame = BlzCreateSimpleFrame(name, owner, createContext)", "FrameAttachEvents(attachEvents)"),
    ...fn("BlzCreateFrameByTypeBT(typeName, name, owner, inherits, createContext, attachEvents)", "bt_lastCreatedFrame = BlzCreateFrameByType(typeName, name, owner, inherits, createContext)", "FrameAttachEvents(attachEvents)"),
    ...fn("BlzQueueImmediateOrderByIdBT (whichUnit, order)", "BlzQueueImmediateOrderById(whichUnit, OrderId(order))"),
    ...fn("BlzQueuePointOrderByIdBT (whichUnit, order, loc)", "BlzQueuePointOrderById(whichUnit, OrderId(order), GetLocationX(loc), GetLocationY(loc))"),
    ...fn("BlzQueueTargetOrderByIdBT (whichUnit, order, targetWidget)", "BlzQueueTargetOrderById(whichUnit, OrderId(order), targetWidget)"),
  ];
  return lines;
}
