Add-Type -AssemblyName System.Drawing

function New-RoundedRectanglePath([float]$x, [float]$y, [float]$width, [float]$height, [float]$radius) {
  $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $diameter = $radius * 2
  $path.AddArc($x, $y, $diameter, $diameter, 180, 90)
  $path.AddArc($x + $width - $diameter, $y, $diameter, $diameter, 270, 90)
  $path.AddArc($x + $width - $diameter, $y + $height - $diameter, $diameter, $diameter, 0, 90)
  $path.AddArc($x, $y + $height - $diameter, $diameter, $diameter, 90, 90)
  $path.CloseFigure()
  return $path
}

function New-PwaIcon([int]$size, [string]$destination) {
  $bitmap = [System.Drawing.Bitmap]::new($size, $size)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.Clear([System.Drawing.ColorTranslator]::FromHtml('#efe3c8'))

  $margin = [int]($size * 0.055)
  $cardPath = New-RoundedRectanglePath $margin $margin ($size - 2 * $margin) ($size - 2 * $margin) ($size * 0.19)
  $cardBrush = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#f9f1df'))
  $cardPen = [System.Drawing.Pen]::new([System.Drawing.ColorTranslator]::FromHtml('#ad392e'), [Math]::Max(3, [int]($size * 0.023)))
  $cardPen.DashStyle = [System.Drawing.Drawing2D.DashStyle]::Dash
  $graphics.FillPath($cardBrush, $cardPath)
  $graphics.DrawPath($cardPen, $cardPath)

  $sealSize = [int]($size * 0.60)
  $sealX = [int](($size - $sealSize) / 2)
  $sealY = $sealX
  $sealBrush = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#ad392e'))
  $sealPen = [System.Drawing.Pen]::new([System.Drawing.ColorTranslator]::FromHtml('#872a22'), [Math]::Max(4, [int]($size * 0.031)))
  $graphics.FillEllipse($sealBrush, $sealX, $sealY, $sealSize, $sealSize)
  $graphics.DrawEllipse($sealPen, $sealX, $sealY, $sealSize, $sealSize)

  $fontName = if ([System.Drawing.FontFamily]::Families.Name -contains 'Noto Serif TC') { 'Noto Serif TC' } else { 'Microsoft JhengHei' }
  $font = [System.Drawing.Font]::new($fontName, [int]($size * 0.22), [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $format = [System.Drawing.StringFormat]::new()
  $format.Alignment = [System.Drawing.StringAlignment]::Center
  $format.LineAlignment = [System.Drawing.StringAlignment]::Center
  $inkBrush = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#fff9ec'))
  $graphics.DrawString('愛', $font, $inkBrush, [System.Drawing.RectangleF]::new(0, 0, $size, $size), $format)

  $bitmap.Save($destination, [System.Drawing.Imaging.ImageFormat]::Png)
  $inkBrush.Dispose(); $format.Dispose(); $font.Dispose(); $sealPen.Dispose(); $sealBrush.Dispose(); $cardPen.Dispose(); $cardBrush.Dispose(); $cardPath.Dispose(); $graphics.Dispose(); $bitmap.Dispose()
}

$publicDir = Join-Path $PSScriptRoot '..\public'
New-PwaIcon 192 (Join-Path $publicDir 'icon-192.png')
New-PwaIcon 512 (Join-Path $publicDir 'icon-512.png')
New-PwaIcon 180 (Join-Path $publicDir 'apple-touch-icon.png')
