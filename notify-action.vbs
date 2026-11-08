Option Explicit
Dim a, node, url, script, sh
Set a = WScript.Arguments
If a.Count < 2 Then WScript.Quit 0
node = a(0)
url = a(1)
script = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\")) & "notify-action.mjs"
Set sh = CreateObject("WScript.Shell")
' 0 = 隐藏窗口，False = 不等待，避免闪控制台
sh.Run """" & node & """ """ & script & """ """ & url & """", 0, False
