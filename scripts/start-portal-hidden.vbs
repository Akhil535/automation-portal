' Starts the DoH Circular Portal without a console window (used by the Windows start-up task).
Set fso = CreateObject("Scripting.FileSystemObject")
appDir = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = appDir
sh.Run "cmd /c node --use-system-ca server.js >> logs\server-console.log 2>&1", 0, False
