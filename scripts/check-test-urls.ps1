$ErrorActionPreference = 'Continue'
$lines = @()
foreach ($page in @('https://test-videos.co.uk/bigbuckbunny/mp4-h264', 'https://test-videos.co.uk/sintel/mp4-h264')) {
  try {
    $r = Invoke-WebRequest -Uri $page -UseBasicParsing -TimeoutSec 30
    $hrefs = $r.Links | ForEach-Object { $_.href } | Where-Object { $_ -like '*.mp4' -and $_ -like '*360*' }
    $lines += "PAGE $page"
    $lines += $hrefs
  } catch {
    $lines += "FAIL $page $($_.Exception.Message)"
  }
}
$lines | Set-Content -Path "$env:TEMP\urlcheck.txt" -Encoding utf8
