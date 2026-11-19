globals
    integer udg_fooCount = 3
    string array udg_fooList
endglobals

// A made-up script for the web demo.
function ShowGreeting takes nothing returns nothing
    call BJDebugMsg("Hello from the demo project")
endfunction

function main takes nothing returns nothing
    call ShowGreeting()
endfunction

function config takes nothing returns nothing
    call SetMapName("Sample Map")
endfunction
