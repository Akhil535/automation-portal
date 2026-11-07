# Measures pictures so they can be told apart (logo / signature / stamp) - local image analysis, nothing is sent out.
# Input: a JSON file with a list of picture paths. Output (one JSON line): for each picture
#   aspect   width / height of the inked area
#   ink      share of the inked area's bounding box that is ink (signatures are thin strokes: low)
#   ring     share of ink lying on the ellipse border of the inked area (round stamps: high)
#   colours  number of clearly different colours (logos are often multi-coloured)
#   dark     share of ink that is dark (black / dark-blue pen)
#   hue      main hue of the coloured ink in degrees (-1 when grey / black)
param([Parameter(Mandatory)][string]$List)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @"
using System; using System.Drawing; using System.Drawing.Imaging; using System.Runtime.InteropServices;
public static class PicFeatures {
  public static double[] Measure(string file) {
    using (var src = (Bitmap)Image.FromFile(file)) {
      double k = Math.Min(1.0, 320.0 / Math.Max(src.Width, src.Height));
      int W = Math.Max(1, (int)(src.Width * k)), H = Math.Max(1, (int)(src.Height * k));
      using (var bmp = new Bitmap(W, H, PixelFormat.Format32bppArgb)) {
        using (var g = Graphics.FromImage(bmp)) { g.Clear(Color.Transparent); g.DrawImage(src, 0, 0, W, H); }
        var data = bmp.LockBits(new Rectangle(0, 0, W, H), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
        var px = new byte[data.Stride * H]; Marshal.Copy(data.Scan0, px, 0, px.Length); bmp.UnlockBits(data);
        var ink = new bool[W * H]; int minX = W, minY = H, maxX = -1, maxY = -1, n = 0, dark = 0;
        var hues = new double[12]; double coloured = 0;
        for (int y = 0; y < H; y++) for (int x = 0; x < W; x++) {
          int i = y * data.Stride + x * 4; byte b = px[i], gg = px[i + 1], r = px[i + 2], a = px[i + 3];
          if (a < 110) continue;
          double R = r / 255.0, G = gg / 255.0, B = b / 255.0, mx = Math.Max(R, Math.Max(G, B)), mn = Math.Min(R, Math.Min(G, B));
          if (mn > 0.86) continue; // white / paper
          ink[y * W + x] = true; n++;
          if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
          if (mx < 0.38) dark++;
          double s = mx == 0 ? 0 : (mx - mn) / mx;
          if (s > 0.28 && mx > 0.25) {
            double h; double d = mx - mn;
            if (mx == R) h = 60 * (((G - B) / d) % 6); else if (mx == G) h = 60 * (((B - R) / d) + 2); else h = 60 * (((R - G) / d) + 4);
            if (h < 0) h += 360; hues[(int)(h / 30) % 12]++; coloured++;
          }
        }
        if (n == 0) return new double[] { 1, 0, 0, 0, 0, -1, 0 };
        double bw = maxX - minX + 1, bh = maxY - minY + 1, cx = minX + bw / 2, cy = minY + bh / 2, rx = bw / 2, ry = bh / 2, onRing = 0;
        for (int y = minY; y <= maxY; y++) for (int x = minX; x <= maxX; x++) if (ink[y * W + x]) {
          double dx = (x - cx) / rx, dy = (y - cy) / ry, rr = Math.Sqrt(dx * dx + dy * dy);
          if (rr > 0.78 && rr < 1.06) onRing++;
        }
        int colours = 0, top = -1; double best = 0;
        for (int j = 0; j < 12; j++) { if (coloured > 0 && hues[j] / coloured > 0.12 && hues[j] / n > 0.04) colours++; if (hues[j] > best) { best = hues[j]; top = j; } }
        if (n - coloured > n * 0.25 && dark > n * 0.15) colours++; // black / dark text counts as a colour
        // colour families: significant hue bins not next to each other (shades of one ink are one family)
        var sig = new bool[12]; int sigN = 0;
        for (int j = 0; j < 12; j++) if (coloured > 0 && hues[j] / coloured > 0.12 && hues[j] / n > 0.04) { sig[j] = true; sigN++; }
        int families = 0; for (int j = 0; j < 12; j++) if (sig[j] && !sig[(j + 11) % 12]) families++;
        if (sigN == 12) families = 1;
        return new double[] { bw / bh, n / (bw * bh), onRing / n, colours, (double)dark / n, coloured > n * 0.2 ? top * 30 + 15 : -1, families };
      }
    }
  }
}
"@
$files = Get-Content -Raw $List | ConvertFrom-Json
$out = @()
foreach ($f in $files) {
  try { $m = [PicFeatures]::Measure($f); $out += @{ ok = $true; aspect = [Math]::Round($m[0], 3); ink = [Math]::Round($m[1], 3); ring = [Math]::Round($m[2], 3); colours = [int]$m[3]; dark = [Math]::Round($m[4], 3); hue = [int]$m[5]; families = [int]$m[6] } }
  catch { $out += @{ ok = $false; error = $_.Exception.Message } }
}
ConvertTo-Json -InputObject @($out) -Compress -Depth 3
