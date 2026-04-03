$path = 'C:\Program Files\Common Files\VST3\RePitch.vst3\Contents\x86_64-win\RePitch.vst3'
$data = [System.IO.File]::ReadAllBytes($path)
$text = [System.Text.Encoding]::ASCII.GetString($data)

# Search for specific algorithm-related substrings
$searches = @(
    'sample rate', 'samplerate', 'sample_rate',
    'fft size', 'fftsize', 'fft_size',
    'window size', 'windowsize',
    'hop size', 'hopsize', 'hop_size',
    'overlap', 'phase vocoder', 'phase_vocoder',
    'sinusoidal', 'partial track', 'harmonic',
    'formant', 'lpc order', 'autocorr',
    'pitch shift', 'pitchshift', 'pitch_shift',
    'resynthes', 'residual',
    'onset', 'transient',
    'vibrato', 'portamento', 'glide',
    'midi note', 'note detect',
    'repitch', 'RePitch',
    'Synchro', 'synchro',
    'algorithm', 'process',
    'version', 'copyright',
    'interpolat', 'resampl',
    'magnitude', 'spectrum',
    'autocorrelation', 'yin', 'crepe', 'pyin',
    'nnls', 'nmf', 'ica',
    'sms', 'loris', 'spear'
)

foreach ($s in $searches) {
    $idx = $text.ToLower().IndexOf($s.ToLower())
    if ($idx -ge 0) {
        $start = [Math]::Max(0, $idx - 20)
        $len = [Math]::Min(200, $text.Length - $start)
        Write-Host "=== Found: '$s' ==="
        Write-Host $text.Substring($start, $len)
        Write-Host ""
    }
}
