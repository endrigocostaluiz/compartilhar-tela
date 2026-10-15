@echo off
chcp 65001 >nul
title Compartilhar Tela - Remover assistente de audio
powershell -NoProfile -ExecutionPolicy Bypass -Command "$t=[IO.File]::ReadAllText('%~f0',[Text.Encoding]::UTF8); $i=$t.IndexOf('#<'+'PS>'); Invoke-Expression $t.Substring($i)"
exit /b
#<PS>
# Remove o assistente de áudio do Compartilhar Tela: encerra o programa, apaga a pasta e o endereço compartilhartela-audio://.
Get-Process -Name AssistenteAudio -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 500
Remove-Item 'HKCU:\Software\Classes\compartilhartela-audio' -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $env:LOCALAPPDATA 'CompartilharTela') -Recurse -Force -ErrorAction SilentlyContinue
Write-Host ''
Write-Host '  Assistente de áudio removido.' -ForegroundColor Green
Start-Sleep -Seconds 3
