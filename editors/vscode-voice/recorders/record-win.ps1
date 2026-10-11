# DGC Voice on Windows: records the microphone to the .wav named by -Out -- 16-bit mono PCM at 16 kHz -- with the
# Windows audio API (winmm's MCI), until a file of the same name plus ".stop" appears (or ten minutes pass). Needs
# nothing Windows doesn't have.
param([Parameter(Mandatory = $true)][string]$Out)
$ErrorActionPreference = 'Stop'
$signature = '[DllImport("winmm.dll", CharSet = CharSet.Unicode)] public static extern int mciSendString(string command, System.Text.StringBuilder answer, int answerLength, System.IntPtr callback);'
$mci = Add-Type -MemberDefinition $signature -Name 'Mci' -Namespace 'DgcVoice' -PassThru
function Send-Mci([string]$command) {
    $code = $mci::mciSendString($command, $null, 0, [IntPtr]::Zero)
    if ($code -ne 0) { throw "could not record: MCI error $code on '$command'" }
}
Send-Mci 'open new type waveaudio alias dgcvoice'
Send-Mci 'set dgcvoice bitspersample 16 samplespersec 16000 channels 1 bytespersec 32000 alignment 2'
Send-Mci 'record dgcvoice'
$until = (Get-Date).AddMinutes(10)
while (-not (Test-Path -LiteralPath ($Out + '.stop')) -and (Get-Date) -lt $until) { Start-Sleep -Milliseconds 50 }
Send-Mci 'stop dgcvoice'
Send-Mci ('save dgcvoice "' + $Out + '"')
Send-Mci 'close dgcvoice'
