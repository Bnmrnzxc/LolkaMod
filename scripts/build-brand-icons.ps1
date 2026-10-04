# Converts the supplied brand artwork into a standard multi-resolution Windows icon.
# The source PNG is preserved; no external service or runtime dependency is required.
$ErrorActionPreference = 'Stop'
$brandRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\assets\branding'))
$brandSource = Join-Path $brandRoot 'logo.png'
$brandIcon = Join-Path $brandRoot 'app.ico'
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
public static class LolkaModIconPackage {
    private static GraphicsPath Rounded(float size, float radius) {
        var p = new GraphicsPath(); var d = radius * 2;
        p.AddArc(0, 0, d, d, 180, 90); p.AddArc(size-d, 0, d, d, 270, 90);
        p.AddArc(size-d, size-d, d, d, 0, 90); p.AddArc(0, size-d, d, d, 90, 90); p.CloseFigure(); return p;
    }
    public static void Write(string source, string output) {
        int[] sizes = { 16, 24, 32, 48, 64, 128, 256 };
        var frames = new List<byte[]>();
        using (var original = new Bitmap(source)) {
            int x1 = original.Width, y1 = original.Height, x2 = -1, y2 = -1;
            for (int y=0; y<original.Height; y++) for (int x=0; x<original.Width; x++) {
                if (original.GetPixel(x,y).A == 0) continue;
                x1=Math.Min(x1,x); y1=Math.Min(y1,y); x2=Math.Max(x2,x); y2=Math.Max(y2,y);
            }
            if (x2<x1) throw new InvalidDataException("Empty logo artwork");
            var crop = new Rectangle(x1,y1,x2-x1+1,y2-y1+1);
            foreach (int size in sizes) {
                // Oversample the icon then reduce once for crisp small-size contours.
                int work = size*4;
                using (var canvas = new Bitmap(work, work, PixelFormat.Format32bppArgb)) {
                    using (var g=Graphics.FromImage(canvas)) {
                        g.Clear(Color.Transparent); g.SmoothingMode=SmoothingMode.AntiAlias;
                        g.InterpolationMode=InterpolationMode.HighQualityBicubic; g.PixelOffsetMode=PixelOffsetMode.HighQuality;
                        using(var shape=Rounded(work-1, work*.21f)) using(var b=new SolidBrush(Color.FromArgb(44,44,48))) g.FillPath(b,shape);
                        float h=work*.82f, w=h*crop.Width/crop.Height;
                        g.DrawImage(original,new RectangleF((work-w)/2,(work-h)/2,w,h),crop,GraphicsUnit.Pixel);
                    }
                    using(var frame=new Bitmap(size,size,PixelFormat.Format32bppArgb)) {
                        using(var g=Graphics.FromImage(frame)) {
                            g.InterpolationMode=InterpolationMode.HighQualityBicubic; g.PixelOffsetMode=PixelOffsetMode.HighQuality;
                            g.DrawImage(canvas,new Rectangle(0,0,size,size));
                        }
                        using(var ms=new MemoryStream()) { frame.Save(ms,ImageFormat.Png); frames.Add(ms.ToArray()); }
                    }
                }
            }
        }
        using(var file=new FileStream(output,FileMode.Create,FileAccess.Write)) using(var writer=new BinaryWriter(file)) {
            writer.Write((ushort)0); writer.Write((ushort)1); writer.Write((ushort)sizes.Length);
            uint offset=(uint)(6+16*sizes.Length);
            for(int i=0;i<sizes.Length;i++) {
                writer.Write((byte)(sizes[i]==256?0:sizes[i])); writer.Write((byte)(sizes[i]==256?0:sizes[i]));
                writer.Write((byte)0); writer.Write((byte)0); writer.Write((ushort)1); writer.Write((ushort)32);
                writer.Write((uint)frames[i].Length); writer.Write(offset); offset+=(uint)frames[i].Length;
            }
            foreach(var frame in frames) writer.Write(frame);
        }
    }
}
'@ -ReferencedAssemblies System.Drawing
[LolkaModIconPackage]::Write($brandSource, $brandIcon)
Get-Item -LiteralPath $brandIcon | Select-Object Name, Length
