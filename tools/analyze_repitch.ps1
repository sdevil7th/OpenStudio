$path = 'C:\Program Files\Common Files\VST3\RePitch.vst3\Contents\x86_64-win\RePitch.vst3'
$data = [System.IO.File]::ReadAllBytes($path)
Write-Host ('Size: ' + $data.Length)

# Extract ASCII strings >= 6 chars
$text = [System.Text.Encoding]::ASCII.GetString($data)
$pattern = [regex]'[ -~]{6,}'
$m_list = $pattern.Matches($text)

$keywords = @('pitch','fft','partial','formant','phase','vocoder','rubber','sinusoid','harmonic','autocorr','lpc','spectrum','transient','residual','stft','overlap','additive','hop size','hann','window size','analysis','resynth','synthesis')

$found = @{}
foreach ($m in $m_list) {
    $v = $m.Value.ToLower()
    foreach ($k in $keywords) {
        if ($v.Contains($k)) {
            $found[$m.Value] = 1
            break
        }
    }
}

$found.Keys | Sort-Object
