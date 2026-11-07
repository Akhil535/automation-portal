# Logo clean-up for the Legal Register Portal (local, Windows imaging - nothing leaves this PC).
#   logo-clean.ps1 <input image> <output.png> [header]
# 1. Finds the background colour from the image border and removes the background connected to the edges
#    (made transparent with soft edges); white inside the logo is kept.
# 2. Crops to the logo with a small margin and drops stray specks.
# 3. "header" mode (a whole scanned page): looks only at the top of the page and keeps the most logo-like
#    block (largest, most colourful group of marks).
# Prints one JSON line: {"ok":true,"width":..,"height":..,"cropped":..,"transparent":..}
param([string]$In, [string]$Out, [string]$Mode = '', [int]$Max = 0)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing -Language CSharp -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

public static class LogoClean {
  static int Diff(int a, int b) {
    int dr = Math.Abs(((a >> 16) & 255) - ((b >> 16) & 255));
    int dg = Math.Abs(((a >> 8) & 255) - ((b >> 8) & 255));
    int db = Math.Abs((a & 255) - (b & 255));
    return Math.Max(dr, Math.Max(dg, db));
  }
  static int Alpha(int p) { return (p >> 24) & 255; }
  static int Sat(int p) {
    int r = (p >> 16) & 255, g = (p >> 8) & 255, b = p & 255;
    return Math.Max(r, Math.Max(g, b)) - Math.Min(r, Math.Min(g, b));
  }

