$path = 'C:\Program Files\Common Files\VST3\RePitch.vst3\Contents\x86_64-win\RePitch.vst3'
$data = [System.IO.File]::ReadAllBytes($path)

# Extract longer ASCII strings >= 12 chars that look like real text (not binary noise)
$text = [System.Text.Encoding]::ASCII.GetString($data)
$pattern = [regex]'[A-Za-z][A-Za-z0-9_ .,\-/\\:()]{11,}'
$m_list = $pattern.Matches($text)

$found = @{}
foreach ($m in $m_list) {
    $found[$m.Value] = 1
}

# Also look for error/log messages
$pattern2 = [regex]'[A-Za-z][A-Za-z0-9_ .!?,\-/\\:()]{20,}'
$m_list2 = $pattern2.Matches($text)
foreach ($m in $m_list2) {
    $found[$m.Value] = 1
}

$found.Keys | Sort-Object | Select-Object -First 500
