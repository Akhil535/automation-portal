' Starts the public link (Cloudflare tunnel + GitHub Pages start page) without a console window (Windows start-up task).
Set fso = CreateObject("Scripting.FileSystemObject")
appDir = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = appDir
sh.Run "cmd /c node scripts\public-link.mjs >> logs\public-link-console.log 2>&1", 0, False
