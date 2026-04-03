$path = 'C:\Program Files\Common Files\VST3\RePitch.vst3\Contents\x86_64-win\RePitch.vst3'
$data = [System.IO.File]::ReadAllBytes($path)
$text = [System.Text.Encoding]::ASCII.GetString($data)

# Only extract strings with mostly printable ASCII (letters, numbers, common symbols)
# Filter out binary noise by requiring high proportion of letters
$pattern = [regex]'[A-Za-z][A-Za-z0-9 _.,\-/:()!?+*=<>]{8,}'
$m_list = $pattern.Matches($text)

$results = @{}
foreach ($m in $m_list) {
    $val = $m.Value
    # Check that at least 60% are letters/digits/space
    $letters = ($val.ToCharArray() | Where-Object { $_ -match '[A-Za-z0-9 ]' }).Count
    if ($letters / $val.Length -ge 0.7) {
        $results[$val] = 1
    }
}

$results.Keys | Sort-Object
