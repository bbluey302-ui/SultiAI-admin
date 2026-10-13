# One-shot: authenticate, set the Groq secrets, deploy both Edge Functions, verify.
# Usage (PowerShell):  .\scripts\deploy-ai-functions.ps1 -Token sbp_xxx
param(
  [Parameter(Mandatory = $true)][string]$Token,
  [string]$ProjectRef = 'pptanwtuybivlqeyntwh'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $root 'server\.env'

# Pull GROQ_API_KEY straight out of server/.env so it never has to be pasted.
$groqKey = (Get-Content $envFile | Where-Object { $_ -match '^GROQ_API_KEY=' } | Select-Object -First 1)
if (-not $groqKey) { throw "GROQ_API_KEY not found in $envFile" }
$groqKey = $groqKey.Split('=', 2)[1].Trim()
if ($groqKey.Length -lt 20) { throw "GROQ_API_KEY looks truncated (len $($groqKey.Length))" }

Write-Host "`n=== 1/4  supabase login ===" -ForegroundColor Cyan
supabase login --token $Token
if ($LASTEXITCODE -ne 0) { throw 'supabase login failed' }

Write-Host "`n=== 2/4  set Groq secrets ===" -ForegroundColor Cyan
# GROQ_MODEL / GROQ_STT_MODEL are pinned to models verified reachable with this key
# on 2026-10-06. GROQ_VISION_MODEL is deliberately NOT set: no vision-capable model
# is reachable with this key, and the ai function now degrades gracefully instead.
supabase secrets set --project-ref $ProjectRef `
  "GROQ_API_KEY=$groqKey" `
  'GROQ_MODEL=openai/gpt-oss-120b' `
  'GROQ_STT_MODEL=whisper-large-v3'
if ($LASTEXITCODE -ne 0) { throw 'secrets set failed' }

Write-Host "`n=== 3/4  deploy ai + agent-token ===" -ForegroundColor Cyan
supabase functions deploy ai agent-token --project-ref $ProjectRef
if ($LASTEXITCODE -ne 0) { throw 'functions deploy failed' }

Write-Host "`n=== 4/4  verify ===" -ForegroundColor Cyan
$url = 'https://' + $ProjectRef + '.supabase.co'
$anon = (Get-Content (Join-Path $root '.env') |
  Where-Object { $_ -match '^EXPO_PUBLIC_SUPABASE_ANON_KEY=' } |
  Select-Object -First 1).Split('=', 2)[1].Trim()
$hdr = @{ apikey = $anon; Authorization = "Bearer $anon"; 'Content-Type' = 'application/json' }

# The anon key is not a signed-in user, so a 401 here is the expected result and
# still proves the function EXISTS - the pre-deploy state was a bare 404.
foreach ($probe in @(
    @{ fn = 'ai'; body = '{"task":"capabilities"}' },
    @{ fn = 'agent-token'; body = '{"action":"status"}' }
  )) {
  $u = "$url/functions/v1/$($probe.fn)"
  try {
    Invoke-WebRequest -Uri $u -Method POST -Headers $hdr -Body $probe.body -UseBasicParsing -TimeoutSec 60 | Out-Null
    Write-Host "  $($probe.fn): reachable (200)" -ForegroundColor Green
  }
  catch {
    $code = try { [int]$_.Exception.Response.StatusCode } catch { 'n/a' }
    if ($code -eq 401) {
      Write-Host "  $($probe.fn): DEPLOYED, reached auth gate (401 = needs a signed-in user, expected)" -ForegroundColor Green
    }
    elseif ($code -eq 404) {
      Write-Host "  $($probe.fn): STILL 404 - not deployed" -ForegroundColor Red
    }
    else {
      Write-Host "  $($probe.fn): HTTP $code - $($_.ErrorDetails.Message)" -ForegroundColor Yellow
    }
  }
}

Write-Host "`nDone. Sign in to the app and both chat and voice should answer." -ForegroundColor Green
Write-Host "Note: xAI realtime voice and the Deepgram live agent stay unavailable (no xAI"
Write-Host "credits; DEEPGRAM_API_KEY lacks the Agent scope). Voice runs push-to-talk:"
Write-Host "Groq Whisper STT -> Groq reply -> on-device expo-speech, which is the path"
Write-Host "VoiceModeScreen actually uses." -ForegroundColor DarkGray