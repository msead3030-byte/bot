' =========================================================================
' Telegram Bot Silent Background Runner
' Runs the watchdog and bot in the background without any visible CMD window.
' =========================================================================
Set objShell = CreateObject("WScript.Shell")
Set objFSO = CreateObject("Scripting.FileSystemObject")

strScriptDir = objFSO.GetParentFolderName(WScript.ScriptFullName)
strBatchPath = objFSO.BuildPath(strScriptDir, "scripts\watchdog.bat")

objShell.CurrentDirectory = strScriptDir
objShell.Run "cmd.exe /c """ & strBatchPath & """", 0, False

Set objShell = Nothing
Set objFSO = Nothing