  public static string Run(string inPath, string outPath, bool header, int maxSide) {
    Bitmap bmp;
    using (var src = new Bitmap(inPath)) {
      int sw = src.Width, sh = src.Height, top = 0;
      if (header) sh = Math.Max(1, (int)(src.Height * 0.22)); // top band of a scanned page
      double k = Math.Min(1.0, 3000.0 / Math.Max(sw, sh));   // only very large scans are reduced
      int w = Math.Max(1, (int)(sw * k)), h = Math.Max(1, (int)(sh * k));
      bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb);
      using (var g = Graphics.FromImage(bmp)) {
        g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
        g.DrawImage(src, new Rectangle(0, 0, w, h), new Rectangle(0, top, sw, sh), GraphicsUnit.Pixel);
      }
    }
    int W = bmp.Width, H = bmp.Height, N = W * H;
    int[] px = new int[N];
    var bd = bmp.LockBits(new Rectangle(0, 0, W, H), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
    Marshal.Copy(bd.Scan0, px, 0, N);
    bmp.UnlockBits(bd);
    bmp.Dispose();

    // ---- background colour = most common (quantised) border colour ----
    var counts = new Dictionary<int, int>();
    var border = new List<int>();
    for (int x = 0; x < W; x++) { border.Add(x); border.Add((H - 1) * W + x); }
    for (int y = 0; y < H; y++) { border.Add(y * W); border.Add(y * W + W - 1); }
    int transparentBorder = 0;
    foreach (int i in border) {
      int p = px[i];
      if (Alpha(p) < 24) { transparentBorder++; continue; }
      int q = (((p >> 16) & 255) / 16 << 8) | (((p >> 8) & 255) / 16 << 4) | ((p & 255) / 16);
      int c; counts.TryGetValue(q, out c); counts[q] = c + 1;
    }
    int bgQ = -1, best = 0;
    foreach (var kv in counts) if (kv.Value > best) { best = kv.Value; bgQ = kv.Key; }
    int bg = 0;
    if (bgQ >= 0) { // average of the border pixels in that bucket
      long r = 0, g = 0, b = 0; int n = 0;
      foreach (int i in border) {
        int p = px[i]; if (Alpha(p) < 24) continue;
        int q = (((p >> 16) & 255) / 16 << 8) | (((p >> 8) & 255) / 16 << 4) | ((p & 255) / 16);
        if (q != bgQ) continue;
        r += (p >> 16) & 255; g += (p >> 8) & 255; b += p & 255; n++;
      }
      bg = (int)(r / n) << 16 | (int)(g / n) << 8 | (int)(b / n);
    }
    int tol = 40;
    int nearBorder = transparentBorder;
    foreach (int i in border) if (Alpha(px[i]) >= 24 && Diff(px[i], bg) <= tol) nearBorder++;
    bool uniform = nearBorder >= border.Count * 0.55; // plain background -> can be removed safely

    // ---- flood fill the background from the edges ----
    bool[] isBg = new bool[N];
    if (uniform) {
      var stack = new Stack<int>();
      foreach (int i in border) if (!isBg[i] && (Alpha(px[i]) < 24 || Diff(px[i], bg) <= tol)) { isBg[i] = true; stack.Push(i); }
      while (stack.Count > 0) {
        int i = stack.Pop(), x = i % W, y = i / W;
        for (int d = 0; d < 4; d++) {
          int nx = x + (d == 0 ? 1 : d == 1 ? -1 : 0), ny = y + (d == 2 ? 1 : d == 3 ? -1 : 0);
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          int j = ny * W + nx;
          if (isBg[j]) continue;
          if (Alpha(px[j]) < 24 || Diff(px[j], bg) <= tol) { isBg[j] = true; stack.Push(j); }
        }
      }
      // Small enclosed holes of the background colour (inside letters such as a, o, e) become transparent too.
      bool[] seen = new bool[N];
      int half = tol / 2, maxHole = Math.Max(64, N / 50);
      var region = new List<int>();
      for (int s = 0; s < N; s++) {
        if (isBg[s] || seen[s] || Diff(px[s], bg) > half) continue;
        region.Clear(); var st2 = new Stack<int>(); st2.Push(s); seen[s] = true; bool tooBig = false;
        while (st2.Count > 0) {
          int i = st2.Pop(); if (!tooBig) region.Add(i); if (region.Count > maxHole) tooBig = true;
          int x = i % W, y = i / W;
          for (int d = 0; d < 4; d++) {
            int nx = x + (d == 0 ? 1 : d == 1 ? -1 : 0), ny = y + (d == 2 ? 1 : d == 3 ? -1 : 0);
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
            int j = ny * W + nx;
            if (!seen[j] && !isBg[j] && Diff(px[j], bg) <= half) { seen[j] = true; st2.Push(j); }
          }
        }
        if (!tooBig) foreach (int i in region) isBg[i] = true;
      }
    } else {
      for (int i = 0; i < N; i++) isBg[i] = Alpha(px[i]) < 24;
    }

    // ---- foreground blocks on a coarse grid (drops specks; header mode picks the logo block) ----
    int cell = Math.Max(4, Math.Max(W, H) / 120);
    int GW = (W + cell - 1) / cell, GH = (H + cell - 1) / cell;
    int[] fgCount = new int[GW * GH], satSum = new int[GW * GH];
    for (int y = 0; y < H; y++) for (int x = 0; x < W; x++) {
      int i = y * W + x; if (isBg[i]) continue;
      int c = (y / cell) * GW + x / cell; fgCount[c]++; satSum[c] += Sat(px[i]);
    }
    int minPix = Math.Max(2, cell * cell / 25);
    int[] comp = new int[GW * GH];
    for (int i = 0; i < comp.Length; i++) comp[i] = -1;
    var comps = new List<int[]>(); // minGx, minGy, maxGx, maxGy, pixels, sat
    int gap = header ? 2 : 3; // cells that may separate parts of one logo
    for (int s = 0; s < GW * GH; s++) {
      if (comp[s] >= 0 || fgCount[s] < minPix) continue;
      int id = comps.Count; var info = new int[] { s % GW, s / GW, s % GW, s / GW, 0, 0 };
      var st = new Stack<int>(); st.Push(s); comp[s] = id;
      while (st.Count > 0) {
        int c = st.Pop(), cx = c % GW, cy = c / GW;
        info[0] = Math.Min(info[0], cx); info[1] = Math.Min(info[1], cy); info[2] = Math.Max(info[2], cx); info[3] = Math.Max(info[3], cy);
        info[4] += fgCount[c]; info[5] += satSum[c];
        for (int dy = -gap; dy <= gap; dy++) for (int dx = -gap; dx <= gap; dx++) {
          int nx = cx + dx, ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= GW || ny >= GH) continue;
          int j = ny * GW + nx;
          if (comp[j] < 0 && fgCount[j] >= minPix) { comp[j] = id; st.Push(j); }
        }
      }
      comps.Add(info);
    }
    if (comps.Count == 0) return "{\"ok\":false,\"reason\":\"empty\"}";
    int total = 0; foreach (var c in comps) total += c[4];

