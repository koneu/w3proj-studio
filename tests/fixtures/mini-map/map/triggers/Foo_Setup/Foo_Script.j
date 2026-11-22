// @w3proj {"type":8,"name":"Foo Script","description":"A custom text (made up).","enabled":true,"initiallyOff":false,"runOnInit":false}
function Trig_Foo_Script_Actions takes nothing returns nothing
    set udg_fooCount = FooHelper()
endfunction

function InitTrig_Foo_Script takes nothing returns nothing
    set gg_trg_Foo_Script = CreateTrigger()
    call TriggerAddAction(gg_trg_Foo_Script, function Trig_Foo_Script_Actions)
endfunction
