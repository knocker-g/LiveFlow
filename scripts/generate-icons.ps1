param(
    [string]$BrowserPath = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$iconDirectory = Join-Path $repositoryRoot 'icons'
$rasterizerPath = Join-Path $iconDirectory 'rasterize.html'
$masterPath = Join-Path $iconDirectory '.liveflow-raster-master.png'

if (-not (Test-Path -LiteralPath $BrowserPath)) {
    $BrowserPath = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
}
if (-not (Test-Path -LiteralPath $BrowserPath)) {
    throw 'Chrome or Edge is required to rasterize the SVG icon.'
}

$rasterizerUri = [System.Uri]::new($rasterizerPath).AbsoluteUri
& $BrowserPath --headless=new --disable-gpu --hide-scrollbars --default-background-color=00000000 --force-device-scale-factor=1 --window-size=640,640 --screenshot="$masterPath" $rasterizerUri | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Master icon rasterization failed.' }

Add-Type -AssemblyName System.Drawing
$master = [System.Drawing.Image]::FromFile($masterPath)
try {
    if ($master.Width -lt 512 -or $master.Height -lt 512) { throw 'Rasterized master is smaller than 512x512.' }
    foreach ($size in 16, 32, 48, 128) {
        $outputPath = Join-Path $iconDirectory "icon$size.png"
        $bitmap = [System.Drawing.Bitmap]::new($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
        try {
            $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
            try {
                $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
                $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
                $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
                $destination = [System.Drawing.Rectangle]::new(0, 0, $size, $size)
                $source = [System.Drawing.Rectangle]::new(0, 0, 512, 512)
                $graphics.DrawImage($master, $destination, $source, [System.Drawing.GraphicsUnit]::Pixel)
            } finally { $graphics.Dispose() }
            $bitmap.Save($outputPath, [System.Drawing.Imaging.ImageFormat]::Png)
        } finally { $bitmap.Dispose() }
    }
} finally {
    $master.Dispose()
    Remove-Item -LiteralPath $masterPath -Force
}