    int x0 = int.MaxValue, y0 = int.MaxValue, x1 = -1, y1 = -1;
    if (header) {
      // Most logo-like block: big and colourful, not a full-width rule or a line of black text.
      double bestScore = -1; int[] pick = null;
      foreach (var c in comps) {
        int bw = (c[2] - c[0] + 1) * cell, bh = (c[3] - c[1] + 1) * cell;
        if (bw > W * 0.85 && bh < H * 0.15) continue;
        double colour = c[4] > 0 ? (double)c[5] / c[4] / 255.0 : 0;
        double aspect = (double)Math.Max(bw, bh) / Math.Max(1, Math.Min(bw, bh));
        double score = c[4] * (1 + 3 * colour) / (aspect > 6 ? 3 : 1);
        if (score > bestScore) { bestScore = score; pick = c; }
      }
      if (pick == null) return "{\"ok\":false,\"reason\":\"no logo block\"}";
      x0 = pick[0] * cell; y0 = pick[1] * cell; x1 = Math.Min(W - 1, (pick[2] + 1) * cell - 1); y1 = Math.Min(H - 1, (pick[3] + 1) * cell - 1);
    } else {
      // Keep every block that matters (ignore specks under 0.4% of the marks).
      foreach (var c in comps) {
        if (c[4] < total * 0.004) continue;
        x0 = Math.Min(x0, c[0] * cell); y0 = Math.Min(y0, c[1] * cell);
        x1 = Math.Max(x1, Math.Min(W - 1, (c[2] + 1) * cell - 1)); y1 = Math.Max(y1, Math.Min(H - 1, (c[3] + 1) * cell - 1));
      }
    }
    // tighten to the actual pixels inside the box
    int tx0 = int.MaxValue, ty0 = int.MaxValue, tx1 = -1, ty1 = -1;
    for (int y = y0; y <= y1; y++) for (int x = x0; x <= x1; x++) {
      if (isBg[y * W + x]) continue;
      int c = (y / cell) * GW + x / cell;
      if (comp[c] < 0) continue;
      if (x < tx0) tx0 = x; if (x > tx1) tx1 = x; if (y < ty0) ty0 = y; if (y > ty1) ty1 = y;
    }
    if (tx1 < 0) return "{\"ok\":false,\"reason\":\"empty\"}";
    int pad = Math.Max(4, (int)(Math.Max(tx1 - tx0, ty1 - ty0) * 0.03));
    tx0 = Math.Max(0, tx0 - pad); ty0 = Math.Max(0, ty0 - pad); tx1 = Math.Min(W - 1, tx1 + pad); ty1 = Math.Min(H - 1, ty1 + pad);
    int OW = tx1 - tx0 + 1, OH = ty1 - ty0 + 1;
    if (OW < 16 || OH < 16) return "{\"ok\":false,\"reason\":\"too small\"}";

    // ---- output: background transparent with soft edges ----
    int[] o = new int[OW * OH];
    for (int y = 0; y < OH; y++) for (int x = 0; x < OW; x++) {
      int i = (y + ty0) * W + (x + tx0), p = px[i];
      int a = Alpha(p);
      if (uniform) {
        if (isBg[i]) a = 0;
        else {
          bool edge = false;
          for (int d = 0; d < 4 && !edge; d++) {
            int nx = x + tx0 + (d == 0 ? 1 : d == 1 ? -1 : 0), ny = y + ty0 + (d == 2 ? 1 : d == 3 ? -1 : 0);
            if (nx >= 0 && ny >= 0 && nx < W && ny < H && isBg[ny * W + nx]) edge = true;
          }
          if (edge) { int df = Diff(p, bg); if (df < tol * 3) a = Math.Min(a, 255 * (df - tol / 2) / (tol * 3 - tol / 2)); if (a < 0) a = 0; }
        }
      }
      o[y * OW + x] = (a << 24) | (p & 0xFFFFFF);
    }
    int FW = OW, FH = OH;
    using (var outBmp = new Bitmap(OW, OH, PixelFormat.Format32bppArgb)) {
      var ob = outBmp.LockBits(new Rectangle(0, 0, OW, OH), ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
      Marshal.Copy(o, 0, ob.Scan0, o.Length);
      outBmp.UnlockBits(ob);
      if (maxSide > 0 && Math.Max(OW, OH) > maxSide) {
        // print size: large photos / scans are reduced (sharp at 300 dpi for their printed size, small files)
        double s = (double)maxSide / Math.Max(OW, OH);
        FW = Math.Max(1, (int)Math.Round(OW * s)); FH = Math.Max(1, (int)Math.Round(OH * s));
        using (var small = new Bitmap(FW, FH, PixelFormat.Format32bppArgb)) {
          using (var g = Graphics.FromImage(small)) {
            g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
            g.PixelOffsetMode = System.Drawing.Drawing2D.PixelOffsetMode.HighQuality;
            g.CompositingMode = System.Drawing.Drawing2D.CompositingMode.SourceCopy;
            g.DrawImage(outBmp, new Rectangle(0, 0, FW, FH));
          }
          small.Save(outPath, ImageFormat.Png);
        }
      } else outBmp.Save(outPath, ImageFormat.Png);
    }
    return "{\"ok\":true,\"width\":" + FW + ",\"height\":" + FH + ",\"cropped\":" + ((OW < W || OH < H) ? "true" : "false") + ",\"transparent\":" + (uniform ? "true" : "false") + ",\"resized\":" + ((FW != OW) ? "true" : "false") + "}";
  }
}
'@
try { [LogoClean]::Run($In, $Out, $Mode -eq 'header', $Max) } catch { '{"ok":false,"reason":' + ($_.Exception.Message | ConvertTo-Json) + '}' }
