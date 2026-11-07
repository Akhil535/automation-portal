# Splits a picture holding a signature AND a stamp side by side into two pictures (local image analysis).
# The ink is grouped into islands (strokes close together belong together); the largest island that is about as
# wide as it is tall is the stamp, the remaining ink is the signature. Each part is saved as a transparent PNG cropped
# to its ink. Output (one JSON line): {"ok":true,"split":true|false} - split=false when there is nothing to separate.
param([Parameter(Mandatory)][string]$In, [Parameter(Mandatory)][string]$OutPrefix)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @"
using System; using System.Collections.Generic; using System.Drawing; using System.Drawing.Imaging; using System.Runtime.InteropServices;
public static class PicSplit2 {
  public static string Run(string inFile, string prefix) {
    Bitmap src0 = (Bitmap)Image.FromFile(inFile);
    double k = Math.Min(1.0, 1400.0 / Math.Max(src0.Width, src0.Height));
    int W = Math.Max(1, (int)(src0.Width * k)), H = Math.Max(1, (int)(src0.Height * k));
    var bmp = new Bitmap(W, H, PixelFormat.Format32bppArgb);
    using (var g = Graphics.FromImage(bmp)) { g.Clear(Color.Transparent); g.DrawImage(src0, 0, 0, W, H); }
    src0.Dispose();
    var data = bmp.LockBits(new Rectangle(0, 0, W, H), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
    int stride = data.Stride; var px = new byte[stride * H]; Marshal.Copy(data.Scan0, px, 0, px.Length); bmp.UnlockBits(data);
    var ink = new bool[W * H]; int total = 0;
    for (int y = 0; y < H; y++) for (int x = 0; x < W; x++) {
      int i = y * stride + x * 4; byte b = px[i], gg = px[i + 1], r = px[i + 2], a = px[i + 3];
      if (a < 110) continue; double mn = Math.Min(r, Math.Min(gg, b)) / 255.0; if (mn > 0.86) continue;
      ink[y * W + x] = true; total++;
    }
    if (total == 0) { bmp.Dispose(); return "{\"ok\":true,\"split\":false}"; }
    int R = Math.Max(3, Math.Max(W, H) / 70);
    var dil = new bool[W * H];
    for (int y = 0; y < H; y++) for (int x = 0; x < W; x++) if (ink[y * W + x])
      for (int dy = -R; dy <= R; dy++) { int yy = y + dy; if (yy < 0 || yy >= H) continue; for (int dx = -R; dx <= R; dx++) { int xx = x + dx; if (xx >= 0 && xx < W) dil[yy * W + xx] = true; } }
    var lab = new int[W * H]; var comps = new List<int[]>(); int next = 0; var q = new Queue<int>();
    for (int s = 0; s < W * H; s++) {
      if (!dil[s] || lab[s] != 0) continue; next++;
      int minX = W, minY = H, maxX = -1, maxY = -1, n = 0; lab[s] = next; q.Enqueue(s);
      while (q.Count > 0) {
        int c = q.Dequeue(), cx = c % W, cy = c / W;
        if (ink[c]) { n++; if (cx < minX) minX = cx; if (cx > maxX) maxX = cx; if (cy < minY) minY = cy; if (cy > maxY) maxY = cy; }
        if (cx > 0 && dil[c - 1] && lab[c - 1] == 0) { lab[c - 1] = next; q.Enqueue(c - 1); }
        if (cx < W - 1 && dil[c + 1] && lab[c + 1] == 0) { lab[c + 1] = next; q.Enqueue(c + 1); }
        if (cy > 0 && dil[c - W] && lab[c - W] == 0) { lab[c - W] = next; q.Enqueue(c - W); }
        if (cy < H - 1 && dil[c + W] && lab[c + W] == 0) { lab[c + W] = next; q.Enqueue(c + W); }
      }
      if (n > 0) comps.Add(new int[] { next, n, minX, minY, maxX, maxY });
    }
    var big = comps.FindAll(c => c[1] >= Math.Max(30, total * 0.04));
    int[] stamp = null;
    foreach (var c in big) {
      double w = c[4] - c[2] + 1, h = c[5] - c[3] + 1, asp = w / h;
      if (asp < 0.7 || asp > 1.45 || Math.Min(w, h) < Math.Max(W, H) * 0.25) continue;
      if (stamp == null || c[1] > stamp[1]) stamp = c;
    }
    if (big.Count < 2 || stamp == null) { bmp.Dispose(); return "{\"ok\":true,\"split\":false}"; }
    var sig = new HashSet<int>(); int bx0 = int.MaxValue, by0 = int.MaxValue, bx1 = -1, by1 = -1;
    foreach (var c in big) if (c[0] != stamp[0]) { sig.Add(c[0]); bx0 = Math.Min(bx0, c[2]); by0 = Math.Min(by0, c[3]); bx1 = Math.Max(bx1, c[4]); by1 = Math.Max(by1, c[5]); }
    if (sig.Count == 0) { bmp.Dispose(); return "{\"ok\":true,\"split\":false}"; }
    foreach (var c in comps) if (c[0] != stamp[0] && !sig.Contains(c[0]) && c[2] >= bx0 - 20 && c[4] <= bx1 + 20 && c[3] >= by0 - 20 && c[5] <= by1 + 20) sig.Add(c[0]);
    Save(px, stride, lab, W, H, new HashSet<int> { stamp[0] }, stamp[2], stamp[3], stamp[4], stamp[5], prefix + "-stamp.png");
    Save(px, stride, lab, W, H, sig, bx0, by0, bx1, by1, prefix + "-signature.png");
    bmp.Dispose();
    return "{\"ok\":true,\"split\":true}";
  }
  static void Save(byte[] px, int stride, int[] lab, int W, int H, HashSet<int> keep, int x0, int y0, int x1, int y1, string file) {
    int pad = 4; x0 = Math.Max(0, x0 - pad); y0 = Math.Max(0, y0 - pad); x1 = Math.Min(W - 1, x1 + pad); y1 = Math.Min(H - 1, y1 + pad);
    int w = x1 - x0 + 1, h = y1 - y0 + 1;
    using (var o = new Bitmap(w, h, PixelFormat.Format32bppArgb)) {
      var d = o.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
      var ob = new byte[d.Stride * h];
      for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) {
        int sx = x + x0, sy = y + y0;
        if (!keep.Contains(lab[sy * W + sx])) continue;
        int si = sy * stride + sx * 4, di = y * d.Stride + x * 4;
        ob[di] = px[si]; ob[di + 1] = px[si + 1]; ob[di + 2] = px[si + 2]; ob[di + 3] = px[si + 3];
      }
      Marshal.Copy(ob, 0, d.Scan0, ob.Length); o.UnlockBits(d);
      o.Save(file, ImageFormat.Png);
    }
  }
}
"@
try { [PicSplit2]::Run($In, $OutPrefix) } catch { @{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress }
