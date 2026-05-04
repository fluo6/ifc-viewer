Add-Type -AssemblyName System.Drawing

$size = 256
$bmp = New-Object System.Drawing.Bitmap $size, $size
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit

# Rounded-square dark background
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$r = 36
$path.AddArc(8, 8, $r, $r, 180, 90)
$path.AddArc(248 - $r, 8, $r, $r, 270, 90)
$path.AddArc(248 - $r, 248 - $r, $r, $r, 0, 90)
$path.AddArc(8, 248 - $r, $r, $r, 90, 90)
$path.CloseFigure()
$bgBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 13, 17, 23))
$g.FillPath($bgBrush, $path)

# Subtle inner border in muted blue-grey
$borderPen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 48, 54, 61)), 2
$g.DrawPath($borderPen, $path)

# Isometric house wireframe in orange (#f0883e)
$orange = [System.Drawing.Color]::FromArgb(255, 240, 136, 62)
$pen = New-Object System.Drawing.Pen $orange, 7
$pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
$pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round

# Cube + roof vertices (X, Y) in pixel space.
# Front face corners
$flx = 60;  $fly = 174
$frx = 156; $fry = 174
$fbx = 60;  $fby = 226    # not used; flat bottom
$flbx = 60;  $flby = 226
$frbx = 156; $frby = 226
# Back face (offset up-right for iso depth)
$blx = 100;  $bly = 134
$brx = 196;  $bry = 134
$blbx = 100; $blby = 186
$brbx = 196; $brby = 186
# Roof apex (front + back)
$apexFx = 108; $apexFy = 100
$apexBx = 148; $apexBy = 60

# Front face rectangle
$g.DrawLine($pen, $flx, $fly, $frx, $fry)
$g.DrawLine($pen, $flx, $fly, $flbx, $flby)
$g.DrawLine($pen, $frx, $fry, $frbx, $frby)
$g.DrawLine($pen, $flbx, $flby, $frbx, $frby)
# Back face rectangle (lighter — semi transparent for "behind" feel)
$penBack = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(170, 240, 136, 62)), 5
$penBack.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
$g.DrawLine($penBack, $blx, $bly, $brx, $bry)
$g.DrawLine($penBack, $brx, $bry, $brbx, $brby)
$g.DrawLine($penBack, $blbx, $blby, $brbx, $brby)
$g.DrawLine($penBack, $blx, $bly, $blbx, $blby)
# Depth edges
$g.DrawLine($penBack, $flx, $fly, $blx, $bly)
$g.DrawLine($pen,     $frx, $fry, $brx, $bry)
$g.DrawLine($penBack, $flbx, $flby, $blbx, $blby)
$g.DrawLine($penBack, $frbx, $frby, $brbx, $brby)
# Roof
$g.DrawLine($pen, $flx, $fly, $apexFx, $apexFy)
$g.DrawLine($pen, $frx, $fry, $apexFx, $apexFy)
$g.DrawLine($penBack, $blx, $bly, $apexBx, $apexBy)
$g.DrawLine($penBack, $brx, $bry, $apexBx, $apexBy)
$g.DrawLine($pen, $apexFx, $apexFy, $apexBx, $apexBy)

$pen.Dispose(); $penBack.Dispose(); $bgBrush.Dispose(); $borderPen.Dispose(); $g.Dispose()

$pngPath = "C:\Users\fujial\fujia-dev\ifc-viewer\icon.png"
$bmp.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()

# Wrap PNG in a single-image ICO container (Windows Vista+ supports PNG-in-ICO at 256x256)
$pngBytes = [System.IO.File]::ReadAllBytes($pngPath)
$pngLen = $pngBytes.Length

$ms = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter $ms
# ICONDIR
$bw.Write([UInt16]0)
$bw.Write([UInt16]1)
$bw.Write([UInt16]1)
# ICONDIRENTRY
$bw.Write([byte]0)         # 0 means 256
$bw.Write([byte]0)         # 0 means 256
$bw.Write([byte]0)
$bw.Write([byte]0)
$bw.Write([UInt16]1)
$bw.Write([UInt16]32)
$bw.Write([UInt32]$pngLen)
$bw.Write([UInt32]22)
$bw.Write($pngBytes)

$icoPath = "C:\Users\fujial\fujia-dev\ifc-viewer\icon.ico"
[System.IO.File]::WriteAllBytes($icoPath, $ms.ToArray())
$bw.Dispose(); $ms.Dispose()

Write-Output "wrote $icoPath ($((Get-Item $icoPath).Length) bytes)"
Write-Output "wrote $pngPath ($((Get-Item $pngPath).Length) bytes)"
